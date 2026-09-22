'use strict';

/**
 * Phase 4 deterministic tests for the normalized report contract.
 *
 * These tests feed hand-crafted parseRunArtifacts fixtures + run contexts
 * into buildNormalizedReport() and assert:
 *   - the contract shape (top-level keys, verdict, summary fields)
 *   - verdict rules (PASS iff execution ok AND all thresholds pass)
 *   - HTTP 5xx does NOT force a K6 process failure
 *   - slowestApis / highestErrorApis ordering
 *   - secret-safe failure entries (no headers, cookies, tokens, bodies)
 *   - loadProfile duration math
 *   - HTML report renders every mandatory section
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNormalizedReport,
  computeVerdict,
  buildLoadProfile,
  buildSummary,
  buildApiMetrics,
  pickSlowest,
  pickHighestError,
  redactFailure,
  sanitizeApiName,
  describeThreshold,
  durationStringToMs,
  bytesHuman,
  durationHuman,
  REPORT_CONTRACT_VERSION,
} = require('../src/lib/report/normalizedReport');
const { renderReportHtml } = require('../src/lib/k6/reportGenerator');

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function fixtureParsed({ thresholdsOk = true, includeErrors = true } = {}) {
  const thresholds = [
    { metric: 'http_req_duration', expression: 'p(95)<2000', ok: thresholdsOk, lastValue: 187.32 },
    { metric: 'http_req_failed',   expression: 'rate<0.05',  ok: thresholdsOk, lastValue: 0.023 },
    { metric: 'perf_transport_failed', expression: 'count==0', ok: true, lastValue: 0 },
    { metric: 'perf_unexpected_status', expression: 'count==0', ok: true, lastValue: 0 },
  ];
  const requests = [
    { name: 'GET /users',   method: 'GET',  group: 'auth', count: 200, errors: 0,               avg: 42.5, min: 12.1, max: 180.2, med: 40.0, p90: 76.4, p95: 92.8,  p99: 150.4 },
    { name: 'POST /orders', method: 'POST', group: 'shop', count: 120, errors: includeErrors ? 18 : 0, avg: 210.7, min: 50.0, max: 900.1, med: 190.3, p90: 380.4, p95: 460.9, p99: 780.2 },
    { name: 'GET /health',  method: 'GET',  group: '',     count: 60,  errors: 0,               avg: 8.3, min: 3.2, max: 22.0, med: 8.0, p90: 12.4, p95: 15.1, p99: 21.4 },
    { name: 'GET /reports/heavy', method: 'GET', group: 'ops', count: 40, errors: includeErrors ? 4 : 0, avg: 1500.4, min: 800.0, max: 3100.1, med: 1400.2, p90: 2400.9, p95: 2800.4, p99: 3100.1 },
  ];
  const failures = includeErrors
    ? [
        { name: 'POST /orders',      method: 'POST', count: 18, lastStatus: '500', samples: [{ t: 't1', status: '500', duration: 210.4 }] },
        { name: 'GET /reports/heavy', method: 'GET',  count: 4,  lastStatus: '502', samples: [] },
      ]
    : [];
  return {
    summary: {
      startedAt: '2026-05-01T12:00:00.000Z',
      endedAt:   '2026-05-01T12:02:00.000Z',
      durationMs: 120_000,
      iterations: 350,
      vusMax: 25,
      requests: {
        total: 420,
        passed: 420 - (includeErrors ? 22 : 0),
        failed: includeErrors ? 22 : 0,
        errorRate: includeErrors ? +(22 / 420).toFixed(4) : 0,
        rps: 3.5,
        throughputBytesPerSec: 4096,
      },
      responseTime: { avg: 210.7, min: 3.2, max: 3100.1, med: 45.0, p90: 240.4, p95: 460.9, p99: 780.2, count: 420 },
      checks: { total: 420, passes: 400, fails: 20, passRate: 0.9524 },
      network: { dataSent: 512000, dataReceived: 4096000 },
      pointsParsed: 5321,
    },
    thresholds,
    timeseries: {
      bucketSeconds: 2,
      points: [
        { t: '2026-05-01T12:00:00.000Z', vus: 5, rps: 3.0, errors: 0, p95: 90,  throughput: 1024 },
        { t: '2026-05-01T12:00:02.000Z', vus: 15, rps: 4.2, errors: 1, p95: 150, throughput: 2048 },
        { t: '2026-05-01T12:00:04.000Z', vus: 25, rps: 5.1, errors: 4, p95: 480, throughput: 4096 },
      ],
    },
    requests,
    failures,
  };
}

function fixtureRun(overrides = {}) {
  return {
    runId: 'run-abc-123',
    scriptId: 'script-abc-123',
    status: 'completed',
    exitCode: 0,
    error: null,
    startedAt: '2026-05-01T12:00:00.000Z',
    endedAt:   '2026-05-01T12:02:00.000Z',
    durationMs: 120_000,
    ...overrides,
  };
}

function fixtureScript() {
  return {
    collectionId: 'col-abc',
    loadProfile: { vus: 25, rampUp: '30s', hold: '1m', rampDown: '30s' },
  };
}

function fixtureCollection() {
  return { summary: { name: 'Demo Collection' } };
}

/* ------------------------------------------------------------------ */
/*  Contract shape                                                     */
/* ------------------------------------------------------------------ */
test('normalized report exposes every top-level contract key in a stable shape', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
    collection: fixtureCollection(),
  });
  const requiredKeys = [
    'metadata',
    'execution',
    'loadProfile',
    'thresholds',
    'summary',
    'apiMetrics',
    'slowestApis',
    'highestErrorApis',
    'failures',
    'timeseries',
    'verdict',
  ];
  for (const k of requiredKeys) {
    assert.ok(k in report, 'missing top-level key: ' + k);
  }
  assert.equal(report.metadata.contractVersion, REPORT_CONTRACT_VERSION);
  assert.equal(report.metadata.generator, 'perf-agent/report@v1');
  assert.match(report.metadata.generatedAt || '', /\d{4}-\d{2}-\d{2}T/);
  assert.equal(report.metadata.runId, 'run-abc-123');
  assert.equal(report.metadata.collectionName, 'Demo Collection');
});

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */
test('summary carries every field the report requires', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
  });
  const s = report.summary;
  const requiredSummaryKeys = [
    'status',
    'totalRequests', 'successfulRequests', 'failedRequests', 'errorPercentage',
    'rps', 'peakVUs', 'iterations',
    'avg', 'median', 'p90', 'p95', 'p99', 'max',
    'dataSent', 'dataReceived', 'dataSentBytes', 'dataReceivedBytes',
    'duration', 'durationMs',
  ];
  for (const k of requiredSummaryKeys) assert.ok(k in s, 'missing summary key: ' + k);
  assert.equal(s.totalRequests, 420);
  assert.equal(s.failedRequests, 22);
  assert.equal(s.successfulRequests, 398);
  assert.equal(s.peakVUs, 25);
  assert.equal(s.iterations, 350);
  assert.equal(s.durationMs, 120_000);
  assert.equal(s.duration, '2m');
  assert.equal(s.dataSent, '500 KB');
  // 4,096,000 bytes = 4000 KB = 3.90625 MB. Formatter rounds to 1 decimal.
  assert.equal(s.dataReceived, '3.9 MB');
  assert.equal(s.p95, 460.9);
  assert.equal(s.median, 45);
  // status must reflect verdict.
  assert.ok(['PASS', 'FAIL'].includes(s.status));
});

test('summary.status mirrors verdict.status', () => {
  const passReport = buildNormalizedReport({
    parsed: fixtureParsed({ thresholdsOk: true, includeErrors: false }),
    run: fixtureRun(),
  });
  assert.equal(passReport.summary.status, 'PASS');
  assert.equal(passReport.verdict.status, 'PASS');

  const failReport = buildNormalizedReport({
    parsed: fixtureParsed({ thresholdsOk: false }),
    run: fixtureRun(),
  });
  assert.equal(failReport.summary.status, 'FAIL');
  assert.equal(failReport.verdict.status, 'FAIL');
});

/* ------------------------------------------------------------------ */
/*  Verdict rules                                                      */
/* ------------------------------------------------------------------ */
test('verdict: PASS when all thresholds pass AND process exit is clean', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed({ thresholdsOk: true, includeErrors: false }),
    run: fixtureRun(),
  });
  assert.equal(report.verdict.status, 'PASS');
  assert.equal(report.verdict.executionOk, true);
  assert.equal(report.verdict.thresholdsFailed, 0);
});

test('verdict: FAIL when any threshold fails, even if execution was clean', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed({ thresholdsOk: false }),
    run: fixtureRun(),
  });
  assert.equal(report.verdict.status, 'FAIL');
  assert.equal(report.verdict.executionOk, true);
  assert.ok(report.verdict.thresholdsFailed >= 1);
  assert.ok(report.verdict.reasons.some((r) => /threshold/i.test(r)));
});

test('verdict: FAIL when the K6 process itself did not complete', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed({ thresholdsOk: true, includeErrors: false }),
    run: fixtureRun({ status: 'failed', exitCode: 1, error: 'k6 crashed' }),
  });
  assert.equal(report.verdict.status, 'FAIL');
  assert.equal(report.verdict.executionOk, false);
  assert.ok(report.verdict.reasons.some((r) => /execution did not complete/i.test(r)));
});

test('verdict: HTTP 500 samples DO NOT constitute a K6 process failure', () => {
  // Every threshold passes and the process exited cleanly, but the run
  // observed some 5xx samples. Verdict must remain PASS.
  const parsed = fixtureParsed({ thresholdsOk: true, includeErrors: true });
  const report = buildNormalizedReport({ parsed, run: fixtureRun() });
  assert.equal(report.verdict.status, 'PASS');
  assert.equal(report.verdict.executionOk, true);
  assert.equal(report.verdict.thresholdsFailed, 0);
  // But the failed request count still surfaces in the summary + failures.
  assert.ok(report.summary.failedRequests > 0);
  assert.ok(report.failures.length > 0);
  assert.ok(report.failures.some((f) => f.lastStatus === '500'));
});

test('verdict: no SLAs declared surfaces a neutral PASS reason', () => {
  const parsed = fixtureParsed({ includeErrors: false });
  parsed.thresholds = [];
  const report = buildNormalizedReport({ parsed, run: fixtureRun() });
  assert.equal(report.verdict.status, 'PASS');
  assert.ok(report.verdict.reasons.some((r) => /no sla/i.test(r)));
});

/* ------------------------------------------------------------------ */
/*  Thresholds table + descriptions                                    */
/* ------------------------------------------------------------------ */
test('thresholds each carry { metric, threshold, actual, status, description }', () => {
  const report = buildNormalizedReport({ parsed: fixtureParsed(), run: fixtureRun() });
  for (const t of report.thresholds) {
    for (const k of ['metric', 'threshold', 'actual', 'status', 'description']) {
      assert.ok(k in t, 'missing threshold key: ' + k);
    }
    assert.ok(['pass', 'fail'].includes(t.status));
    assert.ok(typeof t.description === 'string' && t.description.length > 0);
  }
});

test('describeThreshold explains built-in and custom metrics', () => {
  assert.match(describeThreshold('http_req_duration', 'p(95)<2000'), /HTTP request duration/i);
  assert.match(describeThreshold('http_req_failed', 'rate<0.05'), /failure rate/i);
  assert.match(describeThreshold('checks', 'rate>0.99'), /checks pass rate/i);
  assert.match(describeThreshold('perf_transport_failed', 'count==0'), /transport-failure/i);
  assert.match(describeThreshold('perf_unexpected_status', 'count==0'), /2xx/i);
  assert.match(describeThreshold('my_custom', 'value<1'), /custom metric/i);
});

/* ------------------------------------------------------------------ */
/*  Load profile                                                       */
/* ------------------------------------------------------------------ */
test('loadProfile exposes VUs, ramp phases, executor, and total duration', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
  });
  const lp = report.loadProfile;
  assert.equal(lp.vus, 25);
  assert.equal(lp.rampUp, '30s');
  assert.equal(lp.hold, '1m');
  assert.equal(lp.rampDown, '30s');
  assert.equal(lp.executor, 'ramping-vus');
  assert.equal(lp.totalDurationMs, 120_000);
  assert.equal(lp.totalDuration, '2m');
});

test('durationStringToMs handles ms / s / m / h and bogus inputs', () => {
  assert.equal(durationStringToMs('500ms'), 500);
  assert.equal(durationStringToMs('30s'), 30_000);
  assert.equal(durationStringToMs('2m'), 120_000);
  assert.equal(durationStringToMs('1h'), 3_600_000);
  assert.equal(durationStringToMs('bogus'), 0);
  assert.equal(durationStringToMs(null), 0);
});

/* ------------------------------------------------------------------ */
/*  API metrics table                                                   */
/* ------------------------------------------------------------------ */
test('apiMetrics rows carry the full column set: api / method / folder / count / success / failure / error% / stats', () => {
  const report = buildNormalizedReport({ parsed: fixtureParsed(), run: fixtureRun() });
  const requiredCols = [
    'api', 'method', 'folder', 'count', 'success', 'failure', 'errorPercentage',
    'avg', 'min', 'median', 'p90', 'p95', 'p99', 'max',
  ];
  for (const row of report.apiMetrics) {
    for (const c of requiredCols) assert.ok(c in row, 'missing API column: ' + c);
  }
  const orders = report.apiMetrics.find((r) => r.api === 'POST /orders');
  assert.equal(orders.count, 120);
  assert.equal(orders.failure, 18);
  assert.equal(orders.success, 102);
  assert.equal(orders.method, 'POST');
  assert.equal(orders.folder, 'shop');
  assert.ok(orders.errorPercentage > 0);
});

/* ------------------------------------------------------------------ */
/*  Slowest / highest error subsets                                     */
/* ------------------------------------------------------------------ */
test('slowestApis are sorted by p95 desc and capped at the requested limit', () => {
  const parsed = fixtureParsed();
  const report = buildNormalizedReport({ parsed, run: fixtureRun(), slowestLimit: 2 });
  assert.equal(report.slowestApis.length, 2);
  assert.ok(report.slowestApis[0].p95 >= report.slowestApis[1].p95);
  // Heaviest api in the fixture is /reports/heavy (p95 2800.4).
  assert.equal(report.slowestApis[0].api, 'GET /reports/heavy');
});

test('highestErrorApis excludes zero-failure rows and sorts by errorPercentage desc', () => {
  const parsed = fixtureParsed();
  const report = buildNormalizedReport({ parsed, run: fixtureRun(), highestErrorLimit: 5 });
  assert.ok(report.highestErrorApis.every((r) => r.failure > 0));
  for (let i = 1; i < report.highestErrorApis.length; i += 1) {
    assert.ok(
      report.highestErrorApis[i - 1].errorPercentage >= report.highestErrorApis[i].errorPercentage
    );
  }
});

test('highestErrorApis is empty when no request had any failure', () => {
  const parsed = fixtureParsed({ includeErrors: false });
  const report = buildNormalizedReport({ parsed, run: fixtureRun() });
  assert.deepEqual(report.highestErrorApis, []);
});

/* ------------------------------------------------------------------ */
/*  Failures — secret-safe                                              */
/* ------------------------------------------------------------------ */
test('failures never expose Authorization headers, cookies, tokens, or bodies', () => {
  const parsed = fixtureParsed();
  // Deliberately poison the failure with fields a naive report would emit.
  parsed.failures[0].headers = { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.super.secret' };
  parsed.failures[0].cookies = 'session=very-secret-cookie-value';
  parsed.failures[0].body = '{"password":"topsecret"}';
  parsed.failures[0].requestBody = 'password=p';
  const report = buildNormalizedReport({ parsed, run: fixtureRun() });
  for (const f of report.failures) {
    assert.deepEqual(
      Object.keys(f).sort(),
      ['api', 'count', 'lastStatus', 'method', 'reason']
    );
    const serialized = JSON.stringify(f);
    assert.ok(!serialized.includes('eyJhbGciOiJIUzI1NiJ9'), 'JWT leaked into failure');
    assert.ok(!serialized.includes('very-secret-cookie-value'), 'cookie leaked into failure');
    assert.ok(!serialized.includes('topsecret'), 'password leaked into failure');
    assert.ok(!/authorization/i.test(serialized), 'Authorization key leaked into failure');
  }
});

test('sanitizeApiName strips embedded Bearer tokens and Authorization keys', () => {
  const sanitized = sanitizeApiName('Weird name Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefgh');
  assert.ok(!sanitized.includes('eyJhbGciOiJIUzI1NiJ9'));
  assert.ok(!/authorization\s*:/i.test(sanitized));
  assert.equal(sanitizeApiName(null), '');
});

test('redactFailure produces a stable, whitelisted key set', () => {
  const out = redactFailure({
    name: 'X', method: 'get', count: 3, lastStatus: 500,
    samples: [{ shouldntSurvive: true }],
    headers: { Authorization: 'Bearer secret' },
  });
  assert.deepEqual(Object.keys(out).sort(), ['api', 'count', 'lastStatus', 'method', 'reason']);
  assert.equal(out.method, 'GET');
});

test('buildFailureReason returns human-readable text per status class', () => {
  const parsed = fixtureParsed();
  parsed.failures = [
    { name: 'a', method: 'GET', count: 1, lastStatus: '401' },
    { name: 'b', method: 'GET', count: 1, lastStatus: '429' },
    { name: 'c', method: 'GET', count: 1, lastStatus: '500' },
    { name: 'd', method: 'GET', count: 1, lastStatus: '0' },
    { name: 'e', method: 'GET', count: 1, lastStatus: null },
  ];
  const failures = buildNormalizedReport({ parsed, run: fixtureRun() }).failures;
  assert.match(failures[0].reason, /authorization/i);
  assert.match(failures[1].reason, /rate limit/i);
  assert.match(failures[2].reason, /server error/i);
  assert.match(failures[3].reason, /transport/i);
  assert.match(failures[4].reason, /no status/i);
});

/* ------------------------------------------------------------------ */
/*  Timeseries                                                          */
/* ------------------------------------------------------------------ */
test('timeseries is passed through from parseRunArtifacts', () => {
  const report = buildNormalizedReport({ parsed: fixtureParsed(), run: fixtureRun() });
  assert.equal(report.timeseries.bucketSeconds, 2);
  assert.equal(report.timeseries.points.length, 3);
  assert.equal(report.timeseries.points[0].vus, 5);
});

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                  */
/* ------------------------------------------------------------------ */
test('bytesHuman / durationHuman handle typical inputs', () => {
  assert.equal(bytesHuman(1024), '1.0 KB');
  assert.equal(bytesHuman(1_500_000), '1.4 MB');
  assert.equal(bytesHuman(null), null);
  assert.equal(durationHuman(30_000), '30s');
  assert.equal(durationHuman(90_000), '1m 30s');
  assert.equal(durationHuman(3_720_000), '1h 2m');
  assert.equal(durationHuman(null), null);
});

/* ------------------------------------------------------------------ */
/*  buildLoadProfile / buildSummary units                               */
/* ------------------------------------------------------------------ */
test('buildLoadProfile returns nulls when nothing is provided', () => {
  const lp = buildLoadProfile(null);
  assert.equal(lp.vus, null);
  assert.equal(lp.rampUp, null);
  assert.equal(lp.totalDurationMs, null);
  assert.equal(lp.executor, 'ramping-vus');
});

test('buildSummary uses the caller-supplied verdict status verbatim', () => {
  const s = buildSummary(fixtureParsed(), 'FAIL');
  assert.equal(s.status, 'FAIL');
});

/* ------------------------------------------------------------------ */
/*  HTML renderer accepts the normalized model + shows every section    */
/* ------------------------------------------------------------------ */
test('renderReportHtml renders every mandatory section for the normalized model', () => {
  const report = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
    collection: fixtureCollection(),
  });
  const html = renderReportHtml(report, { runId: report.metadata.runId });
  const expectations = [
    'K6 performance report',
    'Final verdict',
    'Execution',
    'Load profile',
    'Authentication',
    'Executive summary',
    'Latency',
    'Thresholds &amp; SLA',
    'Charts',
    'API metrics',
    'Slowest APIs (by p95)',
    'Highest error-rate APIs',
    'Failure breakdown',
    'Failure analysis',
    'Dependency-skipped requests',
    'Demo Collection',
  ];
  for (const s of expectations) {
    assert.ok(html.includes(s), 'section marker missing: ' + s);
  }
  // Verdict banner reflects the computed status.
  assert.match(html, new RegExp('<div class="label">' + report.verdict.status + '<\\/div>'));
  // No secrets survive the render (defensive — the normalized failures
  // never contained one, but assert it end-to-end anyway).
  assert.ok(!/eyJhbGciOiJIUzI1NiJ9/.test(html), 'JWT literal leaked into HTML');
});

/* ------------------------------------------------------------------ */
/*  computeVerdict unit-level                                           */
/* ------------------------------------------------------------------ */
test('computeVerdict handles missing thresholds + missing exitCode', () => {
  const v = computeVerdict({ thresholds: [], run: { status: 'completed' } });
  assert.equal(v.status, 'PASS');
  assert.equal(v.thresholdsFailed, 0);
  assert.equal(v.executionOk, true);
});

test('computeVerdict flags mixed threshold + execution failures', () => {
  const v = computeVerdict({
    thresholds: [
      { metric: 'a', threshold: 'x', actual: 1, status: 'fail', description: 'd' },
    ],
    run: { status: 'failed', exitCode: 1, error: 'boom' },
  });
  assert.equal(v.status, 'FAIL');
  assert.equal(v.executionOk, false);
  assert.equal(v.thresholdsFailed, 1);
  assert.ok(v.reasons.length >= 2);
});

/* ------------------------------------------------------------------ */
/*  Determinism                                                         */
/* ------------------------------------------------------------------ */
test('given identical inputs, top-level shape and non-time fields are deterministic', () => {
  const a = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
    collection: fixtureCollection(),
  });
  const b = buildNormalizedReport({
    parsed: fixtureParsed(),
    run: fixtureRun(),
    script: fixtureScript(),
    collection: fixtureCollection(),
  });
  // Everything except metadata.generatedAt must be byte-identical.
  a.metadata.generatedAt = b.metadata.generatedAt;
  assert.deepEqual(a, b);
});
