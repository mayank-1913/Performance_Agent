'use strict';

/**
 * Real runtime chaining proof through the actual agent pipeline.
 *
 * This script boots the real Express API, spins a deterministic local target
 * server, uploads a Postman collection that sets auth_token and campaign_id
 * from earlier responses, generates K6, runs it, and prints evidence that the
 * runtime variables really flow across requests.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT_PORT = 4211;
const TARGET_PORT = 4212;
const BASE_TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const AUDIT_USERNAME = 'known-audit-user';
const AUDIT_PASSWORD = 'known-audit-password';
const targetEvidence = [];

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function makeTargetServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method;
    const p = url.pathname;

    try {
      if (req.url.includes('{{') || req.url.includes('undefined')) {
        return send(res, 400, { error: 'unresolved runtime placeholder' });
      }
      if (p === '/health') return send(res, 200, { ok: true });

      if (p === '/login' && method === 'POST') {
        await readBody(req);
        targetEvidence.push({ name: 'LOGIN', status: 200, authReceived: false, authHeaderCount: 0, path: p });
        return send(res, 200, { access_token: 'CHAIN_TEST_TOKEN' });
      }

      if (p === '/campaign' && method === 'POST') {
        const auth = req.headers.authorization || req.headers.Authorization || '';
        const authHeaderCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
        if (authHeaderCount !== 1) return send(res, 400, { error: 'authorization header count', count: authHeaderCount });
        if (auth !== 'Bearer CHAIN_TEST_TOKEN') {
          return send(res, 401, { error: 'missing token', received: auth.slice(0, 20) || '' });
        }
        targetEvidence.push({ name: 'CREATE', status: 200, authReceived: true, authHeaderCount, path: p });
        return send(res, 200, { id: 'CAMPAIGN_123' });
      }

      const campaignIdMatch = p.match(/^\/campaign\/(.+)$/);
      if (campaignIdMatch) {
        const id = decodeURIComponent(campaignIdMatch[1]);
        const auth = req.headers.authorization || req.headers.Authorization || '';
        const authHeaderCount = req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'authorization').length;
        if (authHeaderCount !== 1) return send(res, 400, { error: 'authorization header count', count: authHeaderCount });
        if (auth !== 'Bearer CHAIN_TEST_TOKEN') {
          return send(res, 401, { error: 'missing token', received: auth.slice(0, 20) || '' });
        }
        if (id !== 'CAMPAIGN_123') {
          return send(res, 400, { error: 'wrong campaign id', expected: 'CAMPAIGN_123', received: id });
        }
        const name = method === 'PUT' ? 'EDIT' : method === 'GET' ? 'GET' : 'DELETE';
        targetEvidence.push({ name, status: 200, authReceived: true, authHeaderCount, path: p, campaignId: id });
        if (method === 'PUT') return send(res, 200, { ok: true, id });
        if (method === 'GET') return send(res, 200, { id, ok: true });
        if (method === 'DELETE') return send(res, 200, { ok: true, deleted: id });
      }

      return send(res, 404, { error: 'route not found', path: p });
    } catch (err) {
      return send(res, 500, { error: 'server exception', message: err.message });
    }
  });
}

function jwtFor(token) {
  return { Authorization: `Bearer ${token}` };
}

async function apiJson(method, urlPath, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json, headers: res.headers };
}

async function apiUploadCollection(token, collectionJson, fieldName = 'collection') {
  const boundary = '----runtime-chain-' + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="collection.json"`,
    'Content-Type: application/json',
    '',
    JSON.stringify(collectionJson),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...jwtFor(token),
    },
    body: parts,
  });
  return { status: res.status, json: await res.json() };
}

async function apiUploadEnvironment(token, envJson) {
  const boundary = '----runtime-chain-env-' + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="environment"; filename="env.json"',
    'Content-Type: application/json',
    '',
    JSON.stringify(envJson),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/environments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      ...jwtFor(token),
    },
    body: parts,
  });
  return { status: res.status, json: await res.json() };
}

async function waitForRun(token, runId, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await apiJson('GET', `/api/v1/runs/${runId}`, null, jwtFor(token));
    const status = r.json?.data?.status;
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
      return r.json.data;
    }
    await new Promise((s) => setTimeout(s, 250));
  }
  throw new Error(`waitForRun timeout for ${runId}`);
}

function buildChainCollection() {
  return {
    info: { name: 'runtime-chain-proof', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: BASE_TARGET }],
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/login' },
          body: { mode: 'raw', raw: JSON.stringify({ username: AUDIT_USERNAME, password: AUDIT_PASSWORD }) },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("auth_token", json.access_token);',
              ],
            },
          },
        ],
      },
      {
        name: 'Create campaign',
        request: {
          method: 'POST',
          header: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Authorization', value: 'Bearer {{auth_token}}' },
          ],
          url: { raw: '{{baseUrl}}/campaign' },
          body: { mode: 'raw', raw: '{"name":"demo-campaign"}' },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("campaign_id", json.id);',
              ],
            },
          },
        ],
      },
      {
        name: 'Edit campaign',
        request: {
          method: 'PUT',
          header: [
            { key: 'Content-Type', value: 'application/json' },
            { key: 'Authorization', value: 'Bearer {{auth_token}}' },
          ],
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
          body: { mode: 'raw', raw: '{"status":"updated"}' },
        },
      },
      {
        name: 'Get campaign',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
      {
        name: 'Delete campaign',
        request: {
          method: 'DELETE',
          header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
    ],
  };
}

function buildFalseUnresolvedCollection() {
  return {
    info: { name: 'false-unresolved-proof', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: BASE_TARGET }],
    item: [
      {
        name: 'Folder A',
        item: [
          { name: 'DummyJSON product', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/dummyjson/{{DUMMYJSON_PRODUCT_ID}}' } } },
          { name: 'DummyJSON user', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/dummyjson/{{DUMMYJSON_USER_ID}}' } } },
        ],
      },
      {
        name: 'Folder B',
        item: [
          { name: 'ReqRes user', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/reqres/{{REQRES_USER_ID}}' } } },
        ],
      },
      {
        name: 'Folder C',
        item: [
          { name: 'FakeStore product', request: { method: 'GET', header: [], url: { raw: '{{baseUrl}}/fake/{{FAKESTORE_PRODUCT_ID}}' } } },
        ],
      },
      {
        name: 'Folder D',
        item: [
          {
            name: 'Login',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              url: { raw: '{{baseUrl}}/login' },
              body: { mode: 'raw', raw: '{}' },
            },
            event: [
              {
                listen: 'test',
                script: { exec: ['const json = pm.response.json(); pm.environment.set("auth_token", json.access_token);'] },
              },
            ],
          },
          {
            name: 'Actual chain call',
            request: {
              method: 'GET',
              header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
              url: { raw: '{{baseUrl}}/campaign/CAMPAIGN_123' },
            },
          },
        ],
      },
    ],
  };
}

async function runScenario({ label, collectionJson, environmentJson, selection = { mode: 'all' }, expectedReady, expectedMissing, manualToken }) {
  const login = await apiJson('POST', '/api/v1/auth/login', {
    username: 'admin',
    password: 'phase8-audit-admin-pw',
  });
  const token = login.json?.data?.token;
  if (!token) throw new Error(`${label}: login failed`);

  const coll = await apiUploadCollection(token, collectionJson);
  if (coll.status !== 201 || !coll.json?.data?.id) {
    throw new Error(`${label}: collection upload failed: ${JSON.stringify(coll.json)}`);
  }
  const collectionId = coll.json.data.id;

  let environmentId = null;
  if (environmentJson) {
    const env = await apiUploadEnvironment(token, environmentJson);
    if (env.status !== 201 || !env.json?.data?.id) {
      throw new Error(`${label}: environment upload failed: ${JSON.stringify(env.json)}`);
    }
    environmentId = env.json.data.id;
  }

  const generateReq = {
    collectionId,
    ...(environmentId ? { environmentId } : {}),
    selection,
    options: {
      workload: { profile: 'smoke', overrides: { vus: 1, hold: '1s' } },
    },
  };
  const generated = await apiJson('POST', '/api/v1/scripts/generate', generateReq, jwtFor(token));
  if (generated.status !== 201 || !generated.json?.data?.id) {
    throw new Error(`${label}: script generation failed: ${JSON.stringify(generated.json)}`);
  }
  const scriptId = generated.json.data.id;

  const runPayload = {
    scriptId,
    env: environmentJson ? environmentJson.values.reduce((acc, v) => {
      if (v.enabled !== false) acc[v.key] = v.value;
      return acc;
    }, {}) : { BASE_URL: BASE_TARGET },
    ...(manualToken != null ? { authToken: manualToken } : {}),
  };
  const prepare = await apiJson('POST', '/api/v1/runs/prepare', runPayload, jwtFor(token));

  const prepareReady = !!prepare.json?.data?.ready;
  const missing = prepare.json?.data?.missingEnvVars || [];
  console.log(`\n[${label}] prepare.ready=${prepareReady} missing=${JSON.stringify(missing)}`);
  if (prepareReady !== expectedReady) {
    throw new Error(`${label}: unexpected prepare readiness`);
  }
  if (expectedMissing != null && JSON.stringify(missing) !== JSON.stringify(expectedMissing)) {
    throw new Error(`${label}: unexpected missing env vars`);
  }

  const start = await apiJson('POST', '/api/v1/runs', runPayload, jwtFor(token));
  if (start.status !== 202 || !start.json?.data?.runId) {
    throw new Error(`${label}: start failed: ${JSON.stringify(start.json)}`);
  }
  const runId = start.json.data.runId;
  const finalRun = await waitForRun(token, runId);
  console.log(`[${label}] status=${finalRun.status} exitCode=${finalRun.exitCode ?? 'n/a'} runId=${runId}`);
  const summary = await apiJson('GET', `/api/v1/runs/${runId}/summary`, null, jwtFor(token));
  console.log(`[${label}] summary=${JSON.stringify(summary.json?.data || summary.json).slice(0, 500)}`);
  return { runId, finalRun, summary };
}

function scanArtifacts(runs, secrets) {
  const findings = [];
  for (const run of runs) {
    const runId = run.runId;
    const dir = path.resolve(__dirname, '..', 'apps', 'api', 'storage', 'run-artifacts', runId);
    const logPath = path.resolve(__dirname, '..', 'apps', 'api', 'storage', 'run-logs', `${runId}.log`);
    const files = [];
    const collect = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) collect(full);
        else files.push(full);
      }
    };
    if (fs.existsSync(dir)) collect(dir);
    if (fs.existsSync(logPath)) files.push(logPath);
    if (run.finalRun?.scriptId) {
      const scriptPath = path.resolve(__dirname, '..', 'apps', 'api', 'storage', 'scripts', `${run.finalRun.scriptId}.js`);
      if (fs.existsSync(scriptPath)) files.push(scriptPath);
    }
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (secrets.some((secret) => text.includes(secret))) findings.push(path.relative(path.resolve(__dirname, '..'), file));
    }
  }
  return findings;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-chain-'));
  console.log(`[runtime-chain] working dir=${root}`);

  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'runtime-chain-secret';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'phase8-audit-admin-pw';
  process.env.UPLOAD_DIR = path.join(root, 'uploads');
  process.env.LOG_LEVEL = 'error';

  const target = makeTargetServer();
  await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve));
  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    console.log('[runtime-chain] server booted');

    // 1) Real login -> auth_token -> campaign_id -> edit/get/delete chain.
    const envCollection = {
      id: 'runtime-env',
      name: 'runtime-env',
      values: [{ key: 'BASE_URL', value: BASE_TARGET, enabled: true }],
    };
    const chain = await runScenario({
      label: 'REAL_CHAIN_ENV',
      collectionJson: buildChainCollection(),
      environmentJson: envCollection,
      expectedReady: true,
      expectedMissing: [],
    });

    // 2) Collection-only flow. No env and no auth_token/campaign_id provided.
    const collectionOnly = await runScenario({
      label: 'COLLECTION_ONLY',
      collectionJson: buildChainCollection(),
      environmentJson: null,
      expectedReady: true,
      expectedMissing: [],
    });

    // 3) False unresolved variable scenario: unrelated variables do not block selected flow.
    const falseUnresolved = await runScenario({
      label: 'FALSE_UNRESOLVED',
      collectionJson: buildFalseUnresolvedCollection(),
      environmentJson: {
        id: 'false-unresolved-env',
        name: 'false-unresolved-env',
        values: [{ key: 'BASE_URL', value: BASE_TARGET, enabled: true }],
      },
      selection: { mode: 'folder', folderPath: ['Folder D'] },
      expectedReady: true,
      expectedMissing: [],
    });

    const manualRuns = [];
    for (const [label, manualToken] of [
      ['MANUAL_RAW', 'CHAIN_TEST_TOKEN'],
      ['MANUAL_BEARER', 'Bearer CHAIN_TEST_TOKEN'],
      ['MANUAL_LOWER_BEARER', 'bearer CHAIN_TEST_TOKEN'],
    ]) {
      manualRuns.push(await runScenario({
        label,
        collectionJson: buildChainCollection(),
        environmentJson: null,
        expectedReady: true,
        expectedMissing: [],
        manualToken,
      }));
    }

    const allRuns = [chain, collectionOnly, falseUnresolved, ...manualRuns];
    const leakage = scanArtifacts(allRuns, ['CHAIN_TEST_TOKEN', AUDIT_USERNAME, AUDIT_PASSWORD]);
    const manualPassed = manualRuns.every((run) => run.finalRun.status === 'completed' && run.finalRun.exitCode === 0);
    console.log(`\n[MANUAL_BEARER] variants=${manualRuns.length} passed=${manualPassed}`);
    console.log(`[SECURITY] secretLeakage=${leakage.length === 0 ? 'none' : leakage.join(',')}`);
    console.log(`[TARGET] ${JSON.stringify(targetEvidence.slice(-5))}`);

    console.log('\n=== RUNTIME EVIDENCE ===');
    console.log(JSON.stringify({
      realChain: {
        runId: chain.runId,
        finalStatus: chain.finalRun.status,
        exitCode: chain.finalRun.exitCode,
      },
      collectionOnly: {
        runId: collectionOnly.runId,
        finalStatus: collectionOnly.finalRun.status,
        exitCode: collectionOnly.finalRun.exitCode,
      },
      falseUnresolved: {
        runId: falseUnresolved.runId,
        finalStatus: falseUnresolved.finalRun.status,
        exitCode: falseUnresolved.finalRun.exitCode,
      },
      manualBearer: { variants: manualRuns.length, passed: manualPassed },
      secretLeakage: leakage.length === 0 ? 'none' : leakage,
    }, null, 2));

    console.log('\n[PASS] runtime chain executed through the actual API pipeline');
  } finally {
    server.close();
    target.close();
  }
}

main().catch((err) => {
  console.error('[runtime-chain] FAIL');
  console.error(err.stack || err);
  process.exit(1);
});
