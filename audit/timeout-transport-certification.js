'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');

let PORT = 0;
let TARGET = '';

function singleRequestCollection(base, name, pathname, timeoutMs) {
  return {
    info: { name: `timeout-cert-${name}`, schema: 'v2.1' },
    item: [
      {
        name,
        request: {
          method: 'GET',
          url: `${base}${pathname}`,
          ...(timeoutMs != null ? { timeout: timeoutMs } : {}),
        },
      },
    ],
  };
}

function targetServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, TARGET);
    if (url.pathname === '/slow-200') {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }, 3500);
      return;
    }
    if (url.pathname === '/slow-504') {
      setTimeout(() => {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'gateway timeout' }));
      }, 3500);
      return;
    }
    if (url.pathname === '/hang') {
      return;
    }
    res.writeHead(404);
    res.end();
  });
}

function runK6(scriptPath, outDir) {
  const summary = path.join(outDir, 'summary.json');
  const clean = path.join(outDir, 'summary.clean.json');
  const metrics = path.join(outDir, 'metrics.json');
  const proc = spawnSync(
    'k6',
    [
      'run',
      '--summary-export',
      summary,
      '--out',
      `json=${metrics}`,
      '-e',
      `PA_CLEAN_SUMMARY_PATH=${clean}`,
      scriptPath,
    ],
    { encoding: 'utf8', timeout: 180_000 }
  );
  const summaryPath = fs.existsSync(clean) ? clean : summary;
  return { exitCode: proc.status, summaryPath, metrics, stderr: proc.stderr };
}

async function certifyCase(root, label, collectionInput, expectations) {
  const parsed = parse(collectionInput);
  const code = generateK6Script(parsed, {
    workload: {
      profile: 'smoke',
      overrides: { vus: 1, hold: '15s' },
    },
  });
  const scriptPath = path.join(root, `${label}.js`);
  const outDir = path.join(root, label);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(scriptPath, code, 'utf8');
  const k6 = runK6(scriptPath, outDir);
  const parsedSummary = await parseRunArtifacts({
    summaryExportPath: k6.summaryPath,
    metricsJsonPath: k6.metrics,
  });
  const report = buildNormalizedReport({
    parsed: parsedSummary,
    run: { runId: label, status: 'completed', exitCode: k6.exitCode },
  });
  const ok = expectations(report, code, k6);
  return { label, ok, report: {
    transportFailures: report.summary.transportFailures,
    httpFailures: report.summary.httpFailures,
    p95: report.summary.p95,
    max: report.summary.max,
    http5xx: report.failureBreakdown?.http?.['5xx'],
  }, k6Exit: k6.exitCode };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeout-cert-'));
  const server = targetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  PORT = server.address().port;
  TARGET = `http://127.0.0.1:${PORT}`;

  try {
    const results = [];
    results.push(
      await certifyCase(
        root,
        'slow-200',
        singleRequestCollection(TARGET, 'Slow200', '/slow-200', null),
        (report, code) =>
          code.includes('DEFAULT_REQUEST_TIMEOUT = "120s"') &&
          !code.includes("|| '30s'") &&
          (report.summary.totalRequests || 0) > 0 &&
          (report.summary.transportFailures || 0) === 0 &&
          (report.summary.p95 || 0) > 3000 &&
          (report.summary.p95 || 0) < 100000
      )
    );
    results.push(
      await certifyCase(
        root,
        'slow-504',
        singleRequestCollection(TARGET, 'Slow504', '/slow-504', null),
        (report) =>
          (report.summary.transportFailures || 0) === 0 &&
          (report.summary.httpFailures || 0) >= 1 &&
          (report.failureBreakdown?.http?.['5xx'] || 0) >= 1 &&
          (report.summary.p95 || 0) > 3000
      )
    );
    results.push(
      await certifyCase(
        root,
        'hang-5s',
        singleRequestCollection(TARGET, 'Hang', '/hang', 5000),
        (report, code) =>
          code.includes('"req_01":"5s"') &&
          (report.summary.transportFailures || 0) >= 1 &&
          (report.summary.max || 0) >= 4500 &&
          (report.summary.max || 0) <= 9000
      )
    );

    const pass = results.every((r) => r.ok);
    console.log(JSON.stringify({ pass, results }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
