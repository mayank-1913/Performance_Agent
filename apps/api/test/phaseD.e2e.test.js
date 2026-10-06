'use strict';

// Phase D — end-to-end execution certification.
//
// Runs the REAL Performance Agent generator pipeline (parser → execution
// model → generator) and the REAL worker-runner process manager
// (spawnK6 + commandBuilder + envInjector) against an in-process Node
// HTTP target that records every request. Assertions compare:
//   - the k6 run summary (via --summary-export)
//   - the server-side request audit log
//   - the normalized report (via lib/report/normalizedReport)
//
// No live Mediasmart, no production credentials, no load tests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parse } = require('../src/lib/postman/parser');
const { generateK6Script, toEnvName } = require('../src/lib/k6/generator');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');
const { buildNormalizedReport } = require('../src/lib/report/normalizedReport');
const { parseRunArtifacts } = require('../src/lib/k6/metricsParser');

const {
  spawnK6,
  buildK6Env,
} = require('../../worker-runner/src');

// --- global state -------------------------------------------------------

const BEARER = 'Bearer synthetic-token-123';
const TOKEN = 'synthetic-token-123';
let server;
let baseUrl;
let requestLog = [];
let tmpRoot;

function resetLog() {
  requestLog = [];
}

function recordRequest(req, bodyBuf) {
  const bodyText = bodyBuf.toString('utf8');
  let bodyJson = null;
  try {
    if (bodyText && bodyText.trim().startsWith('{')) bodyJson = JSON.parse(bodyText);
  } catch (_) { /* leave null */ }
  requestLog.push({
    method: req.method,
    path: req.url.split('?')[0],
    url: req.url,
    headers: { ...req.headers },
    body: bodyText,
    bodyJson,
    receivedAt: Date.now(),
  });
}

function respondJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...(extraHeaders || {}),
  });
  res.end(body);
}

function needsAuth(req) {
  return req.headers['authorization'] !== BEARER;
}

// --- target server ------------------------------------------------------

function startServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const buf = Buffer.concat(chunks);
        recordRequest(req, buf);
        const url = new URL(req.url, 'http://localhost');
        const p = url.pathname;

        // health
        if (p === '/health' && req.method === 'GET') {
          return respondJson(res, 200, { status: 'ok' });
        }
        // login
        if (p === '/login' && req.method === 'POST') {
          return respondJson(res, 200, { token: TOKEN });
        }
        // customers create
        if (p === '/customers' && req.method === 'POST') {
          if (needsAuth(req)) return respondJson(res, 401, { error: 'unauthorized' });
          return respondJson(res, 201, {
            id: 'customer-123',
            name: 'Phase-D',
            email: 'phase-d@example.test',
          });
        }
        // customers CRUD
        const m = p.match(/^\/customers\/([^/]+)$/);
        if (m) {
          if (needsAuth(req)) return respondJson(res, 401, { error: 'unauthorized' });
          const id = m[1];
          if (req.method === 'GET') return respondJson(res, 200, { id, name: 'Phase-D', email: 'phase-d@example.test' });
          if (req.method === 'PUT') return respondJson(res, 200, { id, updated: true });
          if (req.method === 'DELETE') return respondJson(res, 200, { deleted: true });
        }
        // query echo
        if (p === '/query' && req.method === 'GET') {
          const qp = {};
          for (const [k, v] of url.searchParams.entries()) qp[k] = v;
          return respondJson(res, 200, { query: qp });
        }
        // echo
        if (p === '/echo' && req.method === 'POST') {
          return respondJson(res, 200, {
            headers: req.headers,
            body: buf.toString('utf8'),
          });
        }
        // not-found endpoint intentionally returns 404 for the negative test.
        if (p === '/not-found') return respondJson(res, 404, { error: 'nope' });
        // payments: intentionally guarded; used in isolation tests.
        if (p === '/payments') return respondJson(res, 201, { paymentId: 'pay-1' });

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

// --- generator + runner glue -------------------------------------------

function generateScript(collection, env, selection = { mode: 'all' }) {
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
    // smoke = constant-vus; small hold = fast E2E certification.
    workload: { profile: 'smoke', overrides: { vus: 1, hold: '3s' } },
    authSessionMode: 'SHARED_SESSION',
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
    const child = spawnK6({
      binPath: 'k6',
      scriptPath,
      env: envMap,
      summaryExportPath: summaryPath,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      let summary = null;
      try {
        if (fs.existsSync(summaryPath)) {
          summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        }
      } catch (_) { /* leave null */ }
      resolve({ code, stdout, stderr, summary, scriptPath, summaryPath });
    });
    child.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, summary: null, scriptPath, summaryPath });
    });
  });
}

// --- collections -------------------------------------------------------

function fullCollection() {
  return {
    info: { name: 'phase-d-e2e', schema: 'v2.1' },
    variable: [
      { key: 'baseUrl', value: baseUrl },
    ],
    item: [
      {
        name: 'Auth',
        item: [
          {
            name: 'Login',
            request: {
              method: 'POST',
              url: { raw: '{{baseUrl}}/login' },
              header: [{ key: 'Content-Type', value: 'application/json' }],
              body: {
                mode: 'raw',
                raw: '{"username":"{{testUsername}}","password":"{{testPassword}}"}',
                options: { raw: { language: 'json' } },
              },
            },
            event: [
              {
                listen: 'test',
                script: { exec: ['pm.environment.set("apiSessionToken", pm.response.json().token);'] },
              },
            ],
          },
        ],
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
                { key: 'X-Request-Guid', value: '{{$guid}}' },
                { key: 'X-Custom-Header', value: 'phase-d' },
              ],
              body: {
                mode: 'raw',
                raw: JSON.stringify({
                  customer: {
                    name: '{{$randomFirstName}}',
                    email: '{{$randomEmail}}',
                  },
                  metadata: { requestId: '{{$guid}}', createdAt: '{{$timestamp}}' },
                  flags: { active: true },
                  quantity: 5,
                }),
                options: { raw: { language: 'json' } },
              },
            },
            event: [
              {
                listen: 'test',
                script: { exec: ['pm.environment.set("customerRef", pm.response.json().id);'] },
              },
            ],
          },
          {
            name: 'GetCustomer',
            request: {
              method: 'GET',
              url: {
                raw: '{{baseUrl}}/customers/{{customerRef}}?requestId={{$guid}}&limit=5',
                host: ['{{baseUrl}}'],
                path: ['customers', '{{customerRef}}'],
                query: [
                  { key: 'requestId', value: '{{$guid}}' },
                  { key: 'limit', value: '5' },
                ],
              },
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
              body: {
                mode: 'raw',
                raw: '{"name":"{{$randomFirstName}}"}',
                options: { raw: { language: 'json' } },
              },
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
      {
        name: 'Utilities',
        item: [
          {
            name: 'Health',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/health' }, header: [] },
          },
          {
            name: 'NotFound',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/not-found' }, header: [] },
          },
          {
            name: 'BadAuth',
            request: {
              method: 'POST',
              url: { raw: '{{baseUrl}}/customers' },
              header: [
                { key: 'Content-Type', value: 'application/json' },
                { key: 'Authorization', value: 'Bearer wrong-token' },
              ],
              body: { mode: 'raw', raw: '{"n":"nope"}', options: { raw: { language: 'json' } } },
            },
          },
        ],
      },
    ],
  };
}

// --- setup / teardown --------------------------------------------------

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phaseD-'));
  server = await startServer();
});

after(() => {
  if (server) server.close();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

// --- scenarios ---------------------------------------------------------

test('PhD-1: k6 binary is available (precondition)', () => {
  // The run harness itself calls spawnK6; this test simply exercises
  // the resolver so a missing k6 shows up as a dedicated failure.
  const { resolveK6Bin } = require('../../worker-runner/src');
  const resolved = resolveK6Bin('k6');
  assert.ok(typeof resolved === 'string' && resolved.length > 0);
});

test('PhD-2: full E2E — Login → CRUD + Utilities, 1 VU 1 iter', async (t) => {
  resetLog();
  const col = fullCollection();
  const env = {
    name: 'phase-d-env',
    values: [
      { key: 'baseUrl', value: baseUrl, enabled: true },
      { key: 'testUsername', value: 'alice', enabled: true },
      { key: 'testPassword', value: 's3cret', enabled: true },
    ],
  };
  const { code, executionModel } = generateScript(col, env);

  // Sanity: generated source is valid-ish.
  assert.match(code, /import http from 'k6\/http'/);
  assert.match(code, /__resolveDynamicVar/);

  const { code: exitCode, stdout, stderr, summary } = await runK6(code, {});
  if (exitCode !== 0 && exitCode !== 99) {
    t.diagnostic(stdout.slice(-2000));
    t.diagnostic(stderr.slice(-2000));
  }
  // k6 exits 99 when thresholds crossed. We set NO thresholds that fail
  // in the happy path, but BadAuth + NotFound inflate http_req_failed.
  // Accept 0 or 99.
  assert.ok(exitCode === 0 || exitCode === 99, `unexpected k6 exit code: ${exitCode}`);
  assert.ok(summary, 'k6 summary export missing');

  // --- server-side audit ---
  const logByPath = (p) => requestLog.filter((r) => r.path === p);
  const login = logByPath('/login');
  const create = logByPath('/customers').filter((r) => r.method === 'POST');
  const getC = requestLog.filter((r) => /^\/customers\/customer-123$/.test(r.path) && r.method === 'GET');
  const putC = requestLog.filter((r) => /^\/customers\/customer-123$/.test(r.path) && r.method === 'PUT');
  const delC = requestLog.filter((r) => /^\/customers\/customer-123$/.test(r.path) && r.method === 'DELETE');
  const health = logByPath('/health');
  const nf = logByPath('/not-found');

  // smoke(1VU, 3s hold) loops iterations until time runs out, so each
  // endpoint receives >=1 request. We assert presence + classification,
  // not exact count.
  if (login.length === 0) {
    t.diagnostic('server log: ' + JSON.stringify(requestLog.map((r) => ({ m: r.method, p: r.path, a: r.headers['authorization'] })).slice(0, 20), null, 2));
    t.diagnostic('stdout tail: ' + stdout.slice(-1500));
    t.diagnostic('stderr tail: ' + stderr.slice(-1500));
  }
  assert.ok(login.length >= 1, 'login must occur');
  const createSuccessful = create.filter((r) => r.headers['authorization'] === BEARER);
  if (createSuccessful.length === 0) {
    t.diagnostic('all /customers POSTs: ' + JSON.stringify(create.map((r) => ({ auth: r.headers['authorization'], body: r.body.slice(0, 120) })), null, 2));
    t.diagnostic('login response path hit: ' + login.length);
    t.diagnostic('stdout tail: ' + stdout.slice(-3000));
    t.diagnostic('stderr tail: ' + stderr.slice(-3000));
    t.diagnostic('authFlow enabled: ' + (executionModel.authFlow?.enabled));
    t.diagnostic('authFlow loginIdx: ' + (executionModel.authFlow?.loginRequestIndex));
    t.diagnostic('executable indices: ' + JSON.stringify(executionModel.executableIndices));
    t.diagnostic('capture rules: ' + JSON.stringify(executionModel.authFlow?.captureRules || executionModel.authFlow?.requestCaptureRules?.find((e) => e.index === executionModel.authFlow?.loginRequestIndex)));
  }
  assert.ok(createSuccessful.length >= 1, 'authenticated customer create must occur');
  const createBad = create.filter((r) => r.headers['authorization'] !== BEARER);
  assert.ok(createBad.length >= 1, 'bad-auth customer create (401 branch) must occur');
  assert.ok(getC.length >= 1, 'GET /customers/customer-123 must occur');
  assert.ok(putC.length >= 1, 'PUT /customers/customer-123 must occur');
  assert.ok(delC.length >= 1, 'DELETE /customers/customer-123 must occur');
  assert.ok(health.length >= 1);
  assert.ok(nf.length >= 1);

  // --- order check ---
  const orderNames = requestLog.map((r) => r.method + ' ' + r.path);
  const loginIdx = orderNames.indexOf('POST /login');
  const createIdx = orderNames.findIndex((x, i) => i > loginIdx && x === 'POST /customers');
  const getIdx = orderNames.findIndex((x, i) => i > createIdx && x === 'GET /customers/customer-123');
  const putIdx = orderNames.findIndex((x, i) => i > getIdx && x === 'PUT /customers/customer-123');
  const delIdx = orderNames.findIndex((x, i) => i > putIdx && x === 'DELETE /customers/customer-123');
  assert.ok(loginIdx >= 0 && createIdx > loginIdx && getIdx > createIdx && putIdx > getIdx && delIdx > putIdx,
    `expected chain order; got: ${orderNames.join(' | ')}`);

  // --- auth header check ---
  for (const r of [getC[0], putC[0], delC[0], createSuccessful[0]]) {
    assert.equal(r.headers['authorization'], BEARER, `expected Bearer token on ${r.method} ${r.path}`);
  }

  // --- dynamic variable runtime population ---
  const createBody = createSuccessful[0].bodyJson;
  assert.ok(createBody, 'create body must be valid JSON');
  assert.ok(typeof createBody.customer === 'object' && !Array.isArray(createBody.customer),
    'nested object preserved');
  assert.equal(createBody.flags.active, true, 'boolean preserved');
  assert.equal(createBody.quantity, 5, 'number preserved');
  assert.ok(typeof createBody.customer.name === 'string' && createBody.customer.name.length > 0,
    'first-name populated at runtime');
  assert.match(createBody.customer.email, /^user\d+@example\.test$/, 'random email populated at runtime');
  assert.match(createBody.metadata.requestId, /^[0-9a-f-]{8,}$/i, 'guid populated at runtime');
  assert.ok(/^\d+$/.test(String(createBody.metadata.createdAt)), 'timestamp populated at runtime');
  assert.doesNotMatch(createSuccessful[0].body, /\{\{/, 'no unresolved template left on wire');
  assert.doesNotMatch(createSuccessful[0].body, /__UNRESOLVED__/);
  assert.doesNotMatch(createSuccessful[0].body, /__UNSUPPORTED_DYNAMIC__/);

  // --- header check: custom + dynamic header values populated ---
  assert.equal(createSuccessful[0].headers['x-custom-header'], 'phase-d');
  assert.match(createSuccessful[0].headers['x-request-guid'] || '', /^[0-9a-f-]{8,}$/i);

  // --- query parameter check on GetCustomer ---
  assert.ok(getC[0].url.includes('limit=5'));
  assert.match(getC[0].url, /requestId=[0-9a-f-]{8,}/i);

  // --- k6 metrics / summary sanity ---
  const metrics = summary.metrics || {};
  const totalReqs = (metrics.http_reqs && (metrics.http_reqs.count ?? metrics.http_reqs.value)) || 0;
  assert.ok(totalReqs >= 8, `expected >=8 http_reqs, got ${totalReqs}`);

  // --- normalized report via the real file-based parser ---
  const summaryPath = path.join(tmpRoot, 'latest-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary));
  const parsed = await parseRunArtifacts({ summaryExportPath: summaryPath });
  assert.ok(parsed, 'parseRunArtifacts must return a parsed object');
  const normalized = buildNormalizedReport({ parsed, run: { exitCode } });
  assert.ok(normalized);
  assert.ok(typeof normalized === 'object');
});

test('PhD-3: unsupported dynamic var in body — zero requests reach target', async () => {
  resetLog();
  const col = {
    info: { name: 'phase-d-dyn-safety', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: baseUrl }],
    item: [
      {
        name: 'BadDynamic',
        request: {
          method: 'POST',
          url: { raw: '{{baseUrl}}/customers' },
          header: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Authorization', value: BEARER },
          ],
          body: {
            mode: 'raw',
            raw: '{"requestId":"{{$futureUnsupportedDynamicVariable}}"}',
            options: { raw: { language: 'json' } },
          },
        },
      },
    ],
  };
  const { code, executionModel } = generateScript(col, null);

  const badEntry = executionModel.requests.find((r) => r.name === 'BadDynamic');
  assert.equal(badEntry.execute, false);
  assert.equal(badEntry.skipReason, 'unsupported_dynamic_variable');

  const { code: exit } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99, `unexpected exit ${exit}`);

  const got = requestLog.filter((r) => r.path === '/customers');
  assert.equal(got.length, 0, 'no HTTP request must reach /customers');
});

test('PhD-4: selection closure — selecting GetCustomer runs only Login+Create+Get', async () => {
  resetLog();
  const col = fullCollection();
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
    workload: { profile: 'smoke', overrides: { vus: 1, hold: '3s' } },
    authSessionMode: 'SHARED_SESSION',
  });

  const { code: exit } = await runK6(code, {
    testUsername: 'alice',
    testPassword: 's3cret',
  });
  assert.ok(exit === 0 || exit === 99, `unexpected exit ${exit}`);

  const paths = requestLog.map((r) => r.method + ' ' + r.path);
  // Must contain the closure.
  assert.ok(paths.some((p) => p === 'POST /login'));
  assert.ok(paths.some((p) => p === 'POST /customers'));
  assert.ok(paths.some((p) => /^GET \/customers\/customer-123$/.test(p)));
  // Must NOT contain unrelated requests.
  assert.ok(!paths.some((p) => /^PUT \/customers\/customer-123$/.test(p)), 'PUT must not run');
  assert.ok(!paths.some((p) => /^DELETE \/customers\/customer-123$/.test(p)), 'DELETE must not run');
  assert.ok(!paths.includes('GET /health'), 'Health must not run');
  assert.ok(!paths.includes('GET /not-found'), 'NotFound must not run');
});

test('PhD-5: network/transport failure — unused local port classified as transport_failure', async () => {
  resetLog();
  // Bind-and-close a socket to grab a free port, then DO NOT re-listen on it.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  await new Promise((r) => probe.close(r));

  const col = {
    info: { name: 'phase-d-net-fail', schema: 'v2.1' },
    item: [
      {
        name: 'Unavailable',
        request: {
          method: 'GET',
          url: { raw: `http://127.0.0.1:${deadPort}/x` },
          header: [],
        },
      },
    ],
  };
  const { code } = generateScript(col, null);
  const { code: exit, summary } = await runK6(code, {});
  // The host is unreachable → k6 may exit 0 (with the request marked
  // failed) or 99 (threshold crossed). Both are acceptable here.
  assert.ok(exit === 0 || exit === 99, `unexpected exit ${exit}`);

  // No request reached our target server (it was never bound).
  assert.equal(requestLog.length, 0);

  // Transport failure must appear as http_req_failed, and either
  // perf_transport_failed>0 or http_req_failed indicates failure.
  const m = summary.metrics || {};
  const failedCount = (m.http_req_failed && (m.http_req_failed.passes ?? m.http_req_failed.value)) || 0;
  const transportFail = (m.perf_transport_failed && (m.perf_transport_failed.count ?? m.perf_transport_failed.value)) || 0;
  assert.ok(failedCount > 0 || transportFail > 0,
    `expected transport/http_req_failed > 0; got failedCount=${failedCount} transportFail=${transportFail}`);
});

test('PhD-6: generator determinism (modulo header timestamp) over 3 generations', () => {
  const col = fullCollection();
  const env = { name: 'env-1', values: [
    { key: 'baseUrl', value: baseUrl, enabled: true },
    { key: 'testUsername', value: 'a', enabled: true },
    { key: 'testPassword', value: 'b', enabled: true },
  ] };
  const strip = (s) => s.replace(/^\/\/ Generated:.*$/m, '');
  const a = generateScript(col, env).code;
  const b = generateScript(col, env).code;
  const c = generateScript(col, env).code;
  assert.equal(strip(a), strip(b));
  assert.equal(strip(b), strip(c));
});

test('PhD-7: regression — existing supported dynamic variables still populated on wire', async () => {
  // Covered implicitly by PhD-2's body check, but we also assert via the
  // auth-less /echo endpoint to isolate from the auth flow.
  resetLog();
  const col = {
    info: { name: 'phase-d-dynvar-echo', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: baseUrl }],
    item: [
      {
        name: 'Echo',
        request: {
          method: 'POST',
          url: { raw: '{{baseUrl}}/echo' },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: {
            mode: 'raw',
            raw: JSON.stringify({
              ts: '{{$timestamp}}',
              iso: '{{$isoTimestamp}}',
              guid: '{{$guid}}',
              uuid: '{{$randomUUID}}',
              n: '{{$randomInt}}',
              first: '{{$randomFirstName}}',
              last: '{{$randomLastName}}',
              email: '{{$randomEmail}}',
              uname: '{{$randomUserName}}',
              pwd: '{{$randomPassword}}',
              b: '{{$randomBoolean}}',
            }),
            options: { raw: { language: 'json' } },
          },
        },
      },
    ],
  };
  const { code } = generateScript(col, null);
  const { code: exit } = await runK6(code, {});
  assert.ok(exit === 0 || exit === 99);
  const echo = requestLog.find((r) => r.path === '/echo');
  assert.ok(echo, 'echo request must reach the server');
  const body = echo.bodyJson;
  assert.ok(body);
  assert.doesNotMatch(echo.body, /\{\{/, 'no unresolved template on wire');
  assert.doesNotMatch(echo.body, /__UNSUPPORTED_DYNAMIC__/);
  assert.doesNotMatch(echo.body, /__UNRESOLVED__/);
  assert.ok(/^\d+$/.test(String(body.ts)));
  assert.ok(String(body.iso).includes('T') && String(body.iso).includes('Z'));
  assert.match(String(body.email), /@example\.test$/);
  assert.match(String(body.uname), /^user_\d+$/);
  assert.ok(['true', 'false'].includes(String(body.b)));
});
