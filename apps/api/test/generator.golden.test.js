'use strict';

/**
 * Phase 3 golden tests for the standardized K6 script generator.
 *
 * For each fixture the test:
 *   1. generates a script
 *   2. verifies it parses as a valid ES module (K6 script surface)
 *   3. verifies request count / methods / URL placeholders are preserved
 *   4. verifies auth behaviour (strategy + resolver usage)
 *   5. verifies no secret leakage via assertNoSecretsInScript
 *   6. verifies every standard section banner is emitted
 *   7. optionally runs `k6 archive` when the k6 binary is available
 *
 * Fixtures cover the three currently-supported auth strategies:
 *   NONE          — no Authorization headers anywhere.
 *   STATIC        — collection uses {{token}} placeholders; no login.
 *   SETUP_LOGIN   — collection has a login endpoint + protected requests.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  generateK6Script,
  AuthStrategy,
  deriveAuthStrategy,
  extractApiPath,
  makeRequestId,
  buildRequestTags,
} = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const {
  sanitizeParsedCollection,
  assertNoSecretsInScript,
} = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');

/* ---------- fixtures ------------------------------------------------- */

function fixtureNone() {
  return {
    info: { name: 'no-auth-fixture', schema: 'v2.1' },
    item: [
      {
        name: 'List public users',
        request: {
          method: 'GET',
          header: [{ key: 'Accept', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/public/users' },
        },
      },
      {
        name: 'Ping health',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/health' },
        },
      },
    ],
  };
}

function fixtureStatic() {
  return {
    info: { name: 'static-auth-fixture', schema: 'v2.1' },
    item: [
      {
        name: "Get User's Carts", // apostrophe on purpose — Phase 0 bug regression
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/carts/1' },
        },
      },
      {
        name: 'Create order',
        request: {
          method: 'POST',
          header: [
            { key: 'Authorization', value: 'Bearer {{jwt_token}}' },
            { key: 'Content-Type', value: 'application/json' },
          ],
          url: { raw: '{{baseUrl}}/orders' },
          body: { mode: 'raw', raw: '{"item":"x"}' },
        },
      },
      {
        name: 'Custom token header',
        request: {
          method: 'GET',
          header: [{ key: 'X-Auth-Token', value: '{{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/custom' },
        },
      },
    ],
  };
}

function fixtureSetupLogin() {
  return {
    info: { name: 'setup-login-fixture', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{"u":"x","p":"y"}' },
        },
      },
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
      {
        name: 'List items',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: '{{baseUrl}}/items?limit=20' },
        },
      },
    ],
  };
}

/* ---------- helpers -------------------------------------------------- */

function generateFor(collection, opts = {}) {
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = opts.withFlow ? buildAuthFlow(parsed) : { enabled: false };
  return {
    parsed,
    flow,
    code: generateK6Script(parsed, {
      injectAuthToken: opts.injectAuthToken !== false,
      authFlow: flow,
    }),
  };
}

function parsesAsESM(code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-golden-'));
  const file = path.join(tmp, 'script.mjs');
  fs.writeFileSync(file, code, 'utf-8');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  return { ok: r.status === 0, stderr: r.stderr || '' };
}

function tryK6Archive(code) {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['k6'], {
    encoding: 'utf-8',
  });
  if (which.status !== 0) return { available: false, ok: null, message: 'k6 not on PATH' };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase3-k6-'));
  const scriptFile = path.join(tmp, 'script.js');
  const tarFile = path.join(tmp, 'script.tar');
  fs.writeFileSync(scriptFile, code, 'utf-8');
  const r = spawnSync('k6', ['archive', scriptFile, '-O', tarFile], { encoding: 'utf-8' });
  return { available: true, ok: r.status === 0, message: r.stderr || r.stdout || '' };
}

/** Every required section banner must appear in the emitted script. */
function assertHasEverySectionBanner(code) {
  for (let i = 1; i <= 14; i += 1) {
    const banner = 'Section ' + String(i).padStart(2, '0') + ':';
    assert.ok(
      code.includes(banner),
      `missing ${banner} banner in generated script`
    );
  }
}

/* --------------------------------------------------------------------- */
/* Golden test: NONE strategy                                            */
/* --------------------------------------------------------------------- */
test('golden(NONE): a collection with no Authorization headers generates a valid, section-complete script', () => {
  const { code, parsed } = generateFor(fixtureNone(), { injectAuthToken: false });
  const check = parsesAsESM(code);
  assert.ok(check.ok, 'generated script must parse as ESM: ' + check.stderr);
  assertNoSecretsInScript(code);
  assertHasEverySectionBanner(code);

  assert.match(code, /const AUTH_STRATEGY = "NONE";/);
  assert.match(code, /No Authorization headers required/);
  assert.equal(parsed.requests.length, 2);

  // Preserve request order + methods + URL placeholder shapes.
  const groups = code.match(/group\(`[^`]+`,/g) || [];
  assert.equal(groups.length, 2, 'one group per request');
  assert.match(code, /group\(`List public users`,/);
  assert.match(code, /group\(`Ping health`,/);
  assert.match(code, /const __url_0 = `\$\{__coalesceVar\("baseUrl", __ENV\.BASE_URL\)\}\/public\/users`/);
  assert.match(code, /const __url_1 = `\$\{__coalesceVar\("baseUrl", __ENV\.BASE_URL\)\}\/health`/);
  assert.match(code, /http\.get\(\s*__url_0,/);
  assert.match(code, /http\.get\(\s*__url_1,/);

  // Standard tags emitted.
  assert.match(code, /"api_name": "List public users"/);
  assert.match(code, /"api_method": "GET"/);
  assert.match(code, /"api_path": "\/public\/users"/);
  assert.match(code, /"request_id": "req_01"/);
});

/* --------------------------------------------------------------------- */
/* Golden test: STATIC strategy                                          */
/* --------------------------------------------------------------------- */
test('golden(STATIC): {{jwt_token}} placeholders + apostrophe request name generate a valid script', () => {
  const { code, parsed } = generateFor(fixtureStatic());
  const check = parsesAsESM(code);
  assert.ok(check.ok, 'generated script must parse as ESM: ' + check.stderr);
  assertNoSecretsInScript(code);
  assertHasEverySectionBanner(code);

  assert.match(code, /const AUTH_STRATEGY = "STATIC";/);
  assert.match(code, /function __resolveAuthHeaderEnv\(fallback, placeholder\)/);
  assert.doesNotMatch(code, /export function setup\(\)/, 'STATIC strategy must not emit setup()');

  // Auth-header resolver routes every Authorization header, and the
  // AUTH_TOKEN fallback is threaded through the {{jwt_token}} placeholder.
  assert.match(code, /\.\.\.__authHeader\(__resolveAuthHeaderEnv\(`Bearer \$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''\)\}`, "jwt_token"\)\)/);
  // Custom auth header still gets the AUTH_TOKEN fallback via the interpolator.
  assert.match(code, /"X-Auth-Token":\s*`\$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''\)\}`/);

  // Request identity is stable via tags, NOT display names alone.
  assert.match(code, /"api_name": "Get User\\u2019s Carts"|"api_name": "Get User's Carts"/);
  assert.match(code, /"request_id": "req_01"/);
  assert.match(code, /"request_id": "req_02"/);
  assert.match(code, /"request_id": "req_03"/);
  assert.match(code, /"api_method": "POST"/);
  assert.match(code, /"api_path": "\/orders"/);

  // Order preserved: req_01 corresponds to the first fixture entry.
  const req1 = code.indexOf('"request_id": "req_01"');
  const req2 = code.indexOf('"request_id": "req_02"');
  const req3 = code.indexOf('"request_id": "req_03"');
  assert.ok(req1 < req2 && req2 < req3, 'request order must be preserved');

  // Apostrophe in "User's Carts" no longer breaks the console.warn line.
  const check2 = parsesAsESM(code);
  assert.ok(check2.ok, 'apostrophe-in-name must not corrupt the emitted script');

  assert.equal(parsed.requests.length, 3);
});

/* --------------------------------------------------------------------- */
/* Golden test: SETUP_LOGIN strategy                                     */
/* --------------------------------------------------------------------- */
test('golden(SETUP_LOGIN): login + protected requests emit setup() + resolver + preserved order', () => {
  const { code, parsed, flow } = generateFor(fixtureSetupLogin(), { withFlow: true });
  const check = parsesAsESM(code);
  assert.ok(check.ok, 'generated script must parse as ESM: ' + check.stderr);
  assertNoSecretsInScript(code);
  assertHasEverySectionBanner(code);

  assert.match(code, /const AUTH_STRATEGY = "SETUP_LOGIN";/);
  assert.match(code, /export function setup\(\)/);
  assert.match(code, /function __resolveAuthHeader\(data, fallback, placeholder\)/);
  assert.match(code, /if \(__ENV\.AUTH_TOKEN\) \{/);

  // Login request runs inside setup() — it must NOT also appear as an
  // iterated group in the default function. The two protected requests
  // must appear as req_1 / req_2 in order.
  assert.ok(flow.enabled, 'buildAuthFlow should detect the login request');
  const iteratedGroups = code.match(/group\(`([^`]+)`,/g) || [];
  assert.equal(iteratedGroups.length, 2, 'setup() consumes the login request');
  assert.match(code, /group\(`Get profile`,/);
  assert.match(code, /group\(`List items`,/);

  assert.match(code, /"request_id": "req_01"/);
  assert.match(code, /"request_id": "req_02"/);
  assert.match(code, /"api_path": "\/me"/);
  assert.match(code, /"api_path": "\/items"/); // query string dropped
  assert.equal(parsed.requests.length, 3);
});

/* --------------------------------------------------------------------- */
/* Structural invariants that hold across all strategies                 */
/* --------------------------------------------------------------------- */
test('every generated script imports the K6 core APIs and Counter, and declares PACING_MS', () => {
  for (const [label, fixture, opts] of [
    ['NONE', fixtureNone(), { injectAuthToken: false }],
    ['STATIC', fixtureStatic(), {}],
    ['SETUP_LOGIN', fixtureSetupLogin(), { withFlow: true }],
  ]) {
    const { code } = generateFor(fixture, opts);
    assert.match(code, /import http from 'k6\/http';/, label + ': http import');
    assert.match(code, /import \{ check, group, sleep \} from 'k6';/, label + ': k6 import');
    assert.match(code, /import \{ Counter \} from 'k6\/metrics';/, label + ': Counter import');
    assert.match(code, /const PACING_MS = /, label + ': PACING_MS declared');
    assert.match(code, /function __requestTimeout/, label + ': __requestTimeout resolver');
    assert.match(code, /DEFAULT_REQUEST_TIMEOUT = "120s"/, label + ': 120s default timeout');
    assert.match(code, /perf_transport_failed: \['count==0'\]/, label + ': transport threshold');
    assert.match(code, /perf_unexpected_status: \['count==0'\]/, label + ': unexpected status threshold');
    assert.match(code, /summaryTrendStats.*p\(99\)/, label + ': p99 in summaryTrendStats');
    assert.match(code, /new Counter\('perf_transport_failed'\)/, label + ': transport counter');
    assert.match(code, /new Counter\('perf_unexpected_status'\)/, label + ': status counter');
    assert.match(code, /__pace\(\);/, label + ': __pace() call');
    assert.match(code, /__classifyResponse\(res\)/, label + ': __classifyResponse call');
  }
});

test('every ITERATED http.<verb>() call has stable request tags on its params', () => {
  // The tag contract applies to the iteration loop (default function). The
  // one-time login call inside setup() is intentionally left untagged
  // because it isn't part of the per-iteration request set and is already
  // observable via the `[auth]` log lines. This is documented under
  // "Known unsupported Postman features" in the Phase 3 summary.
  for (const fixture of [fixtureNone(), fixtureStatic(), fixtureSetupLogin()]) {
    const { code } = generateFor(fixture, { withFlow: fixture.info.name.includes('setup') });
    const defaultFn = code.slice(code.indexOf('export default function'));
    const httpCalls = (defaultFn.match(/http\.(get|post|put|patch|del|options|head|request)\(/g) || []).length;
    const tagsRefs = (defaultFn.match(/tags: __tags_\d+/g) || []).length;
    assert.ok(httpCalls > 0, 'sanity: at least one iterated http call');
    assert.equal(
      tagsRefs,
      httpCalls,
      'each iterated http call must reference its tags variable (' + httpCalls + ' calls, ' + tagsRefs + ' tag refs)'
    );
    const expected = ['api_name', 'api_method', 'api_path', 'folder', 'request_id'];
    for (const k of expected) {
      assert.ok(
        new RegExp('"' + k + '":').test(defaultFn),
        'tag "' + k + '" missing in ' + fixture.info.name
      );
    }
  }
});

test('no generated script leaks a literal secret or a bare ${__ENV.X}', () => {
  for (const [fixture, opts] of [
    [fixtureNone(), { injectAuthToken: false }],
    [fixtureStatic(), {}],
    [fixtureSetupLogin(), { withFlow: true }],
  ]) {
    const { code } = generateFor(fixture, opts);
    assertNoSecretsInScript(code);
    // The interpolator must never emit a bare ${__ENV.X} (unwrapped),
    // which would render as the string "undefined" in K6.
    assert.doesNotMatch(
      code,
      /`\$\{__ENV\.[A-Z_]+\}`/,
      'bare ${__ENV.X} would render as "undefined" — must be wrapped in (X || \'\')'
    );
  }
});

/* --------------------------------------------------------------------- */
/* Pure helpers: buildRequestTags / extractApiPath / makeRequestId       */
/* --------------------------------------------------------------------- */
test('extractApiPath strips placeholder, protocol+host, query, and fragment', () => {
  assert.equal(extractApiPath('{{baseUrl}}/api/users?limit=5'), '/api/users');
  assert.equal(extractApiPath('https://api.example.com/api/users?limit=5'), '/api/users');
  assert.equal(extractApiPath('https://api.example.com/api/users#top'), '/api/users');
  assert.equal(extractApiPath('/relative/path'), '/relative/path');
  assert.equal(extractApiPath('no-leading-slash'), '/no-leading-slash');
  assert.equal(extractApiPath(''), '/');
  assert.equal(extractApiPath(null), '/');
});

test('makeRequestId pads by total-request width, preserving stable IDs', () => {
  assert.equal(makeRequestId(0, 5), 'req_01');
  assert.equal(makeRequestId(9, 100), 'req_010');
  assert.equal(makeRequestId(0, 1), 'req_01');
});

test('buildRequestTags emits every standard tag key', () => {
  const tags = buildRequestTags(
    { name: 'X', method: 'get', url: '{{baseUrl}}/a/b?x=1', folderPath: ['auth', 'v1'] },
    0,
    3
  );
  assert.deepEqual(tags, {
    api_name: 'X',
    api_method: 'GET',
    api_path: '/a/b',
    folder: 'auth/v1',
    request_id: 'req_01',
  });
});

test('deriveAuthStrategy picks the right strategy from the flow inputs', () => {
  assert.equal(deriveAuthStrategy({ runtimeEnabled: true }), AuthStrategy.SETUP_LOGIN);
  assert.equal(deriveAuthStrategy({ injectAuthToken: true }), AuthStrategy.STATIC);
  assert.equal(deriveAuthStrategy({ collectionHasAuthHeader: true }), AuthStrategy.STATIC);
  assert.equal(deriveAuthStrategy({}), AuthStrategy.NONE);
});

/* --------------------------------------------------------------------- */
/* Optional k6 validation: `k6 archive` if the binary is present         */
/* --------------------------------------------------------------------- */
test('k6 archive validates the generated script when k6 is on PATH', () => {
  const { code } = generateFor(fixtureSetupLogin(), { withFlow: true });
  const r = tryK6Archive(code);
  if (!r.available) {
    // Environment-dependent — do not fail the suite when k6 isn't installed.
    console.log('# skip: k6 binary not available on PATH');
    return;
  }
  assert.ok(
    r.ok,
    'k6 archive failed: ' + (r.message || '').split('\n').slice(0, 5).join(' | ')
  );
});

/* --------------------------------------------------------------------- */
/* Configurable pacing preserves historical sleep(1) equivalence         */
/* --------------------------------------------------------------------- */
test('PACING_MS default preserves the historical 1000ms sleep behaviour', () => {
  const { code } = generateFor(fixtureNone(), { injectAuthToken: false });
  // The __pace() helper reads PACING_MS from __ENV with a 1000 default.
  assert.match(code, /if \(raw == null \|\| String\(raw\)\.trim\(\) === ''\) return 1000;/);
  assert.match(code, /if \(PACING_MS > 0\) sleep\(PACING_MS \/ 1000\);/);
});

test('PACING_MS supports both the compatibility default and zero override', () => {
  const { code } = generateFor(fixtureNone(), { injectAuthToken: false });
  assert.match(code, /if \(raw == null \|\| String\(raw\)\.trim\(\) === ''\) return 1000;/);
  assert.match(code, /return Number\.isFinite\(n\) && n >= 0 \? n : 1000;/);
  assert.match(code, /Pacing \(embedded per-request via __pace\(\); PACING_MS default 1000\)/);
});

test('login credential literals are replaced by runtime environment references', () => {
  const loginCollection = {
    info: { name: 'credential safety', schema: 'v2.1' },
    item: [{
      name: 'Login',
      request: {
        method: 'POST',
        url: { raw: 'https://example.test/login' },
        header: [],
        body: { mode: 'raw', raw: '{"username":"known-audit-user","password":"known-audit-password"}' },
      },
    }],
  };
  const loginParsed = parse(loginCollection);
  const code = generateK6Script(loginParsed, { authFlow: buildAuthFlow(loginParsed) });
  assert.doesNotMatch(code, /known-audit-user|known-audit-password/);
  assert.match(code, /__ENV\.LOGIN_USERNAME/);
  assert.match(code, /__ENV\.LOGIN_PASSWORD/);
});

/* --------------------------------------------------------------------- */
/* Custom summary hook is opt-in                                         */
/* --------------------------------------------------------------------- */
test('handleSummary is now emitted UNCONDITIONALLY as a mandatory sanitizer (Phase 6.6)', () => {
  const parsed = sanitizeParsedCollection(parse(fixtureNone())).parsed;
  const off = generateK6Script(parsed, { injectAuthToken: false });
  const on = generateK6Script(parsed, { injectAuthToken: false, customSummary: true });
  // Every generated script gets a handleSummary — that's the Phase 6.6
  // contract that keeps setup_data off disk.
  assert.match(off, /export function handleSummary\(data\) \{/);
  assert.match(on, /export function handleSummary\(data\) \{/);
  assert.match(off, /delete clean\.setup_data;/);
  assert.match(on, /delete clean\.setup_data;/);
  assert.match(off, /__ENV\.PA_CLEAN_SUMMARY_PATH/);
  assert.match(on, /__ENV\.PA_CLEAN_SUMMARY_PATH/);
  // The customSummary flag now toggles an OPTIONAL stdout line INSIDE the
  // handleSummary hook, not the hook's existence.
  assert.doesNotMatch(off, /\[custom-summary\]/);
  assert.match(on, /\[custom-summary\]/);
});
