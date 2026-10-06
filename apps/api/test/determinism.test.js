'use strict';

// Phase B determinism test: the K6 generator must emit byte-identical
// output for the same (collection, environment, options) inputs across
// repeated invocations. Only the cosmetic "// Generated: <ISO>" comment
// is normalized — all semantic content must match exactly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');

// --- synthetic fixture covering the Phase B matrix items ----------------
const COLLECTION = {
  info: { name: 'phase-b-determinism-fixture', schema: 'v2.1' },
  variable: [
    { key: 'service_host', value: 'api.example.test' },
    { key: 'tenant_id', value: 'T-100' },
  ],
  item: [
    {
      name: 'Auth',
      item: [
        {
          name: 'Login',
          request: {
            method: 'POST',
            url: { raw: 'https://{{service_host}}/session' },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: { mode: 'raw', raw: '{"user":"{{username}}"}', options: { raw: { language: 'json' } } },
          },
          event: [
            {
              listen: 'test',
              script: {
                exec: ['pm.environment.set("sessionCredential", pm.response.json().access);'],
              },
            },
          ],
        },
      ],
    },
    {
      name: 'Resources',
      item: [
        {
          name: 'CreateCustomer',
          request: {
            method: 'POST',
            url: { raw: 'https://{{service_host}}/customers' },
            header: [
              { key: 'Authorization', value: 'Bearer {{sessionCredential}}' },
              { key: 'Content-Type', value: 'application/json' },
            ],
            body: {
              mode: 'raw',
              raw: '{"tenant":"{{tenant_id}}","name":"c","meta":{"a":1,"b":true,"c":null,"d":[1,2,3]}}',
              options: { raw: { language: 'json' } },
            },
          },
          event: [
            {
              listen: 'test',
              script: {
                exec: ['pm.environment.set("customerRef", pm.response.json().id);'],
              },
            },
            {
              listen: 'prerequest',
              script: {
                exec: [
                  'const today = new Date();',
                  'const toYMD = (d) => d.toISOString().split("T")[0];',
                  'pm.environment.set("startDate", toYMD(today));',
                ],
              },
            },
          ],
        },
        {
          name: 'GetCustomer',
          request: {
            method: 'GET',
            url: {
              raw: 'https://{{service_host}}/customers/:id?verbose=1',
              host: ['{{service_host}}'],
              path: ['customers', ':id'],
              query: [{ key: 'verbose', value: '1' }],
              variable: [{ key: 'id', value: '{{customerRef}}' }],
            },
            header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }],
          },
        },
        {
          name: 'UpdateCustomer',
          request: {
            method: 'PUT',
            url: { raw: 'https://{{service_host}}/customers/{{customerRef}}' },
            header: [
              { key: 'Authorization', value: 'Bearer {{sessionCredential}}' },
              { key: 'Content-Type', value: 'application/json' },
            ],
            body: { mode: 'raw', raw: '{"name":"c2"}', options: { raw: { language: 'json' } } },
          },
        },
        {
          name: 'DeleteCustomer',
          request: {
            method: 'DELETE',
            url: { raw: 'https://{{service_host}}/customers/{{customerRef}}' },
            header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }],
          },
        },
        {
          name: 'FormUpload',
          request: {
            method: 'POST',
            url: { raw: 'https://{{service_host}}/upload' },
            header: [{ key: 'Authorization', value: 'Bearer {{sessionCredential}}' }],
            body: {
              mode: 'formdata',
              formdata: [
                { key: 'name', value: 'hello', type: 'text' },
                { key: 'kind', value: 'text', type: 'text' },
              ],
            },
          },
        },
      ],
    },
  ],
};

const ENVIRONMENT = {
  name: 'phase-b-env',
  values: [
    { key: 'username', value: 'alice', enabled: true },
    { key: 'service_host', value: 'api.example.test', enabled: true },
  ],
};

const WORKLOAD = {
  profile: 'custom',
  executor: 'ramping-vus',
  vus: 5,
  stages: [{ duration: '30s', target: 5 }, { duration: '1m', target: 5 }, { duration: '30s', target: 0 }],
  gracefulStop: '120s',
  thresholds: { http_req_failed: ['rate<0.05'], http_req_duration: ['p(95)<2000'] },
};

function generateOnce() {
  const parsed = parse(COLLECTION);
  const authFlow = buildAuthFlow(parsed);
  const executionModel = buildExecutionModel({
    parsed,
    rawCollection: COLLECTION,
    rawEnvironment: ENVIRONMENT,
    selection: { mode: 'all' },
    authFlow,
  });
  return generateK6Script(parsed, {
    authFlow,
    authSessionMode: 'SHARED_SESSION',
    workload: WORKLOAD,
    executionModel,
  });
}

// Strip the single known cosmetic non-deterministic field (the generation
// timestamp comment at the top of the file). Nothing else is normalized.
function normalize(code) {
  return code.replace(/^\/\/ Generated:.*$/m, '// Generated: <normalized>');
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

test('Phase-B: generated K6 script is byte-identical across 3 runs (modulo generated-at comment)', () => {
  const a = normalize(generateOnce());
  const b = normalize(generateOnce());
  const c = normalize(generateOnce());

  assert.equal(sha256(a), sha256(b), 'run1 != run2');
  assert.equal(sha256(b), sha256(c), 'run2 != run3');
  assert.ok(a.length > 1000, 'generator produced trivially small output');
});

test('Phase-B: raw unnormalized output differs only in the generated-at timestamp line', () => {
  const a = generateOnce();
  const b = generateOnce();
  const diffs = [];
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  assert.equal(aLines.length, bLines.length, 'line count differs');
  for (let i = 0; i < aLines.length; i += 1) {
    if (aLines[i] !== bLines[i]) diffs.push({ line: i + 1, a: aLines[i], b: bLines[i] });
  }
  // Only the "// Generated: <ISO>" header line is allowed to differ, and
  // only if the two runs crossed a millisecond boundary.
  for (const d of diffs) {
    assert.match(d.a, /^\/\/ Generated:\s+\S/, `unexpected diff at line ${d.line}:\nA=${d.a}\nB=${d.b}`);
    assert.match(d.b, /^\/\/ Generated:\s+\S/, `unexpected diff at line ${d.line}:\nA=${d.a}\nB=${d.b}`);
  }
});

test('Phase-B: no outbound network / AI side-effects during generation (env isolation)', () => {
  // Blank out any AI-shaped env vars that might exist in the host shell.
  const guarded = [
    'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'AZURE_OPENAI_API_KEY', 'AI_MODEL',
    'LLM_MODEL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL',
  ];
  const saved = {};
  for (const k of guarded) { saved[k] = process.env[k]; delete process.env[k]; }
  // Also neuter fetch and http client APIs if present.
  const originalFetch = global.fetch;
  global.fetch = () => { throw new Error('network unavailable in Phase-B isolation test'); };
  try {
    const code = generateOnce();
    assert.ok(code.includes('import http from \'k6/http\''));
    assert.ok(code.includes('export function setup'));
  } finally {
    global.fetch = originalFetch;
    for (const k of guarded) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
