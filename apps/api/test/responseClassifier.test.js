'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyResponse,
  isTransportErrorCode,
} = require('../src/lib/k6/responseClassifier');

test('response classifier matrix: HTTP statuses are unexpected_status, not transport', () => {
  const cases = [
    { status: 200, error_code: 0, expected: 'ok' },
    { status: 201, error_code: 0, expected: 'ok' },
    { status: 400, error_code: 1400, expected: 'unexpected_status' },
    { status: 401, error_code: 1401, expected: 'unexpected_status' },
    { status: 404, error_code: 1404, expected: 'unexpected_status' },
    { status: 500, error_code: 1500, expected: 'unexpected_status' },
  ];
  for (const c of cases) {
    assert.equal(classifyResponse({ status: c.status, error_code: c.error_code }), c.expected);
  }
});

test('response classifier matrix: transport failures', () => {
  assert.equal(classifyResponse({ status: 0, error_code: 1101 }), 'transport_failure');
  assert.equal(classifyResponse(null), 'transport_failure');
  assert.equal(classifyResponse({ status: 0, error_code: 1210 }), 'transport_failure');
  assert.equal(classifyResponse({ status: 0, error_code: 1301 }), 'transport_failure');
});

test('isTransportErrorCode treats k6 14xx as HTTP, not transport', () => {
  assert.equal(isTransportErrorCode(1401), false);
  assert.equal(isTransportErrorCode('1404'), false);
  assert.equal(isTransportErrorCode(1101), true);
  assert.equal(isTransportErrorCode(1210), true);
});
