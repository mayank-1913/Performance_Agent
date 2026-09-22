'use strict';

/**
 * Phase 6.5 audit — end-to-end secret scrub proof.
 *
 * The `run-auth-audit.js` harness runs k6 directly without the API's
 * report-ready pipeline, so it doesn't invoke scrubSummarySetupData.
 * This script wires them together: k6 writes summary.json, then we call
 * scrubSummarySetupData exactly the way `runs.manager.js` does before
 * parseRunArtifacts / persistence run, then we grep for the secret.
 * Guards against a regression that could re-introduce setup_data.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { start: startServer, SECRET_TOKEN } = require('./test-server');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../apps/api/src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');
const { normalizeWorkload } = require('../apps/api/src/lib/k6/workloadProfiles');
const { scrubSummarySetupData } = require('../apps/api/src/modules/runs/runs.manager');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');

const PORT = Number(process.env.AUDIT_SCRUB_PORT) || 4003;
const BASE = `http://127.0.0.1:${PORT}`;

function runK6(scriptPath, artifactsDir) {
  const summaryExportPath = path.join(artifactsDir, 'summary.json');
  const metricsJsonPath = path.join(artifactsDir, 'metrics.json');
  return new Promise((resolve) => {
    const child = spawn(
      'k6',
      ['run', '--quiet', '--summary-export', summaryExportPath, '--out', `json=${metricsJsonPath}`, scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PACING_MS: '100' } }
    );
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr, summaryExportPath, metricsJsonPath }));
  });
}

(async () => {
  const { server } = await startServer(PORT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase65-scrub-'));
  try {
    const collection = {
      info: { name: 'scrub-e2e', schema: 'v2.1' },
      item: [
        {
          name: 'Login',
          request: {
            method: 'POST',
            header: [{ key: 'Content-Type', value: 'application/json' }],
            url: { raw: `${BASE}/login` },
            body: { mode: 'raw', raw: '{"u":"x"}', options: { raw: { language: 'json' } } },
          },
        },
        {
          name: 'GetMe',
          request: {
            method: 'GET',
            header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
            url: { raw: `${BASE}/me` },
          },
        },
      ],
    };
    const parsed = sanitizeParsedCollection(parse(collection)).parsed;
    const flow = buildAuthFlow(parsed);
    const workload = normalizeWorkload({ profile: 'smoke', overrides: { vus: 1, hold: '3s' } });
    const code = generateK6Script(parsed, { injectAuthToken: true, workload, authFlow: flow });
    const scriptPath = path.join(dir, 'e2e.js');
    fs.writeFileSync(scriptPath, code, 'utf-8');
    const run = await runK6(scriptPath, dir);

    const rawBefore = fs.readFileSync(run.summaryExportPath, 'utf-8');
    const leakBefore = rawBefore.includes(SECRET_TOKEN);

    // Emulate the real report-ready pipeline.
    const scrubResult = await scrubSummarySetupData(run.summaryExportPath);
    const parsedReport = await parseRunArtifacts({
      summaryExportPath: run.summaryExportPath,
      metricsJsonPath: run.metricsJsonPath,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 3000,
    });
    const normalized = buildNormalizedReport({
      parsed: parsedReport,
      run: { runId: 'scrub-e2e', scriptId: 's', status: 'completed', exitCode: run.code, durationMs: 3000 },
    });

    const rawAfter = fs.readFileSync(run.summaryExportPath, 'utf-8');
    const leakAfter = rawAfter.includes(SECRET_TOKEN);
    const leakInParsed = JSON.stringify(parsedReport).includes(SECRET_TOKEN);
    const leakInNormalized = JSON.stringify(normalized).includes(SECRET_TOKEN);

    console.log(JSON.stringify({
      k6ExitCode: run.code,
      requests: parsedReport?.summary?.requests?.total,
      failed: parsedReport?.summary?.requests?.failed,
      scrubResult,
      leakInSummaryBeforeScrub: leakBefore,
      leakInSummaryAfterScrub: leakAfter,
      leakInParsedReport: leakInParsed,
      leakInNormalizedReport: leakInNormalized,
    }, null, 2));

    const ok = leakBefore === true && leakAfter === false && !leakInParsed && !leakInNormalized;
    console.log(ok ? 'SCRUB E2E PASSED' : 'SCRUB E2E FAILED');
    process.exit(ok ? 0 : 1);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(3);
});
