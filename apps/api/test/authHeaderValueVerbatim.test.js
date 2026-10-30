'use strict';

/**
 * Verbatim Authorization Header Value tests.
 *
 * The UI's "Authorization Header Value" field (payload: `authToken`)
 * routes to __ENV.AUTH_HEADER_VALUE. The K6 resolver must return that
 * value *exactly* — no Bearer handling, no scheme coercion, no trim.
 *
 * These assertions complement manualToken.integration.test.js (which
 * exercises the legacy AUTH_TOKEN channel's Bearer-normalization).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');

function collectionWithPlaceholder(placeholder) {
  return {
    info: { name: `verbatim ${placeholder}`, schema: 'v2.1' },
    item: [
      {
        name: 'Get',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: `{{${placeholder}}}` }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
}

function evaluateAuthHelpers(code, env = {}) {
  const wanted = [
    'function __normalizeBearer',
    'function __hasUnresolvedPlaceholder',
    'function __resolveAuthHeader',
    'function __resolveAuthHeaderEnv',
    'function __hasAnyAuth',
  ];
  function extract(src, sig) {
    const start = src.indexOf(sig);
    if (start < 0) return '';
    const braceStart = src.indexOf('{', start);
    if (braceStart < 0) return '';
    let depth = 0;
    for (let i = braceStart; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return '';
  }
  const blocks = ['function __getAuthState(data) { return data || {}; }'];
  if (/let __manualOverrideLogged = false;/.test(code)) {
    blocks.push('let __manualOverrideLogged = false;');
  }
  for (const sig of wanted) {
    const block = extract(code, sig);
    if (block) blocks.push(block);
  }
  const logs = [];
  const ctx = {
    __ENV: { ...env },
    console: {
      log: (...args) => logs.push(args.join(' ')),
      warn: () => {},
      error: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(blocks.join('\n\n'), ctx, { timeout: 1000 });
  return {
    resolveRuntime: ctx.__resolveAuthHeader,
    resolveEnvOnly: ctx.__resolveAuthHeaderEnv,
    hasAnyAuth: ctx.__hasAnyAuth,
    logs,
  };
}

function envOnlyCode(placeholder) {
  const parsed = sanitizeParsedCollection(parse(collectionWithPlaceholder(placeholder))).parsed;
  return generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
}

function runtimeCode(placeholder) {
  const collection = {
    info: { name: `runtime ${placeholder}`, schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{"u":"x"}' },
        },
      },
      {
        name: 'Protected',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: `{{${placeholder}}}` }],
          url: { raw: '{{baseUrl}}/protected' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  return generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
}

/* ---- Preservation table ---- */

const PRESERVATION_INPUTS = [
  'abc123',
  'Bearer abc123',
  'bearer abc123',
  'Basic abc123',
  'Bearer Bearer abc123',
];

for (const value of PRESERVATION_INPUTS) {
  test(`env-only: AUTH_HEADER_VALUE "${value}" is returned verbatim`, () => {
    const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('global_auth_token'), {
      AUTH_HEADER_VALUE: value,
    });
    assert.equal(
      resolveEnvOnly('Bearer collection-fallback', 'global_auth_token'),
      value,
      'resolver must preserve the exact header value'
    );
  });

  test(`runtime: AUTH_HEADER_VALUE "${value}" is returned verbatim`, () => {
    const { resolveRuntime } = evaluateAuthHelpers(runtimeCode('global_auth_token'), {
      AUTH_HEADER_VALUE: value,
    });
    // Even with runtime-captured tokens AND a legacy AUTH_TOKEN set, the
    // verbatim header value wins.
    const data = {
      AUTH_TOKEN: 'runtime-auth',
      ACCESS_TOKEN: 'runtime-access',
      JWT: 'runtime-jwt',
    };
    assert.equal(
      resolveRuntime(data, 'Bearer collection-fallback', 'global_auth_token'),
      value
    );
  });
}

/* ---- AUTH_HEADER_VALUE wins over AUTH_TOKEN (dual channel) ---- */
test('AUTH_HEADER_VALUE wins over AUTH_TOKEN when both set (env-only)', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: 'Basic xyz',
    AUTH_TOKEN: 'legacy-tok',
  });
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), 'Basic xyz');
});

test('AUTH_HEADER_VALUE wins over AUTH_TOKEN when both set (runtime)', () => {
  const { resolveRuntime } = evaluateAuthHelpers(runtimeCode('access_token'), {
    AUTH_HEADER_VALUE: 'Custom scheme=xyz',
    AUTH_TOKEN: 'legacy-tok',
  });
  assert.equal(
    resolveRuntime({ ACCESS_TOKEN: 'login-token' }, '', 'access_token'),
    'Custom scheme=xyz'
  );
});

/* ---- AUTH_HEADER_VALUE with unresolved placeholder is rejected ---- */
test('AUTH_HEADER_VALUE containing {{...}} is rejected (fallback branch runs)', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: 'Bearer {{token}}',
  });
  // Must NOT return the unresolved value. Fallback (also unresolved) → empty.
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), '');
});

/* ---- Scheme preservation: no Bearer-prefix auto-injection ---- */
test('a raw non-Bearer token is NOT prefixed with Bearer', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: 'abc123',
  });
  const out = resolveEnvOnly('Bearer irrelevant', 'token');
  assert.equal(out, 'abc123');
  assert.ok(!out.startsWith('Bearer '), 'resolver must not auto-prepend Bearer');
});

test('a "Bearer Bearer <tok>" value is NOT collapsed', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: 'Bearer Bearer abc123',
  });
  assert.equal(resolveEnvOnly('', 'token'), 'Bearer Bearer abc123');
});

test('a "bearer <tok>" value preserves lowercase scheme', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: 'bearer abc123',
  });
  assert.equal(resolveEnvOnly('', 'token'), 'bearer abc123');
});

/* ---- No raw-token leak in logs ---- */
test('resolver never logs the raw AUTH_HEADER_VALUE', () => {
  const raw = 'Bearer super-secret-verbatim-value-abcdef1234567890';
  const { resolveEnvOnly, logs } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_HEADER_VALUE: raw,
  });
  resolveEnvOnly('Bearer {{token}}', 'token');
  const joined = logs.join('\n');
  assert.ok(joined.length > 0);
  assert.ok(!joined.includes(raw), 'resolver leaked the raw header value');
});

/* ---- Legacy AUTH_TOKEN channel unchanged ---- */
test('legacy AUTH_TOKEN still receives Bearer prepending', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {
    AUTH_TOKEN: 'abc123',
  });
  // No AUTH_HEADER_VALUE, so legacy branch runs: Bearer is added once.
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), 'Bearer abc123');
});

/* ---- Non-manual path unchanged ---- */
test('with neither AUTH_HEADER_VALUE nor AUTH_TOKEN, env-defined collection value is preserved', () => {
  const { resolveEnvOnly } = evaluateAuthHelpers(envOnlyCode('token'), {});
  assert.equal(
    resolveEnvOnly('Bearer env-defined-token', 'token'),
    'Bearer env-defined-token'
  );
});
