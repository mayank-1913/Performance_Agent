'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_REQUEST_TIMEOUT,
  durationToMs,
  msToDuration,
  extractPostmanRequestTimeoutMs,
  buildTimeoutCodegen,
  buildTimeoutMetadata,
} = require('../src/lib/k6/requestTimeout');

test('default timeout is 120s not 30s', () => {
  assert.equal(DEFAULT_REQUEST_TIMEOUT, '120s');
});

test('durationToMs and msToDuration round-trip', () => {
  assert.equal(durationToMs('120s'), 120_000);
  assert.equal(durationToMs('45000ms'), 45_000);
  assert.equal(msToDuration(45_000), '45s');
});

test('extractPostmanRequestTimeoutMs reads request timeout fields', () => {
  assert.equal(extractPostmanRequestTimeoutMs({ timeout: 45000 }), 45_000);
  assert.equal(
    extractPostmanRequestTimeoutMs({ protocolProfileBehavior: { requestTimeout: '60s' } }),
    60_000
  );
  assert.equal(extractPostmanRequestTimeoutMs({}), null);
});

test('buildTimeoutCodegen emits resolver with precedence', () => {
  const { codegen, metadata } = buildTimeoutCodegen(
    [{ requestId: 'req_01', timeoutMs: 45_000 }],
    null
  );
  assert.match(codegen, /DEFAULT_REQUEST_TIMEOUT = "120s"/);
  assert.match(codegen, /function __requestTimeout/);
  assert.match(codegen, /"req_01":"45s"/);
  assert.equal(metadata.defaultTimeout, '120s');
  assert.equal(metadata.gracefulStop, '120s');
});

test('buildTimeoutMetadata documents precedence chain', () => {
  const meta = buildTimeoutMetadata({ requests: [], agentDefault: null });
  assert.ok(Array.isArray(meta.precedence));
  assert.equal(meta.precedence[0], 'postman_per_request');
  assert.equal(meta.documentedDefault, '120s');
});
