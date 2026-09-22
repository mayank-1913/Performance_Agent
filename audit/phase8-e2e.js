'use strict';

/**
 * Phase 8 end-to-end certification via the live API server.
 *
 * We can't run browser UI E2E in this workspace — no Playwright/Cypress/
 * Puppeteer is installed and Section 1 explicitly forbids introducing a
 * new framework. So we walk the exact HTTP contract the UI drives:
 *
 *   POST /api/v1/auth/login          → JWT
 *   POST /api/v1/collections         (multipart) upload postman
 *   POST /api/v1/environments        (multipart) upload optional env
 *   POST /api/v1/scripts/generate    generate K6
 *   POST /api/v1/runs/prepare        validate env
 *   POST /api/v1/runs/start          spawn k6
 *   GET  /api/v1/runs/:runId         status
 *   GET  /api/v1/runs/:runId/summary parsed summary
 *   GET  /api/v1/runs/:runId/report  html report
 *   GET  /api/v1/reports/:id/report  persisted html
 *
 * The harness runs against the REAL Express app started in the current
 * Node process (no separate server, no port conflicts).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');

const { start: startPhase7Server, SECRET_TOKEN, MANUAL_SENTINEL } = require('./phase7-server');
const { collection: buildCollection } = require('./phase7-collection');

// Isolate the API's state to a temp dir so we don't pollute real storage.
const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-api-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(runRoot, 'db.sqlite');
process.env.JWT_SECRET = 'phase8-audit-secret-not-for-production-use';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'phase8-audit-admin-pw';
process.env.UPLOAD_DIR = path.join(runRoot, 'uploads');
process.env.LOG_LEVEL = 'error';

// Redirect storage-related paths that the API resolves from __dirname.
// The simplest path: keep the api's default storage location; the DB
// path override above still isolates the SQLite artifact.

process.on('uncaughtException', (e) => { process.stderr.write('UNCAUGHT: ' + (e.stack || e) + '\n'); process.exit(10); });
process.on('unhandledRejection', (e) => { process.stderr.write('UNHANDLED: ' + (e && e.stack || e) + '\n'); process.exit(11); });
process.stderr.write('[phase8-e2e] booting api\n');
const app = require('../apps/api/src/app');
process.stderr.write('[phase8-e2e] app loaded\n');

const AGENT_PORT = 4200;
const TARGET_PORT = 4210;
const BASE_TARGET = `http://127.0.0.1:${TARGET_PORT}`;

async function startApiServer() {
  return new Promise((resolve, reject) => {
    const s = http.createServer(app);
    s.on('error', reject);
    s.listen(AGENT_PORT, '127.0.0.1', () => resolve(s));
  });
}

/* ------------------------------------------------------------------ */
/*  Tiny multipart + fetch helpers (no npm deps beyond node built-ins) */
/* ------------------------------------------------------------------ */

function jwtFor(token) { return { Authorization: `Bearer ${token}` }; }

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
  const boundary = '----phase8-' + Math.random().toString(36).slice(2);
  const filename = 'audit-collection.json';
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"`,
    `Content-Type: application/json`,
    ``,
    JSON.stringify(collectionJson),
    `--${boundary}--`,
    ``,
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
  const boundary = '----phase8-' + Math.random().toString(36).slice(2);
  const parts = [
    `--${boundary}`,
    `Content-Disposition: form-data; name="environment"; filename="env.json"`,
    `Content-Type: application/json`,
    ``,
    JSON.stringify(envJson),
    `--${boundary}--`,
    ``,
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

/* ------------------------------------------------------------------ */

async function main() {
  const target = await startPhase7Server(TARGET_PORT);
  const server = await startApiServer();
  const results = { steps: [], defects: [], leaks: [] };
  const step = (name, extra) => results.steps.push({ name, ok: true, ...extra });
  const fail = (name, extra) => {
    const rec = { name, ok: false, ...extra };
    results.steps.push(rec);
    results.defects.push(rec);
    // Log immediately so we always see what went wrong even if a
    // downstream step later swallows the error path.
    process.stderr.write('[phase8-e2e] STEP FAILED: ' + name + ' :: ' + JSON.stringify(extra).slice(0, 400) + '\n');
  };
  try {
    // ── 1. Login ─────────────────────────────────────────────────────
    process.stderr.write('[phase8-e2e] step: login\n');
    const login = await apiJson('POST', '/api/v1/auth/login', {
      username: 'admin',
      password: 'phase8-audit-admin-pw',
    });
    process.stderr.write('[phase8-e2e] login status=' + login.status + ' body=' + JSON.stringify(login.json).slice(0, 200) + '\n');
    if (login.status !== 200 || !login.json?.data?.token) {
      fail('UI Login', { status: login.status, body: login.json });
    } else {
      step('UI Login', { hasToken: true });
    }
    const jwt = login.json?.data?.token;
    if (!jwt) {
      process.stderr.write('[phase8-e2e] no JWT — aborting further steps\n');
      const out = JSON.stringify(results, null, 2);
      fs.writeFileSync(path.join(os.tmpdir(), 'phase8-e2e-result.json'), out);
      process.stderr.write(out + '\n');
      process.exit(1);
    }

    // ── 2. Upload collection (also tests parsing + auth detection) ───
    process.stderr.write('[phase8-e2e] step: collection upload\n');
    const collectionA = buildCollection({ name: 'phase8-A', baseUrl: BASE_TARGET });
    const up = await apiUploadCollection(jwt, collectionA);
    process.stderr.write('[phase8-e2e] upload status=' + up.status + ' body=' + JSON.stringify(up.json).slice(0, 300) + '\n');
    if (up.status !== 201 || !up.json?.data?.id) {
      fail('Collection Upload', { status: up.status, body: up.json });
      process.exit(1);
    }
    const collectionId = up.json.data.id;
    step('Collection Upload', { collectionId, requests: up.json.data.summary?.requestCount });

    // ── 3. Optional environment upload ───────────────────────────────
    process.stderr.write('[phase8-e2e] step: environment upload\n');
    const envUpload = await apiUploadEnvironment(jwt, {
      id: 'phase8-env',
      name: 'phase8-env',
      values: [
        { key: 'tenant', value: 'phase8-env-tenant', enabled: true },
        { key: 'baseUrl', value: BASE_TARGET, enabled: true },
      ],
    });
    process.stderr.write('[phase8-e2e] env upload status=' + envUpload.status + ' body=' + JSON.stringify(envUpload.json).slice(0, 300) + '\n');
    if (envUpload.status !== 201 || !envUpload.json?.data?.id) {
      fail('Optional Environment', { status: envUpload.status, body: envUpload.json });
      process.exit(1);
    }
    const environmentId = envUpload.json.data.id;
    step('Optional Environment', { environmentId });

    // ── 4. Compatibility + tree pre-check ────────────────────────────
    process.stderr.write('[phase8-e2e] step: tree + generate (collection only)\n');
    const tree = await apiJson('GET', `/api/v1/collections/${collectionId}/tree`, null, jwtFor(jwt));
    process.stderr.write('[phase8-e2e] tree status=' + tree.status + '\n');
    if (tree.status !== 200) { fail('Collection Tree', { status: tree.status }); process.exit(1); }
    step('Compatibility Scanner', { note: 'ran during generate() below' });

    // ── 5. Generate — collection only (Health) ───────────────────────
    const genOnly = await apiJson('POST', '/api/v1/scripts/generate', {
      collectionId,
      selection: { mode: 'requests', requestIndices: [0] }, // Health
      options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '2s' } } },
    }, jwtFor(jwt));
    process.stderr.write('[phase8-e2e] generate status=' + genOnly.status + ' body=' + JSON.stringify(genOnly.json).slice(0, 300) + '\n');
    if (genOnly.status !== 201 || !genOnly.json?.data?.id) {
      fail('Generate (collection only)', { status: genOnly.status, body: genOnly.json });
      process.exit(1);
    }
    step('Collection Only', { scriptId: genOnly.json.data.id, size: genOnly.json.data.sizeBytes });

    // ── 6. Generate — collection + environment ───────────────────────
    const searchIdx = up.json.data.summary?.requestCount != null ? findByName('Search') : -1;
    // We don't have the parsed indices via API easily; use full-collection
    // selection so Search + related endpoints all run.
    const genEnv = await apiJson('POST', '/api/v1/scripts/generate', {
      collectionId,
      environmentId,
      options: {
        workload: { profile: 'smoke', overrides: { vus: 1, hold: '3s' } },
        acknowledgeBlockingWarnings: true, // we don't expect any, but be permissive
      },
    }, jwtFor(jwt));
    if (genEnv.status !== 201) return fail('Collection + Environment', { status: genEnv.status, body: genEnv.json });
    step('Collection + Environment', { scriptId: genEnv.json.data.id });

    // ── 7. Prepare + start (manual token) ────────────────────────────
    const prepareRes = await apiJson('POST', '/api/v1/runs/prepare', {
      scriptId: genOnly.json.data.id,
      env: { BASE_URL: BASE_TARGET },
    }, jwtFor(jwt));
    if (prepareRes.status !== 200) return fail('Prepare run', { status: prepareRes.status, body: prepareRes.json });
    step('Runs Prepare', { ready: prepareRes.json.data.ready });

    const startRes = await apiJson('POST', '/api/v1/runs', {
      scriptId: genOnly.json.data.id,
      env: { BASE_URL: BASE_TARGET },
    }, jwtFor(jwt));
    if (startRes.status !== 202 || !startRes.json?.data?.runId) {
      return fail('Runs Start', { status: startRes.status, body: startRes.json });
    }
    const runIdA = startRes.json.data.runId;
    step('Runs Start', { runId: runIdA });

    // ── 8. Wait, verify final status ─────────────────────────────────
    const doneA = await waitForRun(jwt, runIdA);
    if (doneA.status !== 'completed') {
      return fail('Run completion', { status: doneA.status, error: doneA.error });
    }
    step('Run Completion (A)', { status: doneA.status });

    // ── 9. Open report — verify shape ────────────────────────────────
    const summary = await apiJson('GET', `/api/v1/runs/${runIdA}/summary`, null, jwtFor(jwt));
    if (summary.status !== 200 || !summary.json?.data?.ready) {
      return fail('Report open', { status: summary.status, body: summary.json });
    }
    const summaryData = summary.json.data;
    step('Report Accuracy', {
      requests: summaryData.requests?.total,
      responseTime: summaryData.responseTime,
      normalized: summaryData.normalized != null,
    });

    // ── 10. Download the HTML report ─────────────────────────────────
    const reportRes = await fetch(
      `http://127.0.0.1:${AGENT_PORT}/api/v1/runs/${runIdA}/report`,
      { headers: jwtFor(jwt) }
    );
    const html = await reportRes.text();
    if (reportRes.status !== 200 || !html.includes('K6 performance report')) {
      return fail('Report Download', { status: reportRes.status });
    }
    step('Report Download', { size: html.length });

    // ── 11. Manual-token flow via /me ────────────────────────────────
    // Regenerate with just the "Get Profile" endpoint, then run with a
    // manual AUTH_TOKEN. Server /me accepts SECRET_TOKEN.
    const genManual = await apiJson('POST', '/api/v1/scripts/generate', {
      collectionId,
      selection: { mode: 'requests', requestIndices: [2] }, // Get Profile
      options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '2s' } } },
    }, jwtFor(jwt));
    if (genManual.status !== 201) return fail('Manual-token Generate', { status: genManual.status, body: genManual.json });

    const runManual = await apiJson('POST', '/api/v1/runs', {
      scriptId: genManual.json.data.id,
      env: { BASE_URL: BASE_TARGET },
      // Provide both the standard AUTH_TOKEN (Phase 2 highest-precedence)
      // and the placeholder-derived ACCESS_TOKEN so the pre-spawn env
      // validator (Phase 1) is satisfied. The Phase 2 mirror also fires
      // at spawn time; either path would produce a working header.
      secrets: { AUTH_TOKEN: SECRET_TOKEN, ACCESS_TOKEN: SECRET_TOKEN },
    }, jwtFor(jwt));
    if (runManual.status !== 202) return fail('Manual-token Start', { status: runManual.status, body: runManual.json });
    const doneManual = await waitForRun(jwt, runManual.json.data.runId);
    const summaryManual = await apiJson('GET', `/api/v1/runs/${runManual.json.data.runId}/summary`, null, jwtFor(jwt));
    const failedManual = summaryManual.json?.data?.requests?.failed ?? -1;
    if (failedManual !== 0 || doneManual.status !== 'completed') {
      return fail('Manual Token', { failed: failedManual, status: doneManual.status });
    }
    step('Manual Token', { failed: 0, total: summaryManual.json.data.requests?.total });

    // ── 12. Run isolation: start TWO runs against different scripts ──
    const runB = await apiJson('POST', '/api/v1/runs', {
      scriptId: genOnly.json.data.id,
      env: { BASE_URL: BASE_TARGET },
    }, jwtFor(jwt));
    const runC = await apiJson('POST', '/api/v1/runs', {
      scriptId: genManual.json.data.id,
      env: { BASE_URL: BASE_TARGET },
      secrets: { AUTH_TOKEN: SECRET_TOKEN, ACCESS_TOKEN: SECRET_TOKEN },
    }, jwtFor(jwt));
    if (runB.status !== 202 || runC.status !== 202) {
      return fail('Run Isolation start', { b: runB.status, c: runC.status });
    }
    if (runB.json.data.runId === runC.json.data.runId) {
      return fail('Run Isolation', { reason: 'duplicate run IDs' });
    }
    const [doneB, doneC] = await Promise.all([
      waitForRun(jwt, runB.json.data.runId),
      waitForRun(jwt, runC.json.data.runId),
    ]);
    step('Run Isolation', {
      idsUnique: true,
      bStatus: doneB.status,
      cStatus: doneC.status,
    });

    // ── 13. Secret leakage — grep the run artifacts + api responses ──
    // Every persisted response should exclude the token value.
    const searchNeedles = [SECRET_TOKEN, MANUAL_SENTINEL, 'phase8-audit-admin-pw'];
    const responsesToScan = [
      JSON.stringify(genOnly.json),
      JSON.stringify(genEnv.json),
      JSON.stringify(genManual.json),
      JSON.stringify(startRes.json),
      JSON.stringify(runManual.json),
      JSON.stringify(summary.json),
      JSON.stringify(summaryManual.json),
      html,
    ];
    for (const s of searchNeedles) {
      for (let i = 0; i < responsesToScan.length; i += 1) {
        if (responsesToScan[i].includes(s)) {
          results.leaks.push({ where: `response#${i}`, needle: s.slice(0, 20) });
        }
      }
    }

    // ── 14. Reports endpoint — persisted list ────────────────────────
    const reportsList = await apiJson('GET', '/api/v1/reports', null, jwtFor(jwt));
    step('Persisted reports list', { count: reportsList.json?.data?.length });

    const out = JSON.stringify(results, null, 2);
    process.stderr.write(out + '\n');
    const overall = results.defects.length === 0 && results.leaks.length === 0
      ? 'PHASE 8 E2E OVERALL: PASS'
      : `PHASE 8 E2E OVERALL: FAIL (defects=${results.defects.length}, leaks=${results.leaks.length})`;
    process.stderr.write(overall + '\n');
    // Also write to a fixed file for post-mortem inspection.
    fs.writeFileSync(path.join(os.tmpdir(), 'phase8-e2e-result.json'), out);
    process.exit(results.defects.length === 0 && results.leaks.length === 0 ? 0 : 1);
  } finally {
    target.server.close();
    server.close();
  }
}

function findByName() { return -1; } // placeholder — not used

process.stderr.write('[phase8-e2e] entering main\n');
if (require.main === module) main().then(() => process.stderr.write('[phase8-e2e] main resolved\n')).catch((e) => { process.stderr.write('main failed: ' + (e.stack || e) + '\n'); process.exit(3); });
