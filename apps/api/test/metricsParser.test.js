'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const { parseRunArtifacts, quantile, Buckets, RequestAggregator } = require('../src/lib/k6/metricsParser');
const { renderReportHtml } = require('../src/lib/k6/reportGenerator');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'perf-metrics-'));
}

function metricLine(metric, data) {
  return JSON.stringify({ type: 'Metric', metric, data }) + '\n';
}
function pointLine(metric, time, value, tags = {}) {
  return JSON.stringify({ type: 'Point', metric, data: { time, value, tags } }) + '\n';
}

test('quantile picks the right element (floor-based nearest rank)', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  // idx = floor(q * (n-1)). For n=10: q=0.5 -> idx 4 -> value 5; q=0.95 -> idx 8 -> 9.
  assert.equal(quantile(arr, 0), 1);
  assert.equal(quantile(arr, 0.5), 5);
  assert.equal(quantile(arr, 0.9), 9);
  assert.equal(quantile(arr, 0.95), 9);
  assert.equal(quantile(arr, 1), 10);
});

test('Buckets aggregates by bucketSeconds and computes p95', () => {
  const b = new Buckets(2);
  const t0 = '2026-01-01T00:00:00.000Z';
  const t1 = '2026-01-01T00:00:01.000Z';
  const t2 = '2026-01-01T00:00:03.000Z';
  for (let i = 1; i <= 100; i++) b.trackRequest(t0, i, false);
  b.trackRequest(t1, 50, true);
  b.trackRequest(t2, 200, false);
  const points = b.toPoints();
  // First bucket (0-2s) should hold 101 requests with 1 error and a sane p95.
  assert.equal(points.length, 2);
  assert.equal(points[0].requests || (points[0].rps * 2), 101);
  assert.ok(points[0].p95 > 50);
  assert.equal(points[0].errors, 1);
  // Second bucket (2-4s) only has the 200ms sample.
  assert.equal(points[1].errors, 0);
});

test('RequestAggregator computes per-request stats and sorts by avg desc', () => {
  const ra = new RequestAggregator();
  ra.trackDuration({ name: 'A', method: 'GET' }, 100, false);
  ra.trackDuration({ name: 'A', method: 'GET' }, 300, false);
  ra.trackDuration({ name: 'A', method: 'GET' }, 200, true);
  ra.trackDuration({ name: 'B', method: 'POST' }, 50, false);
  const rows = ra.toRows();
  assert.equal(rows[0].name, 'A');
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].errors, 1);
  assert.ok(Math.abs(rows[0].errorRate - 0.3333) < 0.01);
  assert.equal(rows[1].name, 'B');
});

test('parseRunArtifacts builds a normalized report from synthetic JSONL + summary', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    metrics: {
      http_req_duration: { avg: 120, min: 10, max: 800, med: 100, 'p(90)': 200, 'p(95)': 250, 'p(99)': 600, count: 500 },
      http_req_failed: { rate: 0.04, value: 20 },
      iterations: { count: 500 },
      vus_max: { value: 25 },
      checks: { rate: 0.98, count: 100, passes: 98, fails: 2 },
      data_sent: { count: 1024000 },
      data_received: { count: 4096000 },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));

  // Build a metrics JSONL: 30 http_req_duration points across 6 seconds, with 2 errors,
  // some vus samples, and threshold metric definitions.
  let jsonl = '';
  jsonl += metricLine('http_req_duration', {
    type: 'trend',
    contains: 'time',
    thresholds: { 'p(95)<2000': { ok: true } },
  });
  jsonl += metricLine('http_req_failed', {
    type: 'rate',
    contains: 'default',
    thresholds: { 'rate<0.05': { ok: true } },
  });
  jsonl += metricLine('iterations', {
    type: 'counter',
    thresholds: { 'count>0': { ok: false } },
  });

  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 30; i++) {
    const t = new Date(start + i * 200).toISOString();
    const failed = i % 15 === 0; // 2 failures
    jsonl += pointLine('http_req_duration', t, 100 + (i % 5) * 30, {
      name: i % 2 === 0 ? 'GET /users' : 'POST /login',
      method: i % 2 === 0 ? 'GET' : 'POST',
      url: i % 2 === 0 ? '/users' : '/login',
      status: failed ? '500' : '200',
      expected_response: failed ? 'false' : 'true',
    });
  }
  for (let i = 0; i <= 6; i++) {
    jsonl += pointLine('vus', new Date(start + i * 1000).toISOString(), Math.min(i, 5));
  }
  jsonl += pointLine('data_sent', new Date(start + 1000).toISOString(), 5000);
  jsonl += pointLine('data_received', new Date(start + 1000).toISOString(), 20000);

  await fs.writeFile(metricsPath, jsonl);

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:06Z',
    durationMs: 6000,
    bucketSeconds: 2,
  });

  // Summary numbers come from summary.json
  assert.equal(report.summary.requests.total, 500);
  assert.ok(report.summary.requests.errorRate <= 0.05);
  assert.equal(report.summary.iterations, 500);
  assert.equal(report.summary.vusMax, 25);
  assert.ok(report.summary.responseTime.avg > 0);
  assert.ok(report.summary.responseTime.p95 > 0);

  // Thresholds: at least the three we defined are present; one is failing.
  assert.ok(report.thresholds.length >= 3);
  assert.ok(report.thresholds.some((t) => !t.ok));

  // Timeseries: 6 seconds / 2 = 3 buckets (some may be merged depending on alignment)
  assert.ok(report.timeseries.points.length >= 2);
  assert.ok(report.timeseries.points.some((p) => p.errors > 0));

  // Per-request rows: GET /users and POST /login both present
  const names = report.requests.map((r) => r.name).sort();
  assert.deepEqual(names, ['GET /users', 'POST /login']);

  // Failures list contains at least one entry with status "500"
  assert.ok(report.failures.length >= 1);
  assert.ok(report.failures.some((f) => f.lastStatus === '500'));

  // The HTML report renders without throwing and contains the per-request table
  const html = renderReportHtml(report, {
    runId: 'test-run',
    scriptId: 'test-script',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:06Z',
  });
  assert.ok(html.includes('K6 performance report'));
  assert.ok(html.includes('GET /users'));
  assert.ok(html.includes('POST /login'));
});

test('parseRunArtifacts handles missing artifact files gracefully', async () => {
  const dir = await tempDir();
  const report = await parseRunArtifacts({
    summaryExportPath: path.join(dir, 'no-summary.json'),
    metricsJsonPath: path.join(dir, 'no-metrics.json'),
  });
  assert.equal(report.timeseries.points.length, 0);
  assert.equal(report.requests.length, 0);
  assert.equal(report.thresholds.length, 0);
  assert.equal(report.summary.requests.total, 0);
});


/**
 * Phase 6.5 audit defect: real k6 (v1.x) reports `http_req_failed` as
 *   { passes: <failure-count>, fails: <success-count>, value: <rate 0..1> }
 * NOT as { rate, value: <count> } like the older synthetic fixture.
 *
 * The pre-fix parser treated `value` as a count regardless of scale, so a
 * run with 34 failures out of 51 requests reported as 1 failure (rounded
 * from 0.6666). Locked here so any regression is caught.
 */
test('parseRunArtifacts handles k6 v1 http_req_failed shape (rate in value, count in passes)', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    metrics: {
      http_req_duration: { avg: 1, min: 0, max: 12, med: 1, 'p(90)': 2, 'p(95)': 3 },
      // Real k6 v1 shape — value is a rate between 0 and 1, passes is the
      // count of samples that MET the failure condition (i.e. failed).
      http_req_failed: { passes: 34, fails: 17, value: 0.6666, thresholds: { 'rate<0.05': { ok: false } } },
      http_reqs: { count: 51, rate: 8.5 },
      iterations: { count: 17 },
      vus_max: { value: 1 },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));

  // Minimal JSONL with 51 duration points, 34 failed.
  let jsonl = metricLine('http_req_duration', { type: 'trend', contains: 'time' });
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 51; i++) {
    const t = new Date(start + i * 100).toISOString();
    const failed = i % 3 !== 0; // 34 failures / 17 successes
    jsonl += pointLine('http_req_duration', t, 1, {
      name: 'GET /x',
      method: 'GET',
      status: failed ? '500' : '200',
      expected_response: failed ? 'false' : 'true',
    });
  }
  await fs.writeFile(metricsPath, jsonl);

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:05Z',
    durationMs: 5000,
  });

  // Total requests must match http_reqs.count.
  assert.equal(report.summary.requests.total, 51);
  // Failed count must be the actual count (34), not the rate rounded to 1.
  assert.equal(report.summary.requests.failed, 34);
  assert.equal(report.summary.requests.passed, 17);
  // Error rate must match the value from the summary.
  assert.ok(Math.abs(report.summary.requests.errorRate - 0.6666) < 0.001);
});


/**
 * Phase 7 defect: after Phase 6.6, K6 v1's handleSummary emits a NESTED
 * shape where per-metric values live under a `values` sub-object:
 *   http_req_duration: { type: 'trend', contains: 'time', values: { avg, min, max, med, p(90), p(95), p(99) } }
 *   http_req_failed:   { type: 'rate', values: { passes, fails, rate } }
 *   http_reqs:         { type: 'counter', values: { count, rate } }
 *
 * The pre-fix parser looked for `m.avg`, `m.count`, `m['p(95)']` directly
 * on the metric object and returned nothing when they were nested,
 * silently reverting to JSONL-derived streaming counts and losing every
 * summary-side percentile. This test reproduces the shape and asserts
 * the parser reads it correctly.
 */
test('parseRunArtifacts handles k6 v1 handleSummary NESTED metric shape', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    // handleSummary shape: 4 top-level keys, no setup_data, values nested.
    options: {},
    state: {},
    root_group: {},
    metrics: {
      http_req_duration: {
        type: 'trend', contains: 'time',
        values: {
          avg: 12.5, min: 1, max: 300, med: 8.4,
          'p(90)': 40, 'p(95)': 80, 'p(99)': 200,
        },
        thresholds: { 'p(95)<2000': { ok: true } },
      },
      http_req_failed: {
        type: 'rate', contains: 'default',
        values: { passes: 34, fails: 17, rate: 0.6666 },
        thresholds: { 'rate<0.05': { ok: false } },
      },
      http_reqs: { type: 'counter', values: { count: 51, rate: 8.5 } },
      iterations: { type: 'counter', values: { count: 17, rate: 3.2 } },
      vus_max: { type: 'gauge', values: { value: 1, min: 1, max: 1 } },
      checks: {
        type: 'rate', contains: 'default',
        values: { passes: 40, fails: 11, rate: 0.784 },
      },
      data_sent:     { type: 'counter', values: { count: 4096, rate: 800 } },
      data_received: { type: 'counter', values: { count: 9928, rate: 1900 } },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  await fs.writeFile(metricsPath, '');

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:00:05Z',
    durationMs: 5000,
  });

  assert.equal(report.summary.requests.total, 51, 'total from http_reqs.values.count');
  assert.equal(report.summary.requests.failed, 34, 'failed from http_req_failed.values.passes');
  assert.ok(Math.abs(report.summary.requests.errorRate - 0.6666) < 0.001);
  assert.equal(report.summary.iterations, 17);
  assert.equal(report.summary.vusMax, 1);
  // The percentile assertions are what actually regressed. Pre-fix these
  // came back null because the parser looked at `m.avg` / `m['p(95)']`
  // directly instead of `m.values.avg` / `m.values['p(95)']`.
  assert.equal(report.summary.responseTime.avg, 12.5);
  assert.equal(report.summary.responseTime.min, 1);
  assert.equal(report.summary.responseTime.max, 300);
  assert.equal(report.summary.responseTime.med, 8.4);
  assert.equal(report.summary.responseTime.p90, 40);
  assert.equal(report.summary.responseTime.p95, 80);
  assert.equal(report.summary.responseTime.p99, 200);
  const durationThreshold = report.thresholds.find(
    (t) => t.metric === 'http_req_duration' && t.expression === 'p(95)<2000'
  );
  assert.ok(durationThreshold, 'http_req_duration threshold present');
  assert.equal(durationThreshold.lastValue, 80);
  assert.equal(durationThreshold.ok, true);
  // checks is a k6 rate metric — its nested shape carries passes/fails/rate
  // but no `count`, so parser exposes total=null (with derived passes/fails).
  assert.equal(report.summary.checks.passes, 40);
  assert.equal(report.summary.checks.fails, 11);
  // data_sent/data_received counters are streamed from JSONL; when the
  // JSONL is empty (as in this synthetic test), the parser reports 0.
  // Real runs have JSONL data and produce real byte counts — verified in
  // the Phase 7 certification harness.
  assert.equal(report.summary.network.dataSent, 0);
  assert.equal(report.summary.network.dataReceived, 0);
});

test('parseRunArtifacts exposes http_req_duration p(95) on failed threshold (ms)', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    metrics: {
      http_req_duration: {
        type: 'trend',
        contains: 'time',
        values: {
          'p(95)': 21144.255405,
          avg: 2531.45,
          min: 211.99,
          med: 412.39,
          max: 60409.97,
        },
        thresholds: { 'p(95)<2000': { ok: false } },
      },
      http_reqs: { values: { count: 494 } },
      vus_max: { values: { value: 10 } },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));
  await fs.writeFile(metricsPath, '');

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
  });

  const t = report.thresholds.find(
    (row) => row.metric === 'http_req_duration' && row.expression === 'p(95)<2000'
  );
  assert.ok(t);
  assert.equal(t.lastValue, 21144.26);
  assert.equal(t.ok, false);
  assert.equal(report.summary.responseTime.p95, 21144.26);
});

test('parseRunArtifacts separates HTTP 4xx from transport via k6 error_code tags', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    metrics: {
      http_req_duration: { avg: 100, min: 50, max: 200, med: 90, 'p(95)': 150 },
      http_req_failed: { passes: 3, fails: 2, value: 0.6 },
      http_reqs: { count: 5 },
      perf_transport_failed: { count: 1 },
      perf_unexpected_status: { count: 2 },
      iterations: { count: 1 },
      vus_max: { value: 1 },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));

  let jsonl = '';
  const start = Date.parse('2026-01-01T00:00:00Z');
  const samples = [
    { status: '200', error_code: '0', failed: false },
    { status: '201', error_code: '0', failed: false },
    { status: '400', error_code: '1400', failed: true },
    { status: '401', error_code: '1401', failed: true },
    { status: '0', error_code: '1101', failed: true },
  ];
  samples.forEach((s, i) => {
    const t = new Date(start + i * 100).toISOString();
    jsonl += pointLine('http_req_duration', t, 100, {
      name: 'GET /x',
      method: 'GET',
      status: s.status,
      error_code: s.error_code,
      expected_response: s.failed ? 'false' : 'true',
    });
  });
  await fs.writeFile(metricsPath, jsonl);

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
  });

  assert.equal(report.summary.requests.httpFailures, 2);
  assert.equal(report.summary.requests.transportFailures, 1);
  assert.equal(report.summary.failureBreakdown.http['400'], 1);
  assert.equal(report.summary.failureBreakdown.http['401'], 1);
});

test('parseRunArtifacts reconciles perf_transport_failed threshold with tag-corrected count', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  const metricsPath = path.join(dir, 'metrics.json');

  const summary = {
    metrics: {
      http_req_duration: { avg: 100, 'p(95)': 21144 },
      http_req_failed: { passes: 231, fails: 260, value: 0.4705, thresholds: { 'rate<0.05': { ok: false } } },
      http_reqs: { count: 491 },
      perf_transport_failed: {
        count: 231,
        thresholds: { 'count==0': { ok: false } },
      },
      perf_unexpected_status: {
        count: 0,
        thresholds: { 'count==0': { ok: true } },
      },
      vus_max: { value: 10 },
    },
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary));

  let jsonl = '';
  const start = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < 3; i++) {
    const t = new Date(start + i * 100).toISOString();
    jsonl += pointLine('http_req_duration', t, 100, {
      name: 'GET /x',
      method: 'GET',
      status: i === 0 ? '401' : '200',
      error_code: i === 0 ? '1401' : '0',
      expected_response: i === 0 ? 'false' : 'true',
    });
  }
  await fs.writeFile(metricsPath, jsonl);

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: metricsPath,
  });

  const transport = report.thresholds.find((t) => t.metric === 'perf_transport_failed');
  const unexpected = report.thresholds.find((t) => t.metric === 'perf_unexpected_status');
  assert.equal(transport.lastValue, 0);
  assert.equal(transport.ok, true);
  assert.equal(unexpected.lastValue, 1);
  assert.equal(unexpected.ok, false);
});

test('parseRunArtifacts consumes iteration lifecycle from stdout parser fallback', async () => {
  const dir = await tempDir();
  const summaryPath = path.join(dir, 'summary.json');
  await fs.writeFile(summaryPath, JSON.stringify({ metrics: { vus_max: { value: 10 } } }));

  const report = await parseRunArtifacts({
    summaryExportPath: summaryPath,
    metricsJsonPath: path.join(dir, 'missing-metrics.json'),
    iterationLifecycle: { completedIterations: 0, interruptedIterations: 10 },
  });

  assert.equal(report.summary.completedIterations, 0);
  assert.equal(report.summary.interruptedIterations, 10);
  assert.equal(report.summary.executionLifecycleStatus, 'interrupted_at_graceful_stop');
});
