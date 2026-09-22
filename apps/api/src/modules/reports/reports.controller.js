'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const reportsStore = require('./reports.store');

function publicView(record) {
  if (!record) return null;
  // The internal artifacts paths are filesystem-only; do not leak them to the client.
  const { artifacts, ...safe } = record;
  return {
    ...safe,
    hasReportHtml: !!artifacts?.reportHtmlPath && fs.existsSync(artifacts.reportHtmlPath),
    hasMetrics: !!artifacts?.parsedSummaryPath && fs.existsSync(artifacts.parsedSummaryPath),
    hasLog: !!artifacts?.logFilePath && fs.existsSync(artifacts.logFilePath),
  };
}

function listReports(_req, res) {
  res.json({ success: true, data: reportsStore.list().map(publicView) });
}

function getReport(req, res, next) {
  const r = reportsStore.get(req.params.id);
  if (!r) return next(ApiError.notFound('Report not found'));
  res.json({ success: true, data: publicView(r) });
}

/**
 * Returns the parsed metrics JSON (timeseries, requests, failures, thresholds).
 * Powers the dashboard's RunReport even after the API has restarted.
 */
async function getMetrics(req, res, next) {
  try {
    const r = reportsStore.get(req.params.id);
    if (!r) throw ApiError.notFound('Report not found');
    const p = r.artifacts?.parsedSummaryPath;
    if (!p || !fs.existsSync(p)) {
      throw ApiError.notFound('Parsed metrics not available for this report');
    }
    const buf = await fsp.readFile(p, 'utf-8');
    const data = JSON.parse(buf);
    res.json({
      success: true,
      data: {
        runId: r.runId,
        status: r.status,
        ...data,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * Streams the generated HTML report. Append `?download=1` to force download.
 */
function getReportHtml(req, res, next) {
  const r = reportsStore.get(req.params.id);
  if (!r) return next(ApiError.notFound('Report not found'));
  const p = r.artifacts?.reportHtmlPath;
  if (!p || !fs.existsSync(p)) {
    return next(ApiError.notFound('HTML report file not available'));
  }
  const wantDownload = String(req.query.download || '') === '1';
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (wantDownload) {
    headers['Content-Disposition'] = `attachment; filename="perf-report-${r.id}.html"`;
  }
  res.set(headers);
  res.sendFile(p, (err) => {
    if (err) next(err);
  });
}

/**
 * Reads the persisted log file for the run. Used by the report detail page so
 * a "live console" view is available after restart.
 */
async function getLogs(req, res, next) {
  try {
    const r = reportsStore.get(req.params.id);
    if (!r) throw ApiError.notFound('Report not found');
    const p = r.artifacts?.logFilePath;
    if (!p || !fs.existsSync(p)) {
      return res.json({ success: true, data: { runId: r.runId, lines: [] } });
    }
    const buf = await fsp.readFile(p, 'utf-8');
    // Each log line was written as `[ts] [stream] line`. Parse back into the
    // shape the LiveConsole expects.
    const lines = buf
      .split(/\r?\n/)
      .filter(Boolean)
      .map((raw) => {
        const m = raw.match(/^\[([^\]]+)\]\s\[([^\]]+)\]\s(.*)$/);
        if (m) return { ts: m[1], stream: m[2], line: m[3] };
        return { ts: '', stream: 'stdout', line: raw };
      });
    res.json({ success: true, data: { runId: r.runId, lines } });
  } catch (err) {
    next(err);
  }
}

/**
 * Permanent delete: index entry + every artifact on disk.
 */
async function deleteReport(req, res, next) {
  try {
    const r = reportsStore.get(req.params.id);
    if (!r) throw ApiError.notFound('Report not found');

    const removed = [];
    const failed = [];

    // 1) Remove the per-run artifacts directory if we know it.
    const dir = r.artifacts?.dir;
    if (dir && fs.existsSync(dir)) {
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        removed.push(dir);
      } catch (err) {
        failed.push({ path: dir, error: err.message });
      }
    }

    // 2) Remove individual artifact files in case some live outside `dir`.
    const filesToTry = [
      r.artifacts?.reportHtmlPath,
      r.artifacts?.parsedSummaryPath,
      r.artifacts?.summaryExportPath,
      r.artifacts?.metricsJsonPath,
      r.artifacts?.logFilePath,
    ].filter(Boolean);
    for (const p of filesToTry) {
      if (!fs.existsSync(p)) continue;
      try {
        await fsp.rm(p, { force: true });
        removed.push(p);
      } catch (err) {
        failed.push({ path: p, error: err.message });
      }
    }

    // 3) Remove the manifest entry.
    await reportsStore.remove(r.id);

    logger.info('Report deleted', {
      reportId: r.id,
      removedFiles: removed.length,
      failed: failed.length,
    });

    res.json({
      success: true,
      data: {
        id: r.id,
        removedFiles: removed.length,
        failedFiles: failed,
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listReports,
  getReport,
  getMetrics,
  getReportHtml,
  getLogs,
  deleteReport,
};
