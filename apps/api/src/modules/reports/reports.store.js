'use strict';

/**
 * SQLite-backed reports store.
 *
 * Migration path:
 * - Older builds wrote a JSON manifest at storage/reports/index.json. We do
 *   NOT auto-migrate that file (the run artifacts on disk are still valid
 *   though). New runs always go to the DB.
 *
 * Storage policy:
 * - DB rows hold metadata + headline metrics + threshold counts + paths.
 * - HTML report, parsed metrics JSON, raw K6 outputs and run logs all stay on
 *   disk under storage/run-artifacts/<runId>/ and storage/run-logs/<runId>.log.
 */

const { getDb } = require('../../config/db');

let _logger = console;
function setLogger(logger) {
  _logger = logger;
}

// Kept for API compatibility with the previous file-based store.
function configure() {}
function init() {
  // Touch the DB so the table exists before first read.
  getDb();
  return Promise.resolve();
}

function rowToManifest(row) {
  if (!row) return null;
  return {
    id: row.id,
    runId: row.run_id,
    scriptId: row.script_id,
    status: row.status,
    collectionId: row.collection_id,
    collectionName: row.collection_name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    exitCode: row.exit_code,
    error: row.error,
    loadProfile: row.load_profile_json ? JSON.parse(row.load_profile_json) : null,
    selection: row.selection_json ? JSON.parse(row.selection_json) : null,
    selectedRequests: row.selected_requests_json
      ? JSON.parse(row.selected_requests_json)
      : null,
    requestCount: row.request_count,
    totalCollectionRequests: row.total_collection_requests,
    authFlow: row.auth_flow_json ? JSON.parse(row.auth_flow_json) : null,
    env: row.env_snapshot_json ? JSON.parse(row.env_snapshot_json) : null,
    displayMethod: row.display_method,
    displayApiName: row.display_api_name,
    metrics: row.metrics_json ? JSON.parse(row.metrics_json) : null,
    thresholds: row.thresholds_json ? JSON.parse(row.thresholds_json) : null,
    artifacts: {
      dir: row.artifacts_dir,
      summaryExportPath: row.summary_export_path,
      metricsJsonPath: row.metrics_json_path,
      parsedSummaryPath: row.parsed_summary_path,
      reportHtmlPath: row.report_html_path,
      logFilePath: row.log_file_path,
      scriptFilePath: row.script_file_path,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function add(manifest) {
  if (!manifest?.id) throw new Error('reports.store.add: id is required');
  const now = new Date().toISOString();
  const a = manifest.artifacts || {};
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO reports (
        id, run_id, script_id, status,
        collection_id, collection_name,
        started_at, ended_at, duration_ms, exit_code, error,
        load_profile_json, selection_json, selected_requests_json,
        request_count, total_collection_requests,
        auth_flow_json, env_snapshot_json,
        display_method, display_api_name,
        metrics_json, thresholds_json,
        artifacts_dir, summary_export_path, metrics_json_path,
        parsed_summary_path, report_html_path, log_file_path, script_file_path,
        created_at, updated_at
      ) VALUES (
        @id, @run_id, @script_id, @status,
        @collection_id, @collection_name,
        @started_at, @ended_at, @duration_ms, @exit_code, @error,
        @load_profile_json, @selection_json, @selected_requests_json,
        @request_count, @total_collection_requests,
        @auth_flow_json, @env_snapshot_json,
        @display_method, @display_api_name,
        @metrics_json, @thresholds_json,
        @artifacts_dir, @summary_export_path, @metrics_json_path,
        @parsed_summary_path, @report_html_path, @log_file_path, @script_file_path,
        @created_at, @updated_at
      )`
    )
    .run({
      id: manifest.id,
      run_id: manifest.runId,
      script_id: manifest.scriptId ?? null,
      status: manifest.status,
      collection_id: manifest.collectionId ?? null,
      collection_name: manifest.collectionName ?? null,
      started_at: manifest.startedAt,
      ended_at: manifest.endedAt ?? null,
      duration_ms: manifest.durationMs ?? null,
      exit_code: manifest.exitCode ?? null,
      error: manifest.error ?? null,
      load_profile_json: manifest.loadProfile ? JSON.stringify(manifest.loadProfile) : null,
      selection_json: manifest.selection ? JSON.stringify(manifest.selection) : null,
      selected_requests_json: manifest.selectedRequests
        ? JSON.stringify(manifest.selectedRequests)
        : null,
      request_count: manifest.requestCount ?? null,
      total_collection_requests: manifest.totalCollectionRequests ?? null,
      auth_flow_json: manifest.authFlow ? JSON.stringify(manifest.authFlow) : null,
      env_snapshot_json: manifest.env ? JSON.stringify(manifest.env) : null,
      display_method: manifest.displayMethod || 'GET',
      display_api_name: manifest.displayApiName || '',
      metrics_json: manifest.metrics ? JSON.stringify(manifest.metrics) : null,
      thresholds_json: manifest.thresholds ? JSON.stringify(manifest.thresholds) : null,
      artifacts_dir: a.dir ?? null,
      summary_export_path: a.summaryExportPath ?? null,
      metrics_json_path: a.metricsJsonPath ?? null,
      parsed_summary_path: a.parsedSummaryPath ?? null,
      report_html_path: a.reportHtmlPath ?? null,
      log_file_path: a.logFilePath ?? null,
      script_file_path: a.scriptFilePath ?? null,
      created_at: manifest.createdAt || now,
      updated_at: now,
    });
  _logger.info?.('Report row inserted', { id: manifest.id });
  return get(manifest.id);
}

function update(id, patch) {
  const existing = get(id);
  if (!existing) return null;
  const merged = { ...existing, ...patch };
  return add(merged);
}

function get(id) {
  const row = getDb()
    .prepare('SELECT * FROM reports WHERE id = ? OR run_id = ?')
    .get(id, id);
  return rowToManifest(row);
}

function list() {
  return getDb()
    .prepare('SELECT * FROM reports ORDER BY started_at DESC, created_at DESC')
    .all()
    .map(rowToManifest);
}

function remove(id) {
  const res = getDb().prepare('DELETE FROM reports WHERE id = ? OR run_id = ?').run(id, id);
  return res.changes > 0;
}

module.exports = { configure, init, add, update, get, list, remove, setLogger };
