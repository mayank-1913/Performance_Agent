'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { parse } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');
const { buildAuthFlow, collectRuntimeCapturedVarNames } = require('../src/lib/postman/authFlow');
const { generateK6Script } = require('../src/lib/k6/generator');

/** Evaluate emitted auth helpers in an isolated VM (env-only path). */
function evaluateAuthHelpers(code, env = {}) {
  const wanted = [
    'function __normalizeBearer',
    'function __hasUnresolvedPlaceholder',
    'function __resolveAuthHeaderEnv',
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

  const blocks = [];
  if (/let __manualOverrideLogged = false;/.test(code)) {
    blocks.push('let __manualOverrideLogged = false;');
  }
  for (const sig of wanted) {
    const block = extractFunction(code, sig);
    if (block) blocks.push(block);
  }
  const ctx = {
    __ENV: { ...env },
    console: { log: () => {}, warn: () => {}, error: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(blocks.join('\n\n'), ctx, { timeout: 1000 });
  return { resolveEnvOnly: ctx.__resolveAuthHeaderEnv };
}

function makeCollection() {
  return {
    info: { name: 'Auth chain demo', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{"username":"u","password":"p"}' },
        },
      },
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
      {
        name: 'List items',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: '{{baseUrl}}/items' },
        },
      },
      {
        name: 'Public health',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/health' },
        },
      },
    ],
  };
}

test('collectRuntimeCapturedVarNames tracks pm.set calls from earlier requests', () => {
  const collection = {
    info: { name: 'runtime capture chain', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("auth_token", json.token);',
                'pm.collectionVariables.set("campaign_id", json.campaign.id);',
              ],
            },
          },
        ],
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{}' },
        },
      },
      {
        name: 'Edit campaign',
        request: {
          method: 'PUT',
          header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
    ],
  };

  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const names = collectRuntimeCapturedVarNames(parsed);

  assert.ok(names.includes('auth_token'));
  assert.ok(names.includes('campaign_id'));
  assert.ok(!names.includes('baseUrl'));
});

test('expectedEnvVars omits variables produced by earlier runtime captures', () => {
  const collection = {
    info: { name: 'runtime capture chain', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const res = pm.response.json();',
                'pm.environment.set("auth_token", res.token);',
                'pm.collectionVariables.set("campaign_id", res.id);',
              ],
            },
          },
        ],
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{}' },
        },
      },
      {
        name: 'Create campaign',
        request: {
          method: 'POST',
          header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
          url: { raw: '{{baseUrl}}/campaign' },
        },
      },
      {
        name: 'Update campaign',
        request: {
          method: 'PUT',
          header: [{ key: 'Authorization', value: 'Bearer {{auth_token}}' }],
          url: { raw: '{{baseUrl}}/campaign/{{campaign_id}}' },
        },
      },
    ],
  };

  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  const script = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
  assert.ok(script.includes('data.vars["campaign_id"]'));
  assert.ok(script.includes('AUTH_TOKEN'));
  assert.doesNotMatch(script, /campaign_id.*required/i);
  assert.ok(parsed.referencedVars.some((v) => v.toLowerCase() === 'campaign_id'));
});

test('buildAuthFlow extracts j.token capture path from login test script', () => {
  const collection = {
    info: { name: 'j-token', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] },
        event: [{
          listen: 'test',
          script: {
            exec: [
              'const j = pm.response.json();',
              'pm.environment.set("access_token", j.token || j.data?.token || \'\');',
            ],
          },
        }],
      },
      {
        name: 'Protected',
        request: {
          method: 'GET',
          url: { raw: 'https://example.test/me' },
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
        },
      },
    ],
  };
  const flow = buildAuthFlow(parse(collection));
  assert.equal(flow.captureRules.length, 1);
  assert.equal(flow.captureRules[0].varName, 'access_token');
  assert.deepEqual(flow.captureRules[0].path, ['token']);
});

test('buildAuthFlow detects login and counts injection targets', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  assert.equal(flow.enabled, true);
  assert.equal(flow.loginRequestIndex, 0);
  assert.deepEqual(flow.injectionTargets, [1, 2]); // Get profile + List items
  assert.equal(flow.injectionCount, 2);
});

test('runtime captures preserve arbitrary Postman variable names', () => {
  for (const variableName of ['global_auth_token', 'access_token', 'my_custom_token', 'abc_xyz_token']) {
    const collection = {
      info: { name: `custom ${variableName}`, schema: 'v2.1' },
      item: [
        {
          name: 'Login',
          request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] },
          event: [{ listen: 'test', script: { exec: [`const jsonData = pm.response.json(); pm.environment.set("${variableName}", jsonData.token);`] } }],
        },
        {
          name: 'Protected',
          request: {
            method: 'GET',
            url: { raw: 'https://example.test/me' },
            header: [{ key: 'Authorization', value: `Bearer {{${variableName}}}` }],
          },
        },
      ],
    };
    const parsed = parse(collection);
    const flow = buildAuthFlow(parsed);
    const code = generateK6Script(parsed, { authFlow: flow });
    assert.match(code, new RegExp(`data\\.vars\\["${variableName}"\\]`));
  }
});

test('buildAuthFlow yields empty plan when no login is present', () => {
  const collection = {
    info: { name: 'no auth' },
    item: [
      {
        name: 'Public health',
        request: { method: 'GET', header: [], url: { raw: 'https://x/health' } },
      },
    ],
  };
  const parsed = parse(collection);
  const flow = buildAuthFlow(parsed);
  assert.equal(flow.enabled, false);
  assert.equal(flow.loginRequestIndex, -1);
  assert.equal(flow.injectionCount, 0);
});

test('generator with authFlow emits setup() that finds the token in common shapes', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });

  assert.match(code, /export function setup\(\)/);
  assert.match(code, /const tokenKeys = \[/);
  // setup uses a recursive deepFind walker that handles arbitrarily nested bodies.
  assert.match(code, /function deepFind\(/);
  // Runtime state object exposes the multi-slot shape the generator relies on.
  assert.match(code, /AUTH_TOKEN: ''/);
  assert.match(code, /ACCESS_TOKEN: ''/);
  assert.match(code, /JWT: ''/);
  assert.match(code, /SESSION_ID: ''/);
  // default(data) reads from the chained token first.
  assert.match(code, /export default function \(data\) \{/);
  assert.match(code, /data\.AUTH_TOKEN \|\| data\.ACCESS_TOKEN \|\| data\.JWT/);
});

test('generator with authFlow captures Set-Cookie and replays it as a Cookie header', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });

  // setup() parses Set-Cookie into the runtime cookie jar.
  assert.match(code, /function parseSetCookie\(/);
  assert.match(code, /state\.cookies = parseSetCookie\(sc\)/);
  // Iterations reuse those cookies via __runtimeCookieHeader.
  assert.match(code, /function __runtimeCookieHeader\(data\)/);
  assert.match(code, /\.\.\.__runtimeCookieHeader\(data\)/);
});

test('generator with authFlow honors pm.environment.set capture rules', () => {
  // Login response shape: { data: { customToken: 'xyz' } } with an explicit
  // pm.environment.set("custom_token", json.data.customToken) statement.
  const collection = {
    info: { name: 'Custom capture', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("custom_token", json.data.customToken);',
              ],
            },
          },
        ],
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{}' },
        },
      },
      {
        name: 'Get profile',
        request: {
          method: 'GET',
          header: [{ key: 'X-Custom-Token', value: '{{custom_token}}' }],
          url: { raw: '{{baseUrl}}/me' },
        },
      },
    ],
  };
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = buildAuthFlow(parsed);
  assert.equal(flow.captureRules.length, 1);
  assert.equal(flow.captureRules[0].varName, 'custom_token');
  assert.deepEqual(flow.captureRules[0].path, ['data', 'customToken']);

  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
  // The captureRules array is embedded in setup() so the runtime can apply it.
  assert.match(code, /const captureRules = \[/);
  assert.match(code, /custom_token/);
  // CUSTOM_TOKEN is token-shaped. With runtime + capture enabled the
  // interpolator emits __ENV.AUTH_TOKEN first (manual override), then runtime
  // slots, then the pm.environment.set capture, then the env placeholder.
  assert.match(
    code,
    /\$\{\(__ENV\.AUTH_TOKEN \|\| data\.AUTH_TOKEN \|\| data\.ACCESS_TOKEN \|\| data\.JWT \|\| data\.ID_TOKEN \|\| data\.vars\["custom_token"\] \|\| __ENV\.CUSTOM_TOKEN \|\| ''\)\}/
  );
  // The pm.environment.set capture (data.vars[...]) still participates in
  // the chain between runtime slots and the env placeholder.
  assert.match(code, /data\.vars\["custom_token"\]/);
});

test('generator with authFlow does NOT emit the login request inside default()', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });

  // The login is run only in setup. The default() iteration should not contain
  // a `group(`Login`, ...)` block (because it's been removed from the loop).
  assert.doesNotMatch(code, /group\(`Login`/);
  // But the other groups should remain.
  assert.match(code, /group\(`Get profile`/);
  assert.match(code, /group\(`List items`/);
  assert.match(code, /group\(`Public health`/);
});

test('generator without authFlow falls back to the original env-based behavior', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    authFlow: { enabled: false },
  });
  assert.doesNotMatch(code, /export function setup\(\)/);
  // Every Authorization header now flows through __resolveAuthHeaderEnv so a
  // manual __ENV.AUTH_TOKEN overrides whatever placeholder name the
  // collection used.
  assert.match(code, /function __resolveAuthHeaderEnv\(fallback, placeholder\)/);
  // Defensive Bearer normalizer is always present.
  assert.match(code, /function __normalizeBearer\(token\)/);
  assert.match(code, /while \(\/\^Bearer\\b\\s\*\/i\.test\(t\)\)/);
  // Authorization headers with no value are still injected via the resolver.
  assert.match(code, /\.\.\.__authHeader\(__resolveAuthHeaderEnv\(``\)\)/);
  // Existing Authorization headers using {{token}} are wrapped by the resolver.
  // The inner template consults __ENV.AUTH_TOKEN before the collection's
  // placeholder env var so a manual override flows through even on this path.
  assert.match(
    code,
    /__resolveAuthHeaderEnv\(`Bearer \$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.TOKEN \|\| ''\)\}`, "token"\)/
  );
  // Runtime: manual AUTH_TOKEN short-circuits before the collection fallback.
  const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'manual-lock' });
  assert.equal(resolveEnvOnly('Bearer {{token}}', 'token'), 'Bearer manual-lock');
});

test('chained script keeps secrets out (sanitizer guard still passes)', () => {
  const { assertNoSecretsInScript } = require('../src/lib/postman/authSanitizer');
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });
  assert.doesNotThrow(() => assertNoSecretsInScript(code));
});

test('generator with authFlow: __ENV manual override wins over runtime-extracted tokens', () => {
  const parsed = sanitizeParsedCollection(parse(makeCollection())).parsed;
  const flow = buildAuthFlow(parsed);
  const code = generateK6Script(parsed, { injectAuthToken: true, authFlow: flow });

  // The auth-header resolver consults __ENV.AUTH_TOKEN first. Any captured
  // runtime token (data.AUTH_TOKEN / ACCESS_TOKEN / JWT / ID_TOKEN) only
  // applies when the user did NOT enter a manual override.
  assert.match(code, /function __resolveAuthHeader\(data, fallback, placeholder\)/);
  assert.match(code, /if \(__ENV\.AUTH_TOKEN\) \{/);
  assert.match(
    code,
    /data\.AUTH_TOKEN \|\| data\.ACCESS_TOKEN \|\| data\.JWT \|\| data\.ID_TOKEN/
  );

  // The defensive Bearer normalizer is always emitted so pasting "Bearer xyz"
  // never produces "Bearer Bearer xyz".
  assert.match(code, /function __normalizeBearer\(token\)/);
  assert.match(code, /while \(\/\^Bearer\\b\\s\*\/i\.test\(t\)\)/);

  // Manual override log lines (no token values) are always emitted under
  // the manual-override branch.
  assert.match(code, /\[auth\] manual token override active/);
  assert.match(code, /\[auth\] using manual Authorization header/);
  assert.match(code, /\[auth\] resolved Authorization from manual override/);
  // Per-request placeholder log uses the literal collection name.
  assert.match(code, /\[auth\] placeholder replaced: \{\{' \+ placeholder \+ '\}\}/);
});

test('manual token override beats arbitrary collection placeholder names', () => {
  // Three different collections, three different non-standard token vars.
  // The resolver should win on all of them without depending on the names.
  const variants = [
    { vname: 'jwt_token' },
    { vname: 'global_auth_token' },
    { vname: 'sessionToken' },
    { vname: 'CompanyXYZ_AccessToken_v2' },
  ];
  for (const { vname } of variants) {
    const collection = {
      info: { name: 'placeholder ' + vname, schema: 'v2.1' },
      item: [
        {
          name: 'Get profile',
          request: {
            method: 'GET',
            header: [
              { key: 'Authorization', value: 'Bearer {{' + vname + '}}' },
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
    // Every Authorization header is wrapped by the resolver. The inner template
    // consults __ENV.AUTH_TOKEN before the collection's placeholder env var.
    assert.match(
      code,
      /__resolveAuthHeaderEnv\(`Bearer \$\{\(__ENV\.AUTH_TOKEN \|\| __ENV\.[A-Z0-9_]+ \|\| ''\)\}`,/,
      'expected resolver-wrapped Authorization with AUTH_TOKEN-first precedence for ' + vname
    );
    // The collection placeholder is preserved as the third arg for safe debug
    // logs.
    const placeholderInScript = vname; // stored verbatim from the raw header
    assert.ok(
      code.includes('"' + placeholderInScript + '"'),
      'placeholder name ' + placeholderInScript + ' should appear as resolver hint'
    );
    // No bare Bearer template (raw __ENV.X with no fallback) should remain.
    assert.doesNotMatch(
      code,
      /"Authorization":\s*`Bearer \$\{__ENV\.[A-Z0-9_]+\}`/,
      'no bare Bearer template should remain for ' + vname
    );
    // Runtime: manual AUTH_TOKEN must win regardless of placeholder name.
    const { resolveEnvOnly } = evaluateAuthHelpers(code, { AUTH_TOKEN: 'manual-lock' });
    for (const fb of [`Bearer {{${vname}}}`, 'Bearer undefined', 'Bearer ', '']) {
      assert.equal(
        resolveEnvOnly(fb, vname),
        'Bearer manual-lock',
        `manual override failed for placeholder=${vname}, fallback="${fb}"`
      );
    }
  }
});
