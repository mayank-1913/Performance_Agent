'use strict';

/**
 * HTML report renderer.
 *
 * Phase 4: renders the normalized report contract produced by
 * apps/api/src/lib/report/normalizedReport.js. The same HTML is emitted
 * for every run, regardless of the source Postman collection or the auth
 * strategy the script used.
 *
 * Backward compatibility: if the caller still hands the pre-Phase-4
 * shape (parseRunArtifacts output — no `verdict` / `metadata` / `apiMetrics`
 * keys) we adapt it in-place by wrapping it in a minimal normalized
 * envelope. That path is exercised only by legacy code that hasn't been
 * migrated yet; new code should always pass the normalized model.
 *
 * The HTML is a single self-contained file (inline CSS only, tiny vanilla
 * canvas sparklines) and never issues a network request when opened.
 */

const fs = require('fs/promises');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(pct) {
  if (pct == null || !Number.isFinite(pct)) return '—';
  return `${pct.toFixed(2)}%`;
}

function numOr(v, fallback = '—') {
  if (v == null || !Number.isFinite(v)) return fallback;
  return String(v);
}

/* ------------------------------------------------------------------ */
/*  Back-compat shim: accept either the normalized shape OR the legacy */
/*  parseRunArtifacts output. Legacy inputs are lifted into a minimal   */
/*  normalized envelope so the rest of the renderer only has one shape. */
/* ------------------------------------------------------------------ */

function coerceToNormalized(report, ctx) {
  if (report && report.verdict && report.summary && report.apiMetrics) {
    // Already normalized.
    return report;
  }
  const {
    buildNormalizedReport,
  } = require('../report/normalizedReport');
  return buildNormalizedReport({
    parsed: report,
    run: {
      runId: ctx?.runId || null,
      scriptId: ctx?.scriptId || null,
      status: ctx?.status || null,
      exitCode: ctx?.exitCode ?? null,
      error: ctx?.error || null,
      startedAt: ctx?.startedAt || null,
      endedAt: ctx?.endedAt || null,
      durationMs: ctx?.durationMs ?? null,
    },
  });
}

/* ------------------------------------------------------------------ */
/*  HTML                                                                */
/* ------------------------------------------------------------------ */

function renderReportHtml(reportOrLegacy, ctx) {
  const report = coerceToNormalized(reportOrLegacy, ctx);
  const meta = report.metadata || {};
  const exec = report.execution || {};
  const load = report.loadProfile || {};
  const timeout = report.timeoutConfig || {};
  const auth = report.authSession || {};
  const sum = report.summary || {};
  const fb = report.failureBreakdown || { http: {}, transport: {} };
  const verdict = report.verdict || {
    status: 'FAIL',
    category: 'FAIL',
    reasons: [],
    agentReasons: [],
    applicationReasons: [],
    thresholdsFailed: 0,
    executionOk: false,
  };
  const thresholds = report.thresholds || [];
  const apis = report.apiMetrics || [];
  const slowest = report.slowestApis || [];
  const highestError = report.highestErrorApis || [];
  const failures = report.failures || [];
  const failureAnalysis = report.failureAnalysis || [];
  const dependencySkipped = report.dependencySkippedRequests || [];
  const failureSections = report.failureSections || {};
  const sourceBaseline = report.sourceBaseline || { available: false, comparison: 'NOT_AVAILABLE' };
  const points = report.timeseries?.points || [];
  const fc = report.failureCategorization || {};
  const hasChartData = points.length > 0;

  const passedThresholds = thresholds.filter((t) => t.status === 'pass').length;
  const failedThresholds = thresholds.length - passedThresholds;

  const chartP95 = points.map((p) => p.p95 ?? 0);
  const chartRps = points.map((p) => p.rps ?? 0);
  const chartErr = points.map((p) => p.errors ?? 0);
  const chartVus = points.map((p) => p.vus ?? 0);
  const chartDataJson = JSON.stringify({
    p95: chartP95,
    rps: chartRps,
    err: chartErr,
    vus: chartVus,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>K6 performance report · ${escapeHtml(meta.runId || '')}</title>
<style>
  :root {
    color-scheme: light;
    /* Light-theme palette matching the SPA (reference: modern light dashboard). */
    --bg: #f8fafc;
    --panel: #ffffff;
    --panel-2: #f9fafb;
    --border: #e5e7eb;
    --border-strong: #d1d5db;
    --text: #111827;
    --text-secondary: #4b5563;
    --muted: #6b7280;
    --ok: #10b981;
    --ok-bg: #ecfdf5;
    --bad: #ef4444;
    --bad-bg: #fef2f2;
    --warn: #f59e0b;
    --warn-bg: #fffbeb;
    --accent: #6366f1;
    --accent-blue: #3b82f6;
  }
  * { box-sizing: border-box; }
  html, body { overflow-x: hidden; }
  body { margin: 0; padding: 20px 16px 32px; background: var(--bg); color: var(--text);
         font-family: -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
         line-height: 1.45; font-size: 13px; }
  h1 { margin: 0 0 4px; font-size: 20px; color: var(--text); font-weight: 700; }
  h2 { margin: 28px 0 10px; font-size: 13px; color: var(--muted); text-transform: uppercase;
       letter-spacing: 0.05em; font-weight: 600; }
  h3 { margin: 0 0 8px; font-size: 12px; color: var(--text-secondary); font-weight: 600; }
  .container { max-width: 1200px; margin: 0 auto; }
  .meta { color: var(--muted); font-size: 12px; }
  .grid { display: grid; gap: 12px; }
  .grid-cards { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
  .grid-charts { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .grid-two   { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
          padding: 16px;
          box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06); }
  .stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
                color: var(--muted); }
  .stat-value { margin-top: 6px; font-size: 22px; font-weight: 600; color: var(--text); }
  .stat-sub { margin-top: 4px; font-size: 12px; color: var(--muted); }
  .ok { color: var(--ok); }
  .bad { color: var(--bad); }
  .warn { color: var(--warn); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; color: var(--text); table-layout: auto; }
  thead th { text-align: left; font-weight: 600; font-size: 11px; color: var(--muted);
             text-transform: uppercase; letter-spacing: 0.05em; padding: 8px 10px;
             background: var(--panel-2); position: sticky; top: 0; z-index: 1;
             border-bottom: 1px solid var(--border); white-space: nowrap; }
  tbody td { padding: 8px 10px; border-top: 1px solid var(--border); vertical-align: top;
             word-break: break-word; overflow-wrap: anywhere; max-width: 280px; }
  tbody tr:hover { background: var(--panel-2); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .scroll-y { max-height: 420px; overflow: auto; border: 1px solid var(--border);
              border-radius: 12px; background: var(--panel); }
  .scroll-x { overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
  .table-wrap { border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
  .table-wrap .scroll-y { border: none; border-radius: 0; }
  .note { font-size: 12px; color: var(--text-secondary); margin: 8px 0 0; padding: 10px 12px;
          background: var(--panel-2); border-radius: 8px; border: 1px solid var(--border); }
  .chart-empty { padding: 24px 12px; text-align: center; color: var(--muted); font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px;
           font-weight: 600; }
  .badge.ok  { background: var(--ok-bg);  color: var(--ok);  border: 1px solid #a7f3d0; }
  .badge.bad { background: var(--bad-bg); color: var(--bad); border: 1px solid #fecaca; }
  canvas { display: block; width: 100%; height: 120px; }
  .chart-title { display: flex; justify-content: space-between; font-size: 12px;
                 color: var(--muted); margin-bottom: 8px; }
  .verdict {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 18px; border-radius: 12px; margin: 12px 0 8px;
    border: 1px solid var(--border);
    box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
  }
  .verdict.pass { background: var(--ok-bg);  border-color: #a7f3d0; }
  .verdict.fail { background: var(--bad-bg); border-color: #fecaca; }
  .verdict .label { font-size: 20px; font-weight: 700; }
  .verdict.pass .label { color: var(--ok); }
  .verdict.fail .label { color: var(--bad); }
  .verdict ul { margin: 6px 0 0; padding-left: 18px; color: var(--text-secondary); font-size: 12px; }
  dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 12px;
          font-size: 12px; margin: 0; }
  dl.kv dt { color: var(--muted); }
  dl.kv dd { margin: 0; color: var(--text); }
</style>
</head>
<body>
<div class="container">
  <h1>K6 performance report</h1>
  <div class="meta">
    Run <span class="mono">${escapeHtml(meta.runId || '')}</span> ·
    Script <span class="mono">${escapeHtml(meta.scriptId || '')}</span> ·
    Collection <strong>${escapeHtml(meta.collectionName || '—')}</strong> ·
    Contract v${escapeHtml(meta.contractVersion)}
  </div>

  <div class="verdict ${verdict.status === 'PASS' ? 'pass' : 'fail'}">
    <div class="label">${escapeHtml(verdict.status)}</div>
    <div>
      <div style="font-size:12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em;">Final verdict · ${escapeHtml(verdict.category || verdict.status)}</div>
      ${verdict.reasons && verdict.reasons.length
        ? `<ul>${verdict.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>`
        : ''}
    </div>
  </div>

  <div class="grid grid-two">
    <div class="card">
      <div class="stat-label">Execution</div>
      <dl class="kv" style="margin-top:8px;">
        <dt>Status</dt>       <dd><strong class="${exec.status === 'completed' ? 'ok' : 'bad'}">${escapeHtml(exec.status || '—')}</strong></dd>
        <dt>Exit code</dt>    <dd class="mono">${exec.exitCode == null ? '—' : escapeHtml(String(exec.exitCode))}</dd>
        <dt>Started</dt>      <dd class="mono">${escapeHtml(exec.startedAt || '—')}</dd>
        <dt>Ended</dt>        <dd class="mono">${escapeHtml(exec.endedAt || '—')}</dd>
        <dt>Duration</dt>     <dd>${escapeHtml(sum.duration || formatMs(exec.durationMs))}</dd>
        <dt>Completed iterations</dt><dd class="mono">${numOr(exec.completedIterations ?? exec.iterations)}</dd>
        <dt>Interrupted iterations</dt><dd class="mono ${(exec.interruptedIterations || 0) > 0 ? 'warn' : ''}">${numOr(exec.interruptedIterations)}</dd>
        <dt>Execution lifecycle</dt><dd>${escapeHtml(exec.executionLifecycleStatus || sum.executionLifecycleStatus || '—')}</dd>
        <dt>Peak VUs</dt>     <dd class="mono">${numOr(exec.vusMax)}</dd>
        <dt>Points parsed</dt><dd class="mono">${numOr(exec.pointsParsed)}</dd>
        ${exec.error ? `<dt>Error</dt><dd class="bad">${escapeHtml(exec.error)}</dd>` : ''}
      </dl>
    </div>
    <div class="card">
      <div class="stat-label">Load profile</div>
      <dl class="kv" style="margin-top:8px;">
        <dt>Profile</dt>       <dd>${escapeHtml(load.label || load.profile || '—')}</dd>
        <dt>Executor</dt>      <dd>${escapeHtml(load.executor || '—')}</dd>
        <dt>VUs</dt>           <dd class="mono">${numOr(load.vus)}</dd>
        <dt>Ramp-up</dt>       <dd class="mono">${escapeHtml(load.rampUp || '—')}</dd>
        <dt>Hold</dt>          <dd class="mono">${escapeHtml(load.hold || '—')}</dd>
        <dt>Ramp-down</dt>     <dd class="mono">${escapeHtml(load.rampDown || '—')}</dd>
        <dt>Total duration</dt><dd>${escapeHtml(load.totalDuration || '—')}</dd>
        <dt>Graceful stop</dt><dd class="mono">${escapeHtml(load.gracefulStop || timeout.gracefulStop || '—')}</dd>
        <dt>Request timeout</dt><dd class="mono">${escapeHtml(timeout.defaultTimeout || '—')}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="stat-label">Authentication</div>
      <dl class="kv" style="margin-top:8px;">
        <dt>Mode</dt><dd>${escapeHtml(auth.authenticationMode || '—')}</dd>
        <dt>VUs</dt><dd class="mono">${numOr(auth.vus)}</dd>
        <dt>Credential records</dt><dd class="mono">${numOr(auth.credentialRecords)}</dd>
        <dt>Credential reuse</dt><dd>${auth.credentialReuse ? 'enabled' : 'disabled'}</dd>
      </dl>
    </div>
  </div>

  <h2>Executive summary</h2>
  <div class="grid grid-cards">
    ${renderStat('Total requests', numOr(sum.totalRequests))}
    ${renderStat('Successful HTTP', numOr(sum.successfulHttpResponses ?? sum.successfulRequests), null, 'ok')}
    ${renderStat('HTTP/API failures', numOr(sum.httpFailures), null, sum.httpFailures > 0 ? 'bad' : 'ok')}
    ${renderStat('Transport failures', numOr(sum.transportFailures), null, sum.transportFailures > 0 ? 'bad' : 'ok')}
    ${renderStat('Failure rate', formatPercent(sum.failureRate ?? sum.errorPercentage))}
    ${renderStat('RPS (avg)', numOr(sum.rps))}
    ${renderStat('Peak VUs', numOr(sum.peakVUs))}
    ${renderStat('Completed iterations', numOr(sum.completedIterations ?? sum.iterations))}
    ${renderStat('Interrupted iterations', numOr(sum.interruptedIterations), null, sum.interruptedIterations > 0 ? 'warn' : 'ok')}
    ${renderStat('Test duration', sum.duration || formatMs(sum.durationMs))}
  </div>

  <h2>Failure categorization</h2>
  <div class="grid grid-cards">
    ${renderStat('HTTP/API failures', numOr(fc.httpFailures ?? sum.httpFailures), null, (fc.httpFailures ?? sum.httpFailures) > 0 ? 'bad' : 'ok')}
    ${renderStat('Transport failures', numOr(fc.transportFailures ?? sum.transportFailures), null, (fc.transportFailures ?? sum.transportFailures) > 0 ? 'bad' : 'ok')}
    ${renderStat('Dependency-skipped', numOr(fc.dependencySkipped ?? dependencySkipped.length), null, (fc.dependencySkipped ?? dependencySkipped.length) > 0 ? 'warn' : 'ok')}
    ${renderStat('SLA threshold failures', numOr(fc.slaFailures ?? sum.slaFailures), null, (fc.slaFailures ?? sum.slaFailures) > 0 ? 'bad' : 'ok')}
    ${renderStat('Interrupted iterations', numOr(fc.interruptedIterations ?? sum.interruptedIterations), null, (fc.interruptedIterations ?? sum.interruptedIterations) > 0 ? 'warn' : 'ok')}
    ${renderStat('Execution lifecycle', escapeHtml(fc.executionLifecycleStatus || sum.executionLifecycleStatus || 'n/a'))}
  </div>
  <div class="note">
    ${sourceBaseline.available
      ? `Postman baseline: <strong>${escapeHtml(sourceBaseline.comparison)}</strong>`
      : 'Postman baseline not available; failures attributed to observed application/API response.'}
    ${verdict.category === 'APPLICATION_PERFORMANCE_FAILURE'
      ? ' Application/API failures and SLA violations were observed. Authentication may have been established — see Authentication section.'
      : ''}
  </div>

  <h2>Latency</h2>
  <div class="grid grid-cards">
    ${renderStat('Average', formatMs(sum.avg))}
    ${renderStat('Median', formatMs(sum.median))}
    ${renderStat('p90', formatMs(sum.p90))}
    ${renderStat('p95', formatMs(sum.p95))}
    ${renderStat('p99', formatMs(sum.p99), sum.p99Note || null)}
    ${renderStat('Min', formatMs(sum.min))}
    ${renderStat('Max', formatMs(sum.max))}
    ${renderStat('Data sent', sum.dataSent || formatBytes(sum.dataSentBytes))}
    ${renderStat('Data received', sum.dataReceived || formatBytes(sum.dataReceivedBytes))}
    ${renderStat('Duration', sum.duration || formatMs(sum.durationMs))}
  </div>

  <h2>Thresholds &amp; SLA</h2>
  <div class="card">
    <div style="display:flex; gap:16px; margin-bottom:8px;">
      <div><span class="badge ok">passed ${passedThresholds}</span></div>
      <div><span class="badge bad">failed ${failedThresholds}</span></div>
    </div>
    ${thresholds.length === 0
      ? '<div class="meta">No SLA thresholds were declared for this script.</div>'
      : `<div class="scroll-y"><table>
          <thead><tr>
            <th>Metric</th><th>Threshold</th><th>Actual</th><th>Status</th><th>Description</th>
          </tr></thead>
          <tbody>${thresholds
            .map(
              (t) => `<tr>
                <td class="mono">${escapeHtml(t.metric)}</td>
                <td class="mono">${escapeHtml(t.threshold)}</td>
                <td class="mono">${t.actual == null ? '—' : escapeHtml(String(t.actual))}</td>
                <td><span class="badge ${t.status === 'pass' ? 'ok' : 'bad'}">${escapeHtml(t.status)}</span></td>
                <td>${escapeHtml(t.description)}</td>
              </tr>`
            )
            .join('')}</tbody>
        </table></div>`}
  </div>

  <h2>Charts</h2>
  ${hasChartData
    ? `<div class="grid grid-charts">
    ${renderChart('p95 response time', 'p95Chart', 'ms')}
    ${renderChart('Requests per second', 'rpsChart', 'rps')}
    ${renderChart('Errors per bucket', 'errChart', '')}
    ${renderChart('Virtual users', 'vusChart', 'vus')}
  </div>`
    : '<div class="card chart-empty">No time-series data available for this run.</div>'}

  <h2>API metrics</h2>
  <div class="table-wrap scroll-x"><div class="scroll-y">
    <table>
      <thead><tr>
        <th>API</th><th>Method</th><th>Folder</th>
        <th>Count</th><th>Success</th><th>Failure</th><th>Error %</th>
        <th>Avg</th><th>Min</th><th>Median</th>
        <th>p90</th><th>p95</th><th>p99</th><th>Max</th>
      </tr></thead>
      <tbody>
        ${apis.length === 0
          ? '<tr><td colspan="14" style="text-align:center; color:var(--muted)">No request samples were captured.</td></tr>'
          : apis
              .map(
                (r) => `<tr>
                  <td>${escapeHtml(r.api)}</td>
                  <td class="mono">${escapeHtml(r.method || '')}</td>
                  <td class="mono">${escapeHtml(r.folder || '')}</td>
                  <td class="mono">${numOr(r.count)}</td>
                  <td class="mono ok">${numOr(r.success)}</td>
                  <td class="mono ${r.failure > 0 ? 'bad' : ''}">${numOr(r.failure)}</td>
                  <td class="mono ${r.errorPercentage > 0 ? 'bad' : ''}">${formatPercent(r.errorPercentage)}</td>
                  <td class="mono">${formatMs(r.avg)}</td>
                  <td class="mono">${formatMs(r.min)}</td>
                  <td class="mono">${formatMs(r.median)}</td>
                  <td class="mono">${formatMs(r.p90)}</td>
                  <td class="mono">${formatMs(r.p95)}</td>
                  <td class="mono">${formatMs(r.p99)}</td>
                  <td class="mono">${formatMs(r.max)}</td>
                </tr>`
              )
              .join('')}
      </tbody>
    </table>
  </div></div>

  <div class="grid grid-two" style="margin-top:20px;">
    <div class="card">
      <div class="stat-label">Slowest APIs (by p95)</div>
      ${slowest.length === 0
        ? '<div class="meta" style="margin-top:8px;">No samples.</div>'
        : `<table style="margin-top:8px;">
             <thead><tr><th>API</th><th>Method</th><th>p95</th><th>Avg</th></tr></thead>
             <tbody>${slowest.map((r) => `<tr>
               <td>${escapeHtml(r.api)}</td>
               <td class="mono">${escapeHtml(r.method || '')}</td>
               <td class="mono">${formatMs(r.p95)}</td>
               <td class="mono">${formatMs(r.avg)}</td>
             </tr>`).join('')}</tbody>
           </table>`}
    </div>
    <div class="card">
      <div class="stat-label">Highest error-rate APIs</div>
      ${highestError.length === 0
        ? '<div class="meta" style="margin-top:8px;">No failed requests observed.</div>'
        : `<table style="margin-top:8px;">
             <thead><tr><th>API</th><th>Method</th><th>Error %</th><th>Failures</th></tr></thead>
             <tbody>${highestError.map((r) => `<tr>
               <td>${escapeHtml(r.api)}</td>
               <td class="mono">${escapeHtml(r.method || '')}</td>
               <td class="mono bad">${formatPercent(r.errorPercentage)}</td>
               <td class="mono bad">${numOr(r.failure)}</td>
             </tr>`).join('')}</tbody>
           </table>`}
    </div>
  </div>

  <h2>Failure breakdown</h2>
  <div class="grid grid-two">
    <div class="card">
      <div class="stat-label">HTTP/API failures</div>
      <dl class="kv" style="margin-top:8px;">
        <dt>400</dt><dd class="mono">${numOr(fb.http['400'])}</dd>
        <dt>401</dt><dd class="mono">${numOr(fb.http['401'])}</dd>
        <dt>403</dt><dd class="mono">${numOr(fb.http['403'])}</dd>
        <dt>404</dt><dd class="mono">${numOr(fb.http['404'])}</dd>
        <dt>408</dt><dd class="mono">${numOr(fb.http['408'])}</dd>
        <dt>409</dt><dd class="mono">${numOr(fb.http['409'])}</dd>
        <dt>429</dt><dd class="mono">${numOr(fb.http['429'])}</dd>
        <dt>5xx</dt><dd class="mono">${numOr(fb.http['5xx'])}</dd>
        <dt>Other</dt><dd class="mono">${numOr(fb.http.other)}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="stat-label">Transport failures</div>
      <dl class="kv" style="margin-top:8px;">
        <dt>Total</dt><dd class="mono">${numOr(fb.transport.total)}</dd>
        <dt>Timeout</dt><dd class="mono">${numOr(fb.transport.timeout)}</dd>
        <dt>DNS</dt><dd class="mono">${numOr(fb.transport.dns)}</dd>
        <dt>TCP</dt><dd class="mono">${numOr(fb.transport.tcp)}</dd>
        <dt>TLS</dt><dd class="mono">${numOr(fb.transport.tls)}</dd>
        <dt>Connection reset</dt><dd class="mono">${numOr(fb.transport.connectionReset)}</dd>
        <dt>Other network</dt><dd class="mono">${numOr(fb.transport.other)}</dd>
      </dl>
    </div>
  </div>

  <h2>Dependency-skipped requests</h2>
  <div class="table-wrap scroll-x"><div class="scroll-y">
    <table>
      <thead><tr><th>Request</th><th>Method</th><th>Dependency</th><th>Missing variable</th><th>Count</th><th>Reason</th></tr></thead>
      <tbody>
        ${dependencySkipped.length === 0
          ? '<tr><td colspan="6" style="text-align:center; color:var(--muted)">No dependency-skipped requests.</td></tr>'
          : dependencySkipped.map((d) => `<tr>
              <td>${escapeHtml(d.request)}</td>
              <td class="mono">${escapeHtml(d.method || '')}</td>
              <td>${escapeHtml(d.dependency || '')}</td>
              <td class="mono">${escapeHtml(d.missingVariable || '')}</td>
              <td class="mono">${numOr(d.count)}</td>
              <td>${escapeHtml(d.reason || '')}</td>
            </tr>`).join('')}
      </tbody>
    </table>
  </div></div>

  <h2>Failure analysis</h2>
  <div class="table-wrap scroll-x"><div class="scroll-y">
    <table>
      <thead><tr><th>API</th><th>Method</th><th>Classification</th><th>Count</th><th>Last status</th><th>Reason</th><th>Attribution</th></tr></thead>
      <tbody>
        ${failureAnalysis.length === 0
          ? '<tr><td colspan="7" style="text-align:center; color:var(--muted)">No failed or skipped requests observed.</td></tr>'
          : failureAnalysis.map((f) => `<tr>
              <td>${escapeHtml(f.api)}</td>
              <td class="mono">${escapeHtml(f.method || '')}</td>
              <td><span class="badge ${f.classification === 'DEPENDENCY_SKIPPED' ? 'warn' : 'bad'}">${escapeHtml(f.classification)}</span></td>
              <td class="mono">${numOr(f.count)}</td>
              <td class="mono">${escapeHtml(f.lastStatus || '')}</td>
              <td>${escapeHtml(f.reason || '')}${f.sourceNote ? `<br><span class="meta">${escapeHtml(f.sourceNote)}</span>` : ''}</td>
              <td class="mono">${escapeHtml(f.attribution || '')}</td>
            </tr>`).join('')}
      </tbody>
    </table>
  </div></div>

  <p class="meta" style="margin-top:24px;">
    Generated by ${escapeHtml(meta.generator || 'perf-agent')} at ${escapeHtml(meta.generatedAt || '')}.
    Self-contained HTML; no external requests. Authorization headers, tokens,
    cookies, and passwords are never included in this report.
  </p>
</div>

<script type="application/json" id="chart-data">${chartDataJson}</script>
<script>
  (function() {
    function drawLine(canvas, data) {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = canvas.clientWidth || 300;
      const h = canvas.clientHeight || 120;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!data || data.length === 0) {
        ctx.fillStyle = '#6b7280';
        ctx.font = '11px sans-serif';
        ctx.fillText('No time-series data available for this run.', 8, h / 2);
        return;
      }
      const max = Math.max(1, ...data);
      const stepX = w / Math.max(1, data.length - 1);
      ctx.strokeStyle = '#3b82f6';
      ctx.fillStyle = 'rgba(59,130,246,0.12)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let i = 0; i < data.length; i++) {
        const x = i * stepX;
        const y = h - (data[i] / max) * (h - 8) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      for (let i = 0; i < data.length; i++) {
        const x = i * stepX;
        const y = h - (data[i] / max) * (h - 8) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    function renderCharts() {
      const el = document.getElementById('chart-data');
      if (!el) return;
      let charts = { p95: [], rps: [], err: [], vus: [] };
      try { charts = JSON.parse(el.textContent); } catch (e) { return; }
      drawLine(document.getElementById('p95Chart'), charts.p95);
      drawLine(document.getElementById('rpsChart'), charts.rps);
      drawLine(document.getElementById('errChart'), charts.err);
      drawLine(document.getElementById('vusChart'), charts.vus);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', renderCharts);
    } else {
      renderCharts();
    }
  })();
</script>

</body>
</html>`;
}

function renderStat(label, value, sub, tone) {
  return `<div class="card">
    <div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-value ${tone || ''}">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="stat-sub">${escapeHtml(String(sub))}</div>` : ''}
  </div>`;
}

function renderChart(title, canvasId, suffix) {
  return `<div class="card">
    <div class="chart-title"><span>${escapeHtml(title)}</span><span>${escapeHtml(suffix)}</span></div>
    <canvas id="${escapeHtml(canvasId)}"></canvas>
  </div>`;
}

async function writeReport(reportPath, reportOrLegacy, ctx) {
  const html = renderReportHtml(reportOrLegacy, ctx);
  await fs.writeFile(reportPath, html, 'utf-8');
  return reportPath;
}

module.exports = { renderReportHtml, writeReport };
