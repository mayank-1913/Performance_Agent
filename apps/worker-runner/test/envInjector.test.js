'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildK6Env, normalizeBearer } = require('../src/envInjector');

test('buildK6Env forwards every user-provided env key as a manual override', () => {
  const out = buildK6Env({
    expectedEnvVars: ['BASE_URL'],
    env: { BASE_URL: 'https://api.example.com', OPTICKS_BASE_URL: 'https://opt.example.com' },
    secrets: {},
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.BASE_URL, 'https://api.example.com');
  // Keys not in expectedEnvVars must still flow through — the user typing them
  // counts as a locked override.
  assert.equal(out.envMap.OPTICKS_BASE_URL, 'https://opt.example.com');
  assert.deepEqual(
    out.manualOverrides.sort(),
    ['BASE_URL', 'OPTICKS_BASE_URL'].sort()
  );
});

test('buildK6Env normalizes Bearer prefix on AUTH_TOKEN and JWT_TOKEN', () => {
  const out = buildK6Env({
    expectedEnvVars: ['AUTH_TOKEN'],
    secrets: { AUTH_TOKEN: 'Bearer eyJabc', JWT_TOKEN: 'Bearer Bearer eyJjwt' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.AUTH_TOKEN, 'eyJabc');
  assert.equal(out.envMap.JWT_TOKEN, 'eyJjwt');
  assert.deepEqual(out.bearerNormalized.sort(), ['AUTH_TOKEN', 'JWT_TOKEN']);
});

test('buildK6Env keeps API_KEY, SESSION_ID, HOST_PATH from manual secrets', () => {
  const out = buildK6Env({
    expectedEnvVars: [],
    secrets: {
      API_KEY: 'k-123',
      SESSION_ID: 'sess-1',
      HOST_PATH: 'https://h.example.com',
    },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.API_KEY, 'k-123');
  assert.equal(out.envMap.SESSION_ID, 'sess-1');
  assert.equal(out.envMap.HOST_PATH, 'https://h.example.com');
  // Manual overrides surface every key the user explicitly provided.
  assert.deepEqual(
    out.manualOverrides.sort(),
    ['API_KEY', 'HOST_PATH', 'SESSION_ID']
  );
});

test('buildK6Env never lets the user clobber PATH or other passthrough keys', () => {
  const out = buildK6Env({
    expectedEnvVars: [],
    env: { PATH: '/totally/wrong/path' },
    parentEnv: { PATH: '/correct/path' },
  });
  assert.equal(out.envMap.PATH, '/correct/path');
  assert.deepEqual(out.manualOverrides, []);
});

test('buildK6Env drops empty values', () => {
  const out = buildK6Env({
    expectedEnvVars: ['BASE_URL'],
    env: { BASE_URL: '' },
    secrets: { AUTH_TOKEN: '' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.BASE_URL, undefined);
  assert.equal(out.envMap.AUTH_TOKEN, undefined);
  assert.deepEqual(out.manualOverrides, []);
});

test('buildK6Env: AUTH_TOKEN containing only "Bearer " is treated as empty', () => {
  const out = buildK6Env({
    expectedEnvVars: ['AUTH_TOKEN'],
    secrets: { AUTH_TOKEN: 'Bearer    ' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.AUTH_TOKEN, undefined);
  assert.deepEqual(out.manualOverrides, []);
});

test('normalizeBearer strips repeated prefixes', () => {
  assert.equal(normalizeBearer('Bearer Bearer Bearer abc'), 'abc');
});


test('buildK6Env: manual AUTH_TOKEN is mirrored into common token-shaped env keys', () => {
  // The collection might use {{jwt_token}}, {{access_token}}, etc. The mirror
  // ensures AUTH_TOKEN flows into all of them so any K6 script reading
  // __ENV.JWT_TOKEN directly still picks up the manual override.
  const out = buildK6Env({
    expectedEnvVars: ['JWT_TOKEN', 'ACCESS_TOKEN'],
    secrets: { AUTH_TOKEN: 'pasted-jwt' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.AUTH_TOKEN, 'pasted-jwt');
  assert.equal(out.envMap.JWT_TOKEN, 'pasted-jwt');
  assert.equal(out.envMap.ACCESS_TOKEN, 'pasted-jwt');
  assert.equal(out.envMap.TOKEN, 'pasted-jwt');
  assert.equal(out.envMap.BEARER_TOKEN, 'pasted-jwt');
  assert.equal(out.envMap.ID_TOKEN, 'pasted-jwt');
  // The mirror should report which keys were filled.
  assert.ok(out.tokenMirroredKeys.includes('JWT_TOKEN'));
  assert.ok(out.tokenMirroredKeys.includes('ACCESS_TOKEN'));
  assert.ok(out.tokenMirroredKeys.includes('TOKEN'));
});

test('buildK6Env: AUTH_TOKEN mirror picks up custom token-shaped expectedEnvVars', () => {
  // Collection-specific names like {{global_auth_token}} -> GLOBAL_AUTH_TOKEN
  // become expected vars; the mirror should target them too without us
  // hard-coding the name.
  const out = buildK6Env({
    expectedEnvVars: ['GLOBAL_AUTH_TOKEN', 'CUSTOM_JWT_V2'],
    secrets: { AUTH_TOKEN: 'pasted' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.GLOBAL_AUTH_TOKEN, 'pasted');
  assert.equal(out.envMap.CUSTOM_JWT_V2, 'pasted');
  assert.ok(out.tokenMirroredKeys.includes('GLOBAL_AUTH_TOKEN'));
  assert.ok(out.tokenMirroredKeys.includes('CUSTOM_JWT_V2'));
});

test('buildK6Env: explicit JWT_TOKEN override wins over the AUTH_TOKEN mirror', () => {
  const out = buildK6Env({
    expectedEnvVars: ['JWT_TOKEN'],
    secrets: { AUTH_TOKEN: 'auth-tok', JWT_TOKEN: 'jwt-tok' },
    parentEnv: { PATH: '/x' },
  });
  // User explicitly typed JWT_TOKEN — the mirror MUST NOT clobber it.
  assert.equal(out.envMap.JWT_TOKEN, 'jwt-tok');
  // AUTH_TOKEN is unchanged.
  assert.equal(out.envMap.AUTH_TOKEN, 'auth-tok');
  // tokenMirroredKeys reflects the keys actually mirrored — JWT_TOKEN should
  // NOT be in there because the user set it explicitly.
  assert.equal(out.tokenMirroredKeys.includes('JWT_TOKEN'), false);
});

test('buildK6Env: SESSION/KEY-shaped names are NOT mirrored (different slots)', () => {
  const out = buildK6Env({
    expectedEnvVars: ['SESSION_ID', 'API_KEY'],
    secrets: { AUTH_TOKEN: 'auth-tok' },
    parentEnv: { PATH: '/x' },
  });
  // Mirror must not leak AUTH_TOKEN into SESSION/KEY slots.
  assert.equal(out.envMap.SESSION_ID, undefined);
  assert.equal(out.envMap.API_KEY, undefined);
  assert.equal(out.tokenMirroredKeys.includes('SESSION_ID'), false);
  assert.equal(out.tokenMirroredKeys.includes('API_KEY'), false);
});

test('buildK6Env: no mirror when AUTH_TOKEN is not provided', () => {
  const out = buildK6Env({
    expectedEnvVars: ['JWT_TOKEN'],
    env: { BASE_URL: 'https://api.example.com' },
    parentEnv: { PATH: '/x' },
  });
  assert.equal(out.envMap.JWT_TOKEN, undefined);
  assert.deepEqual(out.tokenMirroredKeys, []);
});

test('buildK6Env: Bearer prefix on AUTH_TOKEN is stripped before mirroring', () => {
  const out = buildK6Env({
    expectedEnvVars: ['JWT_TOKEN', 'ACCESS_TOKEN'],
    secrets: { AUTH_TOKEN: 'Bearer Bearer eyJpasted' },
    parentEnv: { PATH: '/x' },
  });
  // Mirror copies the normalized (Bearer-stripped) value, not the raw input.
  assert.equal(out.envMap.AUTH_TOKEN, 'eyJpasted');
  assert.equal(out.envMap.JWT_TOKEN, 'eyJpasted');
  assert.equal(out.envMap.ACCESS_TOKEN, 'eyJpasted');
});
