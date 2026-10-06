'use strict';

// Phase C.1: unsupported Postman dynamic variables ({{$future...}}) must
// be classified at plan time and must NOT reach the target wire via any
// request location — URL, path, query, header, JSON body, nested JSON,
// JSON array, form-data, or raw body.
//
// Mechanism under test: buildExecutionModel() now removes affected
// requests from executableIndices and sets skipReason to
// 'unsupported_dynamic_variable'. The generator's selectionGuard then
// short-circuits the whole request block.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');

// --------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------

function collection(items, { variable, name = 'phc1-fixture' } = {}) {
  return {
    info: { name, schema: 'v2.1' },
    variable: variable || [],
    item: items,
  };
}

function em(col, selection = { mode: 'all' }) {
  const parsed = parse(col);
  const authFlow = buildAuthFlow(parsed);
  return {
    parsed,
    authFlow,
    model: buildExecutionModel({
      parsed,
      rawCollection: col,
      rawEnvironment: null,
      selection,
      authFlow,
    }),
  };
}

function generate(col, selection = { mode: 'all' }) {
  const { parsed, authFlow, model } = em(col, selection);
  return generateK6Script(parsed, { authFlow, executionModel: model });
}

function requestEntry(model, name) {
  return model.requests.find((r) => r.name === name);
}

// --------------------------------------------------------------------
// Part 4 — unsupported dynamic variable in every request location
// --------------------------------------------------------------------

const LOCATION_FIXTURES = [
  {
    label: 'URL raw',
    build: () => [{
      name: 'R',
      request: {
        method: 'GET',
        url: { raw: 'https://x.test/t/{{$futureUnsupportedDyn}}' },
        header: [],
      },
    }],
  },
  {
    label: 'path variable',
    build: () => [{
      name: 'R',
      request: {
        method: 'GET',
        url: {
          raw: 'https://x.test/users/:id',
          host: ['x', 'test'],
          path: ['users', ':id'],
          variable: [{ key: 'id', value: '{{$futureUnsupportedDyn}}' }],
        },
        header: [],
      },
    }],
  },
  {
    label: 'query parameter',
    build: () => [{
      name: 'R',
      request: {
        method: 'GET',
        url: {
          raw: 'https://x.test/t?rid={{$futureUnsupportedDyn}}',
          host: ['x', 'test'],
          path: ['t'],
          query: [{ key: 'rid', value: '{{$futureUnsupportedDyn}}' }],
        },
        header: [],
      },
    }],
  },
  {
    label: 'header value',
    build: () => [{
      name: 'R',
      request: {
        method: 'GET',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'X-Correlation-Id', value: '{{$futureUnsupportedDyn}}' }],
      },
    }],
  },
  {
    label: 'JSON body top-level',
    build: () => [{
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"id":"{{$futureUnsupportedDyn}}"}',
          options: { raw: { language: 'json' } },
        },
      },
    }],
  },
  {
    label: 'nested JSON',
    build: () => [{
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"outer":{"deep":{"id":"{{$futureUnsupportedDyn}}"}}}',
          options: { raw: { language: 'json' } },
        },
      },
    }],
  },
  {
    label: 'JSON array',
    build: () => [{
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"ids":["ok","{{$futureUnsupportedDyn}}","ok2"]}',
          options: { raw: { language: 'json' } },
        },
      },
    }],
  },
  {
    label: 'form-data text',
    build: () => [{
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [],
        body: {
          mode: 'formdata',
          formdata: [{ key: 'rid', value: '{{$futureUnsupportedDyn}}', type: 'text' }],
        },
      },
    }],
  },
  {
    label: 'raw text body',
    build: () => [{
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'text/plain' }],
        body: { mode: 'raw', raw: 'rid={{$futureUnsupportedDyn}}' },
      },
    }],
  },
];

for (const fx of LOCATION_FIXTURES) {
  test(`PhC1-4.${fx.label}: unsupported dynamic var in ${fx.label} => request blocked, no sentinel on wire`, () => {
    const col = collection(fx.build());
    const { model } = em(col);
    const r = requestEntry(model, 'R');

    assert.equal(r.execute, false, 'request must not be executable');
    assert.equal(r.skipReason, 'unsupported_dynamic_variable', 'skipReason must be explicit');
    assert.ok(
      r.issues.some((i) => i.kind === 'unsupported_dynamic_variable'),
      'issue of kind unsupported_dynamic_variable must be present'
    );
    assert.ok(
      !model.executableIndices.includes(r.index),
      'index must be removed from executableIndices'
    );

    // Generated script must NOT emit an http call for this request. The
    // request index is excluded from __EXECUTABLE_INDICES, so the
    // selectionGuard at the top of the group short-circuits before URL,
    // body, or headers are built. We check the authoritative source:
    // __EXECUTABLE_INDICES in the generated code.
    const code = generate(col);
    const m = code.match(/const __EXECUTABLE_INDICES = (\[[^\]]*\]);/);
    assert.ok(m, 'expected __EXECUTABLE_INDICES const in generated code');
    const indices = JSON.parse(m[1]);
    assert.ok(!indices.includes(r.index), 'blocked index must not appear in __EXECUTABLE_INDICES');
  });
}

// --------------------------------------------------------------------
// Part 13 — multiple dynamic vars, one unsupported => still blocked
// --------------------------------------------------------------------

test('PhC1-13: multiple dynamic vars with one unsupported => request blocked', () => {
  const col = collection([
    {
      name: 'Mixed',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"ok":"{{$guid}}","email":"{{$randomEmail}}","bad":"{{$futureUnsupportedDyn}}"}',
          options: { raw: { language: 'json' } },
        },
      },
    },
  ]);
  const { model } = em(col);
  const r = requestEntry(model, 'Mixed');
  assert.equal(r.execute, false);
  assert.equal(r.skipReason, 'unsupported_dynamic_variable');
  const issue = r.issues.find((i) => i.kind === 'unsupported_dynamic_variable');
  assert.deepEqual(issue.variables, ['$futureUnsupportedDyn']);
});

// --------------------------------------------------------------------
// Part 15 (Case B) — folder isolation: unrelated bad request does NOT
// block the selected folder
// --------------------------------------------------------------------

test('PhC1-15.A: selecting folder A does NOT get blocked by folder B unsupported dynamic var', () => {
  const col = collection([
    {
      name: 'A',
      item: [
        {
          name: 'GetUsers',
          request: { method: 'GET', url: { raw: 'https://x.test/users' }, header: [] },
        },
      ],
    },
    {
      name: 'B',
      item: [
        {
          name: 'CreatePayment',
          request: {
            method: 'POST',
            url: { raw: 'https://x.test/payments' },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: '{"id":"{{$futureUnsupportedDyn}}"}',
              options: { raw: { language: 'json' } },
            },
          },
        },
      ],
    },
  ]);
  const parsed = parse(col);
  const getUsersIdx = parsed.requests.findIndex((r) => r.name === 'GetUsers');
  const model = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'requests', requestIndices: [getUsersIdx] },
    authFlow: buildAuthFlow(parsed),
  });
  const getUsers = requestEntry(model, 'GetUsers');
  const createPayment = requestEntry(model, 'CreatePayment');
  assert.equal(getUsers.execute, true, 'GetUsers must be executable');
  assert.equal(getUsers.skipReason, null, 'GetUsers must not be blocked');
  assert.equal(createPayment.execute, false, 'CreatePayment is outside selection and must not run');
  // CreatePayment is unselected AND has an unsupported dynamic variable.
  // The dynamic-variable classification does not apply when the request is
  // outside the closure — it should remain classified as unselected.
  assert.equal(createPayment.skipReason, 'unselected');
});

test('PhC1-15.B: selecting folder B => request classified unsupported_dynamic_variable', () => {
  const col = collection([
    {
      name: 'A',
      item: [{ name: 'GetUsers', request: { method: 'GET', url: { raw: 'https://x.test/users' }, header: [] } }],
    },
    {
      name: 'B',
      item: [
        {
          name: 'CreatePayment',
          request: {
            method: 'POST',
            url: { raw: 'https://x.test/payments' },
            header: [{ key: 'Content-Type', value: 'application/json' }],
            body: {
              mode: 'raw',
              raw: '{"id":"{{$futureUnsupportedDyn}}"}',
              options: { raw: { language: 'json' } },
            },
          },
        },
      ],
    },
  ]);
  const parsed = parse(col);
  const paymentIdx = parsed.requests.findIndex((r) => r.name === 'CreatePayment');
  const model = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'single', requestIndex: paymentIdx },
    authFlow: buildAuthFlow(parsed),
  });
  const createPayment = requestEntry(model, 'CreatePayment');
  assert.equal(createPayment.execute, false);
  assert.equal(createPayment.skipReason, 'unsupported_dynamic_variable');
});

// --------------------------------------------------------------------
// Part 14 — dependency chain with unsupported dynamic var in producer
// --------------------------------------------------------------------

test('PhC1-14: when CreateCustomer has unsupported dyn var, Get/Update/Delete safely dep-skip via existing runtime check', () => {
  const col = collection([
    {
      name: 'Login',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/login' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{"u":"a"}', options: { raw: { language: 'json' } } },
      },
      event: [{ listen: 'test', script: { exec: ['pm.environment.set("apiSessionToken", pm.response.json().token);'] } }],
    },
    {
      name: 'CreateCustomer',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/customers' },
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer {{apiSessionToken}}' },
        ],
        body: {
          mode: 'raw',
          raw: '{"requestId":"{{$futureUnsupportedDyn}}"}',
          options: { raw: { language: 'json' } },
        },
      },
      event: [{ listen: 'test', script: { exec: ['pm.environment.set("customerRef", pm.response.json().id);'] } }],
    },
    {
      name: 'GetCustomer',
      request: {
        method: 'GET',
        url: { raw: 'https://x.test/customers/{{customerRef}}' },
        header: [{ key: 'Authorization', value: 'Bearer {{apiSessionToken}}' }],
      },
    },
  ]);
  const parsed = parse(col);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCustomer');
  const model = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'single', requestIndex: getIdx },
    authFlow: buildAuthFlow(parsed),
  });
  // CreateCustomer is dynamically blocked -> excluded from executableIndices.
  // GetCustomer survives but will dep-skip at runtime via __checkDependencyDeps.
  const create = requestEntry(model, 'CreateCustomer');
  const get = requestEntry(model, 'GetCustomer');
  assert.equal(create.execute, false, 'CreateCustomer must be plan-blocked');
  assert.equal(create.skipReason, 'unsupported_dynamic_variable');
  assert.equal(get.execute, true, 'GetCustomer stays in closure, dep-skip is enforced at runtime');
  assert.ok(get.dependencies.some((d) => d.varName === 'customerRef'),
    'dependency metadata must preserve customerRef so runtime guard fires');
});

// --------------------------------------------------------------------
// Part 5 — all 11 supported dynamic vars still work (regression guard)
// --------------------------------------------------------------------

test('PhC1-5: supported dynamic variables still generate runtime calls and are not blocked', () => {
  const supportedNames = [
    '$timestamp', '$isoTimestamp', '$guid', '$randomUUID', '$randomInt',
    '$randomFirstName', '$randomLastName', '$randomEmail',
    '$randomUserName', '$randomPassword', '$randomBoolean',
  ];
  for (const n of supportedNames) {
    const col = collection([
      {
        name: 'R-' + n,
        request: {
          method: 'POST',
          url: { raw: 'https://x.test/t' },
          header: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'X-Val', value: `v-{{${n}}}` },
          ],
          body: {
            mode: 'raw',
            raw: `{"v":"{{${n}}}"}`,
            options: { raw: { language: 'json' } },
          },
        },
      },
    ]);
    const { model } = em(col);
    const r = model.requests[0];
    assert.equal(r.execute, true, `${n} must remain executable`);
    assert.equal(r.skipReason, null, `${n} must not be blocked`);
    const code = generate(col);
    assert.match(code, /__resolveDynamicVar\(/, `${n}: runtime resolver must be invoked`);
  }
});

// --------------------------------------------------------------------
// Part 17 — no unnecessary manual prompt / no normal-unresolved mislabeling
// --------------------------------------------------------------------

test('PhC1-17: unknown {{$...}} is NOT reported as a normal unresolved variable', () => {
  const col = collection([
    {
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"a":"{{$futureUnsupportedDyn}}","b":"{{normalUnresolvedVar}}"}',
          options: { raw: { language: 'json' } },
        },
      },
    },
  ]);
  const { model } = em(col);
  const r = model.requests[0];
  const dynIssue = r.issues.find((i) => i.kind === 'unsupported_dynamic_variable');
  assert.ok(dynIssue, 'must have an unsupported_dynamic_variable issue');
  assert.deepEqual(dynIssue.variables, ['$futureUnsupportedDyn']);
  // normalUnresolvedVar must stay in the plain-unresolved channel surfaced
  // by variableResolution — NOT be classified as unsupported dynamic.
  const unresolved = model.variableResolution?.unresolved || [];
  assert.ok(unresolved.includes('normalUnresolvedVar') || model.parsed.referencedVars.includes('normalUnresolvedVar'),
    'normal unresolved variable must stay in the unresolved channel');
});

// --------------------------------------------------------------------
// Part 18 — determinism of classification + generated script
// --------------------------------------------------------------------

test('PhC1-18: classification is deterministic across 3 runs', () => {
  const fx = () => collection([
    {
      name: 'R',
      request: {
        method: 'POST',
        url: { raw: 'https://x.test/t/{{$futureUnsupportedDyn}}' },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: {
          mode: 'raw',
          raw: '{"ok":"{{$guid}}","bad":"{{$anotherFuture}}"}',
          options: { raw: { language: 'json' } },
        },
      },
    },
  ]);
  const results = [em(fx()), em(fx()), em(fx())].map(({ model }) => ({
    skip: model.requests[0].skipReason,
    exec: model.executableIndices,
    vars: model.requests[0].issues.find((i) => i.kind === 'unsupported_dynamic_variable').variables.slice().sort(),
  }));
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[1], results[2]);
  assert.deepEqual(results[0].vars, ['$anotherFuture', '$futureUnsupportedDyn']);
});

// --------------------------------------------------------------------
// Part 9 — explicit URL sentinel check (even if plan-time removes the
// request, confirm the runtime safety belt is still present in the
// generated code so defense-in-depth is maintained).
// --------------------------------------------------------------------

test('PhC1-9: runtime sentinel safety belt (__hasInvalidRuntimeContent) is present in every generated script', () => {
  const code = generate(collection([
    { name: 'R', request: { method: 'GET', url: { raw: 'https://x.test/t' }, header: [] } },
  ]));
  assert.match(code, /__hasInvalidRuntimeContent/);
  assert.match(code, /__UNSUPPORTED_DYNAMIC__/, 'runtime resolver must still emit the sentinel for the defense-in-depth path');
  assert.match(code, /__urlHasInvalidRuntimeRefs/);
});
