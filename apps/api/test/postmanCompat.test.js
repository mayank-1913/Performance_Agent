'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/lib/postman/parser');
const { generateK6Script, makeInterpolator } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { resolveDynamicVariable, isDynamicVariable } = require('../src/lib/postman/dynamicVariables');
const { analyzePrerequestScript } = require('../src/lib/postman/prerequestCodegen');
const { compareWireRequest, resolveTemplateString } = require('../src/lib/postman/wireComparison');
const { normalizeRequestVariables } = require('../src/lib/postman/requestLocals');

function generate(parsed, opts = {}) {
  const flow = buildAuthFlow(parsed);
  return generateK6Script(parsed, { authFlow: flow, ...opts });
}

test('Fixture A: environment + collection variables in URL/body', () => {
  const parsed = parse({
    info: { name: 'fixture-a' },
    variable: [{ key: 'api_host', value: 'api.example.test' }],
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'Call',
        request: {
          method: 'GET',
          url: { raw: 'https://{{api_host}}/{{env_path}}' },
          header: [{ key: 'X-Env', value: '{{env_path}}' }],
          body: { mode: 'raw', raw: '{"path":"{{env_path}}"}' },
        },
      },
    ],
  });
  const code = generate(parsed);
  assert.match(code, /__coalesceVar\("api_host"/);
  assert.match(code, /__coalesceVar\("env_path"/);
});

test('Fixture B: request-local variables in URL/header/body', () => {
  const parsed = parse({
    info: { name: 'fixture-b' },
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'Local',
        variable: [{ key: 'local_id', value: 'req-local-99' }],
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/items/{{local_id}}' },
          header: [{ key: 'X-Local', value: '{{local_id}}' }],
          body: { mode: 'raw', raw: '{"id":"{{local_id}}","nested":{"id":"{{local_id}}"},"items":["{{local_id}}"]}' },
        },
      },
    ],
  });
  const code = generate(parsed);
  assert.match(code, /req-local-99/);
  assert.match(code, /__getRequestLocal/);
});

test('Fixture C: runtime capture flows into downstream body', () => {
  const parsed = parse({
    info: { name: 'fixture-c' },
    item: [
      {
        name: 'Login',
        request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] },
        event: [{ listen: 'test', script: { exec: ['pm.environment.set("entity_id", pm.response.json().id);'] } }],
      },
      {
        name: 'Update',
        request: {
          method: 'PUT',
          url: { raw: 'https://example.test/entities/{{entity_id}}' },
          body: { mode: 'raw', raw: '{"entity_id":"{{entity_id}}"}' },
        },
      },
    ],
  });
  const code = generate(parsed);
  assert.match(code, /\.vars\["entity_id"\]/);
  assert.match(code, /__coalesceVar\("entity_id"/);
});

test('Fixture D: nested JSON and arrays with dynamic + static types', () => {
  const body =
    '{"outer":{"inner":"{{runtime_id}}"},"items":["{{item_id}}",{{numeric_value}}],"enabled":{{enabled}}}';
  const parsed = parse({
    info: { name: 'fixture-d' },
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'Post',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/x' },
          body: { mode: 'raw', raw: body, language: 'json' },
        },
      },
    ],
  });
  const code = generate(parsed);
  assert.match(code, /__coalesceVar\("enabled", __ENV\.ENABLED\)/);
  assert.match(code, /__coalesceVar\("numeric_value", __ENV\.NUMERIC_VALUE\)/);
  assert.match(code, /__coalesceVar\("runtime_id"/);
});

test('Fixture E: dynamic variables in URL/body with per-request cache', () => {
  const parsed = parse({
    info: { name: 'fixture-e' },
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'Dyn',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/t/{{$timestamp}}' },
          body: { mode: 'raw', raw: '{"id":"{{$randomUUID}}","ts":"{{$timestamp}}"}' },
        },
      },
    ],
  });
  const code = generate(parsed);
  const dynGroup = code.match(/group\(`Dyn`[\s\S]*?\n  \}\);/);
  assert.ok(dynGroup);
  assert.match(dynGroup[0], /__resolveDynamicVar\("\$timestamp", __dynCache_/);
  assert.match(dynGroup[0], /__resolveDynamicVar\(.*\$randomUUID.*__dynCache_/);
  assert.doesNotMatch(dynGroup[0], /\{\{\$timestamp\}\}/);
});

test('Fixture F: translatable pre-request pm.environment.set', () => {
  const script = [
    'const today = new Date();',
    'const future = new Date();',
    'future.setDate(today.getDate() + 7);',
    'const toYMD = (d) => d.toISOString().split("T")[0];',
    'pm.environment.set("range_start", toYMD(today));',
    'pm.environment.set("range_end", toYMD(future));',
  ].join('\n');
  const analysis = analyzePrerequestScript(script);
  assert.equal(analysis.translatable, true);
  assert.ok(analysis.k6Lines.length >= 4);
});

test('Fixture G: pm.collectionVariables.set translation', () => {
  const analysis = analyzePrerequestScript('pm.collectionVariables.set("tenant", "acme");');
  assert.equal(analysis.translatable, true);
  assert.match(analysis.k6Lines.join('\n'), /collectionVariables/);
});

test('Fixture H: PER_VU uses isolated auth state accessor', () => {
  const parsed = parse({
    info: { name: 'fixture-h' },
    item: [
      {
        name: 'Login',
        request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] },
        event: [{ listen: 'test', script: { exec: ['pm.environment.set("vu_token", pm.response.json().token);'] } }],
      },
      {
        name: 'Me',
        request: { method: 'GET', url: { raw: 'https://example.test/me' }, header: [{ key: 'Authorization', value: '{{vu_token}}' }] },
      },
    ],
  });
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { authFlow: flow, authSessionMode: 'PER_VU_LOGIN' });
  assert.match(code, /__getAuthState\(data\)/);
});

test('Fixture I: unsupported pre-request is not silently ignored', () => {
  const analysis = analyzePrerequestScript('eval("alert(1)"); pm.environment.set("x", "1");');
  assert.equal(analysis.translatable, false);
  assert.ok(analysis.reason);
});

test('Fixture J: unresolved variable produces skip guard', () => {
  const parsed = parse({
    info: { name: 'fixture-j' },
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'Missing',
        request: { method: 'GET', url: { raw: 'https://example.test/{{missing_var}}' }, header: [] },
      },
    ],
  });
  const code = generate(parsed);
  assert.match(code, /__urlHasInvalidRuntimeRefs\(__url_/);
});

test('Fixture K: manual override precedence in wire comparison', () => {
  const postmanReq = {
    method: 'GET',
    url: '{{host}}/v1',
    body: { mode: 'raw', raw: '{"k":"{{host}}"}' },
  };
  const result = compareWireRequest(
    postmanReq,
    { method: 'GET', url: 'https://override.test/v1', body: '{"k":"https://override.test"}' },
    {
      manual: { HOST: 'https://override.test' },
      provider: { now: () => new Date('2026-01-01T00:00:00.000Z') },
    }
  );
  assert.equal(result.result, 'MATCH');
});

test('dynamic variable provider is deterministic in tests', () => {
  const provider = {
    now: () => new Date('2026-06-15T12:00:00.000Z'),
    random: () => 0.5,
    uuid: () => '11111111-2222-4333-8444-555555555555',
  };
  const cache = new Map();
  const a = resolveDynamicVariable('$timestamp', provider, cache);
  const b = resolveDynamicVariable('$timestamp', provider, cache);
  assert.equal(a.value, b.value);
  assert.ok(isDynamicVariable('$timestamp'));
});

test('request-local maps do not share state between requests', () => {
  const a = normalizeRequestVariables([{ key: 'x', value: '1' }]);
  const b = normalizeRequestVariables([{ key: 'x', value: '2' }]);
  assert.notEqual(a.get('x').value, b.get('x').value);
});

test('raw JSON body without Content-Type infers application/json header', () => {
  const parsed = parse({
    info: { name: 'content-type-infer' },
    item: [
      { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
      {
        name: 'PostJson',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/items' },
          header: [{ key: 'Authorization', value: '{{token}}' }],
          body: { mode: 'raw', raw: '{"enabled":true}', options: { raw: { language: 'json' } } },
        },
      },
    ],
  });
  const code = generate(parsed);
  const group = code.match(/group\(`[^`]*PostJson`[\s\S]*?\n  \}\);/);
  assert.ok(group);
  assert.match(group[0], /"Content-Type": "application\/json"/);
});
