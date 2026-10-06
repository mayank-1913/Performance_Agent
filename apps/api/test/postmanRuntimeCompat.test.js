'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { parse } = require('../src/lib/postman/parser');
const { buildAuthFlow, extractCaptureStatements } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');
const { buildDependencyGraph } = require('../src/lib/postman/dependencyGraph');
const { analyzePrerequestScript, PREREQUEST_RUNTIME_JS } = require('../src/lib/postman/prerequestCodegen');
const { REQUEST_LOCAL_RUNTIME_JS } = require('../src/lib/postman/requestLocals');
const {
  resolveVariables,
  expandNestedPlaceholders,
  lookupRawVariableValue,
} = require('../src/lib/postman/variableResolver');
const { generateK6Script } = require('../src/lib/k6/generator');

function item(name, request, events) {
  const node = { name, request };
  if (events) node.event = events;
  return node;
}

function pre(script) {
  return [{ listen: 'prerequest', script: { exec: script.split('\n') } }];
}

function tests(script) {
  return [{ listen: 'test', script: { exec: script.split('\n') } }];
}

function compile(collection, environment, selection) {
  const parsed = parse(collection);
  const authFlow = buildAuthFlow(parsed);
  const executionModel = buildExecutionModel({
    parsed,
    rawCollection: collection,
    rawEnvironment: environment || null,
    selection: selection || { mode: 'all' },
    authFlow,
  });
  const code = generateK6Script(parsed, { executionModel, authFlow });
  return { parsed, authFlow, executionModel, code };
}

function extractFunction(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) throw new Error('missing ' + signature);
  const brace = src.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unclosed ' + signature);
}

function runTranslated(lines, fixedIso) {
  const fixed = new Date(fixedIso);
  const RealDate = Date;
  function Clock(...args) {
    if (args.length === 0) return new RealDate(fixed.getTime());
    return new RealDate(...args);
  }
  Clock.prototype = RealDate.prototype;
  Clock.now = () => fixed.getTime();
  const context = { Date: Clock, Math, String, console };
  vm.createContext(context);
  const body = [
    'const out = {};',
    'const state = { pm: { environment: {}, collectionVariables: {}, variables: {} }, vars: {}, requestLocals: {} };',
    REQUEST_LOCAL_RUNTIME_JS,
    PREREQUEST_RUNTIME_JS,
    '(function(state) {',
    lines.join('\n'),
    '})(state);',
    'result = { vars: state.vars, local: state.pm.variables, scheduled: state.__scheduledNext || null };',
  ].join('\n');
  vm.runInContext(body, context, { timeout: 1000 });
  return context.result;
}

test('A/B Math.random pre-request writes an arbitrary environment name', () => {
  const script = [
    'const n = Math.floor(Math.random() * 100000);',
    'pm.environment.set("label", "Test API Temp " + n);',
    'pm.environment.set("title", `Test API MS ${n}`);',
  ].join('\n');
  const analysis = analyzePrerequestScript(script);
  assert.equal(analysis.translatable, true);
  assert.deepEqual(analysis.setsEnvironment, ['label', 'title']);
  const out = runTranslated(analysis.k6Lines, '2026-06-15T12:00:00.000Z');
  assert.match(out.vars.label, /^Test API Temp \d+$/);
  assert.match(out.vars.title, /^Test API MS \d+$/);
  assert.equal(out.local.label, undefined);
});

test('C pm.variables.set stays on the current request', () => {
  const analysis = analyzePrerequestScript(
    'pm.variables.set("localKey", Math.floor(10000 + Math.random() * 90000));'
  );
  assert.equal(analysis.translatable, true);
  assert.deepEqual(analysis.setsVariables, ['localKey']);
  assert.deepEqual(analysis.setsEnvironment, []);
  const out = runTranslated(analysis.k6Lines, '2026-06-15T12:00:00.000Z');
  assert.equal(out.vars.localKey, undefined);
  assert.ok(out.local.localKey != null);
  const context = { Math, String };
  vm.createContext(context);
  vm.runInContext(
    [
      REQUEST_LOCAL_RUNTIME_JS,
      PREREQUEST_RUNTIME_JS,
      'state = { pm: { environment: {}, variables: {} }, vars: {}, requestLocals: {} };',
      '__beginRequestScope(state, 0);',
      '__pmSet(state, "variables", "localKey", "111");',
      'first = state.requestLocals[0].localKey;',
      '__beginRequestScope(state, 1);',
      'second = state.requestLocals[1] && state.requestLocals[1].localKey;',
      'still = state.vars.localKey;',
    ].join('\n'),
    context
  );
  assert.equal(context.first, '111');
  assert.equal(context.second, undefined);
  assert.equal(context.still, undefined);
});

test('D enabled empty variable resolves to an empty string', () => {
  const res = resolveVariables({
    collectionVariables: [{ key: 'blank', value: '', enabled: true }],
    environmentVariables: [{ key: 'nested', value: 'pre-{{blank}}-post', enabled: true }],
    referencedVars: ['blank', 'nested', 'missing'],
  });
  assert.equal(res.values.BLANK, '');
  assert.equal(res.sources.BLANK, 'collection');
  assert.ok(!res.unresolved.includes('BLANK'));
  assert.ok(res.unresolved.includes('MISSING'));
  const expanded = expandNestedPlaceholders('pre-{{blank}}-post', (name) =>
    lookupRawVariableValue(name, { collection: { blank: '' }, environment: {} })
  );
  assert.equal(expanded.value, 'pre--post');
  assert.deepEqual(expanded.unresolved, []);
  const missing = expandNestedPlaceholders('{{missing}}', () => undefined);
  assert.match(missing.value, /__UNRESOLVED__/);
});

test('E-J date offsets keep UTC and local calendar formatting distinct', () => {
  const plus = analyzePrerequestScript([
    'const today = new Date();',
    'const future = new Date();',
    'future.setDate(today.getDate() + 7);',
    'const toYMD = (d) => d.toISOString().split("T")[0];',
    'pm.environment.set("started_at", toYMD(today));',
    'pm.environment.set("finished_at", toYMD(future));',
  ].join('\n'));
  const minus1 = analyzePrerequestScript([
    'const today = new Date();',
    'const yesterday = new Date(today);',
    'yesterday.setDate(today.getDate() - 1);',
    'const year = yesterday.getFullYear();',
    'const month = String(yesterday.getMonth() + 1).padStart(2, "0");',
    'const day = String(yesterday.getDate()).padStart(2, "0");',
    'const formatted = `${year}-${month}-${day}`;',
    'pm.environment.set("yesterday_date", formatted);',
  ].join('\n'));
  const minus7 = analyzePrerequestScript([
    'const today = new Date();',
    'const past = new Date(today);',
    'past.setDate(today.getDate() - 7);',
    'pm.environment.set("from_date", past.toISOString().split("T")[0]);',
  ].join('\n'));
  const minus3 = analyzePrerequestScript([
    'const today = new Date();',
    'const past = new Date(today);',
    'past.setMonth(past.getMonth() - 3);',
    'pm.environment.set("from_date", past.toISOString().split("T")[0]);',
  ].join('\n'));
  assert.equal(plus.translatable, true);
  assert.equal(minus1.translatable, true);
  assert.equal(minus7.translatable, true);
  assert.equal(minus3.translatable, true);
  assert.match(plus.k6Lines.join('\n'), /toISOString\(\)\.split\('T'\)\[0\]/);
  assert.match(minus1.k6Lines.join('\n'), /getFullYear\(\)/);
  assert.match(minus1.k6Lines.join('\n'), /padStart\(2, "0"\)/);
  assert.doesNotMatch(minus1.k6Lines.join('\n'), /toISOString/);

  let boundary = null;
  for (let hour = 0; hour < 48; hour += 1) {
    const candidate = new Date(Date.UTC(2026, 0, 1, hour, 30, 0));
    if (candidate.toISOString().slice(0, 10) !== localYmd(candidate)) {
      boundary = candidate;
      break;
    }
  }
  const cursor = boundary || new Date('2026-01-01T12:00:00.000Z');
  const utcRun = runTranslated(
    analyzePrerequestScript(
      'const today = new Date();\npm.environment.set("day", today.toISOString().split("T")[0]);'
    ).k6Lines,
    cursor.toISOString()
  );
  assert.equal(utcRun.vars.day, cursor.toISOString().slice(0, 10));
  const yesterdayNow = new Date(cursor.getTime());
  yesterdayNow.setDate(yesterdayNow.getDate() + 1);
  const localRun = runTranslated(minus1.k6Lines, yesterdayNow.toISOString());
  const expectedYesterday = new Date(yesterdayNow.getTime());
  expectedYesterday.setDate(yesterdayNow.getDate() - 1);
  assert.equal(localRun.vars.yesterday_date, localYmd(expectedYesterday));
  if (boundary) {
    assert.notEqual(boundary.toISOString().slice(0, 10), localYmd(boundary));
  }
  const monthRun = runTranslated(minus3.k6Lines, '2026-05-31T12:00:00.000Z');
  const probe = new Date('2026-05-31T12:00:00.000Z');
  const shifted = new Date(probe.getTime());
  shifted.setMonth(shifted.getMonth() - 3);
  assert.equal(monthRun.vars.from_date, shifted.toISOString().split('T')[0]);
});

function localYmd(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

test('K/L response aliases resolve to body paths', () => {
  const deal = extractCaptureStatements([
    'const response = pm.response.json();',
    'const dealId = response.id;',
    'pm.environment.set("dealId", dealId);',
  ]);
  assert.deepEqual(deal[0].path, ['id']);
  const data = extractCaptureStatements([
    'const responseData = pm.response.json();',
    'pm.environment.set("created", responseData.id);',
  ]);
  assert.deepEqual(data[0].path, ['id']);
  assert.equal(data[0].varName, 'created');
});

test('M/N conditional capture follows status and field checks', () => {
  const rules = extractCaptureStatements([
    'let res = pm.response.json();',
    'if (pm.response.code === 201 && res.id) {',
    '  pm.environment.set("created_id", res.id);',
    '}',
    'let jsonData = pm.response.json();',
    'if (jsonData.username === "some-user" && jsonData.token) {',
    '  pm.environment.set("session_token", jsonData.token);',
    '}',
  ]);
  const created = rules.find((rule) => rule.varName === 'created_id');
  const token = rules.find((rule) => rule.varName === 'session_token');
  assert.equal(created.when.status, 201);
  assert.deepEqual(created.path, ['id']);
  assert.equal(token.when.all[0].equals, 'some-user');
  const { code } = compile({
    info: { name: 'cap' },
    item: [item('Login', { method: 'POST', url: 'https://example.test/login', header: [] }, tests(rules.length ? 'pm.environment.set("created_id", res.id);' : ''))],
  });
  const fn = [
    extractFunction(code, 'function __valueAtPath'),
    extractFunction(code, 'function __captureRuleAllows'),
  ].join('\n');
  const context = {};
  vm.createContext(context);
  vm.runInContext(fn + '\nthis.allow = __captureRuleAllows;', context);
  const allow = context.allow;
  assert.equal(allow(created, { id: 'abc' }, { status: 201 }), true);
  assert.equal(allow(created, { id: 'abc' }, { status: 400 }), false);
  assert.equal(allow(created, {}, { status: 201 }), false);
  assert.equal(allow(token, { username: 'some-user', token: 't' }, { status: 200 }), true);
  assert.equal(allow(token, { username: 'other', token: 't' }, { status: 200 }), false);
});

test('O/P setNextRequest stops after the current request and jumps to the first duplicate name', () => {
  const collection = {
    info: { name: 'next' },
    item: [
      item('Same', { method: 'GET', url: 'https://example.test/same', header: [] }),
      item('Other', {
        method: 'GET',
        url: 'https://example.test/other',
        header: [],
      }, pre('if (pm.environment.get("mode") === "jump") {\n  postman.setNextRequest("Same");\n}\nif (pm.environment.get("mode") === "stop") {\n  postman.setNextRequest(null);\n}')),
      item('Same', { method: 'GET', url: 'https://example.test/same-2', header: [] }),
    ],
  };
  const { code } = compile(collection);
  assert.match(code, /__scheduleNextRequest\(state, null\)/);
  assert.match(code, /__scheduleNextRequest\(state, "Same"\)/);
  assert.match(code, /while \(__pos < __seq\.length/);
  const names = code.match(/const __REQUEST_NAMES = (\[[\s\S]*?\]);/);
  assert.ok(names);
  assert.deepEqual(JSON.parse(names[1]), ['Same', 'Other', 'Same']);
  const context = {
    __REQUEST_NAMES: ['Same', 'Other', 'Same'],
    __EXECUTABLE_INDICES: [0, 1, 2],
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction(code, 'function __firstRequestIndexByName'),
      extractFunction(code, 'function __commitScheduledNext'),
      'state = { __scheduledNext: { name: "Same" } };',
      '__commitScheduledNext(state);',
      'jumped = state.__jumpTo;',
      'state2 = { __scheduledNext: { stop: true } };',
      '__commitScheduledNext(state2);',
      'stopped = state2.__stopRun === true;',
    ].join('\n'),
    context
  );
  assert.equal(context.jumped, 0);
  assert.equal(context.stopped, true);
  const closed = { __REQUEST_NAMES: ['Same', 'Other', 'Same'], __EXECUTABLE_INDICES: [1], console: { warn() {} } };
  vm.createContext(closed);
  vm.runInContext(
    [
      extractFunction(code, 'function __firstRequestIndexByName'),
      extractFunction(code, 'function __commitScheduledNext'),
      'state = { __scheduledNext: { name: "Same" } };',
      '__commitScheduledNext(state);',
      'err = state.__nextRequestError;',
      'jump = state.__jumpTo;',
    ].join('\n'),
    closed
  );
  assert.match(closed.err, /outside the selected execution closure/);
  assert.equal(closed.jump, undefined);
});

test('Q text-only form-data is multipart', () => {
  const { code } = compile({
    info: { name: 'form' },
    item: [
      item('Upload', {
        method: 'POST',
        url: 'https://example.test/upload',
        header: [],
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'name', value: 'Ada', type: 'text' },
            { key: 'note', value: 'hello', type: 'text' },
          ],
        },
      }),
    ],
  });
  assert.match(code, /__encodeTextMultipart/);
  assert.match(code, /multipart\/form-data/);
  assert.doesNotMatch(code, /"name": `Ada`/);
});

test('R/S/T unresolved URL, query, and body skip before HTTP', () => {
  const { code } = compile({
    info: { name: 'missing' },
    item: [
      item('Path', { method: 'GET', url: 'https://example.test/{{missing_path}}', header: [] }),
      item('Query', { method: 'GET', url: 'https://example.test/q?from={{missing_query}}', header: [] }),
      item('Body', {
        method: 'POST',
        url: 'https://example.test/body',
        header: [],
        body: { mode: 'raw', options: { raw: { language: 'json' } }, raw: '{"id":"{{missing_body}}"}' },
      }),
    ],
  });
  assert.match(code, /__urlHasInvalidRuntimeRefs/);
  assert.match(code, /__hasInvalidRuntimeContent/);
  assert.doesNotMatch(code, /%7B%7B/);
  assert.match(code, /__UNRESOLVED__/);
});

test('U/V request-level strictSSL is reported and disableBodyPruning keeps a GET body', () => {
  const collection = {
    info: { name: 'protocol' },
    item: [
      {
        name: 'Secure',
        request: { method: 'GET', url: 'https://example.test/secure', header: [] },
        protocolProfileBehavior: { strictSSL: false, followAuthorizationHeader: false },
      },
      {
        name: 'KeepBody',
        request: {
          method: 'GET',
          url: 'https://example.test/search',
          header: [],
          body: { mode: 'raw', options: { raw: { language: 'json' } }, raw: '{"q":"a"}' },
        },
        protocolProfileBehavior: { disableBodyPruning: true },
      },
      {
        name: 'PruneBody',
        request: {
          method: 'GET',
          url: 'https://example.test/pruned',
          header: [],
          body: { mode: 'raw', options: { raw: { language: 'json' } }, raw: '{"q":"a"}' },
        },
      },
    ],
  };
  const { code, executionModel } = compile(collection);
  const secure = executionModel.requests.find((req) => req.name === 'Secure');
  assert.ok(secure.issues.some((issue) => issue.kind === 'protocol_profile_unsupported' && issue.feature === 'strictSSL'));
  assert.match(code, /strictSSL=false: per-request TLS verification bypass is not supported by k6/);
  assert.doesNotMatch(code, /insecureSkipTLSVerify:\s*true/);
  const keep = code.slice(code.indexOf('group(`KeepBody`'), code.indexOf('group(`PruneBody`'));
  assert.match(keep, /http\.request\(\s*"GET"/);
  const prune = code.slice(code.indexOf('group(`PruneBody`'));
  assert.match(prune, /http\.get\(/);
  assert.doesNotMatch(prune.slice(0, prune.indexOf('http.get')), /http\.request\(\s*"GET"/);
});

test('unsupported pre-request skips the HTTP call', () => {
  const collection = {
    info: { name: 'skip-pre' },
    item: [
      item('Broken', {
        method: 'POST',
        url: 'https://example.test/broken',
        header: [],
        body: { mode: 'raw', raw: '{"n":"{{made_up}}"}' },
      }, pre('made_up = externalCall();')),
    ],
  };
  const { code, executionModel } = compile(collection);
  assert.equal(executionModel.requests[0].skipReason, 'pre_request_unsupported');
  const group = code.slice(code.indexOf('Broken'));
  const warnAt = group.indexOf('pre_request_unsupported');
  const httpAt = group.indexOf('http.post');
  assert.ok(warnAt >= 0);
  assert.ok(httpAt > warnAt);
  const between = group.slice(warnAt, httpAt);
  assert.match(between, /return;/);
});

test('pre-request environment writes are dependency producers and local writes are not', () => {
  const collection = {
    info: { name: 'deps' },
    item: [
      item('Producer', {
        method: 'POST',
        url: 'https://example.test/p',
        header: [],
      }, pre('pm.environment.set("from_date", "2026-01-01");')),
      item('Consumer', {
        method: 'GET',
        url: 'https://example.test/c?from={{from_date}}',
        header: [],
      }),
      item('LocalOnly', {
        method: 'POST',
        url: 'https://example.test/local',
        header: [],
        body: { mode: 'raw', raw: '{"k":"{{localKey}}"}' },
      }, pre('pm.variables.set("localKey", "1");')),
      item('Unrelated', { method: 'GET', url: 'https://example.test/u', header: [] }),
    ],
  };
  const parsed = parse(collection);
  const graph = buildDependencyGraph(parsed, buildAuthFlow(parsed));
  assert.equal(graph.perRequest[1][0].varName, 'from_date');
  assert.equal(graph.perRequest[1][0].producerIndex, 0);
  assert.equal(graph.perRequest[2].length, 0);
  const selected = compile(collection, null, { mode: 'requests', requestIndices: [1] });
  const executed = selected.executionModel.requests.filter((req) => req.execute).map((req) => req.name);
  assert.deepEqual(executed, ['Producer', 'Consumer']);
});
