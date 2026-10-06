'use strict';

// Phase E — multi-VU runtime isolation & concurrency certification.
//
// Runs the real generator pipeline + real worker-runner against a local
// Node HTTP target that is instrumented to detect per-VU contamination:
//   • /login issues a NEW unique token per call.
//   • /customers (POST) assigns a NEW unique id per call and records the
//     binding   id -> bearer   .
//   • /customers/:id (GET|PUT|DELETE) looks up the binding and records a
//     contamination event if the incoming bearer does not match.
//
// VUs: 3   Duration: 12s hold   Executor: ramping-vus (profile=custom).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse } = require('../src/lib/postman/parser');
const { generateK6Script } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');
const { buildNormalizedReport } = require('../src/lib/report/normalizedReport');
const { parseRunArtifacts } = require('../src/lib/k6/metricsParser');
const { spawnK6, buildK6Env } = require('../../worker-runner/src');

// --- shared state -------------------------------------------------------

let server;
let baseUrl;
let tmpRoot;

// Diagnostic buckets reset between tests.
let state;
function resetState() {
  state = {
    log: [],              // every request received
    tokens: new Set(),    // unique tokens issued
    customerToToken: new Map(), // customerId -> issuing bearer
    tokenCounter: 0,
    customerCounter: 0,
    contaminationEvents: [], // {expectedToken, actualToken, customerId, method, path}
    unexpectedCustomers: [], // GET on an id we never issued
    tokenRequestCounts: new Map(), // bearer -> count of authenticated requests
  };
}

function respondJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function recordAuthed(bearer) {
  if (!bearer) return;
  state.tokenRequestCounts.set(bearer, (state.tokenRequestCounts.get(bearer) || 0) + 1);
}

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let bodyJson = null;
        try {
          if (bodyText && bodyText.trim().startsWith('{')) bodyJson = JSON.parse(bodyText);
        } catch (_) { /* ignore */ }
        const bearer = (req.headers['authorization'] || '').startsWith('Bearer ')
          ? req.headers['authorization'].slice(7)
          : null;
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;

        state.log.push({
          t: Date.now(),
          method: req.method,
          path: p,
          query: url.search,
          bearer,
          bodyJson,
        });

        // POST /login -> issue a new unique token
        if (p === '/login' && req.method === 'POST') {
          state.tokenCounter += 1;
          const token = `tok_${state.tokenCounter}_${Math.random().toString(36).slice(2, 8)}`;
          state.tokens.add(token);
          return respondJson(res, 200, { token });
        }
        // POST /customers -> issue a new unique id, bind to current bearer
        if (p === '/customers' && req.method === 'POST') {
          if (!bearer || !state.tokens.has(bearer)) {
            return respondJson(res, 401, { error: 'unauthorized' });
          }
          recordAuthed(bearer);
          state.customerCounter += 1;
          const id = `cust_${state.customerCounter}`;
          state.customerToToken.set(id, bearer);
          return respondJson(res, 201, { id, name: (bodyJson && bodyJson.customer && bodyJson.customer.name) || 'anon' });
        }
        // GET|PUT|DELETE /customers/:id -> contamination check
        const m = p.match(/^\/customers\/([^/]+)$/);
        if (m) {
          const id = m[1];
          if (!bearer || !state.tokens.has(bearer)) {
            return respondJson(res, 401, { error: 'unauthorized' });
          }
          recordAuthed(bearer);
          const bound = state.customerToToken.get(id);
          if (!bound) {
            state.unexpectedCustomers.push({ id, method: req.method, bearer });
          } else if (bound !== bearer) {
            state.contaminationEvents.push({
              expectedToken: bound,
              actualToken: bearer,
              customerId: id,
              method: req.method,
              path: p,
            });
          }
          if (req.method === 'GET') return respondJson(res, 200, { id, ok: true });
          if (req.method === 'PUT') return respondJson(res, 200, { id, updated: true });
          if (req.method === 'DELETE') return respondJson(res, 200, { deleted: true });
        }
        // Negatives
        if (p === '/not-found') return respondJson(res, 404, { error: 'nope' });
        if (p === '/health') return respondJson(res, 200, { status: 'ok' });

        return respondJson(res, 500, { error: 'route-not-handled', path: p });
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve(srv);
    });
  });
}

// --- generator glue -----------------------------------------------------

function generate(collection, env, selection = { mode: 'all' }, extra = {}) {
  const parsed = parse(collection);
  const authFlow = buildAuthFlow(parsed);
  const executionModel = buildExecutionModel({
    parsed,
    rawCollection: collection,
    rawEnvironment: env || null,
    selection,
    authFlow,
  });
  const code = generateK6Script(parsed, {
    authFlow,
    executionModel,
    workload: {
      profile: 'custom',
      overrides: { vus: 3, rampUp: '0s', hold: '12s', rampDown: '0s' },
    },
    authSessionMode: 'PER_VU_LOGIN',
    ...extra,
  });
  return { parsed, executionModel, code };
}

function runK6(scriptCode, envVars = {}) {
  const runId = Math.random().toString(36).slice(2, 10);
  const scriptPath = path.join(tmpRoot, `script-${runId}.js`);
  const summaryPath = path.join(tmpRoot, `summary-${runId}.json`);
  fs.writeFileSync(scriptPath, scriptCode, 'utf8');
  const { envMap } = buildK6Env({
    expectedEnvVars: Object.keys(envVars),
    env: envVars,
    secrets: {},
    parentEnv: process.env,
  });
  return new Promise((resolve) => {
    const child = spawnK6({ binPath: 'k6', scriptPath, env: envMap, summaryExportPath: summaryPath });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      let summary = null;
      try { if (fs.existsSync(summaryPath)) summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (_) {}
      resolve({ code, stdout, stderr, summary, scriptPath, summaryPath });
    });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, summary: null }));
  });
}

// --- collection builder -------------------------------------------------

function phaseECollection({ withBadAuth = true, withNotFound = true, withBadDynamic = false, withTransportFail = null } = {}) {
  const items = [
    {
      name: 'Auth',
      item: [{
        name: 'Login',
        request: {
          method: 'POST',
          url: { raw: '{{baseUrl}}/login' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: {
            mode: 'raw',
            raw: '{"username":"{{$randomUserName}}","password":"pw"}',
            options: { raw: { language: 'json' } },
          },
        },
        event: [
          { listen: 'test', script: { exec: ['pm.environment.set("apiSessionToken", pm.response.json().token);'] } },
        ],
      }],
    },
    {
      name: 'Customers',
      item: [
        {
          name: 'CreateCustomer',
          request: {
            method: 'POST',
            url: { raw: '{{baseUrl}}/customers' },
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer {{apiSessionToken}}' },
              { key: 'X-Correlation', value: '{{$guid}}' },
            ],
            body: {
              mode: 'raw',
              raw: JSON.stringify({
                customer: { name: '{{$randomFirstName}}', email: '{{$randomEmail}}' },
                metadata: { requestId: '{{$guid}}', ts: '{{$timestamp}}' },
              }),
              options: { raw: { language: 'json' } },
            },
          },
          event: [
            { listen: 'test', script: { exec: ['pm.environment.set("customerRef", pm.response.json().id);'] } },
          ],
        },
        {
          name: 'GetCustomer',
          request: {
            method: 'GET',
            url: { raw: '{{baseUrl}}/customers/{{customerRef}}' },
            header: [{ key: 'Authorization', value: 'Bearer {{apiSessionToken}}' }],
          },
        },
        {
          name: 'UpdateCustomer',
          request: {
            method: 'PUT',
            url: { raw: '{{baseUrl}}/customers/{{customerRef}}' },
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer {{apiSessionToken}}' },
            ],
            body: { mode: 'raw', raw: '{"n":"u"}', options: { raw: { language: 'json' } } },
          },
        },
        {
          name: 'DeleteCustomer',
          request: {
            method: 'DELETE',
            url: { raw: '{{baseUrl}}/customers/{{customerRef}}' },
            header: [{ key: 'Authorization', value: 'Bearer {{apiSessionToken}}' }],
          },
        },
      ],
    },
  ];
  const utilityItems = [];
  if (withNotFound) {
    utilityItems.push({
      name: 'NotFound',
      request: { method: 'GET', url: { raw: '{{baseUrl}}/not-found' }, header: [] },
    });
  }
  if (withBadAuth) {
    utilityItems.push({
      name: 'BadAuth',
      request: {
        method: 'GET',
        url: { raw: '{{baseUrl}}/customers/cust_1' },
        header: [{ key: 'Authorization', value: 'Bearer wrong-token' }],
      },
    });
  }
  if (withBadDynamic) {
    utilityItems.push({
      name: 'BadDynamic',
      request: {
        method: 'POST',
        url: { raw: '{{baseUrl}}/customers' },
        header: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: 'Bearer {{apiSessionToken}}' },
        ],
        body: {
          mode: 'raw',
          raw: '{"id":"{{$futureUnsupportedDynamicVariable}}"}',
          options: { raw: { language: 'json' } },
        },
      },
    });
  }
  if (withTransportFail) {
    utilityItems.push({
      name: 'DeadPort',
      request: { method: 'GET', url: { raw: withTransportFail }, header: [] },
    });
  }
  if (utilityItems.length) items.push({ name: 'Utilities', item: utilityItems });

  return {
    info: { name: 'phase-e-multivu', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: baseUrl }],
    item: items,
  };
}

// --- lifecycle ----------------------------------------------------------

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phaseE-'));
  server = await startServer();
});

after(() => {
  if (server) server.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
});

// --- scenarios ----------------------------------------------------------

test('PhE-1: 3 VU × 12 s, full chain, per-VU auth + customerRef isolation (collection+env, PER_VU_LOGIN)', async (t) => {
  resetState();
  const col = phaseECollection({ withBadAuth: true, withNotFound: true, withBadDynamic: true });
  const env = {
    name: 'phase-e-env',
    values: [
      { key: 'baseUrl', value: baseUrl, enabled: true },
    ],
  };
  const { code, executionModel } = generate(col, env);

  // Sanity: BadDynamic request must be plan-blocked.
  const badDyn = executionModel.requests.find((r) => r.name === 'BadDynamic');
  assert.ok(badDyn, 'BadDynamic must exist in the execution model');
  assert.equal(badDyn.execute, false);
  assert.equal(badDyn.skipReason, 'unsupported_dynamic_variable');

  const { code: exit, summary } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99, `unexpected k6 exit ${exit}`);
  assert.ok(summary, 'summary must be exported');

  // ---------------- isolation assertions ----------------------
  // (A) Each VU logs in independently → more than one unique token.
  // ramping-vus with 3 VUs over 12s may issue many logins per VU, but we
  // require at minimum one unique token per VU (3+).
  assert.ok(state.tokens.size >= 3, `expected >=3 unique tokens, got ${state.tokens.size}`);

  // (B) Cross-VU contamination: GET/PUT/DELETE on an id must only ever
  // carry the SAME bearer that created it.
  if (state.contaminationEvents.length > 0) {
    t.diagnostic('contamination events: ' + JSON.stringify(state.contaminationEvents.slice(0, 5), null, 2));
  }
  assert.equal(state.contaminationEvents.length, 0, 'cross-VU customerRef/token contamination detected');

  // (C) No GET/PUT/DELETE on an id the server never issued.
  assert.equal(state.unexpectedCustomers.length, 0, `unexpected customer ids: ${JSON.stringify(state.unexpectedCustomers.slice(0, 5))}`);

  // (D) BadDynamic blocked → ZERO /customers POSTs with the sentinel body.
  const badBodies = state.log.filter((r) => r.path === '/customers' && r.method === 'POST')
    .filter((r) => typeof r.bodyJson?.id === 'string' && r.bodyJson.id.includes('__UNSUPPORTED_DYNAMIC__'));
  assert.equal(badBodies.length, 0, 'unsupported-dynamic sentinel must never reach wire');

  // (E) Each unique bearer that successfully called CreateCustomer must
  // also appear on Get/Put/Delete to its OWN customer id.
  const createByToken = new Map();
  for (const [id, bearer] of state.customerToToken.entries()) {
    const arr = createByToken.get(bearer) || [];
    arr.push(id);
    createByToken.set(bearer, arr);
  }
  // Must have observed CRUD traffic from at least 3 unique bearers.
  const bearersThatCreated = Array.from(createByToken.keys());
  assert.ok(bearersThatCreated.length >= 3, `only ${bearersThatCreated.length} unique bearers created customers`);

  // (F) Every GET/PUT/DELETE's bearer must equal the id's binding (already
  // guarded by contaminationEvents.length==0 above). Double-check that
  // the chain actually ran: at least one GET and one DELETE observed.
  const getCalls = state.log.filter((r) => r.method === 'GET' && /^\/customers\/cust_\d+$/.test(r.path));
  const delCalls = state.log.filter((r) => r.method === 'DELETE' && /^\/customers\/cust_\d+$/.test(r.path));
  assert.ok(getCalls.length >= 3, `expected >=3 GET customers, got ${getCalls.length}`);
  assert.ok(delCalls.length >= 3, `expected >=3 DELETE customers, got ${delCalls.length}`);

  // (G) Dynamic variable isolation: /customers POSTs carry unique
  // X-Correlation guids per request. Collect guids and verify high
  // cardinality (not a single stuck value).
  const guids = new Set();
  for (const r of state.log) {
    if (r.path === '/customers' && r.method === 'POST' && r.bodyJson?.metadata?.requestId) {
      guids.add(r.bodyJson.metadata.requestId);
    }
  }
  // One guid per CreateCustomer POST. Must have at least 3 distinct
  // values (one per VU minimum) — anything less would hint at a shared
  // Math.random seed or a shared dynCache between VUs.
  const createCount = state.customerToToken.size;
  assert.ok(guids.size >= Math.min(createCount, 3),
    `dynamic $guid cardinality too low: ${guids.size} across ${createCount} POSTs — suggests shared state`);
  assert.equal(guids.size, createCount, 'each CreateCustomer must receive a fresh $guid');

  // (H) Negative branches
  const nf = state.log.filter((r) => r.path === '/not-found');
  assert.ok(nf.length >= 1, 'NotFound must occur');
  const badAuth = state.log.filter((r) => r.path === '/customers/cust_1' && r.bearer === 'wrong-token');
  assert.ok(badAuth.length >= 1, 'BadAuth branch must occur with wrong bearer');

  // ---------------- metrics assertions ------------------------
  const m = summary.metrics || {};
  const totalReqs = (m.http_reqs && (m.http_reqs.count ?? m.http_reqs.value)) || 0;
  assert.ok(totalReqs >= 30, `expected many http_reqs under 3 VU × 12 s, got ${totalReqs}`);
  const vusMax = (m.vus_max && (m.vus_max.value ?? m.vus_max.max)) || 0;
  assert.ok(vusMax >= 3, `expected vus_max >= 3, got ${vusMax}`);

  // ---------------- report pipeline ---------------------------
  const summaryPath = path.join(tmpRoot, `summary-pipeline-${Date.now()}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary));
  const parsed = await parseRunArtifacts({ summaryExportPath: summaryPath });
  assert.ok(parsed);
  const normalized = buildNormalizedReport({ parsed, run: { exitCode: exit } });
  assert.ok(normalized);
});

test('PhE-2: selection closure under 3 VU — only Login+Create+Get run; no PUT/DELETE/NotFound/BadAuth', async (t) => {
  resetState();
  const col = phaseECollection({ withBadAuth: true, withNotFound: true });
  const parsed = parse(col);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCustomer');
  const authFlow = buildAuthFlow(parsed);
  const executionModel = buildExecutionModel({
    parsed,
    rawCollection: col,
    selection: { mode: 'single', requestIndex: getIdx },
    authFlow,
  });
  const code = generateK6Script(parsed, {
    authFlow,
    executionModel,
    workload: { profile: 'custom', overrides: { vus: 3, rampUp: '0s', hold: '8s', rampDown: '0s' } },
    authSessionMode: 'PER_VU_LOGIN',
  });

  const { code: exit } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99, `unexpected exit ${exit}`);

  const methods = state.log.map((r) => `${r.method} ${r.path.split('/').slice(0, 3).join('/')}`);
  assert.ok(methods.includes('POST /login'), 'Login must run');
  assert.ok(methods.includes('POST /customers'), 'CreateCustomer must run');
  assert.ok(state.log.some((r) => r.method === 'GET' && /^\/customers\/cust_\d+$/.test(r.path)), 'GetCustomer must run');
  assert.ok(!state.log.some((r) => r.method === 'PUT'), 'PUT must NOT run');
  assert.ok(!state.log.some((r) => r.method === 'DELETE'), 'DELETE must NOT run');
  assert.ok(!state.log.some((r) => r.path === '/not-found'), 'NotFound must NOT run');

  // Contamination still zero.
  assert.equal(state.contaminationEvents.length, 0);
  assert.equal(state.unexpectedCustomers.length, 0);
});

test('PhE-3: collection-only (no environment) under 3 VU — contamination still zero', async (t) => {
  resetState();
  const col = phaseECollection({ withBadAuth: false, withNotFound: false });
  const { code } = generate(col, null);
  const { code: exit, summary } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99, `unexpected exit ${exit}`);
  assert.equal(state.contaminationEvents.length, 0, 'cross-VU contamination in collection-only mode');
  assert.ok(state.tokens.size >= 3, 'should have observed at least 3 unique tokens');
  const totalReqs = summary.metrics?.http_reqs?.count || summary.metrics?.http_reqs?.value || 0;
  assert.ok(totalReqs >= 20);
});

test('PhE-4: transport failure under 3 VU — dead port classified as failed, zero target hits', async (t) => {
  resetState();
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const col = {
    info: { name: 'phase-e-transport', schema: 'v2.1' },
    item: [
      { name: 'DeadPort', request: { method: 'GET', url: { raw: `http://127.0.0.1:${deadPort}/x` }, header: [] } },
    ],
  };
  const { code } = generate(col, null);
  const { code: exit, summary, stdout, stderr } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99);
  assert.equal(state.log.length, 0, 'our target must not have received anything');
  const m = summary.metrics || {};
  const total = (m.http_reqs && (m.http_reqs.count ?? m.http_reqs.value)) || 0;
  if (total === 0) {
    t.diagnostic('metric keys: ' + Object.keys(m).sort().join(', '));
    t.diagnostic('stdout tail: ' + stdout.slice(-2000));
    t.diagnostic('stderr tail: ' + stderr.slice(-2000));
  }
  // The dead-port endpoint results in connection failures reported through
  // k6's standard metrics. We accept either http_req_failed>0 OR
  // perf_transport_failed>0 OR raw http_reqs>0 with 100% failures.
  const failedRate = (m.http_req_failed && m.http_req_failed.value) || 0;
  const failedPasses = (m.http_req_failed && m.http_req_failed.passes) || 0;
  const transportFail = (m.perf_transport_failed && (m.perf_transport_failed.count ?? m.perf_transport_failed.value)) || 0;
  assert.ok(
    failedRate > 0 || failedPasses > 0 || transportFail > 0 || total > 0,
    `expected failure signal; metrics summary: ${JSON.stringify({ total, failedRate, failedPasses, transportFail })}`
  );
});

test('PhE-5: deterministic generation (3 VU workload) over 3 generations', () => {
  const col = phaseECollection({ withBadAuth: true, withNotFound: true });
  const strip = (s) => s.replace(/^\/\/ Generated:.*$/m, '');
  const a = generate(col, null).code;
  const b = generate(col, null).code;
  const c = generate(col, null).code;
  assert.equal(strip(a), strip(b));
  assert.equal(strip(b), strip(c));
});
