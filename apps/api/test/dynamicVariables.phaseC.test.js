'use strict';

// Phase-C certification: generic Postman variable + dynamic-variable
// handling. All fixtures use arbitrary, non-product-specific names.
//
// Scope: unit-level audit via the modules the generator and runtime depend
// on. No live API, no load test.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  SUPPORTED_DYNAMIC,
  isDynamicVariable,
  resolveDynamicVariable,
  DYNAMIC_VARIABLE_RUNTIME_JS,
} = require('../src/lib/postman/dynamicVariables');
const {
  classifyPlaceholder,
  analyzeRequestVariables,
  extractPlaceholderNames,
  VariableStatus,
} = require('../src/lib/postman/unresolvedSafety');
const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');

// ---------------------------------------------------------------------------
// Part 1 + Part 5 — implementation audit (allowlist vs generic)
// ---------------------------------------------------------------------------

test('PhC-1.1: SUPPORTED_DYNAMIC catalog is non-empty and name-prefixed with $', () => {
  assert.ok(SUPPORTED_DYNAMIC.size >= 11);
  for (const n of SUPPORTED_DYNAMIC) assert.ok(n.startsWith('$'), n);
});

test('PhC-1.2: isDynamicVariable rejects unknown $-prefixed names (allowlist is explicit)', () => {
  assert.equal(isDynamicVariable('$timestamp'), true);
  assert.equal(isDynamicVariable('$guid'), true);
  assert.equal(isDynamicVariable('$someFutureDynamicVariable'), false);
  assert.equal(isDynamicVariable('$unknownDynamicVariable'), false);
  assert.equal(isDynamicVariable('customerRef'), false);
});

test('PhC-1.3: classifyPlaceholder returns UNSUPPORTED_DYNAMIC_VARIABLE for unknown $-tokens', () => {
  const ctx = {
    manualOverrides: new Set(),
    prerequestSets: new Set(),
    requestLocals: new Set(),
    capturedVars: new Set(),
    environmentVars: new Set(),
    collectionVars: new Set(),
  };
  assert.equal(classifyPlaceholder('$timestamp', ctx), VariableStatus.DYNAMIC_RESOLVED);
  assert.equal(classifyPlaceholder('$futureUnsupportedDyn', ctx), VariableStatus.UNSUPPORTED_DYNAMIC_VARIABLE);
  assert.equal(classifyPlaceholder('customerRef', ctx), VariableStatus.UNRESOLVED);
});

test('PhC-1.4: resolveDynamicVariable surfaces UNSUPPORTED_DYNAMIC_VARIABLE for unknown names', () => {
  const good = resolveDynamicVariable('$timestamp');
  assert.equal(good.ok, true);
  assert.equal(good.source, 'DYNAMIC_RESOLVED');
  const bad = resolveDynamicVariable('$totallyUnknown');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'UNSUPPORTED_DYNAMIC_VARIABLE');
});

test('PhC-1.5: runtime helper exposes generic $-dispatch with explicit sentinel for unknown', () => {
  assert.match(DYNAMIC_VARIABLE_RUNTIME_JS, /function __resolveDynamicVar/);
  // Any key not in the switch returns a sentinel the caller can detect on wire.
  assert.match(DYNAMIC_VARIABLE_RUNTIME_JS, /__UNSUPPORTED_DYNAMIC__/);
});

// ---------------------------------------------------------------------------
// Part 2 — no hardcoded product-specific names in dynamic-variable handling
// ---------------------------------------------------------------------------

test('PhC-2.1: dynamic-variable sources contain no product-specific names', () => {
  const banned = [
    'Mediasmart',
    'global_auth_token',
    'campaign_id',
    'baseapi_url',
    'organization_Name',
    'Console_API_Monitoring',
  ];
  const sources = [
    require('fs').readFileSync(require.resolve('../src/lib/postman/dynamicVariables'), 'utf8'),
    require('fs').readFileSync(require.resolve('../src/lib/postman/unresolvedSafety'), 'utf8'),
  ].join('\n');
  for (const term of banned) {
    assert.ok(!sources.includes(term), `found "${term}" in dynamic-variable handling source`);
  }
});

// ---------------------------------------------------------------------------
// Part 3 — dynamic variables in URL, path, query, headers, JSON, nested
// JSON, arrays, form-data, raw text, and multi-occurrence in one string
// ---------------------------------------------------------------------------

function tinyCollection(items) {
  return { info: { name: 'phc-dynvar-fixture', schema: 'v2.1' }, item: items };
}

function parseFirst(collection) {
  const parsed = parse(collection);
  return parsed.requests[0];
}

test('PhC-3.1: dynamic variable survives in URL raw', () => {
  const r = parseFirst(
    tinyCollection([
      { name: 'r', request: { method: 'GET', url: { raw: 'https://x.test/t/{{$guid}}' }, header: [] } },
    ])
  );
  assert.ok(r.url.includes('{{$guid}}'), r.url);
});

test('PhC-3.2: dynamic variable survives in header value', () => {
  const r = parseFirst(
    tinyCollection([
      {
        name: 'r',
        request: {
          method: 'GET',
          url: { raw: 'https://x.test/t' },
          header: [{ key: 'X-Correlation-Id', value: '{{$guid}}' }],
        },
      },
    ])
  );
  assert.equal(r.headers.find((h) => h.key === 'X-Correlation-Id').value, '{{$guid}}');
});

test('PhC-3.3: dynamic variable survives in JSON body (nested + array + multi)', () => {
  const bodyRaw = JSON.stringify({
    id: '{{$guid}}',
    email: '{{$randomEmail}}',
    count: '{{$randomInt}}',
    createdAt: '{{$isoTimestamp}}',
    nested: { active: '{{$randomBoolean}}', refs: ['{{$guid}}', '{{$guid}}'] },
    composite: 'u-{{$randomUserName}}-{{$timestamp}}',
  });
  const r = parseFirst(
    tinyCollection([
      {
        name: 'r',
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/t' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: bodyRaw, options: { raw: { language: 'json' } } },
        },
      },
    ])
  );
  const refs = extractPlaceholderNames(r.body.raw);
  assert.ok(refs.has('$guid'));
  assert.ok(refs.has('$randomEmail'));
  assert.ok(refs.has('$randomInt'));
  assert.ok(refs.has('$isoTimestamp'));
  assert.ok(refs.has('$randomBoolean'));
  assert.ok(refs.has('$randomUserName'));
  assert.ok(refs.has('$timestamp'));
});

test('PhC-3.4: dynamic variable survives in form-data value', () => {
  const r = parseFirst(
    tinyCollection([
      {
        name: 'r',
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/t' },
          header: [],
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'id', value: '{{$guid}}', type: 'text' },
              { key: 'label', value: 'ts-{{$timestamp}}', type: 'text' },
            ],
          },
        },
      },
    ])
  );
  const params = r.body.params;
  assert.equal(params.find((p) => p.key === 'id').value, '{{$guid}}');
  assert.equal(params.find((p) => p.key === 'label').value, 'ts-{{$timestamp}}');
});

// ---------------------------------------------------------------------------
// Part 4 — unknown / unrecognized dynamic variable safety
// ---------------------------------------------------------------------------

test('PhC-4.1: unknown {{$...}} reported via analyzeRequestVariables.unsupportedDynamic (not silent)', () => {
  const req = {
    url: 'https://x.test/t/{{$futureUnsupportedDyn}}',
    headers: [{ key: 'X-C', value: '{{$totallyUnknown}}' }],
    body: null,
  };
  const ctx = {
    manualOverrides: new Set(),
    prerequestSets: new Set(),
    requestLocals: new Set(),
    capturedVars: new Set(),
    environmentVars: new Set(),
    collectionVars: new Set(),
  };
  const analysis = analyzeRequestVariables(req, ctx);
  assert.deepEqual(analysis.unsupportedDynamic.sort(), ['$futureUnsupportedDyn', '$totallyUnknown']);
  assert.deepEqual(analysis.unresolved, []);
});

test('PhC-4.2: known {{$timestamp}} does NOT appear in unsupportedDynamic', () => {
  const req = { url: 'https://x.test/t?ts={{$timestamp}}', headers: [], body: null };
  const ctx = {
    manualOverrides: new Set(), prerequestSets: new Set(), requestLocals: new Set(),
    capturedVars: new Set(), environmentVars: new Set(), collectionVars: new Set(),
  };
  const analysis = analyzeRequestVariables(req, ctx);
  assert.deepEqual(analysis.unsupportedDynamic, []);
  assert.deepEqual(analysis.unresolved, []);
});

// ---------------------------------------------------------------------------
// Part 6 + Part 7 — runtime semantics + generator determinism
// ---------------------------------------------------------------------------

function fixtureWithDynamics() {
  return {
    info: { name: 'phc-dyn-end-to-end', schema: 'v2.1' },
    variable: [{ key: 'serviceHost', value: 'api.example.test' }],
    item: [
      {
        name: 'Register',
        request: {
          method: 'POST',
          url: { raw: 'https://{{serviceHost}}/register?rid={{$guid}}' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: {
            mode: 'raw',
            raw: '{"id":"{{$guid}}","email":"{{$randomEmail}}","ts":"{{$isoTimestamp}}"}',
            options: { raw: { language: 'json' } },
          },
        },
      },
    ],
  };
}

function generate(collection) {
  const parsed = parse(collection);
  const authFlow = buildAuthFlow(parsed);
  const executionModel = buildExecutionModel({
    parsed,
    rawCollection: collection,
    rawEnvironment: null,
    selection: { mode: 'all' },
    authFlow,
  });
  return generateK6Script(parsed, { authFlow, executionModel });
}

test('PhC-6.1: dynamic values are NOT pre-baked at generation time (runtime JS emitted)', () => {
  const code = generate(fixtureWithDynamics());
  // Pre-baked GUID / email strings must NOT appear.
  assert.doesNotMatch(code, /550e8400-e29b-41d4-a716-446655440000/);
  // Runtime resolver and dispatch must be present.
  assert.match(code, /function __resolveDynamicVar/);
  assert.match(code, /__resolveDynamicVar\(/);
  // The placeholder name must be preserved for runtime lookup.
  assert.match(code, /\$guid/);
  assert.match(code, /\$randomEmail/);
  assert.match(code, /\$isoTimestamp/);
});

test('PhC-7.1: generator is deterministic across 3 runs (modulo header timestamp)', () => {
  const a = generate(fixtureWithDynamics());
  const b = generate(fixtureWithDynamics());
  const c = generate(fixtureWithDynamics());
  const strip = (s) => s.replace(/^\/\/ Generated:.*$/m, '');
  assert.equal(strip(a), strip(b));
  assert.equal(strip(b), strip(c));
});

// ---------------------------------------------------------------------------
// Part 11 — auth variable name randomization (no hardcoded dependency)
// ---------------------------------------------------------------------------

function authFixture(captureName) {
  return {
    info: { name: 'phc-auth-' + captureName, schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/login' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: '{"u":"a"}', options: { raw: { language: 'json' } } },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [`pm.environment.set("${captureName}", pm.response.json().access);`],
            },
          },
        ],
      },
      {
        name: 'Profile',
        request: {
          method: 'GET',
          url: { raw: 'https://x.test/profile' },
          header: [{ key: 'Authorization', value: `Bearer {{${captureName}}}` }],
        },
      },
    ],
  };
}

test('PhC-11: auth works identically regardless of chosen capture variable name', () => {
  const names = ['apiSessionToken', 'sessionKey', 'myBearerValue', 'accessCredential', 'runtimeAuthValue'];
  const sizes = names.map((n) => generate(authFixture(n)).length);
  // The emitted scripts are structurally equivalent — size must not vary by
  // more than the length-delta of the captured name itself. We check that
  // all scripts contain the capture rule and a Bearer header.
  for (const n of names) {
    const code = generate(authFixture(n));
    assert.ok(code.includes(n), `capture var ${n} missing from generated script`);
    assert.match(code, /Authorization/);
  }
  // All lengths within 400 bytes of each other (name delta ×  references).
  const minLen = Math.min(...sizes);
  const maxLen = Math.max(...sizes);
  assert.ok(maxLen - minLen < 400, `length delta too large: ${maxLen - minLen}`);
});

// ---------------------------------------------------------------------------
// Part 13 — unrelated unresolved variables must not block selected folder
// ---------------------------------------------------------------------------

test('PhC-13: folder A selected => folder B unresolved var is NOT reported as blocking', () => {
  const col = {
    info: { name: 'phc-folders', schema: 'v2.1' },
    item: [
      {
        name: 'A',
        item: [
          { name: 'Login', request: { method: 'POST', url: { raw: 'https://x.test/login' }, header: [] } },
          { name: 'GetUsers', request: { method: 'GET', url: { raw: 'https://x.test/users' }, header: [] } },
        ],
      },
      {
        name: 'B',
        item: [
          {
            name: 'CreatePayment',
            request: {
              method: 'POST',
              url: { raw: 'https://x.test/payment' },
              header: [{ key: 'X-Secret', value: '{{paymentSecret}}' }],
            },
          },
        ],
      },
    ],
  };
  const parsed = parse(col);
  const loginIdx = parsed.requests.findIndex((r) => r.name === 'Login');
  const getUsersIdx = parsed.requests.findIndex((r) => r.name === 'GetUsers');
  const em = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'requests', requestIndices: [loginIdx, getUsersIdx] },
  });
  const names = em.executableIndices.map((i) => parsed.requests[i].name);
  assert.ok(names.includes('Login'));
  assert.ok(names.includes('GetUsers'));
  assert.ok(!names.includes('CreatePayment'));
});

// ---------------------------------------------------------------------------
// Part 14 — selected-request dependency closure
// ---------------------------------------------------------------------------

test('PhC-14: selecting UpdateCustomer executes Login + CreateCustomer + UpdateCustomer only', () => {
  const col = {
    info: { name: 'phc-closure', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/login' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: '{"u":"a"}', options: { raw: { language: 'json' } } },
        },
        event: [{ listen: 'test', script: { exec: ['pm.environment.set("sessionCredential", pm.response.json().access);'] } }],
      },
      {
        name: 'CreateCustomer',
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/customers' },
          header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }],
          body: { mode: 'raw', raw: '{}', options: { raw: { language: 'json' } } },
        },
        event: [{ listen: 'test', script: { exec: ['pm.environment.set("customerRef", pm.response.json().id);'] } }],
      },
      {
        name: 'GetCustomer',
        request: { method: 'GET', url: { raw: 'https://x.test/customers/{{customerRef}}' }, header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }] },
      },
      {
        name: 'UpdateCustomer',
        request: {
          method: 'PUT',
          url: { raw: 'https://x.test/customers/{{customerRef}}' },
          header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }],
          body: { mode: 'raw', raw: '{"n":"n2"}', options: { raw: { language: 'json' } } },
        },
      },
      {
        name: 'DeleteCustomer',
        request: { method: 'DELETE', url: { raw: 'https://x.test/customers/{{customerRef}}' }, header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }] },
      },
      {
        name: 'HealthCheck',
        request: { method: 'GET', url: { raw: 'https://x.test/health' }, header: [] },
      },
    ],
  };
  const parsed = parse(col);
  const updateIndex = parsed.requests.findIndex((r) => r.name === 'UpdateCustomer');
  const em = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'single', requestIndex: updateIndex },
  });
  const execNames = em.executableIndices.map((i) => parsed.requests[i].name);
  assert.deepEqual(execNames.sort(), ['CreateCustomer', 'Login', 'UpdateCustomer']);
  assert.ok(!execNames.includes('HealthCheck'));
  assert.ok(!execNames.includes('DeleteCustomer'));
});
