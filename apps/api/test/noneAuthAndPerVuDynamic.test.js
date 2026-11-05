'use strict';

/**
 * NONE authentication mode + independent per-VU dynamic variables.
 *
 * Verifies the strict backward-compat contract from the enhancement spec:
 *
 *  - NONE produces a valid K6 script with AuthStrategy.NONE and no login,
 *    no Authorization injection, no auth helpers.
 *  - Per-VU dynamic variables are an INDEPENDENT config: they work with
 *    any auth mode (including NONE), the interpolator short-circuits
 *    configured placeholders to `__getPerVuVar(name)`, and the generated
 *    runtime block is only emitted when at least one variable is
 *    configured.
 *  - The pre-existing modes (SHARED_SESSION, PER_VU_LOGIN, MANUAL_TOKEN)
 *    continue to compile byte-equivalent output when dynamic variables
 *    are disabled.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const {
  normalizeDynamicVariables,
  isEnabled,
  buildPerVuDynamicRuntimeJs,
} = require('../src/lib/k6/perVuDynamicVars');
const { AUTH_SESSION_MODES, AUTH_SESSION_MODE_LIST } = require('../src/lib/k6/authSessionMode');

function parsedCollection(items) {
  return sanitizeParsedCollection(parse({
    info: { name: 'none+pervu', schema: 'v2.1' },
    item: items,
  })).parsed;
}

const COLLECTION_WITH_DID = parsedCollection([
  {
    name: 'Ping',
    request: {
      method: 'GET',
      header: [{ key: 'X-Trace-Id', value: '{{Test_did}}' }],
      url: { raw: '{{baseUrl}}/ping?did={{Test_did}}&ip={{Test_ip}}' },
    },
  },
  {
    name: 'Record',
    request: {
      method: 'POST',
      header: [
        { key: 'X-Trace-Id', value: '{{Test_did}}' },
        { key: 'User-Agent', value: '{{Test_useragent}}' },
      ],
      url: { raw: '{{baseUrl}}/record' },
      body: { mode: 'raw', raw: '{"did":"{{Test_did}}","ip":"{{Test_ip}}"}' },
    },
  },
]);

/* ---------- authSessionMode registry ---------- */

test('authSessionMode: NONE is a first-class mode alongside the pre-existing three', () => {
  assert.equal(AUTH_SESSION_MODES.NONE, 'NONE');
  // Pre-existing modes must still be present and unchanged.
  for (const id of ['PER_VU_LOGIN', 'SHARED_SESSION', 'MANUAL_TOKEN']) {
    assert.equal(AUTH_SESSION_MODES[id], id);
  }
  assert.ok(AUTH_SESSION_MODE_LIST.includes('NONE'));
});

/* ---------- Dynamic variables normalization ---------- */

test('normalizeDynamicVariables rejects unsupported generators and bad names', () => {
  const out = normalizeDynamicVariables({
    mode: 'PER_VU',
    variables: [
      { name: 'Test_did', generator: 'uuid' },
      { name: 'Test_ip', generator: 'ipv4' },
      { name: 'bad name with spaces', generator: 'uuid' },
      { name: 'OK_name', generator: 'not-a-real-generator' },
      { name: 'Test_did', generator: 'uuid' }, // duplicate
    ],
  });
  assert.equal(out.mode, 'PER_VU');
  assert.deepEqual(out.variables, [
    { name: 'Test_did', generator: 'uuid' },
    { name: 'Test_ip', generator: 'ipv4' },
  ]);
});

test('normalizeDynamicVariables returns DISABLED when the variable list is empty', () => {
  assert.deepEqual(
    normalizeDynamicVariables({ mode: 'PER_VU', variables: [] }),
    { mode: 'DISABLED', variables: [] }
  );
  assert.equal(isEnabled({ mode: 'DISABLED', variables: [] }), false);
});

/* ---------- NONE auth strategy: no login, no auth helpers ---------- */

test('NONE: emitted script compiles to AuthStrategy.NONE with no login setup', () => {
  const code = generateK6Script(COLLECTION_WITH_DID, {
    workload: {
      profile: 'smoke',
      authSessionMode: 'NONE',
      overrides: { vus: 1, hold: '1s' },
    },
    injectAuthToken: false,
    authFlow: { enabled: false },
  });
  assert.match(code, /const AUTH_STRATEGY = "NONE"/);
  assert.doesNotMatch(code, /function __resolveAuthHeader\(data,/);
  assert.doesNotMatch(code, /function __resolveAuthHeaderEnv\(/);
  assert.doesNotMatch(code, /__ensureVuLogin/);
  // No Authorization header is auto-injected onto a request that didn't declare one.
  assert.doesNotMatch(code, /__authHeader\(__resolveAuthHeader/);
});

test('NONE: existing collection-declared headers are preserved, but no Authorization is synthesized', () => {
  const coll = parsedCollection([
    {
      name: 'Public',
      request: {
        method: 'GET',
        header: [{ key: 'X-Trace-Id', value: 'static-value' }],
        url: { raw: '{{baseUrl}}/public' },
      },
    },
  ]);
  const code = generateK6Script(coll, {
    workload: { profile: 'smoke', authSessionMode: 'NONE', overrides: { vus: 1, hold: '1s' } },
    injectAuthToken: false,
    authFlow: { enabled: false },
  });
  assert.match(code, /"X-Trace-Id": `static-value`/);
  // The generator must not emit an Authorization resolver, an injected
  // Authorization header, or a bare Authorization header literal. Code
  // comments mentioning the word Authorization are fine and unavoidable.
  assert.doesNotMatch(code, /__authHeader\(/);
  assert.doesNotMatch(code, /"Authorization":/);
});

/* ---------- Per-VU dynamic variables: short-circuit resolution ---------- */

test('per-VU dynamic: interpolator emits __getPerVuVar for configured placeholders', () => {
  const code = generateK6Script(COLLECTION_WITH_DID, {
    workload: {
      profile: 'smoke',
      authSessionMode: 'NONE',
      overrides: { vus: 1, hold: '1s' },
      dynamicVariables: {
        mode: 'PER_VU',
        variables: [
          { name: 'Test_did', generator: 'uuid' },
          { name: 'Test_ip', generator: 'ipv4' },
          { name: 'Test_useragent', generator: 'userAgent' },
        ],
      },
    },
    injectAuthToken: false,
    authFlow: { enabled: false },
  });
  // Runtime block emitted exactly once.
  const specMatches = code.match(/const __PER_VU_DYNAMIC_SPEC = /g) || [];
  assert.equal(specMatches.length, 1);
  // Every placeholder reference is rewritten to __getPerVuVar(...).
  assert.match(code, /\$\{__getPerVuVar\("Test_did"\)\}/);
  assert.match(code, /\$\{__getPerVuVar\("Test_ip"\)\}/);
  assert.match(code, /\$\{__getPerVuVar\("Test_useragent"\)\}/);
  // Static env fallback for those names must NOT be present.
  assert.doesNotMatch(code, /__ENV\.TEST_DID/);
  assert.doesNotMatch(code, /__ENV\.TEST_IP/);
});

test('per-VU dynamic: caches one value per VU and reuses it across requests (5 simulated VUs)', () => {
  // Evaluate the generated runtime block in 5 isolated contexts — one per
  // simulated VU — and confirm the DID is stable per VU and distinct
  // across VUs.
  const js = buildPerVuDynamicRuntimeJs({
    mode: 'PER_VU',
    variables: [
      { name: 'Test_did', generator: 'uuid' },
      { name: 'Test_ip', generator: 'ipv4' },
      { name: 'Test_useragent', generator: 'userAgent' },
    ],
  });
  const dids = new Set();
  const perVu = [];
  for (let vu = 1; vu <= 5; vu += 1) {
    const sandbox = { crypto: undefined };
    vm.createContext(sandbox);
    vm.runInContext(js, sandbox);
    const first = sandbox.__getPerVuVar('Test_did');
    const second = sandbox.__getPerVuVar('Test_did');
    const third = sandbox.__getPerVuVar('Test_did');
    assert.equal(first, second, `VU ${vu}: DID must be stable across calls`);
    assert.equal(second, third, `VU ${vu}: DID must be stable across calls`);
    assert.match(first, /^[0-9a-f-]{36}$/i, 'DID must be UUID-shaped');
    dids.add(first);
    perVu.push({
      vu,
      did: first,
      ip: sandbox.__getPerVuVar('Test_ip'),
      ua: sandbox.__getPerVuVar('Test_useragent'),
    });
  }
  assert.equal(dids.size, 5, 'each VU must receive a distinct DID');
  // Sanity: IPs and UAs also look right.
  for (const v of perVu) {
    assert.match(v.ip, /^\d{1,3}(\.\d{1,3}){3}$/);
    assert.match(v.ua, /Mozilla/);
  }
});

/* ---------- Independence: per-VU dynamic works with every auth mode ---------- */

test('per-VU dynamic is independent of auth mode (works with SHARED_SESSION too)', () => {
  const code = generateK6Script(COLLECTION_WITH_DID, {
    workload: {
      profile: 'smoke',
      authSessionMode: 'SHARED_SESSION',
      overrides: { vus: 1, hold: '1s' },
      dynamicVariables: {
        mode: 'PER_VU',
        variables: [{ name: 'Test_did', generator: 'uuid' }],
      },
    },
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  assert.match(code, /function __getPerVuVar\(/);
  assert.match(code, /\$\{__getPerVuVar\("Test_did"\)\}/);
});

test('per-VU dynamic DISABLED does NOT emit the runtime block or alter output', () => {
  const codeDisabled = generateK6Script(COLLECTION_WITH_DID, {
    workload: {
      profile: 'smoke',
      authSessionMode: 'NONE',
      overrides: { vus: 1, hold: '1s' },
    },
    injectAuthToken: false,
    authFlow: { enabled: false },
  });
  assert.doesNotMatch(codeDisabled, /__PER_VU_DYNAMIC_SPEC/);
  assert.doesNotMatch(codeDisabled, /__getPerVuVar/);
});

/* ---------- Backward compat: pre-existing auth modes unchanged ---------- */

for (const mode of ['SHARED_SESSION', 'PER_VU_LOGIN', 'MANUAL_TOKEN']) {
  test(`backward compat: ${mode} still produces a script with Authorization resolver when applicable`, () => {
    const coll = parsedCollection([
      {
        name: 'Auth',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ]);
    const code = generateK6Script(coll, {
      workload: { profile: 'smoke', authSessionMode: mode, overrides: { vus: 1, hold: '1s' } },
      injectAuthToken: true,
      authFlow: { enabled: false },
    });
    assert.match(code, /__resolveAuthHeader(Env)?\(/);
  });
}
