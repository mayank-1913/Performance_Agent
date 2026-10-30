'use strict';

/**
 * Phase D.3.1 — focused regression for the two generator defects proven by
 * the Phase D.3 Postman-vs-K6 wire-level comparison.
 *
 *   D3-1 — JSON body backtick escaping.
 *     Raw collection JSON strings may contain two-char JSON escapes such as
 *     \r / \n / \t that, when embedded verbatim inside a JS template literal,
 *     evaluate to the corresponding control char and break JSON on the wire.
 *     Fix must preserve the ORIGINAL JSON SEMANTIC VALUE while producing a
 *     wire body that JSON.parse accepts.
 *
 *   D3-2 — Pre-request mutation precedence vs env backfill.
 *     The resolver backfills the Postman environment file's static values
 *     into __ENV at run start. For variables mutated by a pre-request
 *     script (pm.environment.set), the mutation must win over the
 *     backfilled env value, matching Postman's own semantics. User-typed
 *     manual overrides still beat pm mutations because they are NOT in
 *     the backfill marker set.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');

/**
 * Evaluate the generated template-literal expression for a specific
 * `const __body_<n> = \`...\`;` block in the script, using a minimal
 * runtime shim so we see the exact bytes K6 would send on the wire.
 */
function evalBodyLiteral(scriptSrc, bodyIndex, env = {}, pmVars = {}) {
  const re = new RegExp(
    'const __body_' + bodyIndex + ' = `([\\s\\S]*?)`;',
    'm'
  );
  const m = scriptSrc.match(re);
  if (!m) throw new Error('body ' + bodyIndex + ' not found in generated script');
  const literal = m[1];
  const data = {
    AUTH_TOKEN: '', ACCESS_TOKEN: '', JWT: '', ID_TOKEN: '',
    vars: {}, pm: { environment: pmVars, collectionVariables: {}, variables: {} },
  };
  // minimal shims matching the runtime helpers used in placeholders
  const __ENV = env;
  const __PA_BACKFILLED_ENV_KEYS = new Set(
    String(env.PA_BACKFILLED_ENV_KEYS || '').split(',').filter(Boolean)
  );
  const __coalesceVar = (n, v) => (v == null || v === '' || v === 'undefined' || v === 'null')
    ? '__UNRESOLVED__' + n : v;
  const __expandNestedVars = (_n, v) => (v == null ? '' : String(v));
  const __envOrPmSet = (envKey, pmValue) => {
    const envV = __ENV[envKey];
    const envHas = typeof envV === 'string' && envV.length > 0;
    const pmHas = pmValue != null && String(pmValue).length > 0;
    if (pmHas) {
      if (!envHas) return pmValue;
      if (__PA_BACKFILLED_ENV_KEYS.has(envKey)) return pmValue;
      return envV;
    }
    return envHas ? envV : '';
  };
  const __getPmVar = (state, scope, key) =>
    (state && state.pm && state.pm[scope] && state.pm[scope][key] != null)
      ? String(state.pm[scope][key]) : '';
  const __pmGet = __getPmVar;
  const __getRequestLocal = () => '';
  const __getCompiledVar = () => '';
  const __resolveDynamicVar = () => '';
  const __resolveJsonLiteral = (_n, v) => v;
  // eslint-disable-next-line no-new-func
  const fn = new Function(
    'data', '__ENV', '__PA_BACKFILLED_ENV_KEYS', '__coalesceVar', '__expandNestedVars',
    '__envOrPmSet', '__getPmVar', '__pmGet', '__getRequestLocal', '__getCompiledVar',
    '__resolveDynamicVar', '__resolveJsonLiteral',
    'return `' + literal + '`;'
  );
  return fn(
    data, __ENV, __PA_BACKFILLED_ENV_KEYS, __coalesceVar, __expandNestedVars,
    __envOrPmSet, __getPmVar, __pmGet, __getRequestLocal, __getCompiledVar,
    __resolveDynamicVar, __resolveJsonLiteral
  );
}

function makeCollection({ bodyRaw, prerequestExec = null, extraVars = [] }) {
  return {
    info: { name: 'd31-fixture', schema: 'v2.1' },
    variable: extraVars,
    item: [
      {
        name: 'TargetReq',
        event: prerequestExec
          ? [{ listen: 'prerequest', script: { exec: Array.isArray(prerequestExec) ? prerequestExec : [prerequestExec] } }]
          : [],
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/thing' },
          header: [],
          body: { mode: 'raw', raw: bodyRaw, options: { raw: { language: 'json' } } },
        },
      },
    ],
  };
}

function generate(col, extra = {}) {
  const parsed = parse(col);
  const authFlow = buildAuthFlow(parsed);
  return generateK6Script(parsed, {
    authFlow,
    injectAuthToken: false,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// D3-1 — JSON body backtick escaping
// ---------------------------------------------------------------------------
test('D3-1: JSON body containing \\r survives template-literal evaluation as valid JSON (regression for addPublisherList 400)', () => {
  // mirrors the exact failing-shape input from the Phase D.3 wire capture
  const col = makeCollection({
    bodyRaw: JSON.stringify({
      name: 'Test publisher',
      publishers: ['publisher,publisherkeyword,creativeformat,Bid offers\r', ''],
    }),
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0);

  // Must parse as valid JSON — this is the exact assertion the Mediasmart
  // API performs server-side.
  const parsed = JSON.parse(wireBody);

  // Semantic value must be preserved: the JSON string field must still
  // contain the original CR control character.
  assert.equal(parsed.name, 'Test publisher');
  assert.deepEqual(parsed.publishers, [
    'publisher,publisherkeyword,creativeformat,Bid offers\r',
    '',
  ]);

  // The wire body must NOT contain a raw CR byte inside the JSON string;
  // the CR must be present only as the two-char JSON escape sequence.
  // (If the fix regresses, this assertion catches it before the server does.)
  // Find the CR control byte in the body — it should NOT be between quotes
  // in a JSON string position.
  const rawCrIdx = wireBody.indexOf('\r');
  assert.equal(
    rawCrIdx,
    -1,
    'wire body must not contain raw CR control byte; found at index ' + rawCrIdx
  );
});

test('D3-1: control chars \\n and \\t are JSON-safe on wire', () => {
  const col = makeCollection({
    bodyRaw: JSON.stringify({ line: 'a\nb\tc' }),
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0);
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.line, 'a\nb\tc');
  assert.equal(wireBody.indexOf('\n'), -1, 'raw LF must not appear on wire');
  assert.equal(wireBody.indexOf('\t'), -1, 'raw TAB must not appear on wire');
});

test('D3-1: backslash in JSON string is preserved end-to-end', () => {
  const col = makeCollection({
    bodyRaw: JSON.stringify({ path: 'C:\\Users\\test\\file.txt' }),
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0);
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.path, 'C:\\Users\\test\\file.txt');
});

test('D3-1: backtick character in a JSON string value does not break the K6 template literal', () => {
  const col = makeCollection({
    bodyRaw: JSON.stringify({ note: 'use `backticks` inline' }),
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0);
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.note, 'use `backticks` inline');
});

test('D3-1: ${...} template-literal substitution sequence inside a JSON string is preserved literally', () => {
  const col = makeCollection({
    bodyRaw: JSON.stringify({ expr: 'placeholder ${not_a_var} example' }),
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0);
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.expr, 'placeholder ${not_a_var} example');
});

test('D3-1: existing placeholder substitution for simple {{var}} still works', () => {
  // sanity — the fix must not break the ordinary templating path
  const col = makeCollection({
    bodyRaw: '{"id":"{{the_id}}"}',
    extraVars: [{ key: 'the_id', value: 'abc-123' }],
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(script, 0, { THE_ID: 'abc-123' });
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.id, 'abc-123');
});

// ---------------------------------------------------------------------------
// D3-2 — Pre-request mutation precedence vs env backfill
// ---------------------------------------------------------------------------
test('D3-2: pre-request pm.environment.set wins over backfilled env value (regression for ToCreateNewOrganization 400)', () => {
  const col = makeCollection({
    bodyRaw: '{"name":"{{organization_Name}}"}',
    prerequestExec: 'pm.environment.set("organization_Name", "Test Org 73697");',
    extraVars: [{ key: 'organization_Name', value: 'Static Static Static' }],
  });
  const script = generate(col);
  // The run.controller advertises backfilled keys via PA_BACKFILLED_ENV_KEYS.
  // Here we simulate the Perf-Agent backfill of ORGANIZATION_NAME.
  const wireBody = evalBodyLiteral(
    script,
    0,
    {
      ORGANIZATION_NAME: 'Test Mediasmart API Org',
      PA_BACKFILLED_ENV_KEYS: 'ORGANIZATION_NAME',
    },
    { organization_Name: 'Test Org 73697' }
  );
  const parsed = JSON.parse(wireBody);
  assert.equal(
    parsed.name,
    'Test Org 73697',
    'pre-request pm.environment.set must beat backfilled env value'
  );
});

test('D3-2: manual UI override (NOT in backfill set) still beats pm mutation', () => {
  const col = makeCollection({
    bodyRaw: '{"name":"{{organization_Name}}"}',
    prerequestExec: 'pm.environment.set("organization_Name", "Test Org 73697");',
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(
    script,
    0,
    {
      ORGANIZATION_NAME: 'User Manual Override',
      // no PA_BACKFILLED_ENV_KEYS → manual
    },
    { organization_Name: 'Test Org 73697' }
  );
  const parsed = JSON.parse(wireBody);
  assert.equal(
    parsed.name,
    'User Manual Override',
    'manual (not-backfilled) env override must still win over pm mutation'
  );
});

test('D3-2: when there is no pre-request mutation, env fallback behaves exactly as before', () => {
  const col = makeCollection({
    bodyRaw: '{"name":"{{organization_Name}}"}',
    // no prerequest script
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(
    script,
    0,
    {
      ORGANIZATION_NAME: 'Env Backfilled Value',
      PA_BACKFILLED_ENV_KEYS: 'ORGANIZATION_NAME',
    }
  );
  const parsed = JSON.parse(wireBody);
  assert.equal(
    parsed.name,
    'Env Backfilled Value',
    'without pm mutation the env value must still resolve'
  );
});

test('D3-2: pm mutation beats backfilled env for a second mutated variable (email path)', () => {
  const col = makeCollection({
    bodyRaw: '{"user":{"email":"{{email}}"}}',
    prerequestExec: 'pm.environment.set("email", "generated+73697@example.com");',
    extraVars: [{ key: 'email', value: 'ignored' }],
  });
  const script = generate(col);
  const wireBody = evalBodyLiteral(
    script,
    0,
    {
      EMAIL: 'static+{{randomNumber}}@example.com',
      PA_BACKFILLED_ENV_KEYS: 'EMAIL',
    },
    { email: 'generated+73697@example.com' }
  );
  const parsed = JSON.parse(wireBody);
  assert.equal(parsed.user.email, 'generated+73697@example.com');
});
