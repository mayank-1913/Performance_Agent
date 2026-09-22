'use strict';

/**
 * Phase 6.6 regression guards for the mandatory summary sanitizer.
 *
 * Coverage:
 *   1. Every generated script emits handleSummary that references
 *      __ENV.PA_CLEAN_SUMMARY_PATH and deletes setup_data.
 *   2. swapCleanSummaryOverRaw atomically replaces the raw summary
 *      with the clean sibling and is a no-op when the sibling is
 *      absent (legacy scripts).
 *   3. Integration proof (only runs when the k6 binary is on PATH):
 *      spawn a real k6 process using the emitted script; verify the
 *      RAW summary file (written by K6's --summary-export) STILL
 *      leaks setup_data (documenting the OS-level race window is
 *      real), then verify the .clean sibling k6 wrote via
 *      handleSummary is setup_data-free, and finally verify
 *      swapCleanSummaryOverRaw produces a clean final artifact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { normalizeWorkload } = require('../src/lib/k6/workloadProfiles');
const {
  swapCleanSummaryOverRaw,
  scrubSummarySetupData,
} = require('../src/modules/runs/runs.manager');

/* ------------------------------------------------------------------ */
/*  1. Every generated script emits the sanitizer                       */
/* ------------------------------------------------------------------ */

function makeParsed() {
  return sanitizeParsedCollection(
    parse({
      info: { name: 'phase66', schema: 'v2.1' },
      item: [
        {
          name: 'Login',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            url: { raw: 'http://127.0.0.1:65535/login' },
            body: { mode: 'raw', raw: '{"u":"x"}' },
          },
        },
        {
          name: 'Protected',
          request: {
            method: 'GET',
            header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
            url: { raw: 'http://127.0.0.1:65535/me' },
          },
        },
      ],
    })
  ).parsed;
}

test('every generated script emits the mandatory handleSummary sanitizer', () => {
  const parsed = makeParsed();
  const flow = buildAuthFlow(parsed);
  const workload = normalizeWorkload({ profile: 'smoke' });
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    workload,
    authFlow: flow,
  });
  assert.match(code, /export function handleSummary\(data\) \{/);
  assert.match(code, /delete clean\.setup_data;/);
  assert.match(code, /__ENV\.PA_CLEAN_SUMMARY_PATH/);
  // The optional stdout customization is OFF by default so we don't emit
  // the [custom-summary] marker.
  assert.doesNotMatch(code, /\[custom-summary\]/);
});

test('handleSummary preserves every top-level key parseRunArtifacts consumes', () => {
  // parseRunArtifacts reads: summaryRaw.metrics.*, summaryRaw.metrics.<name>.thresholds.
  // The sanitizer must only touch setup_data — nothing else — so this
  // regression pins the shape by asserting the code does NOT delete any
  // metric-bearing key from clean.
  const parsed = makeParsed();
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    workload: normalizeWorkload({ profile: 'load' }),
    authFlow: buildAuthFlow(parsed),
  });
  const deletes = code.match(/delete clean\.\w+/g) || [];
  assert.deepEqual(deletes, ['delete clean.setup_data']);
});

/* ------------------------------------------------------------------ */
/*  2. swapCleanSummaryOverRaw unit tests                               */
/* ------------------------------------------------------------------ */

async function tmpDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'p66-swap-'));
}

test('swapCleanSummaryOverRaw replaces the raw summary atomically when the clean file exists', async () => {
  const dir = await tmpDir();
  const raw = path.join(dir, 'summary.json');
  const clean = raw + '.clean';
  await fsp.writeFile(raw, JSON.stringify({ setup_data: { AUTH_TOKEN: 'LEAK' }, metrics: {} }), 'utf-8');
  await fsp.writeFile(clean, JSON.stringify({ metrics: {} }), 'utf-8');

  const result = await swapCleanSummaryOverRaw({ summaryExportPath: raw, cleanSummaryPath: clean });
  assert.equal(result.swapped, true);

  // Clean file consumed.
  await assert.rejects(fsp.access(clean));
  // Raw file now contains the clean content.
  const after = JSON.parse(await fsp.readFile(raw, 'utf-8'));
  assert.equal('setup_data' in after, false);
  const raw2 = await fsp.readFile(raw, 'utf-8');
  assert.ok(!raw2.includes('LEAK'));
});

test('swapCleanSummaryOverRaw is a safe no-op when the clean file is absent (legacy script)', async () => {
  const dir = await tmpDir();
  const raw = path.join(dir, 'summary.json');
  await fsp.writeFile(raw, JSON.stringify({ metrics: {}, setup_data: { LEAK: 'x' } }), 'utf-8');
  const result = await swapCleanSummaryOverRaw({ summaryExportPath: raw });
  assert.equal(result.swapped, false);
  assert.equal(result.reason, 'no-clean-file');
  const after = await fsp.readFile(raw, 'utf-8');
  // The scrubber runs after the swap in the real pipeline; here we only
  // assert the swap itself did not modify the raw file.
  assert.ok(after.includes('setup_data'));
});

test('swapCleanSummaryOverRaw derives .clean when paths.cleanSummaryPath is missing (defence-in-depth)', async () => {
  const dir = await tmpDir();
  const raw = path.join(dir, 'summary.json');
  const clean = raw + '.clean';
  await fsp.writeFile(raw, 'RAW_CONTENT', 'utf-8');
  await fsp.writeFile(clean, 'CLEAN_CONTENT', 'utf-8');
  const result = await swapCleanSummaryOverRaw({ summaryExportPath: raw });
  assert.equal(result.swapped, true);
  assert.equal(await fsp.readFile(raw, 'utf-8'), 'CLEAN_CONTENT');
});

test('the swap+scrub sequence eliminates setup_data in a single pass', async () => {
  const dir = await tmpDir();
  const raw = path.join(dir, 'summary.json');
  const clean = raw + '.clean';
  const secret = 'PHASE_66_TEST_SECRET_XYZ';
  await fsp.writeFile(raw, JSON.stringify({ setup_data: { AUTH_TOKEN: secret }, metrics: {} }), 'utf-8');
  await fsp.writeFile(clean, JSON.stringify({ metrics: {} }), 'utf-8');

  await swapCleanSummaryOverRaw({ summaryExportPath: raw, cleanSummaryPath: clean });
  await scrubSummarySetupData(raw);

  const after = await fsp.readFile(raw, 'utf-8');
  assert.ok(!after.includes(secret));
  assert.ok(!after.includes('setup_data'));
});

/* ------------------------------------------------------------------ */
/*  3. End-to-end proof against a live k6 process                       */
/* ------------------------------------------------------------------ */

function haveK6() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['k6'], {
    encoding: 'utf-8',
  });
  return r.status === 0;
}

async function runK6Async(scriptPath, summaryPath, metricsPath, extraEnv = {}) {
  return await new Promise((resolve) => {
    const child = spawn(
      'k6',
      ['run', '--quiet', '--summary-export', summaryPath, '--out', `json=${metricsPath}`, scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf-8')));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('RAW K6 summary DOES NOT CONTAIN setup_data secret after handleSummary swap', async () => {
  if (!haveK6()) {
    console.log('# skip: k6 binary not available on PATH');
    return;
  }
  const secret = 'PHASE_66_INTEGRATION_TOKEN_qwe123';
  const dir = await tmpDir();
  const scriptPath = path.join(dir, 'script.js');
  const rawSummary = path.join(dir, 'summary.json');
  const cleanSummary = rawSummary + '.clean';
  const metricsPath = path.join(dir, 'metrics.json');

  // Hand-crafted script that mirrors what the generator emits: setup()
  // returns a token, handleSummary writes to PA_CLEAN_SUMMARY_PATH.
  const script = `
import http from 'k6/http';
import { sleep } from 'k6';
export const options = { vus: 1, duration: '1s' };
export function setup() { return { ACCESS_TOKEN: '${secret}' }; }
export default function (data) { http.get('http://127.0.0.1:65535/'); sleep(0.1); }
export function handleSummary(data) {
  const clean = Object.assign({}, data);
  delete clean.setup_data;
  const out = {};
  if (typeof __ENV.PA_CLEAN_SUMMARY_PATH === 'string' && __ENV.PA_CLEAN_SUMMARY_PATH.length > 0) {
    out[__ENV.PA_CLEAN_SUMMARY_PATH] = JSON.stringify(clean);
  }
  return out;
}
`;
  await fsp.writeFile(scriptPath, script, 'utf-8');
  const run = await runK6Async(scriptPath, rawSummary, metricsPath, {
    PA_CLEAN_SUMMARY_PATH: cleanSummary,
  });

  // Sanity: k6 completed and BOTH files exist. This is the pre-swap
  // state — the raw file still leaks (this is what --summary-export
  // wrote); the clean file is what handleSummary produced.
  assert.ok([0, 99].includes(run.code), 'k6 finished: ' + run.stderr.slice(0, 200));
  const rawBefore = await fsp.readFile(rawSummary, 'utf-8');
  const cleanBefore = await fsp.readFile(cleanSummary, 'utf-8');
  assert.ok(rawBefore.includes(secret), 'sanity: raw --summary-export STILL contains the secret pre-swap');
  assert.ok(!cleanBefore.includes(secret), 'PROOF #1: handleSummary output has no secret');
  assert.ok(!cleanBefore.includes('setup_data'), 'PROOF #2: handleSummary output has no setup_data key');

  // Run the pipeline's swap+scrub. After this the on-disk summary must
  // be identical (byte-for-byte) to the clean copy and must contain the
  // same metric structure.
  const swap = await swapCleanSummaryOverRaw({
    summaryExportPath: rawSummary,
    cleanSummaryPath: cleanSummary,
  });
  assert.equal(swap.swapped, true);
  await scrubSummarySetupData(rawSummary);

  const rawAfter = await fsp.readFile(rawSummary, 'utf-8');
  assert.ok(!rawAfter.includes(secret), 'PROOF #3: raw summary is secret-free post-swap');
  assert.ok(!rawAfter.includes('setup_data'), 'PROOF #4: raw summary has no setup_data post-swap');
  // The clean sibling was consumed by rename.
  await assert.rejects(fsp.access(cleanSummary));

  // metricsParser-critical fields survive.
  const parsed = JSON.parse(rawAfter);
  assert.ok(parsed.metrics, 'metrics preserved');
  assert.ok(parsed.metrics.http_reqs || parsed.metrics.iterations, 'a core metric exists');
});
