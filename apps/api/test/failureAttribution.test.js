'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parse } = require('../src/lib/postman/parser');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildDependencyGraph } = require('../src/lib/postman/dependencyGraph');
const { generateK6Script } = require('../src/lib/k6/generator');
const {
  buildNormalizedReport,
  computeVerdict,
  K6_THRESHOLD_EXIT_CODE,
  isK6ExecutionSuccessful,
  buildFailureAnalysis,
} = require('../src/lib/report/normalizedReport');
const { renderReportHtml } = require('../src/lib/k6/reportGenerator');

function campaignChainCollection() {
  return {
    info: { name: 'Campaign chain', schema: 'v2.1' },
    item: [
      {
        name: 'CreateCTVCampaign',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/campaign' },
          body: { mode: 'raw', raw: '{}' },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.collectionVariables.set("campaign_id", json.id);',
              ],
            },
          },
        ],
      },
      {
        name: 'ToUpdateCampaign',
        request: {
          method: 'PUT',
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
      {
        name: 'DeleteCTVCampaign',
        request: {
          method: 'DELETE',
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
    ],
  };
}

test('exitCode 99 + threshold failure => APPLICATION_PERFORMANCE_FAILURE', () => {
  const parsed = {
    thresholds: [
      { metric: 'http_req_failed', expression: 'rate<0.05', ok: false, lastValue: 0.46 },
      { metric: 'perf_transport_failed', expression: 'count==0', ok: true, lastValue: 0 },
    ],
    summary: {
      requests: { total: 100, httpFailures: 46, transportFailures: 0, failed: 46, errorRate: 0.46 },
      iterations: 0,
      interruptedIterations: 5,
      completedIterations: 0,
      executionLifecycleStatus: 'interrupted_at_graceful_stop',
    },
  };
  const verdict = computeVerdict({
    thresholds: parsed.thresholds.map((t) => ({
      metric: t.metric,
      threshold: t.expression,
      actual: t.lastValue,
      status: t.ok === false ? 'fail' : 'pass',
    })),
    run: { status: 'completed', exitCode: K6_THRESHOLD_EXIT_CODE },
    parsed,
  });
  assert.equal(verdict.executionOk, true);
  assert.equal(verdict.category, 'APPLICATION_PERFORMANCE_FAILURE');
  assert.equal(verdict.status, 'FAIL');
  assert.ok(!verdict.agentReasons.some((r) => /execution did not complete/i.test(r)));
});

test('process crash => AGENT_RUNTIME_FAILURE', () => {
  const verdict = computeVerdict({
    thresholds: [],
    run: { status: 'failed', exitCode: 1, error: 'k6 process error' },
    parsed: { summary: { requests: { total: 0 } } },
  });
  assert.equal(verdict.category, 'AGENT_RUNTIME_FAILURE');
  assert.equal(verdict.executionOk, false);
});

test('dependency graph links campaign_id to CreateCTVCampaign', () => {
  const parsed = parse(campaignChainCollection());
  const authFlow = buildAuthFlow(parsed);
  const graph = buildDependencyGraph(parsed, authFlow);
  const updateIdx = parsed.requests.findIndex((r) => r.name === 'ToUpdateCampaign');
  const deps = graph.perRequest[updateIdx];
  assert.ok(deps.some((d) => d.varName === 'campaign_id'));
  assert.equal(deps[0].producerRequest, 'CreateCTVCampaign');
});

test('generated script skips dependent requests when dependency unavailable', () => {
  const parsed = parse(campaignChainCollection());
  const authFlow = buildAuthFlow(parsed);
  const script = generateK6Script(parsed, { authFlow, injectAuthToken: false });
  assert.match(script, /__checkDependencyDeps/);
  assert.match(script, /__dependencySkipped/);
  assert.match(script, /__urlHasInvalidRuntimeRefs/);
  assert.match(script, /campaign_id/);
  assert.match(script, /\[skip\].*ToUpdateCampaign/);
  assert.match(script, /data\.vars\["campaign_id"\]/);
  assert.match(script, /__checkDependencyDeps\(data/);
});

test('token-shaped runtime vars are available when PER_VU login captured AUTH_TOKEN slot', () => {
  const parsed = parse(campaignChainCollection());
  const authFlow = buildAuthFlow(parsed);
  const script = generateK6Script(parsed, { authFlow, injectAuthToken: true, authSessionMode: 'PER_VU_LOGIN' });
  assert.match(script, /function __isTokenShapedVarName/);

  const start = script.indexOf('function __isTokenShapedVarName');
  const end = script.indexOf('function __checkDependencyDeps', start);
  const block = script.slice(start, end);
  const ctx = {
    __ENV: {},
    __getAuthState: () => ({
      AUTH_TOKEN: 'captured-token',
      ACCESS_TOKEN: '',
      JWT: '',
      ID_TOKEN: '',
      vars: {},
    }),
  };
  vm.createContext(ctx);
  vm.runInContext(block, ctx, { timeout: 1000 });
  assert.equal(ctx.__isRuntimeVarAvailable(ctx.__getAuthState(), 'access_token'), true);
  assert.equal(ctx.__isRuntimeVarAvailable(ctx.__getAuthState(), 'campaign_id'), false);
});

test('generated script does not emit literal /null or /undefined URL paths as static strings', () => {
  const parsed = parse(campaignChainCollection());
  const authFlow = buildAuthFlow(parsed);
  const script = generateK6Script(parsed, { authFlow });
  assert.doesNotMatch(script, /\/campaign\/null/);
  assert.doesNotMatch(script, /\/campaign\/undefined/);
});

test('AUTH_REJECTED classification does not imply token missing', () => {
  const analysis = buildFailureAnalysis(
    { failures: [] },
    [{ api: 'GET /secure', method: 'GET', count: 5, lastStatus: '401', authState: 'AUTH_REJECTED_BY_SERVER' }],
    { available: false, comparison: 'NOT_AVAILABLE' }
  );
  assert.equal(analysis[0].classification, 'AUTH_REJECTED');
  assert.match(analysis[0].reason, /token was present|rejected credentials/i);
});

test('Postman FAIL + Agent FAIL => SOURCE_API_FAILURE attribution when baseline matches', () => {
  const analysis = buildFailureAnalysis(
    { failures: [] },
    [{ api: 'CreateCTVCampaign', method: 'POST', count: 10, lastStatus: '400' }],
    { available: true, comparison: 'FAIL_MATCHES', source: 'postman' }
  );
  assert.equal(analysis[0].attribution, 'SOURCE_API_FAILURE');
  assert.match(analysis[0].sourceNote, /also fails in the source Postman/i);
});

test('Postman PASS + Agent FAIL => agent defect classification', () => {
  const analysis = buildFailureAnalysis(
    { failures: [] },
    [{ api: 'GET /items', method: 'GET', count: 3, lastStatus: '500' }],
    { available: true, comparison: 'PASS_AGENT_FAIL', source: 'postman' }
  );
  assert.equal(analysis[0].attribution, 'AGENT_GENERATION_OR_RUNTIME_DEFECT');
});

test('HTML chart data precedes drawing script and renders without overflow', () => {
  const report = buildNormalizedReport({
    parsed: {
      thresholds: [],
      summary: {
        requests: { total: 10, failed: 0, httpFailures: 0, transportFailures: 0 },
        responseTime: { p95: 100 },
      },
      timeseries: {
        bucketSeconds: 2,
        points: [
          { t: '2026-01-01T00:00:00Z', vus: 5, rps: 2, errors: 0, p95: 100 },
          { t: '2026-01-01T00:00:02Z', vus: 5, rps: 3, errors: 1, p95: 150 },
        ],
      },
      failures: [],
    },
    run: { runId: 'r1', status: 'completed', exitCode: 0 },
  });
  const html = renderReportHtml(report);
  const dataIdx = html.indexOf('id="chart-data"');
  const scriptIdx = html.indexOf('function drawLine');
  assert.ok(dataIdx > 0 && scriptIdx > dataIdx, 'chart-data must appear before drawLine');
  assert.match(html, /overflow-x:\s*hidden/);
  assert.match(html, /Failure analysis/);
  assert.match(html, /Dependency-skipped requests/);
});

test('isK6ExecutionSuccessful treats exit 99 with artifacts as successful execution', () => {
  assert.equal(
    isK6ExecutionSuccessful(
      { status: 'completed', exitCode: K6_THRESHOLD_EXIT_CODE },
      { summary: { requests: { total: 50 } }, thresholds: [{ metric: 'x' }] }
    ),
    true
  );
  assert.equal(isK6ExecutionSuccessful({ status: 'failed', exitCode: 1 }, {}), false);
});
