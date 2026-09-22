'use strict';

/**
 * Live Mediasmart load-profile validation (10 VUs, REQUEST_TIMEOUT=120s).
 * Verifies secret-safe logging, HTTP vs transport classification, and iteration lifecycle.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');
const { parseIterationLifecycle, redactLine } = require('../apps/worker-runner/src/streamHandler');

const COLLECTION_PATH = path.resolve(
  __dirname,
  '..',
  'apps',
  'api',
  'storage',
  'uploads',
  '1789627482335_83580a15-b954-4074-b703-8c2d70bb386f_Nightly_API_Monitoring_Mediasmart_postman_collection.json'
);
const ENVIRONMENT_PATH = path.resolve(
  __dirname,
  '..',
  'apps',
  'api',
  'storage',
  'uploads',
  '1789627527568_cf0af232-3c12-4dc3-bf46-48c76d65b987_Nightly_Mediasmart_API_Environment_postman_environment.json'
);

const AGENT_PORT = 4260;
const REQUEST_TIMEOUT = '120s';

function sha12(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function formData(field, filename, value) {
  const boundary = `----mediasmart-load-${Math.random().toString(36).slice(2)}`;
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

async function api(method, pathName, body, token) {
  const response = await fetch(`http://127.0.0.1:${AGENT_PORT}${pathName}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

async function upload(field, filename, value, token, endpoint) {
  const data = formData(field, filename, value);
  const response = await fetch(`http://127.0.0.1:${AGENT_PORT}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${data.boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body: data.body,
  });
  return { status: response.status, json: await response.json() };
}

async function waitRun(token, id, maxMs = 1_800_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const result = await api('GET', `/api/v1/runs/${id}`, null, token);
    const status = result.json?.data?.status;
    if (['completed', 'failed', 'stopped'].includes(status)) return result.json.data;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('run wait timeout');
}

function collectSensitiveValues(collection, environment) {
  const values = new Set();
  const login = parse(collection).requests.find((r) => r.name === 'Login');
  if (login?.body?.raw) {
    try {
      const body = JSON.parse(login.body.raw);
      if (body.username) values.add(String(body.username));
      if (body.password) values.add(String(body.password));
    } catch {
      /* ignore */
    }
  }
  for (const entry of environment?.values || []) {
    if (/password|token|secret|auth/i.test(entry.key) && entry.value) {
      values.add(String(entry.value));
    }
  }
  return [...values].filter((v) => v.length >= 6);
}

function securityScan(root, run, script, sensitiveValues) {
  const files = [];
  const addTree = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) addTree(file);
      else files.push(file);
    }
  };
  addTree(path.join(root, 'storage', 'run-artifacts', run.runId));
  files.push(path.join(root, 'storage', 'run-logs', `${run.runId}.log`));
  const scriptPath = path.join(root, 'storage', 'scripts', `${run.scriptId}.js`);
  if (fs.existsSync(scriptPath)) files.push(scriptPath);

  const jwtRe = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
  const leaks = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const content = fs.readFileSync(file, 'utf8');
    for (const value of sensitiveValues) {
      if (content.includes(value)) leaks.push({ file: path.relative(root, file), kind: 'credential' });
    }
    if (jwtRe.test(content)) leaks.push({ file: path.relative(root, file), kind: 'jwt' });
  }
  return { scanned: files.length, leaks };
}

function scanLaunchLogForSecrets(logText, sensitiveValues) {
  const launchLine = logText.split(/\r?\n/).find((l) => l.includes('[system] $'));
  const redacted = launchLine ? redactLine(launchLine) : '';
  const leaks = sensitiveValues.filter((v) => launchLine && launchLine.includes(v));
  return { launchLine: redacted.slice(0, 200), leaks };
}

async function main() {
  const collectionSource = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
  const environmentSource = JSON.parse(fs.readFileSync(ENVIRONMENT_PATH, 'utf8'));
  const loginRaw = JSON.parse(parse(collectionSource).requests.find((r) => r.name === 'Login').body.raw);
  const sensitiveValues = collectSensitiveValues(collectionSource, environmentSource);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediasmart-load-'));
  const apiRoot = path.resolve(__dirname, '..', 'apps', 'api');
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'mediasmart-load-val-secret-32chars';
  process.env.ADMIN_USERNAME = 'ms-load-val';
  process.env.ADMIN_PASSWORD = 'ms-load-val-pass';
  process.env.LOG_LEVEL = 'error';

  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const login = await api('POST', '/api/v1/auth/login', {
      username: 'ms-load-val',
      password: 'ms-load-val-pass',
    });
    const token = login.json?.data?.token;

    const uploadedCollection = await upload(
      'collection',
      'mediasmart-load.json',
      collectionSource,
      token,
      '/api/v1/collections'
    );
    const generated = await api(
      'POST',
      '/api/v1/scripts/generate',
      {
        collectionId: uploadedCollection.json.data.id,
        selection: { mode: 'all' },
        options: {
          workload: { profile: 'load' },
          requestTimeout: REQUEST_TIMEOUT,
        },
      },
      token
    );
    const script = generated.json.data;

    const runtimeSecrets = {
      LOGIN_USERNAME: loginRaw.username,
      LOGIN_PASSWORD: loginRaw.password,
    };

    const started = await api(
      'POST',
      '/api/v1/runs',
      {
        scriptId: script.id,
        env: { REQUEST_TIMEOUT },
        secrets: runtimeSecrets,
      },
      token
    );
    const run = await waitRun(token, started.json.data.runId);

    const artifactDir = path.join(apiRoot, 'storage', 'run-artifacts', run.runId);
    const logPath = path.join(apiRoot, 'storage', 'run-logs', `${run.runId}.log`);
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
      run: { runId: run.runId, scriptId: script.id, status: run.status, exitCode: run.exitCode },
      script,
    });
    const launchScan = scanLaunchLogForSecrets(logText, sensitiveValues);
    const security = securityScan(apiRoot, run, script, sensitiveValues);

    const output = {
      pass:
        launchScan.leaks.length === 0 &&
        security.leaks.length === 0 &&
        parsed.summary.requests.transportFailures === 0 &&
        parsed.summary.requests.httpFailures > 0,
      run: {
        runId: run.runId,
        status: run.status,
        exitCode: run.exitCode,
        requestTimeout: REQUEST_TIMEOUT,
        profile: 'load',
        vus: 10,
      },
      metrics: {
        httpFailures: parsed.summary.requests.httpFailures,
        transportFailures: parsed.summary.requests.transportFailures,
        p95: parsed.summary.responseTime?.p95,
        p99: parsed.summary.responseTime?.p99,
        completedIterations: parsed.summary.completedIterations,
        interruptedIterations: parsed.summary.interruptedIterations,
        executionLifecycleStatus: parsed.summary.executionLifecycleStatus,
      },
      failureCategorization: normalized.failureCategorization,
      launchLog: launchScan,
      security,
    };

    console.log(JSON.stringify(output, null, 2));
    if (!output.pass) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(`[mediasmart-load-live] FAIL ${error.message}`);
  process.exitCode = 1;
});
