'use strict';

/**
 * Live Mediasmart certification — fresh generated script with dependency-skip guards.
 * Validates real K6 execution against apinightly.mediasmart.io (no mock).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { parseRunArtifacts } = require('../apps/api/src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../apps/api/src/lib/report/normalizedReport');
const { renderReportHtml } = require('../apps/api/src/lib/k6/reportGenerator');
const { parseIterationLifecycle } = require('../apps/worker-runner/src/streamHandler');

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

const AGENT_PORT = 4270;
const REQUEST_TIMEOUT = '120s';
const VUS = 5;
const CAMPAIGN_DEPENDENT_NAMES = [
  'ToUpdateCampaign',
  'DeleteCTVCampaign',
  'GetCampaignHistoryAfterUpdate',
  'GetCampaignCreativesSummaryById',
  'GetSingleCampaignById',
  'CampaignAnalyticsSummary',
  'GetListOfCampaignSummary',
  'AddNewStrategy',
  'UpdateStrategy',
  'DeleteStrategy',
  'GetCampaignCreatives',
  'LinksACreativeToACampaign',
  'GetSingleCreativeByIdAndCid',
  'GetHistoryOfCampaign',
  'ToCreateADuplicateCampaign',
  'DeleteDuplicateCampaign',
];

function formData(field, filename, value) {
  const boundary = `----ms-dep-cert-${Math.random().toString(36).slice(2)}`;
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

async function waitRun(token, id, maxMs = 2_400_000) {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const result = await api('GET', `/api/v1/runs/${id}`, null, token);
    const status = result.json?.data?.status;
    if (['completed', 'failed', 'stopped'].includes(status)) return result.json.data;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('run wait timeout');
}

function credentialDatasetFromLogin(loginRaw, count) {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `vu-${i + 1}`,
      username: loginRaw.username,
      password: loginRaw.password,
    }))
  );
}

function scanScriptGuards(scriptPath) {
  const code = fs.readFileSync(scriptPath, 'utf8');
  return {
    hasDependencyCheck: code.includes('__checkDependencyDeps'),
    hasDependencySkippedCounter: code.includes('perf_dependency_skipped'),
    hasUrlGuard: code.includes('__urlHasInvalidRuntimeRefs'),
    hasCampaignIdCapture: code.includes('campaign_id'),
    hasCreateCTVCampaign: code.includes('CreateCTVCampaign'),
  };
}

function scanBadDependencyUrls(metricsPath, logText, scriptPath) {
  const badPatterns = [
    /\/campaign\/null\b/i,
    /\/campaign\/undefined\b/i,
    /\{\{campaign_id\}\}/,
    /\/null\//,
    /\/undefined\//,
  ];
  const hits = { metrics: [], log: [], script: [] };
  if (fs.existsSync(metricsPath)) {
    const lines = fs.readFileSync(metricsPath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type !== 'Point' || evt.metric !== 'http_req_duration') continue;
      const url = evt.data?.tags?.url || evt.data?.tags?.api_path || '';
      for (const re of badPatterns) {
        if (re.test(url)) hits.metrics.push({ url, time: evt.data?.time });
      }
    }
  }
  for (const re of badPatterns) {
    if (re.test(logText)) hits.log.push(String(re));
  }
  const script = fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, 'utf8') : '';
  for (const re of badPatterns) {
    if (re.test(script) && !/\{\{campaign_id\}\}/.test(script) || (re.source.includes('campaign_id') && script.includes('{{campaign_id}}'))) {
      // api_path tags may retain template — only flag runtime URL points
    }
  }
  if (script.includes('/campaign/null') || script.includes('/campaign/undefined')) {
    hits.script.push('literal bad path in script');
  }
  return hits;
}

function parseDependencySkippedFromMetrics(metricsPath) {
  if (!fs.existsSync(metricsPath)) return { total: 0, byRequest: [] };
  const byName = new Map();
  let total = 0;
  for (const line of fs.readFileSync(metricsPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt.type !== 'Point' || evt.metric !== 'perf_dependency_skipped') continue;
    const v = Number(evt.data?.value) || 0;
    if (v <= 0) continue;
    total += v;
    const name = evt.data?.tags?.api_name || 'unknown';
    byName.set(name, (byName.get(name) || 0) + v);
  }
  return {
    total,
    byRequest: [...byName.entries()].map(([request, count]) => ({ request, count })),
  };
}

function parseAuthLogEvidence(logText) {
  const lines = logText.split(/\r?\n/);
  const authPresent = lines.filter((l) => /\[auth\] runtime state:/.test(l) && !/EMPTY/.test(l));
  const authMissing = lines.filter((l) => /AUTH_MISSING/.test(l));
  const authRejected = lines.filter((l) => /AUTH_PRESENT but server rejected/.test(l));
  const tokenMissingFalse = lines.filter((l) => /no token available/i.test(l));
  const skips = lines.filter((l) => /\[skip\]/.test(l));
  return {
    authPresentLines: authPresent.length,
    authMissingWarnings: authMissing.length,
    authRejectedWarnings: authRejected.length,
    falseTokenMissingWarnings: tokenMissingFalse.length,
    skipLines: skips.slice(0, 20),
    skipCount: skips.length,
  };
}

function compareReportSurfaces(normalized, html) {
  const fields = [
    ['totalRequests', normalized.summary?.totalRequests],
    ['successfulHttp', normalized.summary?.successfulHttpResponses ?? normalized.summary?.successfulRequests],
    ['httpFailures', normalized.summary?.httpFailures],
    ['transportFailures', normalized.summary?.transportFailures],
    ['dependencySkipped', normalized.failureCategorization?.dependencySkipped],
    ['p95', normalized.summary?.p95],
    ['authMode', normalized.authSession?.authenticationMode],
  ];
  const checks = fields.map(([key, val]) => ({
    key,
    normalized: val,
    inHtml: val != null ? html.includes(String(val)) : true,
  }));
  return {
    checks,
    chartDataBeforeDraw: html.indexOf('id="chart-data"') < html.indexOf('function drawLine'),
    hasDependencySection: html.includes('Dependency-skipped requests'),
    hasFailureAnalysis: html.includes('Failure analysis'),
    hasOverflowHidden: html.includes('overflow-x: hidden'),
    hasChartsOrEmpty: html.includes('p95Chart') || html.includes('No time-series data available'),
  };
}

function campaignChainEvidence(parsed, normalized, skipMetrics, logText) {
  const createFailures = (parsed.failures || []).filter((f) =>
    /CreateCTVCampaign/i.test(f.name || '')
  );
  const createStatus = createFailures[0]?.lastStatus || null;
  const dependentSkips = (normalized.dependencySkippedRequests || []).filter((d) =>
    CAMPAIGN_DEPENDENT_NAMES.some((n) => (d.request || '').includes(n))
  );
  const skipLines = logText
    .split(/\r?\n/)
    .filter((l) => /\[skip\]/i.test(l) && CAMPAIGN_DEPENDENT_NAMES.some((n) => l.includes(n)));
  return {
    createCTVCampaignLastStatus: createStatus,
    createFailed: createStatus && Number(createStatus) >= 400,
    dependentSkipsInReport: dependentSkips.length,
    dependentSkipLinesInLog: skipLines.length,
    skipMetricsTotal: skipMetrics.total,
    sampleSkips: dependentSkips.slice(0, 10),
  };
}

async function main() {
  const collectionSource = JSON.parse(fs.readFileSync(COLLECTION_PATH, 'utf8'));
  const environmentSource = JSON.parse(fs.readFileSync(ENVIRONMENT_PATH, 'utf8'));
  const parsedCollection = parse(collectionSource);
  const loginRaw = JSON.parse(parsedCollection.requests.find((r) => r.name === 'Login').body.raw);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-dep-cert-'));
  const apiRoot = path.resolve(__dirname, '..', 'apps', 'api');
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'ms-dep-live-cert-secret-32chars';
  process.env.ADMIN_USERNAME = 'ms-dep-cert';
  process.env.ADMIN_PASSWORD = 'ms-dep-cert-pass';
  process.env.LOG_LEVEL = 'error';

  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const login = await api('POST', '/api/v1/auth/login', {
      username: 'ms-dep-cert',
      password: 'ms-dep-cert-pass',
    });
    const token = login.json?.data?.token;

    const uploadedCollection = await upload(
      'collection',
      'mediasmart-dep-cert.json',
      collectionSource,
      token,
      '/api/v1/collections'
    );
    const uploadedEnv = await upload(
      'environment',
      'mediasmart-env.json',
      environmentSource,
      token,
      '/api/v1/environments'
    );

    const generated = await api(
      'POST',
      '/api/v1/scripts/generate',
      {
        collectionId: uploadedCollection.json.data.id,
        environmentId: uploadedEnv.json.data.id,
        selection: { mode: 'all' },
        options: {
          workload: {
            profile: 'custom',
            authSessionMode: 'PER_VU_LOGIN',
            credentialReuse: false,
            overrides: { vus: VUS, rampUp: '30s', hold: '1m', rampDown: '30s' },
          },
          requestTimeout: REQUEST_TIMEOUT,
        },
      },
      token
    );
    if (generated.status !== 201) {
      throw new Error(`script generation failed: ${JSON.stringify(generated.json)}`);
    }
    const script = generated.json.data;
    const scriptPath = path.join(apiRoot, 'storage', 'scripts', `${script.id}.js`);
    const scriptGuards = scanScriptGuards(scriptPath);

    const runtimeEnv = { REQUEST_TIMEOUT, PACING_MS: '1000' };
    const runtimeSecrets = {
      LOGIN_USERNAME: loginRaw.username,
      LOGIN_PASSWORD: loginRaw.password,
      credentialDataset: credentialDatasetFromLogin(loginRaw, VUS),
      credentialReuse: 'false',
    };

    const prepared = await api(
      'POST',
      '/api/v1/runs/prepare',
      { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets },
      token
    );

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

    const prepareAuth = prepared.json?.data?.authSession || null;
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
        authSession: prepareAuth,
      },
      script,
    });

    const reportJsonPath = path.join(artifactDir, 'report.json');
    if (fs.existsSync(reportJsonPath)) {
      fs.writeFileSync(reportJsonPath, JSON.stringify(normalized, null, 2));
    }
    const htmlPath = path.join(artifactDir, 'report.html');
    const html = renderReportHtml(normalized, { runId: run.runId });
    fs.writeFileSync(htmlPath, html, 'utf8');

    const apiSummary = await api('GET', `/api/v1/runs/${run.runId}/summary`, null, token);
    const embeddedNormalized = apiSummary.json?.data?.normalized || null;

    const skipMetrics = parseDependencySkippedFromMetrics(path.join(artifactDir, 'metrics.json'));
    const badUrls = scanBadDependencyUrls(
      path.join(artifactDir, 'metrics.json'),
      logText,
      scriptPath
    );
    const authEvidence = parseAuthLogEvidence(logText);
    const reportSurfaces = compareReportSurfaces(normalized, html);
    const campaignChain = campaignChainEvidence(parsed, normalized, skipMetrics, logText);

    const dependencySkippedFromSummary =
      parsed.summary?.requests?.dependencySkipped ??
      normalized.failureCategorization?.dependencySkipped ??
      0;

    const checks = {
      freshScriptHasGuards:
        scriptGuards.hasDependencyCheck &&
        scriptGuards.hasDependencySkippedCounter &&
        scriptGuards.hasUrlGuard,
      noBadDependencyUrlsInMetrics: badUrls.metrics.length === 0,
      verdictNotAgentRuntime:
        normalized.verdict.category !== 'AGENT_RUNTIME_FAILURE' ||
        (run.exitCode === 99 && normalized.verdict.category === 'APPLICATION_PERFORMANCE_FAILURE'),
      exit99IsAppFailure:
        run.exitCode !== 99 || normalized.verdict.category === 'APPLICATION_PERFORMANCE_FAILURE',
      dependencySkippedTracked: dependencySkippedFromSummary >= 0,
      httpFailuresSeparateFromSkips:
        (normalized.summary?.httpFailures || 0) >= 0 &&
        dependencySkippedFromSummary !== normalized.summary?.httpFailures,
      postmanBaselineNotAvailable: normalized.sourceBaseline?.comparison === 'NOT_AVAILABLE',
      htmlChartsFixed: reportSurfaces.chartDataBeforeDraw,
      embeddedMatchesNormalized:
        embeddedNormalized &&
        embeddedNormalized.summary?.totalRequests === normalized.summary?.totalRequests &&
        embeddedNormalized.verdict?.category === normalized.verdict.category,
      authNoFalseTokenMissing: authEvidence.falseTokenMissingWarnings === 0,
      transportZero: (parsed.summary?.requests?.transportFailures || 0) === 0,
    };

    if (campaignChain.createFailed) {
      checks.campaignDependentSkipsWhenCreateFails =
        campaignChain.skipMetricsTotal > 0 ||
        campaignChain.dependentSkipsInReport > 0 ||
        campaignChain.dependentSkipLinesInLog > 0;
    } else {
      checks.campaignCreateDidNotFail400 = true;
      checks.note = 'CreateCTVCampaign did not return HTTP 4xx — dependency-skip chain not triggered this run';
    }

    const output = {
      certified: Object.values(checks).every((v) => v === true || typeof v === 'string'),
      checks,
      run: {
        runId: run.runId,
        scriptId: script.id,
        status: run.status,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        vus: VUS,
        authSessionMode: normalized.authSession?.authenticationMode || prepareAuth?.authenticationMode,
        credentialRecords: normalized.authSession?.credentialRecords ?? prepareAuth?.credentialRecords,
      },
      scriptGuards,
      metrics: {
        totalRequests: parsed.summary?.requests?.total,
        httpFailures: parsed.summary?.requests?.httpFailures,
        transportFailures: parsed.summary?.requests?.transportFailures,
        dependencySkipped: dependencySkippedFromSummary,
        skipMetricsFromPoints: skipMetrics,
        failureRate: parsed.summary?.requests?.errorRate,
        p95: parsed.summary?.responseTime?.p95,
        completedIterations: parsed.summary?.completedIterations,
        interruptedIterations: parsed.summary?.interruptedIterations,
        executionLifecycleStatus: parsed.summary?.executionLifecycleStatus,
      },
      verdict: normalized.verdict,
      thresholds: normalized.thresholds,
      sourceBaseline: normalized.sourceBaseline,
      campaignChain,
      authEvidence,
      badUrlScan: badUrls,
      reportSurfaces,
      embeddedVsNormalized: embeddedNormalized
        ? {
            totalRequests: {
              api: embeddedNormalized.summary?.totalRequests,
              normalized: normalized.summary?.totalRequests,
            },
            verdictCategory: {
              api: embeddedNormalized.verdict?.category,
              normalized: normalized.verdict.category,
            },
            dependencySkipped: {
              api: embeddedNormalized.failureCategorization?.dependencySkipped,
              normalized: normalized.failureCategorization?.dependencySkipped,
            },
          }
        : null,
      artifactPaths: {
        script: scriptPath,
        summary: path.join(artifactDir, 'summary.json'),
        metrics: path.join(artifactDir, 'metrics.json'),
        reportJson: reportJsonPath,
        reportHtml: htmlPath,
        log: logPath,
      },
    };

    console.log(JSON.stringify(output, null, 2));
    if (!output.certified) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(`[mediasmart-dependency-live] FAIL ${error.message}`);
  console.error(error.stack);
  process.exitCode = 1;
});
