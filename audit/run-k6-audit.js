'use strict';

/**
 * Phase 6.5 audit — runtime harness.
 *
 * For each workload profile:
 *   1. build a synthetic Postman collection targeting the local audit
 *      test server
 *   2. generate a K6 script with a scaled-down override (seconds, not
 *      minutes/hours) so the harness completes in a reasonable time
 *   3. run k6 with --summary-export + --out json= producing the same
 *      artifact set the Performance Agent's lifecycle would produce in
 *      production
 *   4. parse those artifacts via the exact same parseRunArtifacts +
 *      buildNormalizedReport code paths the API uses
 *   5. compare our normalized report metrics against k6's native
 *      summary.json values
 *   6. grep every produced artifact for the SECRET_TOKEN literal to
 *      confirm nothing leaks it back into logs / report / summary
 *
 * Exits non-zero if any structural / numerical / security assertion
 * fails. Prints a per-profile report to stdout suitable for the
 * certification matrix.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const { start: startServer, SECRET_TOKEN } = require('./test-server');
const {
  generateK6Script,
} = require('../apps/api/src/lib/k6/generator');
const { parse } = require('../apps/api/src/lib/postman/parser');
const {
  sanitizeParsedCollection,
} = require('../apps/api/src/lib/postman/authSanitizer');
const {
  normalizeWorkload,
  publicWorkload,
} = require('../apps/api/src/lib/k6/workloadProfiles');
const {
  parseRunArtifacts,
} = require('../apps/api/src/lib/k6/metricsParser');
const {
  buildNormalizedReport,
} = require('../apps/api/src/lib/report/normalizedReport');

const PORT = Number(process.env.AUDIT_PORT) || 3999;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Scaled-down overrides so the audit completes in seconds, not minutes.
// Preserves the profile's SHAPE (constant-vus vs ramping-vus, plateaus
// for stress, aggressive drop for spike) while making the total run time
// bounded. Every ramp-up / hold / ramp-down is expressed in seconds.
const OVERRIDES = {
  smoke:  { vus: 1, rampUp: '0s',  hold: '5s',  rampDown: '0s'  },
  load:   { vus: 3, rampUp: '2s',  hold: '5s',  rampDown: '1s'  },
  // Stress at VU=4 produces plateau targets [1, 2, 3, 4] — the smallest
  // VU count that still exercises every plateau boundary.
  stress: { vus: 4, rampUp: '1s',  hold: '2s',  rampDown: '1s'  },
  spike:  { vus: 5, rampUp: '1s',  hold: '3s',  rampDown: '1s'  },
  soak:   { vus: 2, rampUp: '1s',  hold: '5s',  rampDown: '1s'  },
  custom: { vus: 3, rampUp: '1s',  hold: '3s',  rampDown: '1s'  },
};

function buildCollection() {
  return {
    info: { name: 'phase-6.5-audit', schema: 'v2.1' },
    // Only include endpoints we control. No external network. Health
    // dominates so total request count is predictable.
    item: [
      {
        name: 'Health',
        request: { method: 'GET', header: [], url: { raw: `${BASE_URL}/health` } },
      },
      {
        name: 'NotFound',
        request: { method: 'GET', header: [], url: { raw: `${BASE_URL}/notfound` } },
      },
      {
        name: 'ServerError',
        request: { method: 'GET', header: [], url: { raw: `${BASE_URL}/server-error` } },
      },
    ],
  };
}

function haveK6() {
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['k6'], {
    encoding: 'utf-8',
  });
  return which.status === 0;
}

/**
 * Run k6 via async spawn. Critical for this harness: the local test
 * server lives in the SAME Node process as this function, so blocking
 * the event loop (spawnSync) would prevent the server from accepting
 * TCP connections from the k6 subprocess and every request would time
 * out at REQUEST_TIMEOUT. Using async spawn keeps the event loop free
 * to serve requests.
 */
function runK6(scriptPath, artifactsDir, extraEnv = {}) {
  const summaryExportPath = path.join(artifactsDir, 'summary.json');
  const metricsJsonPath = path.join(artifactsDir, 'metrics.json');
  const args = [
    'run',
    '--quiet',
    '--summary-export',
    summaryExportPath,
    '--out',
    `json=${metricsJsonPath}`,
    '-e',
    'PACING_MS=100',
    ...Object.entries(extraEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    scriptPath,
  ];
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('k6', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf-8')));
    child.on('close', (code) => {
      resolve({
        exitCode: code,
        stdout,
        stderr,
        summaryExportPath,
        metricsJsonPath,
        durationMs: Date.now() - start,
      });
    });
  });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function approxEqual(a, b, tolerance = 0.05) {
  if (a == null || b == null) return a === b;
  const diff = Math.abs(a - b);
  const base = Math.max(1, Math.max(Math.abs(a), Math.abs(b)));
  return diff / base <= tolerance;
}

async function auditProfile(profile, artifactsDir) {
  const overrides = OVERRIDES[profile];
  const workload = normalizeWorkload({ profile, overrides });
  const parsed = sanitizeParsedCollection(parse(buildCollection())).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: false,
    workload,
    authFlow: { enabled: false },
  });
  const scriptPath = path.join(artifactsDir, `${profile}.js`);
  fs.writeFileSync(scriptPath, code, 'utf-8');

  const run = await runK6(scriptPath, artifactsDir);
  const parsedReport = await parseRunArtifacts({
    summaryExportPath: run.summaryExportPath,
    metricsJsonPath: run.metricsJsonPath,
    startedAt: new Date(Date.now() - run.durationMs).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: run.durationMs,
  });
  const normalized = buildNormalizedReport({
    parsed: parsedReport,
    run: {
      runId: `audit-${profile}`,
      scriptId: `audit-${profile}-script`,
      status: run.exitCode === 0 ? 'completed' : 'failed',
      exitCode: run.exitCode,
      startedAt: new Date(Date.now() - run.durationMs).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: run.durationMs,
    },
    script: {
      loadProfile: workload.loadProfile,
      workload: publicWorkload(workload),
    },
  });

  const nativeSummary = readJson(run.summaryExportPath);
  const nativeMetrics = nativeSummary?.metrics || {};
  const nativeTotal = nativeMetrics.http_reqs?.count ?? null;
  // Real k6 emits http_req_failed with { passes: <fail-count>, value: <rate> }.
  // Prefer passes (exact count); fall back to value*total when passes missing.
  const httpFailed = nativeMetrics.http_req_failed || {};
  const nativeFailed =
    typeof httpFailed.passes === 'number'
      ? httpFailed.passes
      : typeof httpFailed.value === 'number' && httpFailed.value <= 1 && nativeTotal
        ? Math.round(httpFailed.value * nativeTotal)
        : null;
  const nativeRate =
    typeof httpFailed.value === 'number'
      ? Number(httpFailed.value.toFixed(4))
      : null;
  const nativeP95 = nativeMetrics.http_req_duration?.['p(95)'] ?? null;
  const nativeMax = nativeMetrics.http_req_duration?.max ?? null;
  const nativeIter = nativeMetrics.iterations?.count ?? null;
  const nativeVus = nativeMetrics.vus_max?.value ?? null;

  const rpt = normalized.summary;
  const rptTotal = rpt.totalRequests;
  const rptFailed = rpt.failedRequests;
  const rptRate = rpt.errorPercentage != null ? +(rpt.errorPercentage / 100).toFixed(4) : null;
  const rptP95 = rpt.p95;
  const rptMax = rpt.max;
  const rptIter = rpt.iterations;
  const rptVus = rpt.peakVUs;

  // Secret leakage grep across every artifact.
  const artifactsToScan = [scriptPath, run.summaryExportPath, run.metricsJsonPath];
  const leakedIn = artifactsToScan.filter((p) => {
    try {
      return fs.readFileSync(p, 'utf-8').includes(SECRET_TOKEN);
    } catch {
      return false;
    }
  });
  // Also scan the rendered report JSON (in-memory) + the parsedReport.
  const serializedReport = JSON.stringify(normalized);
  const serializedParsed = JSON.stringify(parsedReport);
  const leaks = {
    files: leakedIn,
    inNormalizedReport: serializedReport.includes(SECRET_TOKEN),
    inParsedReport: serializedParsed.includes(SECRET_TOKEN),
    inStdout: run.stdout.includes(SECRET_TOKEN),
    inStderr: run.stderr.includes(SECRET_TOKEN),
  };

  const comparisons = {
    total:      { native: nativeTotal,  report: rptTotal,  match: approxEqual(nativeTotal, rptTotal, 0.02) },
    failed:     { native: nativeFailed, report: rptFailed, match: approxEqual(nativeFailed, rptFailed, 0.05) },
    errorRate:  { native: nativeRate,   report: rptRate,   match: approxEqual(nativeRate, rptRate, 0.05) },
    p95Ms:      { native: nativeP95,    report: rptP95,    match: approxEqual(nativeP95, rptP95, 0.05) },
    maxMs:      { native: nativeMax,    report: rptMax,    match: approxEqual(nativeMax, rptMax, 0.05) },
    iterations: { native: nativeIter,   report: rptIter,   match: approxEqual(nativeIter, rptIter, 0.02) },
    vusMax:     { native: nativeVus,    report: rptVus,    match: approxEqual(nativeVus, rptVus, 0.01) },
  };

  return {
    profile,
    scriptPath,
    scriptSize: fs.statSync(scriptPath).size,
    exitCode: run.exitCode,
    durationMs: run.durationMs,
    workload: publicWorkload(workload),
    executor: workload.executor,
    verdict: normalized.verdict,
    comparisons,
    leaks,
    stderrTail: run.stderr ? run.stderr.split('\n').slice(-3).join(' | ') : '',
  };
}

async function main() {
  if (!haveK6()) {
    console.log(JSON.stringify({ error: 'k6 not on PATH — audit cannot proceed' }, null, 2));
    process.exit(2);
  }
  const { server } = await startServer(PORT);
  const rootTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase65-audit-'));
  console.log(`# audit artifacts under: ${rootTmp}`);
  const results = [];
  try {
    for (const profile of ['smoke', 'load', 'stress', 'spike', 'soak', 'custom']) {
      const dir = fs.mkdtempSync(path.join(rootTmp, `${profile}-`));
      const r = await auditProfile(profile, dir);
      results.push(r);
      const cmp = Object.entries(r.comparisons)
        .map(([k, v]) => `${k}=${v.match ? 'OK' : 'MISMATCH'}(k6=${v.native} report=${v.report})`)
        .join(', ');
      const leak = Object.values(r.leaks).some((v) =>
        Array.isArray(v) ? v.length > 0 : Boolean(v)
      )
        ? 'LEAK'
        : 'clean';
      console.log(
        `# ${r.profile.padEnd(6)} exit=${r.exitCode} dur=${r.durationMs}ms exec=${r.executor} verdict=${r.verdict.status} ${cmp} secrets=${leak}`
      );
    }
    const overallOk = results.every(
      (r) =>
        r.exitCode === 0 &&
        Object.values(r.comparisons).every((c) => c.match) &&
        !r.leaks.files.length &&
        !r.leaks.inNormalizedReport &&
        !r.leaks.inParsedReport &&
        !r.leaks.inStdout
    );
    console.log(JSON.stringify({ overallOk, results }, null, 2));
    process.exit(overallOk ? 0 : 1);
  } finally {
    server.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('audit failed:', err.stack || err);
    process.exit(3);
  });
}

module.exports = { auditProfile };
