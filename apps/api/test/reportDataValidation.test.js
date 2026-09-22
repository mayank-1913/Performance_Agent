'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRunArtifacts } = require('../src/lib/k6/metricsParser');
const { buildNormalizedReport } = require('../src/lib/report/normalizedReport');
const { renderReportHtml } = require('../src/lib/k6/reportGenerator');
const fs = require('fs');
const path = require('path');

test('raw K6 summary, normalized report, and HTML stay consistent', async () => {
  const summaryPath = path.join(__dirname, 'fixtures', 'k6-summary-with-p99.json');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  const parsed = await parseRunArtifacts({ summaryExportPath: summaryPath });
  const report = buildNormalizedReport({
    parsed,
    run: { runId: 'fixture', status: 'completed', exitCode: 0 },
    script: { requestTimeout: { defaultTimeout: '120s', gracefulStop: '120s' } },
  });
  const html = renderReportHtml(report, { runId: 'fixture' });

  const rawReqs = summary.metrics.http_reqs.values?.count ?? summary.metrics.http_reqs.count;
  const rawP95 =
    summary.metrics.http_req_duration.values?.['p(95)'] ??
    summary.metrics.http_req_duration['p(95)'];
  const rawP99 =
    summary.metrics.http_req_duration.values?.['p(99)'] ??
    summary.metrics.http_req_duration['p(99)'];

  assert.equal(report.summary.totalRequests, rawReqs);
  assert.equal(report.summary.p95, +Number(rawP95).toFixed(2));
  assert.equal(report.summary.p99, +Number(rawP99).toFixed(2));
  assert.equal(report.summary.transportFailures, 0);
  assert.equal(report.summary.httpFailures, 2);
  assert.ok(html.includes('Executive summary'));
  assert.ok(html.includes(String(report.summary.p99)));
});
