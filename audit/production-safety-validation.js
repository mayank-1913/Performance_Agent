'use strict';

/**
 * Production safety validation — real Console Mediasmart E2E + regression orchestration.
 * Does not add Postman features; validates current implementation only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execSync } = require('child_process');

const { parse } = require('../apps/api/src/lib/postman/parser');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');
const { parseIterationLifecycle } = require('../apps/worker-runner/src/streamHandler');

const ROOT = path.resolve(__dirname, '..');
const API_ROOT = path.join(ROOT, 'apps', 'api');
const AGENT_PORT = 4288;

const CONSOLE_COLLECTION_PATH = path.join(
  API_ROOT,
  'storage',
  'uploads',
  '1790073175067_e5c4e3d5-33f8-4cac-86b1-09b8ef38de44_Console_API_Monitoring_Mediasmart_postman_collection.json'
);
const CONSOLE_ENVIRONMENT_PATH = path.join(
  API_ROOT,
  'storage',
  'uploads',
  '1790073187998_027dbd43-c8f7-49a6-9ab4-59b414beb10f_Mediasmart_API_Environment_postman_environment.json'
);

const CHAIN_REQUESTS = [
  'Login',
  'createCampaign',
  'GetSingleCampaignById',
  'updateCampaign',
  'DeleteCTVCampaign',
];

const SECRET_PATTERNS = [
  { label: 'literal-password', re: /Mayank@841913/ },
  { label: 'literal-email', re: /mayank\.harsora@mediasmart\.io/ },
  { label: 'bearer-token', re: /Bearer\s+[A-Za-z0-9._-]{20,}/ },
  {
    label: 'password-field',
    re: /"password"\s*:\s*"(?!\$\{__coalesceVar)(?!\$\{__resolveLoginField)(?!LOGIN_PASSWORD)[^"]{3,}"/i,
  },
];

function redactText(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/"password"\s*:\s*"[^"]+"/gi, '"password":"<redacted>"');
  s = s.replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"<redacted>"');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
  s = s.replace(/Mayank@841913/g, '<redacted-password>');
  s = s.replace(/mayank\.harsora@mediasmart\.io/g, '<redacted-email>');
  return s.slice(0, 4000);
}

function formData(field, filename, value) {
  const boundary = `----prod-val-${Math.random().toString(36).slice(2)}`;
  return {
    boundary,
    body: [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${field}"; filename="${filename}"`,
      'Content-Type: application/json',
      '',
      JSON.stringify(value),
      `--${boundary}--`,
      '',
    ].join('\r\n'),
  };
}

async function api(method, route, body, token) {
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function upload(field, filename, value, token, endpoint) {
  const data = formData(field, filename, value);
  const res = await fetch(`http://127.0.0.1:${AGENT_PORT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${data.boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body: data.body,
  });
  return { status: res.status, json: await res.json() };
}

async function waitRun(token, runId, maxMs = 900_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const r = await api('GET', `/api/v1/runs/${runId}`, null, token);
    const status = r.json?.data?.status;
    if (['completed', 'failed', 'stopped'].includes(status)) return r.json.data;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('run wait timeout');
}

function runCommand(label, cmd, cwd) {
  try {
    const output = execSync(cmd, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    const passMatch = output.match(/# pass (\d+)/);
    const failMatch = output.match(/# fail (\d+)/);
    return {
      label,
      pass: true,
      passCount: passMatch ? Number(passMatch[1]) : null,
      failCount: failMatch ? Number(failMatch[0] && failMatch[1]) : 0,
      summary: passMatch ? `${passMatch[1]} pass` : 'ok',
    };
  } catch (err) {
    const out = `${err.stdout || ''}\n${err.stderr || ''}`;
    const passMatch = out.match(/# pass (\d+)/);
    const failMatch = out.match(/# fail (\d+)/);
    return {
      label,
      pass: false,
      passCount: passMatch ? Number(passMatch[1]) : null,
      failCount: failMatch ? Number(failMatch[1]) : null,
      summary: (err.message || 'failed').split('\n')[0],
      tail: out.split('\n').slice(-20).join('\n'),
    };
  }
}

function scanForSecrets(files) {
  const hits = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const { label, re } of SECRET_PATTERNS) {
      if (re.test(text)) hits.push({ file: path.relative(ROOT, file), kind: label });
    }
  }
  return hits;
}

function analyzeCreateCampaignGroup(scriptCode) {
  const group = scriptCode.match(/group\(`[^`]*createCampaign`[\s\S]*?\n  \}\);/i);
  if (!group) {
    return { found: false, pass: false, reason: 'createCampaign group not found in generated script' };
  }
  const block = group[0];
  const checks = {
    noLiteralPlaceholders: !/\{\{[^}]+\}\}/.test(block),
    noUnresolvedMarkers: !/__UNRESOLVED__/.test(block),
    hasStartedAtPmSet: /__pmSet\(state, 'environment', "started_at"/.test(block),
    hasFinishedAtPmSet: /__pmSet\(state, 'environment', "finished_at"/.test(block),
    hasDynamicStartedAtInBody: /"started_at":"\$\{/.test(block) || /started_at/.test(block),
    hasDynamicFinishedAtInBody: /"finished_at":"\$\{/.test(block) || /finished_at/.test(block),
    preservesNumericMaxDailyCost: /"max_daily_cost":10/.test(block) || /"max_daily_cost":\$\{/.test(block),
    preservesBooleanNullFields: /"connectedtv":true/.test(block) || /null/.test(block),
    singleAuthorizationHeader:
      (block.match(/Authorization/g) || []).length <= 2 &&
      !/Authorization[\s\S]*Authorization/.test(block.replace(/headers:\s*\{[\s\S]*?\}/, '')),
  };
  const pass = Object.values(checks).every(Boolean);
  return { found: true, pass, checks, snippet: redactText(block.slice(0, 1200)) };
}

function requestStatusesFromArtifacts(parsed, chainNames) {
  const byName = new Map();
  for (const name of chainNames) byName.set(name, { name, status: null, failed: false, skipped: false });
  for (const f of parsed.failures || []) {
    if (byName.has(f.name)) {
      byName.get(f.name).status = f.lastStatus;
      byName.get(f.name).failed = true;
    }
  }
  for (const row of parsed.summary?.requests?.byName || []) {
    if (byName.has(row.name) && row.count > 0 && !byName.get(row.name).status) {
      byName.get(row.name).status = row.lastStatus || '2xx';
    }
  }
  return Array.from(byName.values());
}

async function probeLoginAndCreate(loginBody) {
  const loginRes = await fetch('https://api.mediasmart.io/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginBody),
  });
  const loginText = await loginRes.text();
  let loginJson = null;
  try {
    loginJson = JSON.parse(loginText);
  } catch {
    loginJson = null;
  }
  const token = loginJson?.token || null;
  const today = new Date();
  const future = new Date(today);
  future.setDate(today.getDate() + 7);
  const toYMD = (d) => d.toISOString().split('T')[0];
  const createBody = {
    name: 'Test API CTV Campaign',
    advertiser: 'mediasmart-swwsby8uovz5chkj5wscxfqn8oz7nxln',
    countries: ['IND'],
    regions: [],
    cities: [],
    targeting: { geolist_acquisition: null, device_type: { connectedtv: true } },
    schedule: {
      max_impressions_user_day: '',
      max_impressions_user_hour: '',
      max_impressions_user: '',
      daily_limits_type: 'manual',
    },
    creatives: [],
    sync_campaign_creation: false,
    tracking_tool: 'none',
    type: 'smart-tv',
    started_at: toYMD(today),
    finished_at: toYMD(future),
    advanced: { goal_primary: { kpi: 'cpm', value: 1 } },
    strategy: {
      name: 'Strategy 1',
      cost_percentage: 100,
      deals_and_pricing: {
        cpa: null,
        cpc: null,
        cpm: 0.25,
        cpv: null,
        cpv_event: '',
        event_number_for_cpa: '',
        event_number_for_video_completion: '',
        max_cpm: null,
      },
    },
    max_daily_cost: 10,
    state: 'active',
  };
  let createRes = null;
  if (token) {
    createRes = await fetch('https://api.mediasmart.io/api/v2/campaign', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: String(token).startsWith('Bearer ') ? String(token) : `Bearer ${token}`,
      },
      body: JSON.stringify(createBody),
    });
  }
  const createText = createRes ? await createRes.text() : null;
  return {
    login: {
      status: loginRes.status,
      body: redactText(loginText),
      tokenPresent: !!token,
      tokenLength: token ? String(token).length : 0,
    },
    createProbe: createRes
      ? {
          status: createRes.status,
          body: redactText(createText),
          startedAt: createBody.started_at,
          finishedAt: createBody.finished_at,
        }
      : null,
  };
}

async function runConsoleLive() {
  const collectionSource = JSON.parse(fs.readFileSync(CONSOLE_COLLECTION_PATH, 'utf8'));
  const environmentSource = JSON.parse(fs.readFileSync(CONSOLE_ENVIRONMENT_PATH, 'utf8'));
  const parsedCollection = parse(collectionSource);
  const loginReq = parsedCollection.requests.find((r) => r.name === 'Login');
  const loginRaw = JSON.parse(loginReq.body.raw);
  const selectedIndices = parsedCollection.requests
    .map((r, i) => (CHAIN_REQUESTS.includes(r.name) ? i : -1))
    .filter((i) => i >= 0);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-console-live-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(tmp, 'db.sqlite');
  process.env.JWT_SECRET = 'prod-console-live-secret-32chars';
  process.env.ADMIN_USERNAME = 'prod-val';
  process.env.ADMIN_PASSWORD = 'prod-val-pass';
  process.env.LOG_LEVEL = 'error';

  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const admin = await api('POST', '/api/v1/auth/login', {
      username: 'prod-val',
      password: 'prod-val-pass',
    });
    const adminToken = admin.json?.data?.token;

    const uploadedCollection = await upload(
      'collection',
      'console-mediasmart.json',
      collectionSource,
      adminToken,
      '/api/v1/collections'
    );
    const uploadedEnv = await upload(
      'environment',
      'console-env.json',
      environmentSource,
      adminToken,
      '/api/v1/environments'
    );

    const generated = await api(
      'POST',
      '/api/v1/scripts/generate',
      {
        collectionId: uploadedCollection.json.data.id,
        environmentId: uploadedEnv.json.data.id,
        selection: { mode: 'requests', requestIndices: selectedIndices },
        options: {
          workload: {
            profile: 'smoke',
            authSessionMode: 'SHARED_SESSION',
            overrides: { vus: 1, hold: '5s' },
          },
          requestTimeout: '120s',
        },
      },
      adminToken
    );
    const script = generated.json.data;
    const scriptPath = path.join(API_ROOT, 'storage', 'scripts', `${script.id}.js`);
    const scriptCode = fs.readFileSync(scriptPath, 'utf8');
    const createCampaignAnalysis = analyzeCreateCampaignGroup(scriptCode);

    const runtimeEnv = { REQUEST_TIMEOUT: '120s', PACING_MS: '500' };
    const runtimeSecrets = {
      LOGIN_USERNAME: loginRaw.username,
      LOGIN_PASSWORD: loginRaw.password,
    };

    const prepared = await api(
      'POST',
      '/api/v1/runs/prepare',
      { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets },
      adminToken
    );

    const started = await api(
      'POST',
      '/api/v1/runs',
      { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets },
      adminToken
    );
    const run = await waitRun(adminToken, started.json.data.runId);

    const artifactDir = path.join(API_ROOT, 'storage', 'run-artifacts', run.runId);
    const logPath = path.join(API_ROOT, 'storage', 'run-logs', `${run.runId}.log`);
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    const logLines = logText.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]+\]\s*\[[^\]]+\]\s*/, ''));
    const iterationLifecycle = parseIterationLifecycle(logLines);
    const parsed = await parseRunArtifacts({
      summaryExportPath: path.join(artifactDir, 'summary.json'),
      metricsJsonPath: path.join(artifactDir, 'metrics.json'),
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs: run.durationMs,
      iterationLifecycle,
    });
    const normalized = buildNormalizedReport({
      parsed,
      run: {
        runId: run.runId,
        scriptId: script.id,
        status: run.status,
        exitCode: run.exitCode,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        authSession: prepared.json?.data?.authSession || null,
      },
      script,
    });

    const chainStatuses = requestStatusesFromArtifacts(parsed, CHAIN_REQUESTS);
    const skipLines = logText
      .split(/\r?\n/)
      .filter((l) => /\[skip\]/i.test(l) && CHAIN_REQUESTS.some((n) => l.includes(n)))
      .map(redactText);

    const failedRequests = (parsed.failures || [])
      .filter((f) => CHAIN_REQUESTS.includes(f.name))
      .map((f) => ({
        name: f.name,
        status: f.lastStatus,
        count: f.count,
        lastError: f.lastError ? redactText(String(f.lastError)) : null,
      }));

    const probe = await probeLoginAndCreate({
      username: loginRaw.username,
      password: loginRaw.password,
    });

    const artifactFiles = [
      scriptPath,
      logPath,
      path.join(artifactDir, 'summary.json'),
      path.join(artifactDir, 'metrics.json'),
      path.join(artifactDir, 'report.json'),
    ];
    const secretLeaks = scanForSecrets(artifactFiles);

    const pass =
      run.status === 'completed' &&
      run.exitCode === 0 &&
      createCampaignAnalysis.pass &&
      secretLeaks.length === 0 &&
      (parsed.summary?.requests?.httpFailures || 0) === 0 &&
      (normalized.failureCategorization?.dependencySkipped || 0) === 0 &&
      (parsed.failures || []).length === 0;

    return {
      pass,
      run: {
        runId: run.runId,
        status: run.status,
        exitCode: run.exitCode,
        authSessionMode: normalized.authSession?.authenticationMode,
      },
      createCampaignAnalysis,
      chainStatuses,
      failedRequests,
      skipLines,
      directApiProbe: probe,
      secretLeaks,
      metrics: {
        totalRequests: parsed.summary?.requests?.total,
        httpFailures: parsed.summary?.requests?.httpFailures,
        dependencySkipped: normalized.failureCategorization?.dependencySkipped,
        p95: parsed.summary?.responseTime?.p95,
      },
      prepareReady: prepared.json?.data?.ready,
    };
  } finally {
    server.close();
  }
}

function parseAuditStdout(out) {
  try {
    const jsonStart = out.indexOf('{');
    if (jsonStart >= 0) return JSON.parse(out.slice(jsonStart));
  } catch {
    return null;
  }
  return null;
}

async function runAuditScript(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  try {
    const out = execSync(`node "${scriptPath}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
    const parsed = parseAuditStdout(out);
    return { script: scriptName, pass: parsed?.pass !== false, parsed };
  } catch (err) {
    const out = `${err.stdout || ''}\n${err.stderr || ''}`;
    const parsed = parseAuditStdout(out);
    return {
      script: scriptName,
      pass: false,
      message: err.message,
      parsed,
      tail: out.slice(-1500),
    };
  }
}

async function main() {
  const startedAt = new Date().toISOString();
  const matrix = {};

  matrix.regression = {
    apiTests: runCommand('api-tests', 'npm test', API_ROOT),
    workerTests: runCommand('worker-tests', 'npm test', path.join(ROOT, 'apps', 'worker-runner')),
    frontendBuild: runCommand('frontend-build', 'npm run build', path.join(ROOT, 'apps', 'web')),
  };

  matrix.existingRegression =
    matrix.regression.apiTests.pass &&
    matrix.regression.workerTests.pass &&
    matrix.regression.frontendBuild.pass;

  console.log('[prod-val] running Console Mediasmart live validation...');
  matrix.consoleMediasmartLive = await runConsoleLive();

  console.log('[prod-val] running supporting E2E audits...');
  matrix.runtimeChaining = await runAuditScript('runtime-chain-e2e.js');
  matrix.genericPostmanCert = await runAuditScript('generic-postman-certification.js');
  matrix.multiVuAuth = await runAuditScript('multi-vu-auth-certification.js');
  matrix.mediasmartMockE2E = await runAuditScript('mediasmart-runtime-e2e.js');
  matrix.phase7Static = await runAuditScript('phase7-certify.js');
  matrix.consolePrerequestCodegen = await runAuditScript('postman-console-prerequest-validation.js');

  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    matrix: {
      existingRegression: matrix.existingRegression ? 'PASS' : 'FAIL',
      realMediasmartConsole: matrix.consoleMediasmartLive.pass ? 'PASS' : 'FAIL',
      consolePrerequest: matrix.consolePrerequestCodegen.pass ? 'PASS' : 'FAIL',
      runtimeChaining: matrix.runtimeChaining.pass ? 'PASS' : 'FAIL',
      perVuLogin:
        matrix.multiVuAuth.parsed?.analyzed?.filter((s) => /^[ABC]-/.test(s.label)).every((s) => s.result === 'PASS')
          ? 'PASS'
          : 'FAIL',
      sharedSession:
        matrix.multiVuAuth.parsed?.analyzed?.find((s) => s.label === 'D-3vu-shared-session')?.result === 'PASS'
          ? 'PASS'
          : 'FAIL',
      manualToken:
        matrix.multiVuAuth.parsed?.analyzed?.find((s) => s.label === 'E-manual-token-3vu')?.result === 'PASS'
          ? 'PASS'
          : 'FAIL',
      staticBody: matrix.phase7Static.pass ? 'PASS' : 'FAIL',
      dynamicBody: matrix.regression.apiTests.pass ? 'PASS' : 'FAIL',
      requestLocalVariables: matrix.regression.apiTests.pass ? 'PASS' : 'FAIL',
      dynamicVariables: matrix.regression.apiTests.pass ? 'PASS' : 'FAIL',
      unresolvedVariableSafety: matrix.regression.apiTests.pass ? 'PASS' : 'FAIL',
      genericPostmanCertification: matrix.genericPostmanCert.pass ? 'PASS' : 'FAIL',
      mediasmartMockE2E: matrix.mediasmartMockE2E.pass ? 'PASS' : 'FAIL',
    },
    details: matrix,
  };

  const outPath = path.join(__dirname, 'production-safety-validation-report.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ matrix: report.matrix, outPath }, null, 2));

  const anyFail = Object.values(report.matrix).some((v) => v === 'FAIL');
  if (anyFail) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[production-safety-validation] FAIL', err.message);
  console.error(err.stack);
  process.exitCode = 1;
});
