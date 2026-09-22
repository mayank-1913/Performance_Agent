'use strict';

/**
 * Phase 6 — workload profile tests.
 *
 * Two layers of coverage:
 *   1. Module-level unit tests for the profile catalogue, normalization,
 *      override merging, executor selection, and legacy compatibility.
 *   2. Generator-level integration tests: emit a K6 script for every
 *      profile and assert the emitted `scenarios` block, threshold
 *      values, workload constants, and per-request tags match the
 *      normalized profile — without duplicating request generation code.
 *
 * If a `k6` binary is available on PATH, every emitted script is also
 * validated with `k6 archive` so the whole surface has been round-tripped
 * through K6's own parser.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  PROFILES,
  DEFAULT_PROFILE,
  PROFILE_DEFAULTS,
  PROFILE_LABELS,
  executorFor,
  buildStages,
  durationToMs,
  computeTotalDurationMs,
  isLegacyLoadProfile,
  normalizeWorkload,
  publicWorkload,
} = require('../src/lib/k6/workloadProfiles');
const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const {
  buildLoadProfile,
  buildNormalizedReport,
} = require('../src/lib/report/normalizedReport');

/* ------------------------------------------------------------------ */
/*  1. profile catalogue                                                */
/* ------------------------------------------------------------------ */

test('profile list contains exactly the six standardized profiles', () => {
  assert.deepEqual(PROFILES.slice(), ['smoke', 'load', 'stress', 'spike', 'soak', 'custom']);
  assert.equal(DEFAULT_PROFILE, 'custom');
});

test('every profile has deterministic defaults + a human label', () => {
  for (const p of PROFILES) {
    const d = PROFILE_DEFAULTS[p];
    assert.ok(d, `defaults for ${p}`);
    assert.equal(typeof d.vus, 'number');
    assert.ok(d.vus >= 1);
    for (const k of ['rampUp', 'hold', 'rampDown']) {
      assert.match(d[k], /^\d+(ms|s|m|h)$/, `${p}.${k}`);
    }
    assert.ok(d.thresholds.errorRate >= 0 && d.thresholds.errorRate <= 1);
    assert.ok(d.thresholds.p95Ms > 0);
    assert.equal(typeof PROFILE_LABELS[p], 'string');
  }
});

test('load and custom share the historical Phase-3 defaults byte-for-byte', () => {
  assert.deepEqual(PROFILE_DEFAULTS.custom, {
    vus: 5,
    rampUp: '30s',
    hold: '1m',
    rampDown: '30s',
    thresholds: { errorRate: 0.05, p95Ms: 2000 },
  });
  // load shares the same thresholds so the pre-Phase-6 SLA is preserved
  // when a user picks Load without overriding anything.
  assert.deepEqual(PROFILE_DEFAULTS.load.thresholds, PROFILE_DEFAULTS.custom.thresholds);
});

/* ------------------------------------------------------------------ */
/*  2. executor mapping                                                 */
/* ------------------------------------------------------------------ */

test('executor mapping: smoke → constant-vus, everything else → ramping-vus', () => {
  assert.equal(executorFor('smoke'), 'constant-vus');
  for (const p of PROFILES.filter((x) => x !== 'smoke')) {
    assert.equal(executorFor(p), 'ramping-vus', `${p}`);
  }
});

/* ------------------------------------------------------------------ */
/*  3. normalization                                                    */
/* ------------------------------------------------------------------ */

test('normalizeWorkload(null) returns the custom-profile defaults', () => {
  const w = normalizeWorkload(null);
  assert.equal(w.profile, 'custom');
  assert.equal(w.executor, 'ramping-vus');
  assert.equal(w.vus, 5);
  assert.equal(w.rampUp, '30s');
  assert.equal(w.hold, '1m');
  assert.equal(w.rampDown, '30s');
  assert.equal(w.thresholds.errorRate, 0.05);
  assert.equal(w.thresholds.p95Ms, 2000);
  assert.equal(w.isDefault, true);
});

test('normalizeWorkload({ profile: "load" }) picks up profile defaults, no overrides required', () => {
  const w = normalizeWorkload({ profile: 'load' });
  assert.equal(w.profile, 'load');
  assert.equal(w.executor, 'ramping-vus');
  assert.equal(w.vus, PROFILE_DEFAULTS.load.vus);
  assert.equal(w.rampUp, PROFILE_DEFAULTS.load.rampUp);
  assert.equal(w.hold, PROFILE_DEFAULTS.load.hold);
  assert.equal(w.rampDown, PROFILE_DEFAULTS.load.rampDown);
});

test('normalizeWorkload merges overrides on top of profile defaults', () => {
  const w = normalizeWorkload({
    profile: 'load',
    overrides: { vus: 25, hold: '5m' },
  });
  assert.equal(w.profile, 'load');
  assert.equal(w.vus, 25);
  assert.equal(w.hold, '5m');
  // fields NOT overridden keep the profile default
  assert.equal(w.rampUp, PROFILE_DEFAULTS.load.rampUp);
  assert.equal(w.rampDown, PROFILE_DEFAULTS.load.rampDown);
});

test('normalizeWorkload override-thresholds are respected', () => {
  const w = normalizeWorkload({
    profile: 'stress',
    overrides: { thresholds: { errorRate: 0.20, p95Ms: 8000 } },
  });
  assert.equal(w.thresholds.errorRate, 0.20);
  assert.equal(w.thresholds.p95Ms, 8000);
});

test('normalizeWorkload rejects invalid VU counts and durations', () => {
  assert.throws(() => normalizeWorkload({ profile: 'load', overrides: { vus: 0 } }));
  assert.throws(() => normalizeWorkload({ profile: 'load', overrides: { vus: 1001 } }));
  assert.throws(() => normalizeWorkload({ profile: 'load', overrides: { rampUp: 'bogus' } }));
  assert.throws(() => normalizeWorkload({ profile: 'load', overrides: { hold: '30' } }));
});

test('normalizeWorkload rejects out-of-range thresholds', () => {
  assert.throws(() =>
    normalizeWorkload({ profile: 'load', overrides: { thresholds: { errorRate: -0.1 } } })
  );
  assert.throws(() =>
    normalizeWorkload({ profile: 'load', overrides: { thresholds: { p95Ms: 0 } } })
  );
});

test('normalizeWorkload silently coerces unknown profile ids to "custom"', () => {
  const w = normalizeWorkload({ profile: 'not-a-real-profile' });
  assert.equal(w.profile, 'custom');
});

/* ------------------------------------------------------------------ */
/*  4. legacy loadProfile compatibility                                 */
/* ------------------------------------------------------------------ */

test('isLegacyLoadProfile detects the four-field shape', () => {
  assert.equal(isLegacyLoadProfile({ vus: 5, rampUp: '30s', hold: '1m', rampDown: '30s' }), true);
  assert.equal(isLegacyLoadProfile({ vus: 5 }), true);
  assert.equal(isLegacyLoadProfile({ profile: 'load', vus: 5 }), false);
  assert.equal(isLegacyLoadProfile(null), false);
  assert.equal(isLegacyLoadProfile({}), false);
});

test('legacy loadProfile input is routed into the "custom" profile verbatim', () => {
  const legacy = { vus: 12, rampUp: '45s', hold: '2m', rampDown: '15s' };
  const w = normalizeWorkload(legacy);
  assert.equal(w.profile, 'custom');
  assert.equal(w.executor, 'ramping-vus');
  assert.equal(w.vus, 12);
  assert.equal(w.rampUp, '45s');
  assert.equal(w.hold, '2m');
  assert.equal(w.rampDown, '15s');
  // loadProfile mirror preserves the exact 4-field shape existing code
  // paths (scripts.store, run manifest, UI estimator) depend on.
  assert.deepEqual(w.loadProfile, legacy);
});

/* ------------------------------------------------------------------ */
/*  5. scenario configuration per profile                              */
/* ------------------------------------------------------------------ */

test('smoke emits a single constant-vus scenario with no stages', () => {
  const w = normalizeWorkload({ profile: 'smoke' });
  const sc = w.scenarios.smoke;
  assert.equal(sc.executor, 'constant-vus');
  assert.equal(sc.vus, PROFILE_DEFAULTS.smoke.vus);
  assert.equal(sc.duration, PROFILE_DEFAULTS.smoke.hold);
  assert.equal(sc.stages, undefined);
  assert.deepEqual(sc.tags, { workload_profile: 'smoke' });
});

test('load emits a 3-stage ramping-vus (rampUp / hold / rampDown)', () => {
  const w = normalizeWorkload({ profile: 'load' });
  const sc = w.scenarios.load;
  assert.equal(sc.executor, 'ramping-vus');
  assert.equal(sc.startVUs, 0);
  assert.equal(sc.stages.length, 3);
  assert.equal(sc.stages[0].target, PROFILE_DEFAULTS.load.vus);
  assert.equal(sc.stages[2].target, 0);
});

test('stress emits a multi-plateau ramp (4 targets at 25/50/75/100% of VU)', () => {
  const w = normalizeWorkload({ profile: 'stress' });
  const sc = w.scenarios.stress;
  assert.equal(sc.executor, 'ramping-vus');
  assert.equal(sc.stages.length, 9); // ramp+hold * 4 plateaus + rampDown
  const targets = sc.stages.map((s) => s.target);
  const uniqueSorted = Array.from(new Set(targets.filter((t) => t > 0))).sort((a, b) => a - b);
  assert.equal(uniqueSorted.length, 4, 'four distinct plateau levels');
  assert.equal(uniqueSorted[uniqueSorted.length - 1], PROFILE_DEFAULTS.stress.vus, 'peak equals target VUs');
  assert.equal(sc.stages[sc.stages.length - 1].target, 0, 'final ramp-down');
});

test('spike emits an aggressive short-duration 3-stage scenario', () => {
  const w = normalizeWorkload({ profile: 'spike' });
  const sc = w.scenarios.spike;
  assert.equal(sc.executor, 'ramping-vus');
  assert.equal(sc.stages.length, 3);
  assert.equal(sc.stages[0].duration, '10s'); // rapid ramp
  assert.equal(sc.stages[0].target, PROFILE_DEFAULTS.spike.vus);
  assert.equal(sc.stages[2].duration, '10s'); // rapid drop
});

test('soak emits a long-hold scenario with modest ramping', () => {
  const w = normalizeWorkload({ profile: 'soak' });
  const sc = w.scenarios.soak;
  assert.equal(sc.executor, 'ramping-vus');
  assert.equal(sc.stages.length, 3);
  assert.equal(sc.stages[1].duration, '1h');
});

test('custom emits a 3-stage ramping-vus using the caller-provided values', () => {
  const w = normalizeWorkload({
    profile: 'custom',
    overrides: { vus: 7, rampUp: '15s', hold: '45s', rampDown: '15s' },
  });
  const sc = w.scenarios.custom;
  assert.equal(sc.executor, 'ramping-vus');
  assert.deepEqual(
    sc.stages,
    [
      { duration: '15s', target: 7 },
      { duration: '45s', target: 7 },
      { duration: '15s', target: 0 },
    ]
  );
});

/* ------------------------------------------------------------------ */
/*  6. profile differentiation                                          */
/* ------------------------------------------------------------------ */

test('generated scenario configs are pairwise different across profiles', () => {
  const key = (p) => JSON.stringify(normalizeWorkload({ profile: p }).scenarios);
  const smoke = key('smoke');
  const load = key('load');
  const stress = key('stress');
  const spike = key('spike');
  const soak = key('soak');
  const uniques = new Set([smoke, load, stress, spike, soak]);
  assert.equal(uniques.size, 5, 'all five standardized profiles must produce distinct scenarios');
});

/* ------------------------------------------------------------------ */
/*  7. duration math                                                    */
/* ------------------------------------------------------------------ */

test('durationToMs handles ms / s / m / h and bogus input', () => {
  assert.equal(durationToMs('500ms'), 500);
  assert.equal(durationToMs('30s'), 30_000);
  assert.equal(durationToMs('2m'), 120_000);
  assert.equal(durationToMs('1h'), 3_600_000);
  assert.equal(durationToMs('bogus'), 0);
  assert.equal(durationToMs(null), 0);
});

test('computeTotalDurationMs sums stages OR returns constant-vus duration', () => {
  const load = normalizeWorkload({ profile: 'load' });
  assert.equal(load.totalDurationMs, 30_000 + 120_000 + 30_000);
  const smoke = normalizeWorkload({ profile: 'smoke' });
  assert.equal(smoke.totalDurationMs, 30_000);
  const stress = normalizeWorkload({ profile: 'stress' });
  // 4 ramp phases (30s each) + 4 hold phases (1m each) + rampDown (30s)
  assert.equal(stress.totalDurationMs, 4 * 30_000 + 4 * 60_000 + 30_000);
});

/* ------------------------------------------------------------------ */
/*  8. publicWorkload strips the internal scenarios blob                */
/* ------------------------------------------------------------------ */

test('publicWorkload never exposes the internal K6 scenarios object', () => {
  const w = normalizeWorkload({ profile: 'load' });
  const pub = publicWorkload(w);
  assert.equal(pub.scenarios, undefined);
  for (const k of ['profile', 'label', 'executor', 'vus', 'rampUp', 'hold', 'rampDown', 'thresholds', 'totalDurationMs']) {
    assert.ok(k in pub, `missing public key ${k}`);
  }
});

/* ------------------------------------------------------------------ */
/*  9. generator integration                                            */
/* ------------------------------------------------------------------ */

function makeParsed() {
  const collection = {
    info: { name: 'wl-demo', schema: 'v2.1' },
    item: [
      {
        name: 'Health',
        request: { method: 'GET', url: { raw: '{{baseUrl}}/health' } },
      },
      {
        name: 'Create thing',
        request: {
          method: 'POST',
          header: [{ key: 'Authorization', value: 'Bearer {{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/things' },
          body: { mode: 'raw', raw: '{"n":1}', options: { raw: { language: 'json' } } },
        },
      },
    ],
  };
  return sanitizeParsedCollection(parse(collection)).parsed;
}

function generateFor(profile) {
  const workload = normalizeWorkload({ profile });
  const code = generateK6Script(makeParsed(), {
    injectAuthToken: true,
    workload,
    authFlow: { enabled: false },
  });
  return { workload, code };
}

test('every profile emits WORKLOAD_PROFILE + WORKLOAD_EXECUTOR constants', () => {
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    assert.match(code, new RegExp('const WORKLOAD_PROFILE = "' + p + '";'), `${p}: WORKLOAD_PROFILE constant`);
    const exec = p === 'smoke' ? 'constant-vus' : 'ramping-vus';
    assert.match(code, new RegExp('const WORKLOAD_EXECUTOR = "' + exec + '";'), `${p}: WORKLOAD_EXECUTOR constant`);
  }
});

test('every profile emits options.scenarios and no top-level stages', () => {
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    assert.match(code, /scenarios:\s*\{/, `${p}: scenarios block emitted`);
    // The emitted options block must NOT re-introduce top-level stages
    // (K6 rejects scripts that carry both). Ignore stages inside scenarios.
    const optionsStart = code.indexOf('export const options');
    const optionsEnd = code.indexOf('\n};', optionsStart);
    const optionsBlock = code.slice(optionsStart, optionsEnd);
    // The word "stages" appears inside the scenarios literal for ramping
    // profiles; make sure it never appears as a top-level options key.
    assert.ok(
      !/^\s*stages:/m.test(optionsBlock.replace(/scenarios:\s*\{[\s\S]*?\n\s*\},/g, '')),
      `${p}: found top-level stages key alongside scenarios`
    );
  }
});

test('every profile emits the profile-specific error-rate + p95 thresholds', () => {
  for (const p of PROFILES) {
    const { workload, code } = generateFor(p);
    const errRe = new RegExp("http_req_failed: \\['rate<" + workload.thresholds.errorRate + "'\\]");
    const p95Re = new RegExp("http_req_duration: \\['p\\(95\\)<" + workload.thresholds.p95Ms + "'\\]");
    assert.match(code, errRe, `${p}: error-rate threshold`);
    assert.match(code, p95Re, `${p}: p95 threshold`);
  }
});

test('every generated script tags every request with the workload profile', () => {
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    // The `__defaultTags` helper folds WORKLOAD_PROFILE into every
    // request's tags map at runtime.
    assert.match(code, /workload_profile: WORKLOAD_PROFILE/);
    // API identity tags from Phase 3 remain present.
    const expected = ['api_name', 'api_method', 'api_path', 'folder', 'request_id'];
    for (const k of expected) {
      assert.match(code, new RegExp('"' + k + '":'), `${p}: tag ${k}`);
    }
  }
});

test('smoke emits scenarios[smoke].executor === "constant-vus"; others use ramping-vus', () => {
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    const executor = p === 'smoke' ? 'constant-vus' : 'ramping-vus';
    const re = new RegExp(
      '"' + p + '": \\{[^}]*"executor":\\s*"' + executor + '"',
      's'
    );
    assert.match(code, re, `${p}: expected scenario executor "${executor}"`);
  }
});

test('legacy options.loadProfile input still generates a valid script (custom profile)', () => {
  const code = generateK6Script(makeParsed(), {
    injectAuthToken: true,
    loadProfile: { vus: 7, rampUp: '15s', hold: '45s', rampDown: '15s' },
    authFlow: { enabled: false },
  });
  assert.match(code, /const WORKLOAD_PROFILE = "custom";/);
  assert.match(code, /"custom":\s*\{[\s\S]*?"executor":\s*"ramping-vus"/);
  assert.match(code, /"duration":\s*"15s",\s*"target":\s*7/);
});

/* ------------------------------------------------------------------ */
/*  10. request generation is not duplicated per profile                */
/* ------------------------------------------------------------------ */

test('every profile shares the same request-execution loop shape', () => {
  // Concretely: the default export contains the same set of `group(` +
  // http verb calls across every profile — only the options block differs.
  const scripts = PROFILES.map((p) => generateFor(p).code);
  const defaultBodies = scripts.map((code) => {
    const start = code.indexOf('export default function');
    const end = code.indexOf('\n}', start);
    return code.slice(start, end);
  });
  const groupsFirst = (defaultBodies[0].match(/group\(/g) || []).length;
  for (let i = 1; i < defaultBodies.length; i += 1) {
    const groupsN = (defaultBodies[i].match(/group\(/g) || []).length;
    assert.equal(
      groupsN,
      groupsFirst,
      'profile ' + PROFILES[i] + ' emitted a different number of request groups than ' + PROFILES[0]
    );
  }
});

/* ------------------------------------------------------------------ */
/*  11. report metadata                                                 */
/* ------------------------------------------------------------------ */

test('buildLoadProfile threads profile + executor from the normalized workload into the report', () => {
  const w = normalizeWorkload({ profile: 'stress' });
  const lp = buildLoadProfile(w.loadProfile, w);
  assert.equal(lp.profile, 'stress');
  assert.equal(lp.label, 'Stress');
  assert.equal(lp.executor, 'ramping-vus');
  assert.deepEqual(lp.thresholds, { errorRate: 0.10, p95Ms: 4000 });
});

test('normalized report carries the workload metadata for every profile', () => {
  for (const p of PROFILES) {
    const w = normalizeWorkload({ profile: p });
    const report = buildNormalizedReport({
      parsed: null,
      run: { runId: 'r', scriptId: 's', status: 'completed', exitCode: 0 },
      script: { loadProfile: w.loadProfile, workload: publicWorkload(w) },
    });
    assert.equal(report.loadProfile.profile, p, `${p}: report.loadProfile.profile`);
    assert.equal(
      report.loadProfile.executor,
      p === 'smoke' ? 'constant-vus' : 'ramping-vus',
      `${p}: report.loadProfile.executor`
    );
  }
});

test('normalized report falls back to ramping-vus when the script pre-dates Phase 6', () => {
  const report = buildNormalizedReport({
    parsed: null,
    run: { runId: 'r', scriptId: 's', status: 'completed', exitCode: 0 },
    script: { loadProfile: { vus: 5, rampUp: '30s', hold: '1m', rampDown: '30s' } },
  });
  assert.equal(report.loadProfile.executor, 'ramping-vus');
  assert.equal(report.loadProfile.profile, null);
});

/* ------------------------------------------------------------------ */
/*  12. K6 syntax validation                                            */
/* ------------------------------------------------------------------ */

test('every profile-emitted script parses as valid ESM (node --check)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-esm-'));
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    const file = path.join(tmp, `${p}.mjs`);
    fs.writeFileSync(file, code, 'utf-8');
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
    assert.equal(r.status, 0, `${p}: node --check failed: ${r.stderr}`);
  }
});

test('k6 archive validates every profile-emitted script when k6 is on PATH', () => {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['k6'], {
    encoding: 'utf-8',
  });
  if (which.status !== 0) {
    console.log('# skip: k6 binary not available on PATH');
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-k6-'));
  for (const p of PROFILES) {
    const { code } = generateFor(p);
    const scriptFile = path.join(tmp, `${p}.js`);
    const tarFile = path.join(tmp, `${p}.tar`);
    fs.writeFileSync(scriptFile, code, 'utf-8');
    const r = spawnSync('k6', ['archive', scriptFile, '-O', tarFile], { encoding: 'utf-8' });
    assert.equal(
      r.status,
      0,
      `${p}: k6 archive failed: ${(r.stderr || r.stdout || '').split('\n').slice(0, 4).join(' | ')}`
    );
  }
});

/* ------------------------------------------------------------------ */
/*  13. deterministic emission                                          */
/* ------------------------------------------------------------------ */

test('scenario emission is deterministic across repeated calls', () => {
  const a = normalizeWorkload({ profile: 'stress' });
  const b = normalizeWorkload({ profile: 'stress' });
  // Ignore the isDefault flag which reflects "= custom defaults" — same
  // for both runs anyway. Compare everything else structurally.
  assert.deepEqual(a.scenarios, b.scenarios);
  assert.deepEqual(a.thresholds, b.thresholds);
  assert.deepEqual(a.loadProfile, b.loadProfile);
});


/* ------------------------------------------------------------------ */
/*  14. Phase 6.5 regression: normalize is idempotent                   */
/* ------------------------------------------------------------------ */
/*  Defect found during Phase 6.5 audit: re-normalizing an already-    */
/*  normalized workload silently dropped user overrides because the    */
/*  normalized output has no `.overrides` key. Callers that hand a     */
/*  fully-normalized workload back through normalizeWorkload() (e.g.   */
/*  the generator's own resilience path) would see profile defaults    */
/*  instead of the user's scaled-down values. Locked in here.          */

test('normalizeWorkload is idempotent — round-tripping a normalized workload preserves every field', () => {
  const first = normalizeWorkload({
    profile: 'smoke',
    overrides: { vus: 1, rampUp: '0s', hold: '3s', rampDown: '0s' },
  });
  const again = normalizeWorkload(first);
  assert.equal(again.profile, first.profile);
  assert.equal(again.executor, first.executor);
  assert.equal(again.vus, first.vus, 'vus preserved');
  assert.equal(again.rampUp, first.rampUp, 'rampUp preserved');
  assert.equal(again.hold, first.hold, 'hold preserved');
  assert.equal(again.rampDown, first.rampDown, 'rampDown preserved');
  assert.deepEqual(again.thresholds, first.thresholds, 'thresholds preserved');
  assert.deepEqual(again.scenarios, first.scenarios, 'scenarios preserved');
});

test('normalizeWorkload round-trip preserves scaled-down durations for every profile', () => {
  // Audit scenario: use short seconds-scale durations everywhere so the
  // profile can be executed in a bounded time. This must survive a
  // second pass through normalizeWorkload.
  for (const p of PROFILES) {
    const w = normalizeWorkload({
      profile: p,
      overrides: { vus: 2, rampUp: '1s', hold: '3s', rampDown: '1s' },
    });
    const again = normalizeWorkload(w);
    assert.equal(again.hold, '3s', `${p}: hold preserved`);
    assert.equal(again.vus, 2, `${p}: vus preserved`);
    if (p === 'smoke') {
      assert.equal(again.scenarios.smoke.duration, '3s');
    } else {
      // First hold stage carries the overridden duration.
      assert.equal(again.scenarios[p].stages[1].duration, '3s');
    }
  }
});
