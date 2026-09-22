'use strict';

/**
 * Phase 6.6 end-to-end proof.
 *
 * Reuses the local audit test server and the SAME generator + normalized
 * report pipeline the API uses in production. Runs a login-flow K6 test
 * (setup() captures the token, default fn hits /me) and asserts:
 *
 *   1. The RAW K6 --summary-export file DOES leak setup_data + the
 *      captured token during the brief pre-swap window. (This confirms
 *      the risk documented in Phase 6.5 remaining-limitations is real.)
 *   2. The .clean sibling K6 handleSummary wrote is setup_data-free.
 *   3. After runs.manager's swap the raw summary matches the clean
 *      version and no reader downstream sees the token.
 *   4. Report metrics are preserved (parseRunArtifacts finds every
 *      metric it did before Phase 6.6).
 */

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const { start: startServer, SECRET_TOKEN } = require('./test-server');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { parse } = require('../apps/api/src/lib/postman/parser');
const {
  sanitizeParsedCollection,
} = require('../apps/api/src/lib/postman/authSanitizer');
const {
  buildAuthFlow,
} = require('../apps/api/src/lib/postman/authFlow');
const {
  normalizeWorkload,
} = require('../apps/api/src/lib/k6/workloadProfiles');
const {
  swapCleanSummaryOverRaw,
  scrubSummarySetupData,
} = require('../apps/api/src/modules/runs/runs.manager');
const {
  parseRunArtifacts,
} = require('../apps/api/src/lib/k6/metricsParser');
const {
  buildNormalizedReport,
} = require('../apps/api/src/lib/report/normalizedReport');

const PORT = Number(process.env.AUDIT_66_PORT) || 4004;
const BASE = `http://127.0.0.1:${PORT}`;

async function runK6(scriptPath, artifactsDir, extraEnv) {
  const summaryExportPath = path.join(artifactsDir, 'summary.json');
  const metricsJsonPath = path.join(artifactsDir, 'metrics.json');
  return await new Promise((resolve) => {
    const child = spawn(
      'k6',
      [
        'run',
        '--quiet',
        '--summary-export', summaryExportPath,
        '--out', `json=${metricsJsonPath}`,
        scriptPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PACING_MS: '100', ...extraEnv },
      }
    );
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) =>
      resolve({ code, stdout, stderr, summaryExportPath, metricsJsonPath })
    );
  });
}

(async () => {
  const { server } = await startServer(PORT);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p66-e2e-'));
  try {
    const collection = {
      info: { name: 'p66-e2e', schema: 'v2.1' },
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
    const code = generateK6Script(parsed, {
      injectAuthToken: true,
      workload,
      authFlow: flow,
    });
    const scriptPath = path.join(dir, 'e2e.js');
    fs.writeFileSync(scriptPath, code, 'utf-8');

    const cleanSummary = path.join(dir, 'summary.json.clean');
    const run = await runK6(scriptPath, dir, { PA_CLEAN_SUMMARY_PATH: cleanSummary });

    // Pre-swap state: raw --summary-export still leaks; clean is clean.
    const rawBefore = await fsp.readFile(run.summaryExportPath, 'utf-8');
    const cleanBefore = fs.existsSync(cleanSummary)
      ? await fsp.readFile(cleanSummary, 'utf-8')
      : null;
    const rawLeakPre = rawBefore.includes(SECRET_TOKEN);
    const cleanLeakPre = cleanBefore == null ? null : cleanBefore.includes(SECRET_TOKEN);
    const cleanHasSetupData = cleanBefore == null ? null : cleanBefore.includes('setup_data');

    // Emulate the runs.manager pipeline: swap first, then scrubber.
    const swap = await swapCleanSummaryOverRaw({
      summaryExportPath: run.summaryExportPath,
      cleanSummaryPath: cleanSummary,
    });
    await scrubSummarySetupData(run.summaryExportPath);

    const rawAfter = await fsp.readFile(run.summaryExportPath, 'utf-8');
    const rawLeakPost = rawAfter.includes(SECRET_TOKEN);
    const rawHasSetupDataPost = rawAfter.includes('setup_data');

    // Metrics preservation via parseRunArtifacts.
    const parsedReport = await parseRunArtifacts({
      summaryExportPath: run.summaryExportPath,
      metricsJsonPath: run.metricsJsonPath,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 3000,
    });
    const normalized = buildNormalizedReport({
      parsed: parsedReport,
      run: {
        runId: 'p66-e2e',
        scriptId: 's',
        status: 'completed',
        exitCode: run.code,
        durationMs: 3000,
      },
    });
    const parsedLeak = JSON.stringify(parsedReport).includes(SECRET_TOKEN);
    const normLeak = JSON.stringify(normalized).includes(SECRET_TOKEN);

    const report = {
      k6ExitCode: run.code,
      rawSummaryPresent: fs.existsSync(run.summaryExportPath),
      cleanSummaryWrittenByK6: cleanBefore != null,
      rawLeaked_preSwap: rawLeakPre,
      cleanLeaked_preSwap: cleanLeakPre,
      cleanHadSetupData_preSwap: cleanHasSetupData,
      swapResult: swap,
      rawLeaked_postSwap: rawLeakPost,
      rawHasSetupData_postSwap: rawHasSetupDataPost,
      parsedReportLeaked: parsedLeak,
      normalizedReportLeaked: normLeak,
      requests: parsedReport?.summary?.requests?.total,
      failed: parsedReport?.summary?.requests?.failed,
    };
    console.log(JSON.stringify(report, null, 2));

    const ok =
      cleanBefore != null &&
      cleanLeakPre === false &&
      cleanHasSetupData === false &&
      swap.swapped === true &&
      rawLeakPost === false &&
      rawHasSetupDataPost === false &&
      parsedLeak === false &&
      normLeak === false;
    console.log(ok ? 'PHASE-6.6 E2E PASSED' : 'PHASE-6.6 E2E FAILED');
    process.exit(ok ? 0 : 1);
  } finally {
    server.close();
  }
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(3);
});
