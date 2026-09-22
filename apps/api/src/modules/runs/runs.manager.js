'use strict';

const path = require('path');
const fs = require('fs/promises');
const { LifecycleManager } = require('@perf/worker-runner');
const env = require('../../config/env');
const logger = require('../../config/logger');
const { parseRunArtifacts } = require('../../lib/k6/metricsParser');
const { writeReport } = require('../../lib/k6/reportGenerator');
const { buildNormalizedReport } = require('../../lib/report/normalizedReport');
const reportsStore = require('../reports/reports.store');
const scriptsStore = require('../scripts/scripts.store');
const collectionsStore = require('../collections/collections.store');

const logsDir = path.resolve(__dirname, '..', '..', '..', 'storage', 'run-logs');
const artifactsDir = path.resolve(__dirname, '..', '..', '..', 'storage', 'run-artifacts');
const reportsDir = path.resolve(__dirname, '..', '..', '..', 'storage', 'reports');

/**
 * Singleton lifecycle manager for the API process.
 * Phase 4+ will move this into a separate worker process talking via a queue.
 */
const lifecycle = new LifecycleManager({
  binPath: env.k6Bin || 'k6',
  logsDir,
  artifactsDir,
  maxLogLines: 2000,
  maxRuntimeMs: env.maxRunTimeMs || 30 * 60 * 1000,
});

/**
 * In-memory cache keyed by runId so we don't re-parse 10MB+ artifacts on
 * every API hit. Survives only for the API process lifetime.
 */
const reportCache = new Map();

reportsStore.configure({ indexPath: path.join(reportsDir, 'index.json') });
reportsStore.setLogger(logger);

let reportsReady = false;
async function ensureReportsReady() {
  if (reportsReady) return;
  await reportsStore.init();
  reportsReady = true;
  logger.info('Reports store initialized', {
    indexPath: path.join(reportsDir, 'index.json'),
    items: reportsStore.list().length,
  });
}
// Best-effort init at boot; non-blocking.
ensureReportsReady().catch((err) =>
  logger.error('Failed to init reports store', { error: err.message })
);

lifecycle.on('status', (evt) => {
  logger.info('Run status', {
    runId: evt.runId,
    status: evt.status,
    exitCode: evt.exitCode,
    durationMs: evt.durationMs,
  });
});

lifecycle.on('summary', ({ runId, summary }) => {
  logger.info('Run summary', { runId, summary });
});

/**
 * Build the headline numbers + display values used by the reports table.
 */
function buildManifest(ctx, script, collection, parsedReport, normalizedReport = null) {
  const s = parsedReport?.summary || {};
  const reqs = s.requests || {};
  const rt = s.responseTime || {};
  const checksTotal = parsedReport?.thresholds?.length || 0;
  const passed = (parsedReport?.thresholds || []).filter((t) => t.ok).length;
  // Phase 4: the normalized report is the authority for the pass/fail
  // verdict. If it wasn't built (early parse failure), leave the field
  // null — downstream UI treats null as "not yet available".
  const verdict = normalizedReport?.verdict?.status || null;

  // Display fields for the reports table.
  let displayMethod = 'MIXED';
  let displayApiName = '';
  const sel = script?.selectedRequests || [];
  if (sel.length === 1) {
    displayMethod = sel[0].method || 'GET';
    displayApiName = sel[0].name || sel[0].url || '';
  } else if (sel.length > 1) {
    const methods = new Set(sel.map((r) => (r.method || '').toUpperCase()));
    displayMethod = methods.size === 1 ? Array.from(methods)[0] : 'MIXED';
    displayApiName = `${sel.length} requests`;
  } else if (collection?.summary?.requestCount) {
    displayApiName = 'Entire collection';
  } else {
    displayApiName = '—';
  }

  return {
    id: ctx.runId,
    runId: ctx.runId,
    scriptId: ctx.scriptId,
    status: ctx.status,

    collectionId: script?.collectionId || null,
    collectionName: collection?.summary?.name || collection?.originalName || null,

    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    durationMs: ctx.durationMs,
    exitCode: ctx.exitCode ?? null,
    error: ctx.error || null,

    loadProfile: script?.loadProfile || null,
    workload: script?.workload || null,
    selection: script?.selection || null,
    selectedRequests: script?.selectedRequests || null,
    requestCount: script?.requestCount ?? null,
    totalCollectionRequests: script?.totalCollectionRequests ?? null,

    authFlow: script?.authFlow || null,
    authSession: ctx.authSession || null,
    env: ctx.env || null,
    manualOverrides: ctx.manualOverrides || [],

    displayMethod,
    displayApiName,

    metrics: {
      totalRequests: reqs.total ?? 0,
      failedRequests: reqs.failed ?? 0,
      errorRate: reqs.errorRate ?? 0,
      rps: reqs.rps ?? 0,
      avg: rt.avg ?? null,
      p95: rt.p95 ?? null,
      p99: rt.p99 ?? null,
      vusMax: s.vusMax ?? script?.loadProfile?.vus ?? null,
      iterations: s.iterations ?? null,
      dataSent: s.network?.dataSent ?? null,
      dataReceived: s.network?.dataReceived ?? null,
    },
    thresholds: {
      passed,
      failed: checksTotal - passed,
      total: checksTotal,
    },
    verdict,

    artifacts: {
      dir: ctx.artifacts?.dir || null,
      summaryExportPath: ctx.artifacts?.summaryExportPath || null,
      metricsJsonPath: ctx.artifacts?.metricsJsonPath || null,
      parsedSummaryPath: ctx.artifacts?.parsedSummaryPath || null,
      reportHtmlPath: ctx.artifacts?.reportHtmlPath || null,
      logFilePath: ctx.logFilePath || null,
      scriptFilePath: script?.filePath || null,
    },
  };
}

/**
 * Phase 4: sibling artifact holding the normalized report contract JSON.
 * Placed next to the (legacy) parsed-summary.json so it can be discovered
 * without a DB schema change and is served by getReport() below.
 */
function reportJsonPathFor(parsedSummaryPath) {
  if (!parsedSummaryPath) return null;
  return path.join(path.dirname(parsedSummaryPath), 'report.json');
}

/**
 * Phase 6.5 audit finding: K6's --summary-export writes a top-level
 * `setup_data` key that contains the entire object setup() returned.
 * When runtime auth chaining is active, that object carries the
 * captured ACCESS_TOKEN / AUTH_TOKEN / cookies verbatim — an
 * on-disk secret leak. Scrub the field in place before ANY code
 * reads the file. Best-effort: if scrubbing fails, we log and
 * continue — the parsed report never consumes setup_data anyway.
 */
/**
 * Phase 6.6: swap the setup_data-free summary written by the generated
 * script's handleSummary over the raw --summary-export write. Best
 * effort: silently succeeds when the clean file is missing (legacy
 * script) so pre-Phase-6.6 collections keep running.
 *
 * We rename rather than delete-then-write so there's no window where
 * the file doesn't exist.
 */
async function swapCleanSummaryOverRaw(pathsObj) {
  const raw = pathsObj?.summaryExportPath;
  // The worker-runner sets `cleanSummaryPath = summaryExportPath + '.clean'`.
  // Derive it here so the API works even if a caller passes a paths
  // object that doesn't carry the field yet (defence against a runtime
  // mismatch between the api and the worker-runner package).
  const clean = pathsObj?.cleanSummaryPath || (raw ? raw + '.clean' : null);
  if (!raw || !clean) return { swapped: false, reason: 'no-paths' };
  try {
    await fs.access(clean);
  } catch {
    return { swapped: false, reason: 'no-clean-file' };
  }
  try {
    await fs.rename(clean, raw);
    return { swapped: true };
  } catch (err) {
    logger.warn('clean summary swap failed; falling back to scrubber', {
      raw,
      clean,
      error: err.message,
    });
    return { swapped: false, reason: 'rename-failed', error: err.message };
  }
}

async function scrubSummarySetupData(summaryExportPath) {
  if (!summaryExportPath) return { scrubbed: false };
  try {
    const raw = await fs.readFile(summaryExportPath, 'utf-8');
    const obj = JSON.parse(raw);
    if (obj && Object.prototype.hasOwnProperty.call(obj, 'setup_data')) {
      delete obj.setup_data;
      await fs.writeFile(summaryExportPath, JSON.stringify(obj), 'utf-8');
      return { scrubbed: true };
    }
    return { scrubbed: false };
  } catch (err) {
    logger.warn('setup_data scrub failed', { path: summaryExportPath, error: err.message });
    return { scrubbed: false, error: err.message };
  }
}

lifecycle.on('report-ready', async ({ runId, paths }) => {
  await ensureReportsReady().catch(() => {});
  let parsed = null;
  let normalized = null;
  try {
    const ctx = lifecycle.get(runId);
    if (!ctx || !paths) return;
    // Phase 6.6: the generated script's handleSummary writes a
    // setup_data-free copy of the summary to <path>.clean via
    // __ENV.PA_CLEAN_SUMMARY_PATH. If that clean file exists, swap it
    // over the raw --summary-export write so downstream code (including
    // scrubSummarySetupData below) sees only clean content.
    await swapCleanSummaryOverRaw(paths);
    // Phase 6.5 scrubber runs unconditionally as defense-in-depth. If the
    // clean-swap already succeeded there's nothing to strip; if the
    // script pre-dates Phase 6.6 (no handleSummary), the scrubber is
    // still the safety net.
    await scrubSummarySetupData(paths.summaryExportPath);
    parsed = await parseRunArtifacts({
      summaryExportPath: paths.summaryExportPath,
      metricsJsonPath: paths.metricsJsonPath,
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
      durationMs: ctx.durationMs,
      iterationLifecycle: ctx.iterationLifecycle || null,
    });
    // Preserve the legacy artifact for any external consumers that still
    // consume parseRunArtifacts output. New code reads report.json.
    await fs.writeFile(paths.parsedSummaryPath, JSON.stringify(parsed, null, 2), 'utf-8');

    // Build the Phase 4 normalized report and persist it as report.json.
    const script = ctx.scriptId ? scriptsStore.get(ctx.scriptId) : null;
    const collection = script?.collectionId
      ? collectionsStore.get(script.collectionId)
      : null;
    normalized = buildNormalizedReport({
      parsed,
      run: {
        runId,
        scriptId: ctx.scriptId,
        status: ctx.status,
        exitCode: ctx.exitCode ?? null,
        error: ctx.error || null,
        startedAt: ctx.startedAt,
        endedAt: ctx.endedAt,
        durationMs: ctx.durationMs,
        pacingMs: ctx.env?.PACING_MS ?? script?.pacingMs ?? 1000,
        authSession: ctx.authSession || null,
        sourceBaseline: ctx.sourceBaseline || null,
      },
      script,
      collection,
    });
    const reportJsonPath = reportJsonPathFor(paths.parsedSummaryPath);
    if (reportJsonPath) {
      await fs.writeFile(reportJsonPath, JSON.stringify(normalized, null, 2), 'utf-8');
    }

    // HTML report is rendered from the normalized model.
    await writeReport(paths.reportHtmlPath, normalized, {
      runId,
      scriptId: ctx.scriptId,
      status: ctx.status,
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
    });
    reportCache.set(runId, {
      parsed,
      normalized,
      generatedAt: new Date().toISOString(),
    });
    logger.info('Run report generated', {
      runId,
      pointsParsed: parsed.summary?.pointsParsed,
      requests: parsed.summary?.requests?.total,
      thresholds: parsed.thresholds.length,
      verdict: normalized.verdict.status,
      thresholdsFailed: normalized.verdict.thresholdsFailed,
    });
  } catch (err) {
    logger.warn('Run report generation failed', { runId, error: err.message });
  }

  // Persist a manifest regardless of whether parsing succeeded — the user
  // still needs to see that a run happened, with logs available.
  try {
    const ctx = lifecycle.get(runId);
    if (!ctx) return;
    const script = ctx.scriptId ? scriptsStore.get(ctx.scriptId) : null;
    const collection = script?.collectionId
      ? collectionsStore.get(script.collectionId)
      : null;
    const manifest = buildManifest(ctx, script, collection, parsed, normalized);
    await reportsStore.add(manifest);
    logger.info('Report manifest persisted', { reportId: manifest.id });
  } catch (err) {
    logger.warn('Failed to persist report manifest', { runId, error: err.message });
  }
});

/**
 * Lazily load (and cache) a parsed report for a run. Used by the
 * summary/metrics/report endpoints when the cache wasn't populated by the
 * 'report-ready' handler (e.g. server restart). Now also falls back to the
 * persistent reports store so reports survive restarts.
 */
async function getReport(runId) {
  const entry = await loadReportEntry(runId);
  return entry ? entry.parsed : null;
}

/**
 * Phase 4: return the normalized report contract. Prefers a persisted
 * report.json sibling, falls back to building it from the parsed shape.
 */
async function getNormalizedReport(runId) {
  const entry = await loadReportEntry(runId);
  if (!entry) return null;
  if (entry.normalized) return entry.normalized;
  // Build on demand — happens on the cold-start / post-restart path where
  // we hydrated the parsed shape from disk but no report.json exists yet
  // (e.g. legacy artifacts predating Phase 4).
  const ctx = lifecycle.get(runId);
  const persisted = ctx ? null : reportsStore.get(runId);
  const script = ctx?.scriptId
    ? scriptsStore.get(ctx.scriptId)
    : persisted?.scriptId
      ? scriptsStore.get(persisted.scriptId)
      : null;
  const collection = script?.collectionId
    ? collectionsStore.get(script.collectionId)
    : null;
  const normalized = buildNormalizedReport({
    parsed: entry.parsed,
    run: {
      runId,
      scriptId: ctx?.scriptId || persisted?.scriptId || null,
      status: ctx?.status || persisted?.status || null,
      exitCode: ctx?.exitCode ?? persisted?.exitCode ?? null,
      error: ctx?.error || persisted?.error || null,
      startedAt: ctx?.startedAt || persisted?.startedAt || null,
      endedAt: ctx?.endedAt || persisted?.endedAt || null,
      durationMs: ctx?.durationMs ?? persisted?.durationMs ?? null,
    },
    script,
    collection,
  });
  entry.normalized = normalized;
  reportCache.set(runId, entry);
  return normalized;
}

/**
 * Hydrate a { parsed, normalized } entry for the given runId. Prefers the
 * cache, then live artifacts on disk, finally the persisted reports store.
 */
async function loadReportEntry(runId) {
  if (reportCache.has(runId)) return reportCache.get(runId);

  // Prefer live lifecycle context.
  const ctx = lifecycle.get(runId);
  const artifacts = ctx?.artifacts || reportsStore.get(runId)?.artifacts || null;
  if (!artifacts) return null;

  const entry = { parsed: null, normalized: null, generatedAt: new Date().toISOString() };
  const reportJsonPath = reportJsonPathFor(artifacts.parsedSummaryPath);

  // Try the normalized artifact first — it's authoritative for Phase 4.
  if (reportJsonPath) {
    try {
      entry.normalized = JSON.parse(await fs.readFile(reportJsonPath, 'utf-8'));
    } catch {
      /* fall through */
    }
  }
  // Legacy parsed artifact for backward compatibility.
  try {
    entry.parsed = JSON.parse(await fs.readFile(artifacts.parsedSummaryPath, 'utf-8'));
  } catch {
    /* fall through */
  }
  // Live re-parse when the file wasn't written yet.
  if (!entry.parsed && ctx?.artifacts) {
    try {
      entry.parsed = await parseRunArtifacts({
        summaryExportPath: ctx.artifacts.summaryExportPath,
        metricsJsonPath: ctx.artifacts.metricsJsonPath,
        startedAt: ctx.startedAt,
        endedAt: ctx.endedAt,
        durationMs: ctx.durationMs,
      });
    } catch {
      /* fall through */
    }
  }
  if (!entry.parsed && !entry.normalized) return null;
  reportCache.set(runId, entry);
  return entry;
}

module.exports = {
  lifecycle,
  getReport,
  getNormalizedReport,
  ensureReportsReady,
  scrubSummarySetupData,
  swapCleanSummaryOverRaw,
};
