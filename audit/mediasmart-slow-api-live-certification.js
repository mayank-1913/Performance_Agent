'use strict';

/**
 * Live Mediasmart slow-API certification.
 * Runs the real collection against apinightly.mediasmart.io with REQUEST_TIMEOUT=120s.
 * Does NOT rewrite hosts to a mock target.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');
const { renderReportHtml } = require('../apps/api/src/lib/k6/reportGenerator');

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

const AGENT_PORT = 4250;
const REQUEST_TIMEOUT = '120s';
const TRANSPORT_TIMEOUT_MS = 120_000;

const SLOW_API_PATTERNS = [
  {
    label: '/api/campaigns/download',
    match: (p) => p === '/api/campaigns/download',
    requestName: 'ExtractCampaingns',
  },
  {
    label: '/api/campaign/{id}/creatives',
    match: (p) => /\/api\/campaign\/[^/]+\/creatives$/.test(p),
    requestName: 'LinksACreativeToACampaign',
  },
  {
    label: '/api/analytics/reports',
    match: (p) => p.startsWith('/api/analytics/reports'),
    requestName: 'GetTemplateList',
  },
  {
    label: '/api/v2/analytics/unique-users',
    match: (p) => p.startsWith('/api/v2/analytics/unique-users'),
    requestName: 'GetDownloadAdvancedReport',
  },
];

const SELECTED_NAMES = new Set([
  'Login',
  'CreateCTVCampaign',
  'ExtractCampaingns',
  'LinksACreativeToACampaign',
  'GetTemplateList',
  'GetDownloadAdvancedReport',
]);

function sha12(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

function formData(field, filename, value) {
  const boundary = `----mediasmart-live-${Math.random().toString(36).slice(2)}`;
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

async function waitRun(token, id, maxMs = 1_200_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const result = await api('GET', `/api/v1/runs/${id}`, null, token);
    const status = result.json?.data?.status;
    if (['completed', 'failed', 'stopped'].includes(status)) return result.json.data;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('run wait timeout');
}

function classifySlowApiRow(row) {
  const durationMs = row.durationMs;
  const status = row.status;
  const hitTransportTimeout =
    durationMs >= TRANSPORT_TIMEOUT_MS - 500 && (status === 0 || status === '0');
  const completedBefore120s = durationMs < TRANSPORT_TIMEOUT_MS;
  let classification;
  if (hitTransportTimeout || status === 0 || status === '0') {
    classification = 'transport failure';
  } else if (status >= 200 && status < 300) {
    classification = 'successful HTTP response';
  } else {
    classification = 'HTTP/API failure';
  }
  return {
    api: row.api,
    status: hitTransportTimeout ? 'transport timeout' : status,
    durationMs: Math.round(durationMs),
    durationSec: +(durationMs / 1000).toFixed(2),
    classification,
    completedBefore120s,
    hitTransportTimeout,
    timeout: REQUEST_TIMEOUT,
    requestName: row.requestName,
    apiPath: row.apiPath,
    samples: row.samples,
  };
}

function parseMetricsSlowApis(metricsPath) {
  if (!fs.existsSync(metricsPath)) return [];
  const lines = fs.readFileSync(metricsPath, 'utf8').split('\n');
  const buckets = new Map();
  for (const line of lines) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== 'Point' || evt.metric !== 'http_req_duration') continue;
    const tags = evt.data?.tags || {};
    const apiPath = tags.api_path || '';
    const pattern = SLOW_API_PATTERNS.find((p) => p.match(apiPath));
    if (!pattern) continue;
    const key = pattern.label;
    const status = tags.status != null ? Number(tags.status) : 0;
    const durationMs = Number(evt.data.value) || 0;
    const existing = buckets.get(key) || {
      api: key,
      requestName: pattern.requestName,
      apiPath,
      durationMs: 0,
      status: 0,
      samples: 0,
    };
    existing.samples += 1;
    if (durationMs >= existing.durationMs) {
      existing.durationMs = durationMs;
      existing.status = status;
      existing.apiPath = apiPath;
    }
    buckets.set(key, existing);
  }
  return SLOW_API_PATTERNS.map((pattern) => {
    const row = buckets.get(pattern.label);
    if (!row) {
      return classifySlowApiRow({
        api: pattern.label,
        requestName: pattern.requestName,
        apiPath: pattern.label,
        durationMs: 0,
        status: 'NOT_FOUND',
        samples: 0,
      });
    }
    return classifySlowApiRow(row);
  });
}

function parseConsoleSlowApis(logText) {
  const results = [];
  for (const pattern of SLOW_API_PATTERNS) {
    const re = new RegExp(
      `${pattern.requestName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]{0,200}`,
      'i'
    );
    const found = logText.match(re);
    results.push({
      api: pattern.label,
      requestName: pattern.requestName,
      consoleEvidence: found ? 'group/check present' : 'not found in console',
    });
  }
  return results;
}

function fieldFrom(metric, key) {
  if (!metric) return undefined;
  if (metric[key] !== undefined) return metric[key];
  if (metric.values && metric.values[key] !== undefined) return metric.values[key];
  return undefined;
}

/** Parse human-readable duration strings from HTML (e.g. "36.86s", "453.48ms") to milliseconds. */
function parseHtmlDurationToMs(text) {
  if (text == null || text === '') return null;
  const s = String(text).trim().replace(/,/g, '');
  const sec = s.match(/^([\d.]+)\s*s$/i);
  if (sec) return +Number(parseFloat(sec[1]) * 1000).toFixed(2);
  const ms = s.match(/^([\d.]+)\s*ms$/i);
  if (ms) return +Number(parseFloat(ms[1])).toFixed(2);
  const plain = s.match(/^([\d.]+)$/);
  if (plain) return +Number(parseFloat(plain[1])).toFixed(2);
  return null;
}

function round2(v) {
  if (v == null) return v;
  if (typeof v === 'number') return +Number(v).toFixed(2);
  const asMs = parseHtmlDurationToMs(v);
  return asMs != null ? asMs : v;
}

/** Compare numeric or duration values with unit normalization and formatting tolerance. */
function metricsEqual(a, b, { duration = false } = {}) {
  if (a == null && b == null) return true;
  if (typeof a === 'string' && typeof b === 'string' && !duration) {
    return a.trim() === b.trim();
  }
  const na = typeof a === 'number' ? a : duration ? parseHtmlDurationToMs(a) : parseFloat(a);
  const nb = typeof b === 'number' ? b : duration ? parseHtmlDurationToMs(b) : parseFloat(b);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) {
    return String(a ?? '') === String(b ?? '');
  }
  const diff = Math.abs(na - nb);
  const tolerance = duration ? Math.max(100, Math.abs(na) * 0.02) : Math.max(0.02, Math.abs(na) * 0.01);
  return diff <= tolerance;
}

function extractHtmlStatValues(html) {
  const stats = {};
  const re = /<div class="stat-label">([^<]+)<\/div>\s*<div class="stat-value[^"]*">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    stats[m[1].trim()] = m[2].trim();
  }
  const timeoutMatch = html.match(/<dt>Request timeout<\/dt><dd class="mono">([^<]+)<\/dd>/);
  if (timeoutMatch) stats['Request timeout'] = timeoutMatch[1].trim();
  return stats;
}

async function buildReportComparison(artifactDir, run, script) {
  const summaryPath = path.join(artifactDir, 'summary.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const parsed = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: path.join(artifactDir, 'metrics.json'),
  });
  const normalizedPath = path.join(artifactDir, 'report.json');
  const normalized =
    fs.existsSync(normalizedPath)
      ? JSON.parse(fs.readFileSync(normalizedPath, 'utf8'))
      : buildNormalizedReport({
          parsed,
          run,
          script,
        });
  const htmlPath = path.join(artifactDir, 'report.html');
  const html =
    fs.existsSync(htmlPath)
      ? fs.readFileSync(htmlPath, 'utf8')
      : renderReportHtml(normalized, { runId: run.runId });

  const raw = summary.metrics || {};
  const ns = normalized.summary || {};
  const htmlStats = extractHtmlStatValues(html);
  const rows = [];

  const authMode =
    normalized.authSession?.authenticationMode ||
    normalized.authentication?.mode ||
    normalized.auth?.mode ||
    null;
  const timeoutCfg =
    normalized.timeoutConfig?.defaultRequestTimeout ||
    normalized.timeoutConfig?.requestTimeout ||
    REQUEST_TIMEOUT;

  const add = (metric, rawVal, normVal, htmlVal, { duration = false } = {}) => {
    const rawRounded = round2(rawVal);
    const normRounded = round2(normVal);
    const htmlRounded = duration ? round2(htmlVal) : htmlVal;
    const rawNormMatch = metricsEqual(rawRounded, normRounded, { duration });
    const normHtmlMatch = metricsEqual(normRounded, htmlRounded, { duration });
    const match = rawNormMatch && normHtmlMatch;
    rows.push({
      metric,
      rawK6: rawRounded ?? rawVal,
      normalized: normRounded ?? normVal,
      html: htmlRounded ?? htmlVal,
      match,
    });
  };

  add('totalRequests', fieldFrom(raw.http_reqs, 'count'), ns.totalRequests, htmlStats['Total requests']);
  add('successfulRequests', ns.successfulRequests, ns.successfulRequests, htmlStats['Successful HTTP']);
  add('httpFailures', ns.httpFailures, ns.httpFailures, htmlStats['HTTP/API failures']);
  add(
    'transportFailures',
    fieldFrom(raw.perf_transport_failed, 'count'),
    ns.transportFailures,
    htmlStats['Transport failures']
  );
  add('avg', fieldFrom(raw.http_req_duration, 'avg'), ns.avg, htmlStats.Average, { duration: true });
  add('median', fieldFrom(raw.http_req_duration, 'med'), ns.median, htmlStats.Median, { duration: true });
  add('p90', fieldFrom(raw.http_req_duration, 'p(90)'), ns.p90, htmlStats.p90, { duration: true });
  add('p95', fieldFrom(raw.http_req_duration, 'p(95)'), ns.p95, htmlStats.p95, { duration: true });
  add('p99', fieldFrom(raw.http_req_duration, 'p(99)'), ns.p99, htmlStats.p99, { duration: true });
  add('min', fieldFrom(raw.http_req_duration, 'min'), ns.min, htmlStats.Min, { duration: true });
  add('max', fieldFrom(raw.http_req_duration, 'max'), ns.max, htmlStats.Max, { duration: true });
  add('RPS', fieldFrom(raw.http_reqs, 'rate'), ns.rps, htmlStats['RPS (avg)']);
  add('VUs', fieldFrom(raw.vus_max, 'value') ?? fieldFrom(raw.vus_max, 'max'), ns.peakVUs, htmlStats['Peak VUs']);
  add(
    'completedIterations',
    fieldFrom(raw.iterations, 'count'),
    ns.completedIterations,
    htmlStats['Completed iterations']
  );
  add(
    'interruptedIterations',
    fieldFrom(raw.dropped_iterations, 'count') ?? 0,
    ns.interruptedIterations ?? 0,
    htmlStats['Interrupted iterations']
  );
  add('timeoutConfiguration', REQUEST_TIMEOUT, timeoutCfg, htmlStats['Request timeout'], {
    duration: true,
  });
  add('authenticationMode', authMode, authMode, authMode);

  const thresholdRows = (normalized.thresholds || []).map((t) => ({
    metric: t.metric,
    expression: t.threshold || t.expression,
    ok: t.status === 'pass' || t.ok === true,
    lastValue: t.actual ?? t.lastValue,
    classification: t.status === 'pass' ? 'PASS' : 'APPLICATION_PERFORMANCE_FAILURE',
  }));

  return { rows, thresholdRows, allMatch: rows.every((r) => r.match) };
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
      if (content.includes(value)) {
        leaks.push({ file: path.relative(root, file), kind: 'credential', fingerprint: sha12(value) });
      }
    }
    if (jwtRe.test(content)) {
      leaks.push({ file: path.relative(root, file), kind: 'jwt' });
    }
    if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(content) && !content.includes('Bearer {{')) {
      leaks.push({ file: path.relative(root, file), kind: 'bearer-token' });
    }
  }
  return { scanned: files.length, leaks };
}

async function main() {
  const collectionSource = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
  const environmentSource = JSON.parse(fs.readFileSync(ENVIRONMENT_PATH, 'utf8'));
  const parsed = parse(collectionSource);
  const selectedIndices = parsed.requests
    .map((request, index) => (SELECTED_NAMES.has(request.name) ? index : -1))
    .filter((index) => index >= 0);

  const loginRaw = JSON.parse(parsed.requests.find((r) => r.name === 'Login').body.raw);
  const sensitiveValues = collectSensitiveValues(collectionSource, environmentSource);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediasmart-live-'));
  const apiRoot = path.resolve(__dirname, '..', 'apps', 'api');
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'mediasmart-live-cert-secret-32';
  process.env.ADMIN_USERNAME = 'ms-live-cert';
  process.env.ADMIN_PASSWORD = 'ms-live-cert-pass';
  process.env.LOG_LEVEL = 'error';

  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const login = await api('POST', '/api/v1/auth/login', {
      username: 'ms-live-cert',
      password: 'ms-live-cert-pass',
    });
    const token = login.json?.data?.token;

    const uploadedCollection = await upload(
      'collection',
      'mediasmart-live.json',
      collectionSource,
      token,
      '/api/v1/collections'
    );
    const generated = await api(
      'POST',
      '/api/v1/scripts/generate',
      {
        collectionId: uploadedCollection.json.data.id,
        selection: { mode: 'requests', requestIndices: selectedIndices },
        options: {
          workload: {
            profile: 'smoke',
            overrides: { vus: 1, hold: '3m' },
          },
          requestTimeout: REQUEST_TIMEOUT,
        },
      },
      token
    );
    const script = generated.json.data;

    const runtimeEnv = {
      REQUEST_TIMEOUT,
      PACING_MS: '0',
    };
    const runtimeSecrets = {
      LOGIN_USERNAME: loginRaw.username,
      LOGIN_PASSWORD: loginRaw.password,
    };

    const prepared = await api(
      'POST',
      '/api/v1/runs/prepare',
      { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets },
      token
    );
    if (!prepared.json.data.ready) {
      throw new Error(`prepare not ready: ${JSON.stringify(prepared.json.data.missingEnvVars)}`);
    }

    const started = await api(
      'POST',
      '/api/v1/runs',
      { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets },
      token
    );
    const run = await waitRun(token, started.json.data.runId);

    const artifactDir = path.join(apiRoot, 'storage', 'run-artifacts', run.runId);
    const logPath = path.join(apiRoot, 'storage', 'run-logs', `${run.runId}.log`);
    const logText = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';

    const slowApis = parseMetricsSlowApis(path.join(artifactDir, 'metrics.json'));
    const consoleSlow = parseConsoleSlowApis(logText);
    const reportComparison = await buildReportComparison(artifactDir, run, script);
    const security = securityScan(apiRoot, run, script, sensitiveValues);

    const downloadApi = slowApis.find((row) => row.api === '/api/campaigns/download');
    const notKilledAt30s = slowApis.every((row) => {
      const dur = row.durationMs || 0;
      const killedAtOldDefault = dur >= 29_000 && dur <= 30_500 && row.hitTransportTimeout;
      return !killedAtOldDefault;
    });
    const agentTimeoutOk = slowApis.every((row) => !row.hitTransportTimeout || row.durationMs >= 119_000);
    const downloadProof =
      downloadApi &&
      downloadApi.classification === 'successful HTTP response' &&
      downloadApi.durationMs > 30_000 &&
      downloadApi.durationMs < TRANSPORT_TIMEOUT_MS &&
      !downloadApi.hitTransportTimeout;

    const applicationFailures = slowApis
      .filter((row) => row.classification === 'HTTP/API failure')
      .map((row) => ({
        api: row.api,
        status: row.status,
        durationMs: row.durationMs,
        classification: 'HTTP/API failure (application or test-data)',
      }));

    const output = {
      pass:
        downloadProof &&
        notKilledAt30s &&
        agentTimeoutOk &&
        reportComparison.allMatch &&
        security.leaks.length === 0,
      run: {
        runId: run.runId,
        status: run.status,
        exitCode: run.exitCode,
        requestTimeout: REQUEST_TIMEOUT,
        target: 'https://apinightly.mediasmart.io',
        mockUsed: false,
      },
      slowApis,
      consoleSlow,
      reportComparison,
      security,
      certification: {
        agentImplementation: {
          downloadProof,
          notKilledAt30s,
          agentTimeoutOk,
          reportDataConsistent: reportComparison.allMatch,
          securityClean: security.leaks.length === 0,
        },
        applicationOrTestDataFailures: applicationFailures,
        slaThresholdFailures: (reportComparison.thresholdRows || [])
          .filter((t) => !t.ok)
          .map((t) => ({ ...t, classification: 'APPLICATION_PERFORMANCE_FAILURE' })),
      },
    };

    console.log(JSON.stringify(output, null, 2));
    if (!output.pass) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(`[mediasmart-slow-api-live] FAIL ${error.message}`);
  process.exitCode = 1;
});
