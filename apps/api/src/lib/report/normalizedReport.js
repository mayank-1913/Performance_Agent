'use strict';

/**
 * Phase 4 — Normalized performance report contract.
 *
 * This module owns the single canonical report shape emitted for every run.
 * Downstream consumers (HTML renderer, REST responses, future exporters)
 * receive the SAME structure regardless of which Postman collection was
 * uploaded, which auth strategy the script used, or which K6 metrics were
 * available. Missing inputs degrade gracefully to `null` values inside the
 * fixed skeleton — the outer key set is always identical.
 *
 * The shape (top-level keys — order is documented, tested, and stable):
 *
 *   {
 *     metadata:         { runId, scriptId, collectionId, collectionName,
 *                         contractVersion, generator, generatedAt },
 *     execution:        { status, exitCode, startedAt, endedAt, durationMs,
 *                         iterations, vusMax, pointsParsed, error },
 *     loadProfile:      { vus, rampUp, hold, rampDown, executor, totalDuration },
 *     thresholds:       [{ metric, threshold, actual, status, description }],
 *     summary:          { status, totalRequests, successfulRequests,
 *                         failedRequests, errorPercentage, rps, peakVUs,
 *                         iterations, avg, median, p90, p95, p99, max,
 *                         dataSent, dataReceived, dataSentBytes,
 *                         dataReceivedBytes, duration, durationMs },
 *     apiMetrics:       [{ api, method, folder, count, success, failure,
 *                          errorPercentage, avg, min, median, p90, p95,
 *                          p99, max }],
 *     slowestApis:      [ top-N apiMetrics rows sorted by p95 desc ],
 *     highestErrorApis: [ top-N apiMetrics rows sorted by errorPercentage desc, errors > 0 ],
 *     failures:         [{ api, method, count, lastStatus, reason }],
 *     timeseries:       { bucketSeconds, points: [{ t, vus, rps, errors, p95, throughput }] },
 *     verdict:          { status: 'PASS'|'FAIL', reasons: string[], thresholdsFailed, executionOk },
 *   }
 *
 * Security posture:
 *  - failures[] carries ONLY: api name, HTTP method, count, last observed
 *    HTTP status code, and a human-readable reason string. It never
 *    reproduces request headers, request bodies, response bodies, cookies,
 *    URLs with tokens, or Authorization values. `redactFailure()` is the
 *    single filter for this.
 *  - The api / api names go through `sanitizeApiName()` which trims and
 *    drops any Authorization-looking fragment before it reaches the report.
 *  - `apiMetrics` rows are keyed off the K6 request name tag and never
 *    include headers, bodies, or auth material.
 */

const REPORT_CONTRACT_VERSION = 1;
const GENERATOR_ID = 'perf-agent/report@v1';
/** k6 convention: exit 99 means thresholds were crossed, not a crash. */
const K6_THRESHOLD_EXIT_CODE = 99;

// Secret-name detector — aligned with utils/secrets + variableResolver so
// the whole stack agrees on what "looks sensitive". Used defensively when
// filtering failure metadata and API names.
const SECRET_KEY_RE = /(token|secret|jwt|key|session|auth|bearer|password|cookie)/i;
const AUTH_HEADER_RE = /authorization\s*:/i;
const BEARER_INLINE_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]{8,}/gi;

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function roundOrNull(v, digits = 2) {
  const n = num(v);
  if (n == null) return null;
  const m = Math.pow(10, digits);
  return Math.round(n * m) / m;
}

function pctOrNull(rate) {
  const n = num(rate);
  if (n == null) return null;
  return roundOrNull(n * 100, 2);
}

function bytesHuman(b) {
  const n = num(b);
  if (n == null) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function msHuman(ms) {
  const n = num(ms);
  if (n == null) return null;
  if (n < 1) return `${(n * 1000).toFixed(0)}µs`;
  if (n < 1000) return `${n.toFixed(2)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function durationHuman(ms) {
  const n = num(ms);
  if (n == null) return null;
  const totalSeconds = Math.round(n / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/* ------------------------------------------------------------------ */
/*  Secret-safe filters                                                */
/* ------------------------------------------------------------------ */

/**
 * Scrub any accidentally-embedded secret literal from a string field. Never
 * mutates input; returns a safe version. Reports must never expose
 * Authorization headers or bearer tokens even if a Postman request name
 * happens to include one.
 */
function sanitizeApiName(raw) {
  if (raw == null) return '';
  let s = String(raw);
  s = s.replace(BEARER_INLINE_RE, 'Bearer ***');
  // Drop the colon so nothing matching /authorization\s*:/ survives even
  // if the caller pipes the sanitized output through another secret filter.
  s = s.replace(AUTH_HEADER_RE, '[auth-header]');
  return s.trim();
}

/**
 * Build a failure entry with ONLY the whitelisted fields. Any incidental
 * fields on the input (e.g. `samples`, `headers`, `body`) are dropped.
 */
function redactFailure(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    api: sanitizeApiName(row.name),
    method: String(row.method || '').toUpperCase() || null,
    count: num(row.count) || 0,
    lastStatus: row.lastStatus != null ? String(row.lastStatus) : null,
    reason: buildFailureReason(row),
  };
}

function buildFailureReason(row) {
  const classification = row?.classification || null;
  if (classification === 'DEPENDENCY_SKIPPED') {
    return row?.reason || 'Skipped — required upstream variable unavailable';
  }
  const status = row?.lastStatus != null ? String(row.lastStatus) : '';
  if (!status) return 'HTTP request failed (no status recorded)';
  const code = Number(status);
  if (!Number.isFinite(code)) return `Last observed status: ${status}`;
  if (code === 0) return 'Transport / connection failure';
  if (code >= 500) return `Server error (HTTP ${code})`;
  if (code === 401 || code === 403) {
    return row?.authState === 'AUTH_REJECTED_BY_SERVER'
      ? `Server rejected credentials (HTTP ${code}) — token was present`
      : `Authentication / authorization failure (HTTP ${code})`;
  }
  if (code === 404) return `Endpoint not found (HTTP ${code})`;
  if (code === 429) return `Rate limited (HTTP ${code})`;
  if (code >= 400) return `Client error (HTTP ${code})`;
  return `Unexpected status (HTTP ${code})`;
}

function classifyFailure(row, sourceBaseline) {
  const status = row?.lastStatus != null ? String(row.lastStatus) : '';
  const code = Number(status);
  if (row?.classification === 'DEPENDENCY_SKIPPED') {
    return {
      classification: 'DEPENDENCY_SKIPPED',
      attribution: 'DEPENDENCY_CASCADE',
      sourceNote: null,
    };
  }
  if (!Number.isFinite(code) || code === 0) {
    return {
      classification: 'TRANSPORT_FAILURE',
      attribution: 'TRANSPORT',
      sourceNote: null,
    };
  }
  if (code === 401 || code === 403) {
    return {
      classification: row?.authState === 'AUTH_REJECTED_BY_SERVER' ? 'AUTH_REJECTED' : 'HTTP_API_FAILURE',
      attribution: inferSourceAttribution(row, sourceBaseline, 'HTTP_API_FAILURE'),
      sourceNote: buildSourceNote(row, sourceBaseline),
    };
  }
  if (code >= 400) {
    return {
      classification: 'HTTP_API_FAILURE',
      attribution: inferSourceAttribution(row, sourceBaseline, 'HTTP_API_FAILURE'),
      sourceNote: buildSourceNote(row, sourceBaseline),
    };
  }
  return {
    classification: 'HTTP_API_FAILURE',
    attribution: 'OBSERVED_RESPONSE',
    sourceNote: null,
  };
}

function inferSourceAttribution(row, sourceBaseline, defaultClass) {
  if (!sourceBaseline?.available) return defaultClass;
  const cmp = sourceBaseline.comparison;
  if (cmp === 'FAIL_MATCHES') return 'SOURCE_API_FAILURE';
  if (cmp === 'PASS_AGENT_FAIL') return 'AGENT_GENERATION_OR_RUNTIME_DEFECT';
  if (cmp === 'FAIL_AGENT_PASS') return 'SOURCE_API_BEHAVIOR_DIFFERENCE';
  return defaultClass;
}

function buildSourceNote(row, sourceBaseline) {
  if (!sourceBaseline?.available) {
    return 'Postman baseline not available; failure attributed to observed application/API response.';
  }
  const cmp = sourceBaseline.comparison;
  const api = sanitizeApiName(row?.name || row?.api || '');
  if (cmp === 'FAIL_MATCHES') {
    return `Request also fails in the source Postman execution/baseline (${api}).`;
  }
  if (cmp === 'PASS_AGENT_FAIL') {
    return `Postman passes but agent fails for ${api} — investigate generated request/auth/variable differences.`;
  }
  if (cmp === 'FAIL_AGENT_PASS') {
    return `Postman fails but agent passes for ${api} — source/API behavior difference; investigate.`;
  }
  return null;
}

function buildSourceBaseline(run = null) {
  const src = run?.sourceBaseline || run?.postmanBaseline || null;
  if (!src || typeof src !== 'object') {
    return {
      available: false,
      source: 'postman',
      comparison: 'NOT_AVAILABLE',
    };
  }
  const comparison = src.comparison || 'NOT_AVAILABLE';
  return {
    available: comparison !== 'NOT_AVAILABLE',
    source: src.source || 'postman',
    comparison,
    details: src.details || null,
  };
}

function buildDependencySkippedRequests(parsed) {
  const src = Array.isArray(parsed?.dependencySkipped) ? parsed.dependencySkipped : [];
  return src.map((row) => ({
    request: sanitizeApiName(row.request || row.name || row.api),
    method: String(row.method || '').toUpperCase() || null,
    dependency: sanitizeApiName(row.dependency || row.dependencyRequest || ''),
    missingVariable: row.missingVariable || row.missingVar || null,
    dependencyStatus: row.dependencyStatus || null,
    reason: row.reason || 'Required upstream variable unavailable',
    count: num(row.count) || 1,
    classification: 'DEPENDENCY_SKIPPED',
  }));
}

function buildFailureAnalysis(parsed, failures, sourceBaseline) {
  const analysis = [];
  for (const f of failures) {
    const cls = classifyFailure(f, sourceBaseline);
    analysis.push({
      api: sanitizeApiName(f.api || f.name),
      method: String(f.method || '').toUpperCase() || null,
      count: num(f.count) || 0,
      lastStatus: f.lastStatus != null ? String(f.lastStatus) : null,
      classification: cls.classification,
      attribution: cls.attribution,
      reason: buildFailureReason({ ...f, classification: cls.classification }),
      sourceNote: cls.sourceNote,
    });
  }
  for (const skip of buildDependencySkippedRequests(parsed)) {
    analysis.push({
      api: skip.request,
      method: skip.method,
      count: skip.count,
      lastStatus: 'SKIPPED',
      classification: 'DEPENDENCY_SKIPPED',
      attribution: 'DEPENDENCY_CASCADE',
      reason: skip.reason,
      sourceNote: null,
      dependency: skip.dependency,
      missingVariable: skip.missingVariable,
    });
  }
  return analysis;
}

/**
 * k6 completed successfully when status=completed OR exit 99 (threshold cross).
 */
function isK6ExecutionSuccessful(run, parsed) {
  if (run?.status === 'completed') return true;
  if (run?.exitCode === K6_THRESHOLD_EXIT_CODE) {
    const hasArtifacts =
      (parsed?.summary?.requests?.total != null && parsed.summary.requests.total > 0) ||
      (Array.isArray(parsed?.timeseries?.points) && parsed.timeseries.points.length > 0) ||
      (Array.isArray(parsed?.thresholds) && parsed.thresholds.length > 0);
    return hasArtifacts;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Threshold model                                                    */
/* ------------------------------------------------------------------ */

/**
 * Human-readable explanation for K6's built-in threshold metrics and the
 * Phase 3 custom counters. Unknown metrics fall back to a generic phrase
 * so the report always shows something. The description explicitly names
 * the SLA / threshold intent so a non-K6-native reader can understand
 * whether a failure is a latency, an error-rate, or a transport issue.
 */
function describeThreshold(metric, expression) {
  const m = String(metric || '');
  const e = String(expression || '');
  switch (m) {
    case 'http_req_duration':
      return `HTTP request duration SLA (${e}) — request latency percentile budget.`;
    case 'http_req_failed':
      return `HTTP request failure rate SLA (${e}) — share of requests classified as failed by K6.`;
    case 'checks':
      return `Checks pass rate SLA (${e}) — share of check() assertions that passed.`;
    case 'iterations':
      return `Iteration throughput SLA (${e}) — total iterations completed.`;
    case 'vus':
    case 'vus_max':
      return `Virtual user count SLA (${e}).`;
    case 'perf_transport_failed':
      return `Transport-failure counter SLA (${e}) — zero client-side DNS / TCP / TLS / timeout events expected.`;
    case 'perf_unexpected_status':
      return `Unexpected-HTTP-status counter SLA (${e}) — zero responses outside the expected 2xx set (HTTP 4xx/5xx are counted).`;
    case 'perf_check_failed':
      return `Functional check-failure counter SLA (${e}) — failed check() assertions per request.`;
    default:
      if (m.startsWith('http_req_')) return `HTTP request metric SLA (${e}).`;
      return `Custom metric "${m}" SLA (${e}).`;
  }
}

function buildThresholds(parsed) {
  const src = Array.isArray(parsed?.thresholds) ? parsed.thresholds : [];
  return src.map((t) => ({
    metric: String(t.metric || ''),
    threshold: String(t.expression || ''),
    actual: t.lastValue != null ? roundOrNull(t.lastValue, 4) : null,
    status: t.ok === false ? 'fail' : 'pass',
    description: describeThreshold(t.metric, t.expression),
  }));
}

/* ------------------------------------------------------------------ */
/*  Load profile                                                        */
/* ------------------------------------------------------------------ */

/**
 * Convert a K6 duration string ("30s", "2m", "500ms", "1h") into ms.
 * Returns 0 for unknown / invalid inputs so downstream sums stay stable.
 */
function durationStringToMs(raw) {
  if (typeof raw !== 'string') return 0;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2].toLowerCase();
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 60 * 60 * 1000;
    default: return 0;
  }
}

function buildAuthSession(loadProfile, workload = null, runAuthSession = null) {
  const lp = loadProfile || {};
  const w = workload || {};
  const runPlan = runAuthSession && typeof runAuthSession === 'object' ? runAuthSession : null;
  const mode =
    runPlan?.authenticationMode ||
    lp.authSessionMode ||
    w.authSessionMode ||
    null;
  const vus = num(runPlan?.configuredVus ?? (w.vus != null ? w.vus : lp.vus)) || null;
  const credentialRecords =
    num(runPlan?.credentialRecords) ??
    num(lp.credentialRecords) ??
    null;
  return {
    authenticationMode: mode,
    vus,
    credentialRecords,
    credentialReuse:
      runPlan?.credentialReuse != null
        ? !!runPlan.credentialReuse
        : lp.credentialReuse != null
          ? !!lp.credentialReuse
          : w.credentialReuse != null
            ? !!w.credentialReuse
            : false,
    credentialSufficient:
      runPlan?.credentialSufficient != null ? !!runPlan.credentialSufficient : null,
    warning: runPlan?.warning || null,
  };
}

function buildTimeoutConfig(script = null, run = null) {
  const src = script?.requestTimeout || run?.requestTimeout || null;
  if (!src || typeof src !== 'object') {
    return {
      defaultTimeout: '120s',
      documentedDefault: '120s',
      precedence: [
        'postman_per_request',
        'runtime_REQUEST_TIMEOUT_<REQUEST_ID>',
        'runtime_REQUEST_TIMEOUT',
        'PA_DEFAULT_REQUEST_TIMEOUT',
        'documented_default_120s',
      ],
      gracefulStop: '120s',
      perRequest: null,
    };
  }
  return {
    defaultTimeout: src.defaultTimeout || '120s',
    documentedDefault: src.documentedDefault || '120s',
    precedence: Array.isArray(src.precedence) ? src.precedence : [],
    gracefulStop: src.gracefulStop || src.defaultTimeout || '120s',
    perRequest: src.perRequest || null,
  };
}

function buildLoadProfile(loadProfile, workload = null, pacingMs = 1000) {
  const lp = loadProfile || {};
  const w = workload || {};
  const rampUp = lp.rampUp != null ? String(lp.rampUp) : null;
  const hold = lp.hold != null ? String(lp.hold) : null;
  const rampDown = lp.rampDown != null ? String(lp.rampDown) : null;
  const totalMs =
    (typeof w.totalDurationMs === 'number' && w.totalDurationMs > 0
      ? w.totalDurationMs
      : durationStringToMs(rampUp) +
        durationStringToMs(hold) +
        durationStringToMs(rampDown));
  return {
    // Phase 6: profile / executor / thresholds come from the normalized
    // workload when the script was generated after Phase 6 landed. Older
    // scripts (no workload) fall back to the historical 'ramping-vus'
    // executor default so the report table keeps rendering something.
    profile: w.profile || null,
    label: w.label || null,
    vus: num(w.vus != null ? w.vus : lp.vus) || null,
    rampUp,
    hold,
    rampDown,
    executor: w.executor || lp.executor || 'ramping-vus',
    thresholds: w.thresholds || null,
    totalDuration: totalMs > 0 ? durationHuman(totalMs) : null,
    totalDurationMs: totalMs > 0 ? totalMs : null,
    pacingMs: Number.isFinite(Number(pacingMs)) && Number(pacingMs) >= 0 ? Number(pacingMs) : 1000,
    gracefulStop:
      workload?.scenarios &&
      Object.values(workload.scenarios).find((s) => s && s.gracefulStop)?.gracefulStop ||
      null,
  };
}

/* ------------------------------------------------------------------ */
/*  API metrics table + slowest / highest-error subsets                 */
/* ------------------------------------------------------------------ */

function normalizeApiRow(r) {
  const count = num(r?.count) || 0;
  const errors = num(r?.errors) || 0;
  const success = Math.max(0, count - errors);
  return {
    api: sanitizeApiName(r?.name),
    method: String(r?.method || '').toUpperCase() || null,
    folder: sanitizeApiName(r?.group || ''),
    count,
    success,
    failure: errors,
    errorPercentage: pctOrNull(count > 0 ? errors / count : 0) || 0,
    avg: roundOrNull(r?.avg),
    min: roundOrNull(r?.min),
    median: roundOrNull(r?.median != null ? r.median : r?.med),
    p90: roundOrNull(r?.p90),
    p95: roundOrNull(r?.p95),
    p99: roundOrNull(r?.p99),
    max: roundOrNull(r?.max),
  };
}

function buildApiMetrics(parsed) {
  const src = Array.isArray(parsed?.requests) ? parsed.requests : [];
  return src.map(normalizeApiRow);
}

function pickSlowest(apiMetrics, n = 5) {
  return apiMetrics
    .filter((r) => num(r.p95) != null)
    .slice()
    .sort((a, b) => (b.p95 || 0) - (a.p95 || 0))
    .slice(0, n);
}

function pickHighestError(apiMetrics, n = 5) {
  return apiMetrics
    .filter((r) => (r.failure || 0) > 0)
    .slice()
    .sort((a, b) => (b.errorPercentage || 0) - (a.errorPercentage || 0))
    .slice(0, n);
}

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */

function buildSummary(parsed, verdictStatus, thresholds = []) {
  const s = parsed?.summary || {};
  const rt = s.responseTime || {};
  const reqs = s.requests || {};
  const slaFailures = thresholds.filter((t) => t.status !== 'pass').length;
  const net = s.network || {};
  const total = num(reqs.total) || 0;
  const failed = num(reqs.failed) || 0;
  const httpFailures = num(reqs.httpFailures) || 0;
  const transportFailures = num(reqs.transportFailures) || 0;
  const successfulHttp = num(reqs.successfulHttp);
  const success =
    successfulHttp != null ? successfulHttp : Math.max(0, total - failed);
  const durationMs = num(s.durationMs);
  const p99Raw = rt.p99;
  const p99 =
    p99Raw != null && Number.isFinite(p99Raw)
      ? roundOrNull(p99Raw)
      : total >= 100
        ? null
        : total > 0
          ? null
          : null;
  const p99Note =
    p99Raw == null && total > 0
      ? total < 100
        ? 'p99 unavailable — insufficient samples for reliable 99th percentile (need more requests).'
        : 'p99 unavailable in K6 summary export.'
      : null;
  return {
    status: verdictStatus, // 'PASS' | 'FAIL'
    totalRequests: total,
    successfulRequests: success,
    successfulHttpResponses: success,
    httpFailures,
    transportFailures,
    failedRequests: failed,
    errorPercentage: pctOrNull(reqs.errorRate) || 0,
    failureRate: pctOrNull(reqs.errorRate) || 0,
    rps: roundOrNull(reqs.rps),
    peakVUs: num(s.vusMax),
    iterations: num(s.iterations),
    completedIterations: num(s.completedIterations ?? s.iterations),
    interruptedIterations: num(s.interruptedIterations) || 0,
    executionLifecycleStatus: s.executionLifecycleStatus || null,
    slaFailures,
    avg: roundOrNull(rt.avg),
    median: roundOrNull(rt.med),
    p90: roundOrNull(rt.p90),
    p95: roundOrNull(rt.p95),
    p99,
    p99Note,
    min: roundOrNull(rt.min),
    max: roundOrNull(rt.max),
    dataSent: bytesHuman(net.dataSent),
    dataReceived: bytesHuman(net.dataReceived),
    dataSentBytes: num(net.dataSent) || 0,
    dataReceivedBytes: num(net.dataReceived) || 0,
    duration: durationHuman(durationMs),
    durationMs,
  };
}

function buildFailureBreakdown(parsed) {
  const fb = parsed?.summary?.failureBreakdown;
  const http = fb?.http || {};
  const transport = fb?.transport || {};
  return {
    http: {
      '400': num(http['400']) || 0,
      '401': num(http['401']) || 0,
      '403': num(http['403']) || 0,
      '404': num(http['404']) || 0,
      '408': num(http['408']) || 0,
      '409': num(http['409']) || 0,
      '429': num(http['429']) || 0,
      '5xx': num(http['5xx']) || 0,
      other: num(http.other) || 0,
    },
    transport: {
      total: num(transport.total) || num(parsed?.summary?.requests?.transportFailures) || 0,
      timeout: num(transport.timeout) || num(transport.total) || 0,
      dns: num(transport.dns) || 0,
      tcp: num(transport.tcp) || 0,
      tls: num(transport.tls) || 0,
      connectionReset: num(transport.connectionReset) || 0,
      other: num(transport.other) || 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Verdict                                                             */
/* ------------------------------------------------------------------ */

/**
 * Verdict rules — deliberately strict:
 *  - PASS requires BOTH (a) the K6 process itself completed cleanly
 *    (status='completed', exit=0), AND (b) every declared threshold
 *    reported ok. Missing thresholds do not force a FAIL — we just note
 *    "no SLAs declared" as a reason.
 *  - FAIL applies whenever any threshold reports fail OR the process
 *    itself did not complete cleanly (crash, kill, timeout, non-zero
 *    exit).
 *  - An HTTP 5xx observed on a sample is NEVER treated as a process
 *    failure. It contributes to `failedRequests`, not to `executionOk`.
 */
function computeVerdict({ thresholds, run, parsed }) {
  const reasons = [];
  const agentReasons = [];
  const applicationReasons = [];
  const executionReasons = [];
  const thresholdsFailed = thresholds.filter((t) => t.status !== 'pass').length;
  const executionOk = isK6ExecutionSuccessful(run, parsed);
  const thresholdExitOnly =
    run?.exitCode === K6_THRESHOLD_EXIT_CODE && executionOk && !run?.error;
  const interrupted = num(parsed?.summary?.interruptedIterations) || 0;
  const completed = num(parsed?.summary?.completedIterations ?? parsed?.summary?.iterations) || 0;
  const lifecycle = parsed?.summary?.executionLifecycleStatus || null;

  const transportFailed = thresholds.find(
    (t) => t.metric === 'perf_transport_failed' && t.status !== 'pass'
  );
  const transportCount = num(parsed?.summary?.requests?.transportFailures) || 0;

  if (!executionOk) {
    const parts = [];
    if (run?.status && run.status !== 'completed') parts.push(`status=${run.status}`);
    if (run?.exitCode != null && run.exitCode !== 0 && run.exitCode !== K6_THRESHOLD_EXIT_CODE) {
      parts.push(`exitCode=${run.exitCode}`);
    }
    if (run?.error) parts.push(`error=${run.error}`);
    const msg = `Performance Agent FAILED — execution did not complete cleanly (${parts.join(', ') || 'unknown reason'}).`;
    reasons.push(msg);
    agentReasons.push(msg);
  } else if (thresholdExitOnly) {
    const msg =
      'K6 exited with code 99 (threshold failure) — script executed successfully; SLA thresholds were crossed.';
    reasons.push(msg);
    applicationReasons.push(msg);
  }

  if (
    executionOk &&
    interrupted > 0 &&
    lifecycle === 'interrupted_at_graceful_stop'
  ) {
    const msg = `Execution interrupted at graceful stop: ${completed} completed, ${interrupted} interrupted iteration(s). Consider increasing scenario duration when full iteration completion is required.`;
    reasons.push(msg);
    executionReasons.push(msg);
  }
  if (transportFailed || transportCount > 0) {
    const msg = `Performance Agent FAILED — ${transportCount} client transport failure(s) detected (timeout / DNS / TCP / TLS / network).`;
    if (!agentReasons.includes(msg)) {
      reasons.push(msg);
      agentReasons.push(msg);
    }
  }
  if (thresholdsFailed > 0) {
    const failedNames = thresholds
      .filter((t) => t.status !== 'pass')
      .map((t) => `${t.metric} ${t.threshold}`);
    const latencyOrRate = thresholds.filter(
      (t) =>
        t.status !== 'pass' &&
        (t.metric === 'http_req_duration' || t.metric === 'http_req_failed')
    );
    const unexpected = thresholds.find(
      (t) => t.metric === 'perf_unexpected_status' && t.status !== 'pass'
    );
    if (latencyOrRate.length > 0) {
      const msg = `Performance test FAILED — application SLA threshold(s) exceeded: ${latencyOrRate.map((t) => `${t.metric} ${t.threshold}`).join(', ')}.`;
      reasons.push(msg);
      applicationReasons.push(msg);
    }
    if (unexpected) {
      const msg = `Performance test FAILED — ${num(parsed?.summary?.requests?.httpFailures) || 'unexpected'} HTTP response(s) outside the expected 2xx set.`;
      reasons.push(msg);
      applicationReasons.push(msg);
    }
    const otherFailed = thresholds.filter(
      (t) =>
        t.status !== 'pass' &&
        t.metric !== 'http_req_duration' &&
        t.metric !== 'http_req_failed' &&
        t.metric !== 'perf_transport_failed' &&
        t.metric !== 'perf_unexpected_status'
    );
    if (otherFailed.length > 0) {
      const msg = `${otherFailed.length} additional threshold(s) failed: ${otherFailed.map((t) => `${t.metric} ${t.threshold}`).join(', ')}.`;
      reasons.push(msg);
      applicationReasons.push(msg);
    }
    if (latencyOrRate.length === 0 && !unexpected && otherFailed.length === 0 && failedNames.length > 0) {
      const msg = `${thresholdsFailed} threshold(s) failed: ${failedNames.join(', ')}.`;
      reasons.push(msg);
      applicationReasons.push(msg);
    }
  }
  if (executionOk && thresholdsFailed === 0 && thresholds.length === 0) {
    reasons.push('No SLA thresholds were declared; PASS is based purely on clean execution.');
  }

  const hasSlaConclusion = executionOk && (thresholds.length > 0 || thresholdsFailed > 0);
  const executionIncomplete =
    executionOk &&
    interrupted > 0 &&
    completed === 0 &&
    !hasSlaConclusion &&
    thresholdsFailed === 0;

  let status = 'FAIL';
  let category = 'FAIL';

  if (agentReasons.length > 0) {
    status = 'FAIL';
    category = 'AGENT_RUNTIME_FAILURE';
  } else if (executionIncomplete) {
    status = 'FAIL';
    category = 'EXECUTION_INCOMPLETE';
  } else if (executionOk && thresholdsFailed > 0) {
    status = 'FAIL';
    category = 'APPLICATION_PERFORMANCE_FAILURE';
  } else if (executionOk && thresholdsFailed === 0) {
    status = 'PASS';
    category = thresholds.length > 0 ? 'APPLICATION_PERFORMANCE_PASS' : 'PASS';
  } else {
    status = 'FAIL';
    category = 'FAIL';
  }

  if (
    category === 'APPLICATION_PERFORMANCE_FAILURE' &&
    executionReasons.length > 0 &&
    !reasons.some((r) => /interrupted at graceful stop/i.test(r))
  ) {
    // execution interruption is informational alongside SLA failure
  }

  return {
    status,
    category,
    reasons,
    agentReasons,
    applicationReasons,
    executionReasons,
    thresholdsFailed,
    executionOk,
    thresholdExitOnly,
    executionIncomplete,
  };
}

/* ------------------------------------------------------------------ */
/*  Public entry: buildNormalizedReport                                 */
/* ------------------------------------------------------------------ */

/**
 * @param {object} args
 * @param {object} args.parsed         Output of parseRunArtifacts (may be null on early failure)
 * @param {object} args.run            { runId, scriptId, status, exitCode, error, startedAt, endedAt, durationMs }
 * @param {object} [args.script]       { collectionId, loadProfile }
 * @param {object} [args.collection]   { summary: { name } }
 * @param {number} [args.slowestLimit=5]
 * @param {number} [args.highestErrorLimit=5]
 */
function buildNormalizedReport({
  parsed,
  run,
  script = null,
  collection = null,
  slowestLimit = 5,
  highestErrorLimit = 5,
} = {}) {
  const thresholds = buildThresholds(parsed);
  const verdict = computeVerdict({ thresholds, run, parsed });
  const summary = buildSummary(parsed, verdict.status, thresholds);
  const failureBreakdown = buildFailureBreakdown(parsed);
  const timeoutConfig = buildTimeoutConfig(script, run);
  const apiMetrics = buildApiMetrics(parsed);
  const slowestApis = pickSlowest(apiMetrics, slowestLimit);
  const highestErrorApis = pickHighestError(apiMetrics, highestErrorLimit);
  const sourceBaseline = buildSourceBaseline(run);
  const dependencySkippedRequests = buildDependencySkippedRequests(parsed);

  const failures = Array.isArray(parsed?.failures)
    ? parsed.failures.map(redactFailure).filter(Boolean)
    : [];
  const failureAnalysis = buildFailureAnalysis(parsed, failures, sourceBaseline);

  const ts = parsed?.timeseries || { bucketSeconds: null, points: [] };

  return {
    metadata: {
      runId: run?.runId || null,
      scriptId: run?.scriptId || null,
      collectionId: script?.collectionId || null,
      collectionName:
        collection?.summary?.name || collection?.originalName || null,
      contractVersion: REPORT_CONTRACT_VERSION,
      generator: GENERATOR_ID,
      generatedAt: new Date().toISOString(),
    },
    execution: {
      status: run?.status || null,
      exitCode: run?.exitCode != null ? run.exitCode : null,
      startedAt: run?.startedAt || parsed?.summary?.startedAt || null,
      endedAt: run?.endedAt || parsed?.summary?.endedAt || null,
      durationMs: num(run?.durationMs) != null ? run.durationMs : num(parsed?.summary?.durationMs),
      iterations: num(parsed?.summary?.iterations),
      completedIterations: num(parsed?.summary?.completedIterations ?? parsed?.summary?.iterations),
      interruptedIterations: num(parsed?.summary?.interruptedIterations) || 0,
      executionLifecycleStatus: parsed?.summary?.executionLifecycleStatus || null,
      vusMax: num(parsed?.summary?.vusMax),
      pointsParsed: num(parsed?.summary?.pointsParsed) || 0,
      error: run?.error || null,
    },
    failureCategorization: {
      httpFailures: num(parsed?.summary?.requests?.httpFailures) || 0,
      transportFailures: num(parsed?.summary?.requests?.transportFailures) || 0,
      dependencySkipped: num(parsed?.summary?.requests?.dependencySkipped) || dependencySkippedRequests.length,
      slaFailures: thresholds.filter((t) => t.status !== 'pass').length,
      interruptedIterations: num(parsed?.summary?.interruptedIterations) || 0,
      executionLifecycleStatus: parsed?.summary?.executionLifecycleStatus || null,
      agentRuntimeFailures: verdict.category === 'AGENT_RUNTIME_FAILURE' ? 1 : 0,
    },
    sourceBaseline,
    dependencySkippedRequests,
    failureAnalysis,
    failureSections: {
      httpApiFailures: failureAnalysis.filter((f) => f.classification === 'HTTP_API_FAILURE' || f.classification === 'AUTH_REJECTED'),
      transportFailures: failureAnalysis.filter((f) => f.classification === 'TRANSPORT_FAILURE'),
      dependencySkipped: dependencySkippedRequests,
      interruptedIterations: {
        completed: num(parsed?.summary?.completedIterations ?? parsed?.summary?.iterations) || 0,
        interrupted: num(parsed?.summary?.interruptedIterations) || 0,
        lifecycle: parsed?.summary?.executionLifecycleStatus || null,
        note: verdict.executionReasons?.[0] || null,
      },
      slaThresholdFailures: thresholds.filter((t) => t.status !== 'pass'),
      agentRuntimeFailures: verdict.category === 'AGENT_RUNTIME_FAILURE' ? verdict.agentReasons : [],
    },
    loadProfile: buildLoadProfile(
      script?.loadProfile,
      script?.workload,
      run?.pacingMs ?? script?.pacingMs ?? 1000
    ),
    timeoutConfig,
    authSession: buildAuthSession(script?.loadProfile, script?.workload, run?.authSession),
    thresholds,
    summary,
    failureBreakdown,
    apiMetrics,
    slowestApis,
    highestErrorApis,
    failures,
    timeseries: {
      bucketSeconds: ts.bucketSeconds ?? null,
      points: Array.isArray(ts.points) ? ts.points : [],
    },
    verdict,
  };
}

module.exports = {
  buildNormalizedReport,
  // Named exports for tests + tools:
  K6_THRESHOLD_EXIT_CODE,
  isK6ExecutionSuccessful,
  computeVerdict,
  buildSourceBaseline,
  buildDependencySkippedRequests,
  buildFailureAnalysis,
  classifyFailure,
  buildThresholds,
  buildLoadProfile,
  buildTimeoutConfig,
  buildAuthSession,
  buildSummary,
  buildFailureBreakdown,
  buildApiMetrics,
  pickSlowest,
  pickHighestError,
  redactFailure,
  sanitizeApiName,
  describeThreshold,
  durationStringToMs,
  bytesHuman,
  msHuman,
  durationHuman,
  REPORT_CONTRACT_VERSION,
  GENERATOR_ID,
};
