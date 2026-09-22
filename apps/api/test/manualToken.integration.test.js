'use strict';

/**
 * Phase 2 integration tests.
 *
 * Generates a K6 script from a synthetic Postman collection that uses an
 * arbitrary token placeholder name, then executes the emitted auth helpers
 * inside a Node VM with a controlled __ENV / data. Asserts the observable
 * behavior at the seam K6 will actually use at request time.
 *
 * Placeholders exercised here:
 *   {{token}}   {{access_token}}   {{jwt}}   {{jwt_token}}
 *   {{global_auth_token}}   {{custom_jwt_token}}   {{myAccessToken}}
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');

/* ------------------------------------------------------------------ */

function collectionWithPlaceholder(placeholder) {
  return {
    info: { name: `integ ${placeholder}`, schema: 'v2.1' },
    item: [
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: `Bearer {{${placeholder}}}` }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
}

function collectionWithLoginAndProtected(placeholder) {
  return {
    info: { name: `integ login+${placeholder}`, schema: 'v2.1' },
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
          header: [{ key: 'Authorization', value: `Bearer {{${placeholder}}}` }],
          url: { raw: '{{baseUrl}}/protected' },
        },
      },
    ],
  };
}

/** Extract the emitted auth helpers and evaluate them in an isolated VM. */
function evaluateAuthHelpers(code, env = {}) {
  const wanted = [
    'function __normalizeBearer',
    'function __hasUnresolvedPlaceholder',
    'function __resolveAuthHeader',
    'function __resolveAuthHeaderEnv',
    'function __runtimeAuthHeader',
    'function __hasAnyAuth',
  ];

  function extractFunction(src, signature) {
    const start = src.indexOf(signature);
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
    const block = extractFunction(code, sig);
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
  const collection = collectionWithPlaceholder(placeholder);
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  return generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
}

function runtimeCode(placeholder) {
  const collection = collectionWithLoginAndProtected(placeholder);
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  return generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
}

test('auth diagnostic matches every effective auth source', () => {
  const auth = evaluateAuthHelpers(runtimeCode('global_auth_token'));
  assert.equal(auth.hasAnyAuth({ vars: { global_auth_token: 'captured' } }, ''), true);
  assert.equal(auth.hasAnyAuth({ ACCESS_TOKEN: 'runtime' }, ''), true);
  assert.equal(auth.hasAnyAuth({ AUTH_TOKEN: 'runtime' }, ''), true);
  const envAuth = evaluateAuthHelpers(runtimeCode('token'), { GLOBAL_AUTH_TOKEN: 'environment' });
  assert.equal(envAuth.hasAnyAuth({}, ''), true);
  assert.equal(auth.hasAnyAuth({}, 'Bearer collection-fallback'), true);
  assert.equal(auth.hasAnyAuth({}, ''), false);
});

/* ------------------------------------------------------------------ */
/*  Requirement 10: manual token works with every placeholder name     */
/* ------------------------------------------------------------------ */

const PLACEHOLDERS = [
  'token',
  'access_token',
  'jwt',
  'jwt_token',
  'global_auth_token',
  'custom_jwt_token',
  'myAccessToken',
];

for (const placeholder of PLACEHOLDERS) {
  test(`env-only: manual AUTH_TOKEN overrides Bearer {{${placeholder}}}`, () => {
    const code = envOnlyCode(placeholder);
    const { resolveEnvOnly } = evaluateAuthHelpers(code, {
      AUTH_TOKEN: 'manual-tok',
    });
    // The interpolated fallback (rendered by the interpolator) will look
    // like `Bearer ${(__ENV.<PLACEHOLDER> || __ENV.AUTH_TOKEN || '')}` but
    // for VM evaluation we pass a synthetic string. Any of these fallback
    // shapes must yield "Bearer manual-tok":
    const fallbacks = [
      `Bearer {{${placeholder}}}`,
      `Bearer undefined`,
      `Bearer `,
      ``,
      `Bearer some-old-collection-token`,
    ];
    for (const fb of fallbacks) {
      const out = resolveEnvOnly(fb, placeholder);
      assert.equal(
        out,
        'Bearer manual-tok',
        `manual override failed for placeholder=${placeholder}, fallback="${fb}"`
      );
    }
  });

  test(`runtime: manual AUTH_TOKEN overrides Bearer {{${placeholder}}} even when login captured a different token`, () => {
    const code = runtimeCode(placeholder);
    const { resolveRuntime } = evaluateAuthHelpers(code, {
      AUTH_TOKEN: 'manual-lock',
    });
    // Populate every runtime slot the resolver checks. Manual must still win.
    const data = {
      AUTH_TOKEN: 'runtime-auth',
      ACCESS_TOKEN: 'runtime-access',
      JWT: 'runtime-jwt',
      ID_TOKEN: 'runtime-id',
    };
    const out = resolveRuntime(data, `Bearer {{${placeholder}}}`, placeholder);
    assert.equal(out, 'Bearer manual-lock');
  });
}

/* ------------------------------------------------------------------ */
/*  Requirement 11: environment token still works without a manual token */
/* ------------------------------------------------------------------ */
test('env-only: environment-supplied placeholder value still works when manual is absent', () => {
  // With no __ENV.AUTH_TOKEN, the interpolator falls back to
  // __ENV.<PLACEHOLDER>. To simulate the interpolated fallback we pass a
  // resolved literal Bearer header — the resolver must preserve it.
  const code = envOnlyCode('access_token');
  const { resolveEnvOnly } = evaluateAuthHelpers(code, {});
  const out = resolveEnvOnly('Bearer env-supplied-token', 'access_token');
  assert.equal(out, 'Bearer env-supplied-token');
});

/* ------------------------------------------------------------------ */
/*  Requirement 12: runtime login-captured token works without manual  */
/* ------------------------------------------------------------------ */
test('runtime: login-captured token is used when manual is absent', () => {
  const code = runtimeCode('access_token');
  const { resolveRuntime } = evaluateAuthHelpers(code, {});
  const out = resolveRuntime(
    { ACCESS_TOKEN: 'captured-at-login' },
    'Bearer {{access_token}}',
    'access_token'
  );
  assert.equal(out, 'Bearer captured-at-login');
});

/* ------------------------------------------------------------------ */
/*  Requirement 13: manual wins when both env and login token exist    */
/* ------------------------------------------------------------------ */
test('runtime: manual token wins even when both environment and login token are present', () => {
  const code = runtimeCode('access_token');
  const { resolveRuntime } = evaluateAuthHelpers(code, {
    AUTH_TOKEN: 'manual-abc',
    ACCESS_TOKEN: 'env-access',
  });
  const out = resolveRuntime(
    { ACCESS_TOKEN: 'login-captured' },
    'Bearer env-access',
    'access_token'
  );
  assert.equal(out, 'Bearer manual-abc');
});

/* ------------------------------------------------------------------ */
/*  Requirement 6: Bearer Bearer / Bearer undefined / Bearer {{token}} */
/*  / Authorization duplication                                        */
/* ------------------------------------------------------------------ */

test('Bearer Bearer prefixes collapse to a single Bearer', () => {
  const code = envOnlyCode('token');
  const { resolveEnvOnly } = evaluateAuthHelpers(code, {
    AUTH_TOKEN: 'Bearer Bearer abc123',
  });
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), 'Bearer abc123');
});

test('manual token value "undefined" is rejected — no "Bearer undefined" on the wire', () => {
  const code = envOnlyCode('token');
  // With env fallback also empty, output must be empty (never Bearer undefined).
  const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'undefined' });
  assert.equal(resolveEnvOnly('Bearer undefined', 'token'), '');
});

test('manual token value "null" is rejected', () => {
  const code = envOnlyCode('token');
  const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'null' });
  assert.equal(resolveEnvOnly('', 'token'), '');
});

test('manual token containing an unresolved Postman placeholder is rejected', () => {
  const code = envOnlyCode('token');
  const { resolveEnvOnly } = evaluateAuthHelpers(code, {
    AUTH_TOKEN: 'Bearer {{token}}',
  });
  // Fall through to the fallback path. When the fallback itself is
  // unresolved we still emit empty (not "Bearer {{token}}").
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), '');
});

test('lone "Bearer" as manual token is rejected', () => {
  const code = envOnlyCode('token');
  const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'Bearer' });
  assert.equal(resolveEnvOnly('Bearer collection-tok', 'token'), 'Bearer collection-tok');
});

test('Authorization header duplication: a second Authorization header is dropped from the emitted request', () => {
  // Postman occasionally exports two Authorization headers on the same
  // request (usually from a stale copy). The generator must emit exactly
  // one — routed through the resolver — otherwise the second, unrouted
  // one silently wins because JS object literals coalesce on the last key.
  const collection = {
    info: { name: 'dup-auth', schema: 'v2.1' },
    item: [
      {
        name: 'Get',
        request: {
          method: 'GET',
          header: [
            { key: 'Authorization', value: 'Bearer {{token}}' },
            { key: 'Authorization', value: 'Bearer legacy-stale-value' },
          ],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  // Only one Authorization key in the emitted headers block, and it must
  // be the resolver-routed form.
  const matches = code.match(/\.\.\.__authHeader\(/g) || [];
  assert.equal(matches.length, 1, 'expected exactly one Authorization resolver, got ' + matches.length);
  assert.match(code, /\.\.\.__authHeader\(__resolveAuthHeaderEnv\(/);
  // The stale literal value must be absent.
  assert.doesNotMatch(code, /legacy-stale-value/);
});

/* ------------------------------------------------------------------ */
/*  Requirement 8: never log the raw token                             */
/* ------------------------------------------------------------------ */
test('the resolver never logs the raw manual token, only metadata', () => {
  const code = envOnlyCode('token');
  const rawToken = 'ultra-secret-value-do-not-leak-abcdef1234567890';
  const { resolveEnvOnly, logs } = evaluateAuthHelpers(code, {
    AUTH_TOKEN: rawToken,
  });
  resolveEnvOnly('Bearer {{token}}', 'token');
  const joined = logs.join('\n');
  assert.ok(joined.length > 0, 'resolver should log at least the override event');
  assert.ok(!joined.includes(rawToken), 'resolver leaked the raw token: ' + joined);
});

/* ------------------------------------------------------------------ */
/*  Requirement 5: manual token works whether or not an Authorization  */
/*  header exists, and whether or not the placeholder is standard      */
/* ------------------------------------------------------------------ */
test('no Authorization header on the request: injected Authorization uses the manual token', () => {
  // The collection request has no Authorization header at all; the
  // generator injects one because injectAuthToken=true. The injected
  // header must still resolve to the manual token.
  const collection = {
    info: { name: 'no-auth-header', schema: 'v2.1' },
    item: [
      {
        name: 'GetPublic',
        request: {
          method: 'GET',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/thing' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  assert.match(code, /\.\.\.__authHeader\(__resolveAuthHeaderEnv\(``\)\)/);
  const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'inject-me' });
  assert.equal(resolveEnvOnly('', undefined), 'Bearer inject-me');
});

test('token-shaped placeholder in a CUSTOM auth header (X-Auth-Token) still receives the manual override', () => {
  const collection = {
    info: { name: 'custom-auth-header', schema: 'v2.1' },
    item: [
      {
        name: 'Get',
        request: {
          method: 'GET',
          header: [{ key: 'X-Auth-Token', value: '{{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  // The interpolator emits `${(__ENV.JWT_TOKEN || __ENV.AUTH_TOKEN || '')}`,
  // so the manual token reaches the wire even outside Authorization.
  assert.match(code, /"X-Auth-Token":\s*`\$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''\)\}`/);
});
