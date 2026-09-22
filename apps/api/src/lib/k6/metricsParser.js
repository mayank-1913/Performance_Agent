'use strict';

/**
 * K6 metrics parser.
 *
 * Inputs:
 *   - summary.json     produced by `--summary-export` (object with `metrics`
 *                      and `root_group`, the same shape as k6's stdout summary).
 *   - metrics.json     JSON-Lines produced by `--out json=`. Each line is one
 *                      of:
 *                        {"type":"Metric","metric":"<name>","data":{...}}
 *                        {"type":"Point","metric":"<name>","data":{
 *                          "time":"<rfc3339>", "value":<number>,
 *                          "tags":{...}}}
 *
 * Output:
 *   {
 *     summary: {                       // global numbers, sourced from summary.json (preferred) or aggregated from points
 *       startedAt, endedAt, durationMs,
 *       iterations, vusMax,
 *       requests: { total, passed, failed, errorRate, rps, throughputBytesPerSec },
 *       responseTime: { avg, min, max, med, p90, p95, p99 },
 *       checks: { total, passes, fails, passRate },
 *       network: { dataSent, dataReceived },
 *     },
 *     thresholds: [                    // one entry per defined threshold
 *       { metric, expression, ok, lastValue }
 *     ],
 *     timeseries: {                    // bucketed every `bucketSeconds`, ready for recharts
 *       bucketSeconds,
 *       points: [{ t, vus, rps, errors, p95, throughput }]
 *     },
 *     requests: [                      // per request/group
 *       { name, count, avg, min, max, p90, p95, errorRate, group }
 *     ],
 *     failures: [                      // most failed requests, derived from points with status>=400 or http_req_failed=1
 *       { name, count, lastStatus }
 *     ]
 *   }
 *
 * Designed to be cheap and synchronous: the metrics file can be 10–100 MB for
 * long runs, so we stream lines and only keep aggregated state.
 */

const fs = require('fs');
const readline = require('readline');
const { isTransportErrorCode } = require('./responseClassifier');

const PERCENTILE_KEYS = ['avg', 'min', 'max', 'med', 'p(90)', 'p(95)', 'p(99)'];

function categorizeTransportErrorCode(code) {
  const n = typeof code === 'string' ? parseInt(code, 10) : code;
  if (!Number.isFinite(n) || n === 0 || (n >= 1400 && n < 1600)) return null;
  if (n >= 1100 && n < 1200) return 'timeout';
  if (n >= 1200 && n < 1300) return 'tcp';
  if (n >= 1300 && n < 1400) return 'tls';
  if (n === 1210 || n === 1211) return 'connectionReset';
  if (n >= 1000 && n < 1100) return 'dns';
  return 'other';
}

function sumHttpStatusFailures(httpStatusCounts) {
  let total = 0;
  for (const [status, count] of httpStatusCounts.entries()) {
    const code = Number(status);
    if (!Number.isFinite(code) || code < 400) continue;
    total += count;
  }
  return total;
}

/**
 * Resolve the observed value for a k6 threshold expression from a summary metric.
 * Trend metrics store percentiles under values['p(95)'], not count/rate/value.
 */
function resolveThresholdLastValue(m, expression, fieldFrom) {
  const expr = String(expression || '').trim();

  const pMatch = expr.match(/^p\((\d+)\)/);
  if (pMatch) {
    const key = `p(${pMatch[1]})`;
    const v = fieldFrom(m, key);
    if (typeof v === 'number') return +Number(v).toFixed(2);
    return null;
  }

  if (expr.startsWith('rate')) {
    const rateVal = fieldFrom(m, 'rate');
    if (typeof rateVal === 'number') return +rateVal.toFixed(4);
    const valueVal = fieldFrom(m, 'value');
    if (typeof valueVal === 'number' && valueVal >= 0 && valueVal <= 1) {
      return +valueVal.toFixed(4);
    }
    return null;
  }

  if (expr.startsWith('count')) {
    const countVal = fieldFrom(m, 'count');
    if (typeof countVal === 'number') return countVal;
    return null;
  }

  const countVal = fieldFrom(m, 'count');
  const rateVal = fieldFrom(m, 'rate');
  const valueVal = fieldFrom(m, 'value');
  if (typeof countVal === 'number') return countVal;
  if (typeof rateVal === 'number') return +rateVal.toFixed(4);
  if (typeof valueVal === 'number') return +valueVal.toFixed(4);
  return null;
}

/** Re-evaluate custom counter thresholds using tag-corrected counts. */
function reconcileCustomCounterThresholds(thresholds, transportCount, unexpectedCount) {
  for (const t of thresholds) {
    if (t.metric === 'perf_transport_failed' && t.expression === 'count==0') {
      t.lastValue = transportCount;
      t.ok = transportCount === 0;
    }
    if (t.metric === 'perf_unexpected_status' && t.expression === 'count==0') {
      t.lastValue = unexpectedCount;
      t.ok = unexpectedCount === 0;
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(q * (sortedAsc.length - 1)))
  );
  return sortedAsc[idx];
}

function safeNum(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return n;
}

function roundPercentile(v) {
  if (v == null || !Number.isFinite(v)) return null;
  return +v.toFixed(2);
}

/* ------------------------------------------------------------------ */
/*  Bucketed online aggregator for timeseries                           */
/* ------------------------------------------------------------------ */

class Buckets {
  constructor(bucketSeconds) {
    this.bucketSeconds = bucketSeconds;
    /** Map<bucketIdx, { t, vus, requests, errors, durations, dataSent, dataReceived }> */
    this.map = new Map();
  }
  _bucket(timeIso) {
    const t = new Date(timeIso).getTime();
    if (!Number.isFinite(t)) return null;
    const idx = Math.floor(t / 1000 / this.bucketSeconds);
    if (!this.map.has(idx)) {
      this.map.set(idx, {
        t: new Date(idx * this.bucketSeconds * 1000).toISOString(),
        vus: 0,
        requests: 0,
        errors: 0,
        durations: [],
        dataSent: 0,
        dataReceived: 0,
      });
    }
    return this.map.get(idx);
  }
  trackVUs(timeIso, value) {
    const b = this._bucket(timeIso);
    if (b) b.vus = Math.max(b.vus, Number(value) || 0);
  }
  trackRequest(timeIso, durationMs, failed) {
    const b = this._bucket(timeIso);
    if (!b) return;
    b.requests += 1;
    if (failed) b.errors += 1;
    if (Number.isFinite(durationMs)) b.durations.push(durationMs);
  }
  trackData(timeIso, sent, received) {
    const b = this._bucket(timeIso);
    if (!b) return;
    b.dataSent += sent || 0;
    b.dataReceived += received || 0;
  }
  toPoints() {
    const out = [];
    const keys = Array.from(this.map.keys()).sort((a, b) => a - b);
    for (const k of keys) {
      const b = this.map.get(k);
      const sorted = b.durations.slice().sort((a, c) => a - c);
      const p95 = quantile(sorted, 0.95);
      out.push({
        t: b.t,
        vus: b.vus,
        rps: +(b.requests / this.bucketSeconds).toFixed(2),
        errors: b.errors,
        p95: p95 != null ? +p95.toFixed(2) : null,
        throughput: +((b.dataSent + b.dataReceived) / this.bucketSeconds).toFixed(2),
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/*  Per-request aggregator (uses k6 `name` tag, falling back to URL)    */
/* ------------------------------------------------------------------ */

class RequestAggregator {
  constructor() {
    this.map = new Map(); // key -> { name, group, count, durations, errors, lastStatus }
  }
  _key(tags) {
    return (
      tags?.name ||
      tags?.url ||
      `${tags?.method || 'REQ'} ${tags?.scenario || ''}`
    );
  }
  trackDuration(tags, durationMs, failed) {
    const key = this._key(tags);
    if (!key) return;
    let row = this.map.get(key);
    if (!row) {
      row = {
        name: key,
        group: tags?.group || '',
        method: tags?.method || '',
        count: 0,
        durations: [],
        errors: 0,
        lastStatus: null,
      };
      this.map.set(key, row);
    }
    row.count += 1;
    if (Number.isFinite(durationMs)) row.durations.push(durationMs);
    if (failed) row.errors += 1;
    if (tags?.status) row.lastStatus = String(tags.status);
  }
  toRows() {
    const rows = [];
    for (const r of this.map.values()) {
      const sorted = r.durations.slice().sort((a, b) => a - b);
      const sum = r.durations.reduce((a, b) => a + b, 0);
      rows.push({
        name: r.name,
        group: r.group,
        method: r.method,
        count: r.count,
        errors: r.errors,
        errorRate: r.count > 0 ? +(r.errors / r.count).toFixed(4) : 0,
        avg: r.durations.length ? +(sum / r.durations.length).toFixed(2) : null,
        min: r.durations.length ? +sorted[0].toFixed(2) : null,
        max: r.durations.length ? +sorted[sorted.length - 1].toFixed(2) : null,
        p90: roundPercentile(quantile(sorted, 0.9)),
        p95: roundPercentile(quantile(sorted, 0.95)),
        p99: roundPercentile(quantile(sorted, 0.99)),
        lastStatus: r.lastStatus,
      });
    }
    rows.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    return rows;
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry: parseRunArtifacts                                     */
/* ------------------------------------------------------------------ */

/**
 * @param {object} opts
 * @param {string} opts.summaryExportPath  Path to k6 summary.json (may not exist on early failure)
 * @param {string} opts.metricsJsonPath    Path to k6 metrics.json (JSONL; may not exist)
 * @param {string} [opts.startedAt]
 * @param {string} [opts.endedAt]
 * @param {number} [opts.durationMs]
 * @param {number} [opts.bucketSeconds=2]
 * @param {number} [opts.maxFailures=20]
 * @returns {Promise<object>} normalized report
 */
async function parseRunArtifacts(opts) {
  const {
    summaryExportPath,
    metricsJsonPath,
    startedAt = null,
    endedAt = null,
    durationMs = null,
    bucketSeconds = 2,
    maxFailures = 20,
    iterationLifecycle = null,
  } = opts || {};

  const buckets = new Buckets(bucketSeconds);
  const requests = new RequestAggregator();
  const failuresByKey = new Map(); // key -> { name, count, lastStatus, lastError, samples: [] }
  const dependencySkippedByKey = new Map();
  let dependencySkippedCount = 0;
  const thresholdDefs = []; // from Metric lines that contain `thresholds`
  const httpStatusCounts = new Map(); // status code string -> count
  let transportFailureCount = 0;
  let unexpectedStatusCount = 0;
  let tagDerivedHttpFailures = 0;
  let tagDerivedTransportFailures = 0;
  const transportBreakdown = {
    total: 0,
    timeout: 0,
    dns: 0,
    tcp: 0,
    tls: 0,
    connectionReset: 0,
    other: 0,
  };

  let pointCount = 0;
  let totalRequests = 0;
  let totalFailed = 0;
  let totalDataSent = 0;
  let totalDataReceived = 0;
  let firstPointTime = null;
  let lastPointTime = null;
  let vusMaxFromPoints = 0;

  // 1) Stream metrics.json (JSONL)
  if (metricsJsonPath && fs.existsSync(metricsJsonPath)) {
    const stream = fs.createReadStream(metricsJsonPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      if (evt.type === 'Metric' && evt.metric && evt.data?.thresholds) {
        for (const [expr, def] of Object.entries(evt.data.thresholds || {})) {
          thresholdDefs.push({
            metric: evt.metric,
            expression: expr,
            ok: !def?.ok ? false : true,
            lastValue: null,
          });
        }
        continue;
      }
      if (evt.type !== 'Point') continue;
      const data = evt.data || {};
      const tags = data.tags || {};
      const time = data.time;
      const value = safeNum(data.value);
      if (time) {
        if (!firstPointTime || time < firstPointTime) firstPointTime = time;
        if (!lastPointTime || time > lastPointTime) lastPointTime = time;
      }
      pointCount += 1;
      switch (evt.metric) {
        case 'vus':
          if (value != null) {
            buckets.trackVUs(time, value);
            vusMaxFromPoints = Math.max(vusMaxFromPoints, value);
          }
          break;
        case 'perf_transport_failed':
          if (value != null && value > 0) transportFailureCount += value;
          break;
        case 'perf_unexpected_status':
          if (value != null && value > 0) unexpectedStatusCount += value;
          break;
        case 'perf_dependency_skipped':
          if (value != null && value > 0) {
            dependencySkippedCount += value;
            const reqName = tags.api_name || tags.name || 'unknown';
            const row =
              dependencySkippedByKey.get(reqName) || {
                request: reqName,
                name: reqName,
                method: tags.api_method || tags.method || '',
                count: 0,
                dependency: tags.dependency_request || null,
                missingVariable: tags.missing_var || null,
                reason: tags.skip_reason || 'Required upstream variable unavailable',
              };
            row.count += value;
            dependencySkippedByKey.set(reqName, row);
          }
          break;
        case 'http_req_duration': {
          const failed = String(tags.expected_response).toLowerCase() === 'false';
          buckets.trackRequest(time, value, failed);
          requests.trackDuration(tags, value, failed);
          totalRequests += 1;
          const statusTag = tags.status != null ? String(tags.status) : null;
          const errorCode = tags.error_code;
          if (statusTag) {
            httpStatusCounts.set(statusTag, (httpStatusCounts.get(statusTag) || 0) + 1);
          } else if (failed && !statusTag) {
            httpStatusCounts.set('0', (httpStatusCounts.get('0') || 0) + 1);
          }
          if (failed) {
            const statusNum = statusTag != null ? Number(statusTag) : 0;
            if (statusNum === 0 || isTransportErrorCode(errorCode)) {
              tagDerivedTransportFailures += 1;
              const bucket = categorizeTransportErrorCode(errorCode) || 'other';
              transportBreakdown[bucket] += 1;
              transportBreakdown.total += 1;
            } else if (statusNum >= 400) {
              tagDerivedHttpFailures += 1;
            }
          }
          if (failed) {
            totalFailed += 1;
            const key = tags.name || tags.url || `${tags.method || 'REQ'}`;
            const row =
              failuresByKey.get(key) || {
                name: key,
                method: tags.method || '',
                count: 0,
                lastStatus: tags.status || null,
                samples: [],
              };
            row.count += 1;
            row.lastStatus = tags.status || row.lastStatus;
            if (row.samples.length < 3) {
              row.samples.push({ t: time, status: tags.status, duration: value });
            }
            failuresByKey.set(key, row);
          }
          break;
        }
        case 'http_req_failed':
          // value 1 = failed; we already increment failures via http_req_duration's expected_response,
          // but this is a useful belt-and-braces signal.
          break;
        case 'data_sent':
          if (value != null) {
            totalDataSent += value;
            buckets.trackData(time, value, 0);
          }
          break;
        case 'data_received':
          if (value != null) {
            totalDataReceived += value;
            buckets.trackData(time, 0, value);
          }
          break;
        default:
          break;
      }
    }
  }

  // 2) Read summary.json (the global authority for thresholds and per-metric stats).
  let summaryRaw = null;
  if (summaryExportPath && fs.existsSync(summaryExportPath)) {
    try {
      summaryRaw = JSON.parse(fs.readFileSync(summaryExportPath, 'utf-8'));
    } catch {
      summaryRaw = null;
    }
  }

  // Phase 7 fix: k6 v1's handleSummary payload nests every metric's
  // scalar values under a `values` sub-object, while the legacy
  // --summary-export payload put them directly on the metric object.
  // Read from either shape so downstream code sees the same view
  // regardless of which artifact the pipeline consumed.
  const fieldFrom = (m, key) => {
    if (!m) return undefined;
    if (m[key] !== undefined) return m[key];
    if (m.values && m.values[key] !== undefined) return m.values[key];
    return undefined;
  };
  const metricStats = (key) => {
    const m = summaryRaw?.metrics?.[key];
    if (!m) return null;
    const out = {};
    for (const k of PERCENTILE_KEYS) {
      const vk = k === 'p(90)' ? 'p90' : k === 'p(95)' ? 'p95' : k === 'p(99)' ? 'p99' : k;
      const v = fieldFrom(m, k) ?? fieldFrom(m, vk);
      if (typeof v === 'number') out[vk] = +v.toFixed(2);
    }
    const count = fieldFrom(m, 'count');
    const rate = fieldFrom(m, 'rate');
    const value = fieldFrom(m, 'value');
    if (typeof count === 'number') out.count = count;
    if (typeof rate === 'number') out.rate = +rate.toFixed(4);
    if (typeof value === 'number') out.value = value;
    return out;
  };

  // 3) Compose summary
  const inferredDurationMs =
    durationMs != null
      ? durationMs
      : firstPointTime && lastPointTime
      ? Math.max(0, new Date(lastPointTime) - new Date(firstPointTime))
      : null;

  const reqStats = metricStats('http_req_duration');
  const httpFailedStats = metricStats('http_req_failed');
  const checksStats = metricStats('checks');
  const iterCount =
    fieldFrom(summaryRaw?.metrics?.iterations, 'count') ??
    iterationLifecycle?.completedIterations ??
    null;
  const droppedIterations =
    fieldFrom(summaryRaw?.metrics?.dropped_iterations, 'count') ??
    iterationLifecycle?.interruptedIterations ??
    null;
  const vusMaxFromSummary =
    fieldFrom(summaryRaw?.metrics?.vus_max, 'value') ??
    fieldFrom(summaryRaw?.metrics?.vus_max, 'max');

  const transportFromSummary = fieldFrom(summaryRaw?.metrics?.perf_transport_failed, 'count');
  const unexpectedFromSummary = fieldFrom(summaryRaw?.metrics?.perf_unexpected_status, 'count');
  const dependencySkippedFromSummary = fieldFrom(
    summaryRaw?.metrics?.perf_dependency_skipped,
    'count'
  );
  if (typeof dependencySkippedFromSummary === 'number' && dependencySkippedCount === 0) {
    dependencySkippedCount = dependencySkippedFromSummary;
  }
  // Prefer tag-derived classification from http_req_duration points when available.
  // Legacy runs may have mis-tagged perf_transport_failed counters (HTTP 4xx/5xx
  // incorrectly counted as transport) — error_code tags are authoritative.
  if (tagDerivedHttpFailures > 0 || tagDerivedTransportFailures > 0) {
    unexpectedStatusCount = tagDerivedHttpFailures;
    transportFailureCount = tagDerivedTransportFailures;
  } else {
    if (typeof transportFromSummary === 'number') transportFailureCount = transportFromSummary;
    if (typeof unexpectedFromSummary === 'number') unexpectedStatusCount = unexpectedFromSummary;
  }

  // Reconcile with thresholds from summary (preferred source).
  const thresholdsFromSummary = [];
  if (summaryRaw?.metrics) {
    for (const [metric, m] of Object.entries(summaryRaw.metrics)) {
      const t = m?.thresholds;
      if (!t) continue;
      for (const [expr, def] of Object.entries(t)) {
        const lastValue = resolveThresholdLastValue(m, expr, fieldFrom);
        thresholdsFromSummary.push({
          metric,
          expression: expr,
          ok: def?.ok !== false, // some k6 versions: { ok: true } / others: {}
          lastValue,
        });
      }
    }
  }
  const thresholds = thresholdsFromSummary.length > 0 ? thresholdsFromSummary : thresholdDefs;

  // When tag-derived classification corrected the transport / HTTP failure
  // counts, threshold ok/lastValue must use the same numbers — not stale k6
  // summary counters from a pre-fix script run.
  if (tagDerivedHttpFailures > 0 || tagDerivedTransportFailures > 0) {
    reconcileCustomCounterThresholds(
      thresholds,
      transportFailureCount,
      unexpectedStatusCount
    );
  }

  // Phase 7 fix: k6 v1's handleSummary payload strips `count` from
  // http_req_duration (percentiles only) but preserves it on the
  // http_reqs counter. Prefer that authoritative total when present;
  // fall back to http_req_duration.count (legacy shape) or the JSONL
  // streaming count.
  const httpReqsCount = fieldFrom(summaryRaw?.metrics?.http_reqs, 'count');
  const totalRequestsFinal =
    typeof httpReqsCount === 'number'
      ? httpReqsCount
      : reqStats?.count != null
        ? reqStats.count
        : totalRequests;
  // Phase 6.5 audit fix: k6 v1 reports http_req_failed as
  //   { passes: <failure-count>, fails: <success-count>, value: <rate 0..1> }
  // while older shapes used { rate, value: <count> }. Pick the right
  // interpretation instead of blindly rounding `value` — otherwise a run
  // with rate 0.6666 gets reported as "1 failed request".
  const rawFailed = summaryRaw?.metrics?.http_req_failed || {};
  const rawPasses = fieldFrom(rawFailed, 'passes');
  const rawFails = fieldFrom(rawFailed, 'fails');
  const passesNum = typeof rawPasses === 'number' ? rawPasses : null;
  const failsNum = typeof rawFails === 'number' ? rawFails : null;
  const valueLooksLikeRate =
    httpFailedStats?.value != null &&
    Number.isFinite(httpFailedStats.value) &&
    httpFailedStats.value >= 0 &&
    httpFailedStats.value <= 1 &&
    (passesNum != null || failsNum != null || totalRequestsFinal > 0);

  const failedRate =
    httpFailedStats?.rate != null
      ? httpFailedStats.rate
      : valueLooksLikeRate
      ? +Number(httpFailedStats.value).toFixed(4)
      : totalRequestsFinal > 0
      ? +(totalFailed / totalRequestsFinal).toFixed(4)
      : 0;

  let failedFinal;
  if (passesNum != null) {
    // In k6's rate-metric semantics, "passes" counts samples that met the
    // failure condition (i.e. failed requests).
    failedFinal = passesNum;
  } else if (valueLooksLikeRate && totalRequestsFinal > 0) {
    failedFinal = Math.round(Number(httpFailedStats.value) * totalRequestsFinal);
  } else if (httpFailedStats?.value != null) {
    // Legacy synthetic shape: value is a count.
    failedFinal = Math.round(httpFailedStats.value);
  } else {
    failedFinal = totalFailed;
  }
  const durSeconds = (inferredDurationMs || 0) / 1000;
  const rps = durSeconds > 0 ? +(totalRequestsFinal / durSeconds).toFixed(2) : 0;
  const throughputBytesPerSec =
    durSeconds > 0
      ? +(((totalDataSent + totalDataReceived) || 0) / durSeconds).toFixed(2)
      : 0;

  const failuresList = Array.from(failuresByKey.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, maxFailures);

  const httpFailures = {
    '400': 0,
    '401': 0,
    '403': 0,
    '404': 0,
    '408': 0,
    '409': 0,
    '429': 0,
    '5xx': 0,
    other: 0,
  };
  for (const [status, count] of httpStatusCounts.entries()) {
    const code = Number(status);
    if (!Number.isFinite(code) || code === 0) continue;
    if (code >= 500) httpFailures['5xx'] += count;
    else if (httpFailures[String(code)] != null) httpFailures[String(code)] += count;
    else if (code >= 400) httpFailures.other += count;
  }
  const httpFailuresFromStatuses = sumHttpStatusFailures(httpStatusCounts);
  const httpFailuresFinal =
    unexpectedStatusCount > 0 ? unexpectedStatusCount : httpFailuresFromStatuses;

  const successfulHttp =
    typeof httpReqsCount === 'number'
      ? Math.max(0, httpReqsCount - httpFailuresFinal - transportFailureCount)
      : Math.max(0, totalRequestsFinal - failedFinal);

  const executionLifecycleStatus =
    (droppedIterations ?? 0) > 0 && (iterCount ?? 0) === 0
      ? 'interrupted_at_graceful_stop'
      : (droppedIterations ?? 0) > 0
        ? 'partially_interrupted'
        : iterCount != null && iterCount > 0
          ? 'completed'
          : null;

  return {
    summary: {
      startedAt: startedAt || firstPointTime || null,
      endedAt: endedAt || lastPointTime || null,
      durationMs: inferredDurationMs,
      iterations: iterCount ?? null,
      completedIterations: iterCount ?? iterationLifecycle?.completedIterations ?? null,
      interruptedIterations: droppedIterations ?? iterationLifecycle?.interruptedIterations ?? 0,
      executionLifecycleStatus,
      vusMax: vusMaxFromSummary ?? vusMaxFromPoints ?? null,
      requests: {
        total: totalRequestsFinal,
        passed: Math.max(0, totalRequestsFinal - failedFinal),
        failed: failedFinal,
        successfulHttp,
        httpFailures: httpFailuresFinal,
        transportFailures: transportFailureCount,
        dependencySkipped: dependencySkippedCount,
        errorRate: failedRate,
        rps,
        throughputBytesPerSec,
      },
      failureBreakdown: {
        http: httpFailures,
        transport:
          transportBreakdown.total > 0
            ? transportBreakdown
            : {
                total: transportFailureCount,
                timeout: transportFailureCount,
                dns: 0,
                tcp: 0,
                tls: 0,
                connectionReset: 0,
                other: 0,
              },
      },
      responseTime: reqStats || null,
      checks: checksStats
        ? {
            total: checksStats.count ?? null,
            passes:
              fieldFrom(summaryRaw?.metrics?.checks, 'passes') ??
              (checksStats.count != null && checksStats.rate != null
                ? Math.round(checksStats.count * checksStats.rate)
                : null),
            fails:
              fieldFrom(summaryRaw?.metrics?.checks, 'fails') ??
              (checksStats.count != null && checksStats.rate != null
                ? Math.round(checksStats.count * (1 - checksStats.rate))
                : null),
            passRate: checksStats.rate ?? null,
          }
        : null,
      network: {
        dataSent: totalDataSent,
        dataReceived: totalDataReceived,
      },
      pointsParsed: pointCount,
    },
    thresholds,
    timeseries: {
      bucketSeconds,
      points: buckets.toPoints(),
    },
    requests: requests.toRows(),
    failures: failuresList,
    dependencySkipped: Array.from(dependencySkippedByKey.values()).sort(
      (a, b) => b.count - a.count
    ),
  };
}

module.exports = {
  parseRunArtifacts,
  // Exposed for tests:
  Buckets,
  RequestAggregator,
  quantile,
};
