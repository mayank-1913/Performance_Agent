'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { generateK6Script } = require('../src/lib/k6/generator');
const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');

/**
 * These tests prove the auth-resolution contract at runtime: the generated
 * K6 script's __resolveAuthHeader / __resolveAuthHeaderEnv functions are
 * extracted, evaluated in an isolated context with a synthetic __ENV / data,
 * and we assert their return values directly. Regex assertions on source
 * are not enough because the manual-override priority is the whole point.
 */

function evaluateHelpers(code, env = {}, data = {}) {
  // Extract just the helper definitions we care about. We don't need to
  // execute the iteration body or the K6-specific export. The helpers are
  // top-level `function ... { ... }` blocks plus a single `let` declaration
  // for the log-once flag.
  const wanted = [
    'function __normalizeBearer',
    'function __hasUnresolvedPlaceholder',
    'function __resolveAuthHeader',
    'function __resolveAuthHeaderEnv',
    'function __runtimeAuthHeader',
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
        if (depth === 0) {
          return src.slice(start, i + 1);
        }
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
  // Stub __ENV at module scope inside the VM.
  const harness = blocks.join('\n\n');

  const ctx = {
    __ENV: { ...env },
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
  };
  vm.createContext(ctx);
  vm.runInContext(harness, ctx, { timeout: 1000 });

  const resolveRuntime = ctx.__resolveAuthHeader;
  const resolveEnvOnly = ctx.__resolveAuthHeaderEnv;
  const normalize = ctx.__normalizeBearer;

  return {
    resolveRuntime: resolveRuntime
      ? (d, fb) => resolveRuntime(d == null ? data : d, fb)
      : null,
    resolveEnvOnly: resolveEnvOnly ? (fb) => resolveEnvOnly(fb) : null,
    normalize,
  };
}

function makeRuntimeScript() {
  const collection = {
    info: { name: 'auth runtime priority', schema: 'v2.1' },
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
        name: 'Get profile',
        request: {
          method: 'GET',
          // Non-standard placeholder name — the whole point of the new flow.
          header: [{ key: 'Authorization', value: 'Bearer {{global_auth_token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  return generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
}

function makeEnvOnlyScript() {
  const collection = {
    info: { name: 'env only priority', schema: 'v2.1' },
    item: [
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [
            { key: 'Authorization', value: 'Bearer {{custom_session_token}}' },
          ],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  return generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
}

test('runtime resolver: manual __ENV.AUTH_TOKEN overrides every placeholder name', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, { AUTH_TOKEN: 'manual-xyz' });
  assert.ok(resolveRuntime, '__resolveAuthHeader must be emitted for runtime mode');

  // Manual token wins over a runtime-captured token.
  const out = resolveRuntime(
    { AUTH_TOKEN: 'runtime-extracted', ACCESS_TOKEN: 'runtime-access' },
    'Bearer {{global_auth_token}}'
  );
  assert.equal(out, 'Bearer manual-xyz');
});

test('runtime resolver: Bearer prefix on manual token is normalized once', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, {
    AUTH_TOKEN: 'Bearer Bearer pasted-token',
  });
  const out = resolveRuntime({}, '');
  assert.equal(out, 'Bearer pasted-token');
});

test('runtime resolver: when no manual token, runtime-captured token wins over fallback', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, {});
  const out = resolveRuntime(
    { ACCESS_TOKEN: 'rt-access' },
    'Bearer {{global_auth_token}}'
  );
  assert.equal(out, 'Bearer rt-access');
});

test('runtime resolver: unresolved {{placeholder}} fallback is dropped (no Bearer {{xxx}} on wire)', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, {});
  const out = resolveRuntime({}, 'Bearer {{global_auth_token}}');
  assert.equal(out, '');
});

test('runtime resolver: resolved fallback is preserved (collection placeholder still works)', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, {});
  // The interpolator already replaces {{x}} with __ENV.X, so a "resolved"
  // fallback looks like a literal Bearer string at runtime.
  const out = resolveRuntime({}, 'Bearer collection-token');
  assert.equal(out, 'Bearer collection-token');
});

test('env-only resolver: manual __ENV.AUTH_TOKEN beats a non-standard placeholder', () => {
  const code = makeEnvOnlyScript();
  const { resolveEnvOnly } = evaluateHelpers(code, { AUTH_TOKEN: 'manual-tok' });
  assert.ok(resolveEnvOnly, '__resolveAuthHeaderEnv must be emitted in env-only mode');
  const out = resolveEnvOnly('Bearer {{custom_session_token}}');
  assert.equal(out, 'Bearer manual-tok');
});

test('env-only resolver: empty manual token + unresolved placeholder yields empty header', () => {
  const code = makeEnvOnlyScript();
  const { resolveEnvOnly } = evaluateHelpers(code, {});
  const out = resolveEnvOnly('Bearer {{custom_session_token}}');
  assert.equal(out, '');
});

test('env-only resolver: empty manual token + resolved fallback uses fallback as-is', () => {
  const code = makeEnvOnlyScript();
  const { resolveEnvOnly } = evaluateHelpers(code, {});
  const out = resolveEnvOnly('Bearer real-collection-token');
  assert.equal(out, 'Bearer real-collection-token');
});

test('env-only resolver: re-normalizes a fallback that already starts with Bearer', () => {
  const code = makeEnvOnlyScript();
  const { resolveEnvOnly } = evaluateHelpers(code, {});
  // Edge case: collection variable accidentally carries the Bearer prefix.
  const out = resolveEnvOnly('Bearer Bearer ABC');
  assert.equal(out, 'Bearer ABC');
});

test('env-only resolver: a lone "Bearer" with no token yields empty header', () => {
  const code = makeEnvOnlyScript();
  const { resolveEnvOnly } = evaluateHelpers(code, {});
  const out = resolveEnvOnly('Bearer    ');
  assert.equal(out, '');
});

test('runtime resolver: priority holds across many placeholder name variants', () => {
  const code = makeRuntimeScript();
  const { resolveRuntime } = evaluateHelpers(code, { AUTH_TOKEN: 'lock' });
  const fallbacks = [
    'Bearer {{jwt_token}}',
    'Bearer {{global_auth_token}}',
    'Bearer {{access_token}}',
    'Bearer {{token}}',
    'Bearer {{sessionToken}}',
    'Bearer {{CompanyXYZ_AccessToken_v2}}',
  ];
  for (const fb of fallbacks) {
    const out = resolveRuntime(
      { AUTH_TOKEN: 'rt-1', ACCESS_TOKEN: 'rt-2', JWT: 'rt-3', ID_TOKEN: 'rt-4' },
      fb
    );
    assert.equal(
      out,
      'Bearer lock',
      'manual override must win for fallback: ' + fb
    );
  }
});


/**
 * THE bug-fix smoke test. The collection uses Bearer {{jwt_token}} (with no
 * matching __ENV.JWT_TOKEN), and the user provides ONLY a manual AUTH_TOKEN
 * via the UI. Without the fix, the previously-generated script emitted
 * Authorization: Bearer ${__ENV.JWT_TOKEN} → "Bearer undefined" → 401.
 *
 * The fix makes BOTH layers cooperate:
 *   1) The interpolator falls back to __ENV.AUTH_TOKEN inside the template.
 *   2) The resolver wrapper short-circuits to the manual token when set.
 */
test('regression: Bearer {{jwt_token}} resolves to manual AUTH_TOKEN when only AUTH_TOKEN is set', () => {
  const collection = {
    info: { name: 'jwt-only collection', schema: 'v2.1' },
    item: [
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{jwt_token}}' }],
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

  // 1) The Authorization header for {{jwt_token}} uses the resolver and the
  //    inner template consults __ENV.AUTH_TOKEN before __ENV.JWT_TOKEN.
  assert.match(
    code,
    /__resolveAuthHeaderEnv\(`Bearer \$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''\)\}`, "jwt_token"\)/
  );

  // 2) Runtime check: with ONLY __ENV.AUTH_TOKEN set, calling the resolver
  //    on the Bearer-templated fallback returns Bearer <manual>. (The
  //    template can't be evaluated standalone but the resolver short-circuit
  //    happens before the fallback is consulted.)
  const { resolveEnvOnly } = evaluateHelpers(code, { AUTH_TOKEN: 'manual-jwt' });
  // Even if the template were rendered (Bearer "undefined" / empty), the
  // resolver must short-circuit to the manual override:
  assert.equal(resolveEnvOnly('Bearer undefined', 'jwt_token'), 'Bearer manual-jwt');
  assert.equal(resolveEnvOnly('Bearer ', 'jwt_token'), 'Bearer manual-jwt');
  assert.equal(resolveEnvOnly('', 'jwt_token'), 'Bearer manual-jwt');
});

test('regression: collection with multiple non-standard token placeholders all resolve to manual override', () => {
  const collection = {
    info: { name: 'mixed token names', schema: 'v2.1' },
    item: [
      {
        name: 'a',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/a' },
        },
      },
      {
        name: 'b',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{global_auth_token}}' }],
          url: { raw: '{{baseUrl}}/b' },
        },
      },
      {
        name: 'c',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: '{{baseUrl}}/c' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });

  // Every placeholder consults __ENV.AUTH_TOKEN before its own env var.
  assert.match(code, /__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''/);
  assert.match(code, /__ENV\.AUTH_TOKEN \|\| __ENV\.GLOBAL_AUTH_TOKEN \|\| ''/);
  assert.match(code, /__ENV\.AUTH_TOKEN \|\| __ENV\.ACCESS_TOKEN \|\| ''/);

  // And the resolver always returns the manual override regardless.
  const { resolveEnvOnly } = evaluateHelpers(code, { AUTH_TOKEN: 'lock' });
  for (const fb of [
    'Bearer ${__ENV.JWT_TOKEN}',
    'Bearer ${__ENV.GLOBAL_AUTH_TOKEN}',
    'Bearer ${__ENV.ACCESS_TOKEN}',
    '',
    'Bearer undefined',
  ]) {
    assert.equal(resolveEnvOnly(fb), 'Bearer lock', 'manual override must win for: ' + fb);
  }
});

test('regression: token-shaped placeholder OUTSIDE Authorization header still falls back to AUTH_TOKEN', () => {
  // Some collections embed the token in a custom header (X-Auth-Token) or
  // even in the URL/body. The interpolator-level fallback ensures
  // __ENV.AUTH_TOKEN is the ultimate fallback for ANY token-shaped name,
  // even when the resolver wrapper isn't in play.
  const collection = {
    info: { name: 'custom token header', schema: 'v2.1' },
    item: [
      {
        name: 'a',
        request: {
          method: 'GET',
          header: [{ key: 'X-Auth-Token', value: '{{jwt_token}}' }],
          url: { raw: '{{baseUrl}}/a' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  // The X-Auth-Token header now reads
  //   ${(__ENV.AUTH_TOKEN || __ENV.JWT_TOKEN || '')}
  // so a manual override flows through even outside Authorization.
  assert.match(code, /\$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.JWT_TOKEN \|\| ''\)\}/);
});

test('regression: non-token placeholders use __coalesceVar to avoid literal "undefined"', () => {
  const collection = {
    info: { name: 'plain base url', schema: 'v2.1' },
    item: [
      {
        name: 'a',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/a' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const code = generateK6Script(parsed, { authFlow: { enabled: false } });
  assert.match(code, /\$\{__coalesceVar\("baseUrl", __ENV\.BASE_URL\)\}/);
  // And the bare unwrapped form must NOT appear.
  assert.doesNotMatch(code, /`\$\{__ENV\.BASE_URL\}/);
});
