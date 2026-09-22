'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  AUTH_SESSION_MODES,
  resolveAuthSessionMode,
  normalizeAuthSessionConfig,
} = require('../src/lib/k6/authSessionMode');
const { deriveAuthStrategy, AuthStrategy, generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { normalizeWorkload } = require('../src/lib/k6/workloadProfiles');

test('resolveAuthSessionMode defaults to SHARED_SESSION when auth flow enabled', () => {
  assert.equal(
    resolveAuthSessionMode({ authFlowEnabled: true }),
    AUTH_SESSION_MODES.SHARED_SESSION
  );
});

test('resolveAuthSessionMode defaults to MANUAL_TOKEN when injectAuthToken without flow', () => {
  assert.equal(
    resolveAuthSessionMode({ injectAuthToken: true, authFlowEnabled: false }),
    AUTH_SESSION_MODES.MANUAL_TOKEN
  );
});

test('deriveAuthStrategy maps PER_VU_LOGIN to PER_VU_LOGIN strategy', () => {
  assert.equal(
    deriveAuthStrategy({
      runtimeEnabled: true,
      authSessionMode: 'PER_VU_LOGIN',
    }),
    AuthStrategy.PER_VU_LOGIN
  );
});

test('deriveAuthStrategy maps MANUAL_TOKEN to STATIC', () => {
  assert.equal(
    deriveAuthStrategy({
      runtimeEnabled: true,
      authSessionMode: 'MANUAL_TOKEN',
    }),
    AuthStrategy.STATIC
  );
});

test('generator emits PER_VU_LOGIN helpers and no shared setup()', () => {
  const collection = {
    info: { name: 'per-vu', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/login' },
          body: { mode: 'raw', raw: '{"username":"u","password":"p"}' },
        },
      },
      {
        name: 'Protected',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: '{{baseUrl}}/protected' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  const workload = normalizeWorkload(
    { profile: 'smoke', authSessionMode: 'PER_VU_LOGIN' },
    { authFlowEnabled: true, injectAuthToken: false }
  );
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: flow,
    workload,
    authSessionMode: 'PER_VU_LOGIN',
  });
  assert.match(code, /AUTH_SESSION_MODE = "PER_VU_LOGIN"/);
  assert.match(code, /function __ensureVuLogin\(/);
  assert.match(code, /function __getAuthState\(/);
  assert.doesNotMatch(code, /export function setup\(\)/);
  assert.match(code, /__getAuthState\(data\)/);
});

test('generator SHARED_SESSION still emits setup()', () => {
  const collection = {
    info: { name: 'shared', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          url: { raw: '{{baseUrl}}/login' },
          body: { mode: 'raw', raw: '{}' },
        },
      },
      {
        name: 'Protected',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: '{{baseUrl}}/protected' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  const workload = normalizeWorkload(
    { profile: 'smoke', authSessionMode: 'SHARED_SESSION' },
    { authFlowEnabled: true }
  );
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: flow,
    workload,
    authSessionMode: 'SHARED_SESSION',
  });
  assert.match(code, /AUTH_SESSION_MODE = "SHARED_SESSION"/);
  assert.match(code, /export function setup\(\)/);
});
