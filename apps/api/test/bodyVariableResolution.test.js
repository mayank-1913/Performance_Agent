'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { resolveVariables } = require('../src/lib/postman/variableResolver');

function makeCollection(requestBody, { captures = [], prerequest = '', requestVariable = null } = {}) {
  const loginEvent = captures.length
    ? [
        {
          listen: 'test',
          script: {
            exec: captures.map((c) => `pm.environment.set("${c}", "captured-${c}");`),
          },
        },
      ]
    : [];
  const reqEvents = prerequest
    ? [{ listen: 'prerequest', script: { exec: [prerequest] } }]
    : [];
  const targetItem = {
    name: 'Target',
    request: {
      method: 'POST',
      url: { raw: 'https://example.test/resource' },
      header: [],
      body: requestBody,
    },
    event: reqEvents,
  };
  if (requestVariable) {
    targetItem.variable = [requestVariable];
  }
  return {
    info: { name: 'body-resolution-fixture', schema: 'v2.1' },
    variable: [{ key: 'collection_var', value: 'from-collection' }],
    item: [
      {
        name: 'Login',
        request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] },
        event: loginEvent,
      },
      targetItem,
    ],
  };
}

function generateBody(requestBody, opts = {}) {
  const parsed = parse(makeCollection(requestBody, opts));
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, {
    authFlow: flow,
    authSessionMode: opts.perVu ? 'PER_VU_LOGIN' : 'SHARED_SESSION',
  });
  const group = code.match(/group\(`Target`[\s\S]*?\n  \}\);/);
  assert.ok(group, 'expected Target request group');
  return { code, body: group[0] };
}

test('environment variable in quoted JSON body field', () => {
  const { body } = generateBody({ mode: 'raw', raw: '{"started_at":"{{started_at}}"}' });
  assert.match(body, /__coalesceVar\(.*started_at.*__ENV\.STARTED_AT/);
});

test('collection variable resolves via __ENV at runtime', () => {
  const { body } = generateBody({ mode: 'raw', raw: '{"source":"{{collection_var}}"}' });
  assert.match(body, /__ENV\.COLLECTION_VAR/);
});

test('request-local variable in JSON body', () => {
  const { body } = generateBody(
    { mode: 'raw', raw: '{"region":"{{region_code}}"}' },
    { requestVariable: { key: 'region_code', value: 'EU-WEST' } }
  );
  assert.match(body, /"EU-WEST"/);
  assert.match(body, /__getRequestLocal/);
});

test('nested object body variable', () => {
  const { body } = generateBody({
    mode: 'raw',
    raw: '{"targeting":{"campaign_type":"{{campaign_type}}"}}',
  });
  assert.match(body, /__coalesceVar\(.*campaign_type.*__ENV\.CAMPAIGN_TYPE/);
});

test('array body variable', () => {
  const { body } = generateBody({
    mode: 'raw',
    raw: '{"countries":["{{country1}}","{{country2}}"]}',
  });
  assert.match(body, /__ENV\.COUNTRY1/);
  assert.match(body, /__ENV\.COUNTRY2/);
});

test('multiple variables in one string', () => {
  const { body } = generateBody({
    mode: 'raw',
    raw: '{"name":"{{prefix}}-{{campaign_name}}-{{suffix}}"}',
  });
  assert.match(body, /__ENV\.PREFIX/);
  assert.match(body, /__ENV\.CAMPAIGN_NAME/);
  assert.match(body, /__ENV\.SUFFIX/);
});

test('unquoted boolean placeholder preserves JSON type path', () => {
  const { body } = generateBody({ mode: 'raw', raw: '{"connectedtv":{{connectedtv}}}' });
  assert.match(body, /__resolveJsonLiteral\("connectedtv"/);
});

test('unquoted number placeholder preserves JSON type path', () => {
  const { body } = generateBody({ mode: 'raw', raw: '{"max_daily_cost":{{max_daily_cost}}}' });
  assert.match(body, /__resolveJsonLiteral\("max_daily_cost"/);
});

test('runtime-captured variable in body prefers __ENV then data.vars', () => {
  const { body } = generateBody(
    { mode: 'raw', raw: '{"campaign_id":"{{campaign_id}}","name":"Updated {{campaign_id}}"}' },
    { captures: ['campaign_id'] }
  );
  assert.match(body, /__ENV\.CAMPAIGN_ID.*\.vars\[\\?"campaign_id\\?"\]/);
  assert.doesNotMatch(body, /AUTH_TOKEN \|\| .*campaign_id/);
});

test('PER_VU runtime isolation uses __getAuthState for captured body vars', () => {
  const { body } = generateBody(
    { mode: 'raw', raw: '{"campaign_id":"{{campaign_id}}"}' },
    { captures: ['campaign_id'], perVu: true }
  );
  assert.match(body, /__getAuthState\(data\)\.vars\[\\?"campaign_id\\?"\]/);
});

test('unresolved body variable uses coalesce marker not literal placeholder', () => {
  const { code, body } = generateBody({ mode: 'raw', raw: '{"missing":"{{not_defined_anywhere}}"}' });
  assert.doesNotMatch(body, /\{\{not_defined_anywhere\}\}/);
  assert.match(body, /__coalesceVar\(.*not_defined_anywhere/);
  assert.match(code, /__hasInvalidRuntimeContent\(__body_/);
});

test('variable resolver precedence: manual override > environment > collection', () => {
  const resolution = resolveVariables({
    collectionVariables: [{ key: 'started_at', value: '2025-01-01' }],
    environmentVariables: [{ key: 'started_at', value: '2025-06-01' }],
    runtimeOverrides: { STARTED_AT: '2025-12-01' },
    referencedVars: ['started_at'],
  });
  assert.equal(resolution.values.STARTED_AT, '2025-12-01');
  assert.equal(resolution.sources.STARTED_AT, 'runtime');
});

test('supported pre-request script is translated into runtime pm operations', () => {
  const prerequest =
    'pm.environment.set("started_at", new Date().toISOString().split("T")[0]);';
  const { code } = generateBody(
    { mode: 'raw', raw: '{"started_at":"{{started_at}}"}' },
    { prerequest }
  );
  assert.match(code, /__pmSet\(state, 'environment', "started_at"/);
  assert.match(code, /__getPmVar/);
});
