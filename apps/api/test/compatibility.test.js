'use strict';

/**
 * Phase 5 — deterministic tests for the Postman compatibility scanner.
 *
 * The suite walks every feature listed in the Phase 5 spec and asserts
 * either:
 *   - the scanner adds the feature id to `supported` (feature is reliably
 *     translated to K6), OR
 *   - the scanner emits a structured warning with the correct severity
 *     and identifiable request context.
 *
 * The tests also lock in the parser's path-variable substitution so
 * :name → value / {{name}} conversion is deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  scanCompatibility,
  Severity,
  Features,
} = require('../src/lib/postman/compatibility');
const { parse, applyPathVariables } = require('../src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../src/lib/postman/authSanitizer');

/* ------------------------------------------------------------------ */
/*  Fixture builders                                                   */
/* ------------------------------------------------------------------ */

function collection({ items = [], name = 'test', variable = null, auth = null, protocolProfileBehavior = null } = {}) {
  const c = { info: { name, schema: 'v2.1' }, item: items };
  if (variable) c.variable = variable;
  if (auth) c.auth = auth;
  if (protocolProfileBehavior) c.protocolProfileBehavior = protocolProfileBehavior;
  return c;
}

function req({ name = 'r', method = 'GET', urlRaw, url, header = [], body = null, auth = null, event = null } = {}) {
  return {
    name,
    request: {
      method,
      header,
      url: url != null ? url : { raw: urlRaw },
      body: body || undefined,
      auth: auth || undefined,
    },
    event: event || undefined,
  };
}

function folder({ name = 'f', item = [] } = {}) {
  return { name, item };
}

function scanFor(raw, rawEnvironment = null) {
  const parsed = sanitizeParsedCollection(parse(raw)).parsed;
  return {
    parsed,
    result: scanCompatibility({ rawCollection: raw, parsed, rawEnvironment }),
  };
}

function findWarning(result, feature) {
  return result.warnings.find((w) => w.feature === feature) || null;
}

/* ==================================================================
 * SUPPORTED FEATURES
 * ================================================================== */

test('supported: collection variables', () => {
  const raw = collection({
    variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    items: [req({ urlRaw: '{{baseUrl}}/health' })],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.COLLECTION_VARIABLES));
  assert.equal(result.hasBlocking, false);
});

test('supported: environment variables', () => {
  const raw = collection({ items: [req({ urlRaw: '{{baseUrl}}/x' })] });
  const env = { values: [{ key: 'baseUrl', value: 'https://staging', enabled: true }] };
  const { result } = scanFor(raw, env);
  assert.ok(result.supported.includes(Features.ENVIRONMENT_VARIABLES));
});

test('supported: nested folders', () => {
  const raw = collection({
    items: [
      folder({
        name: 'auth',
        item: [
          folder({
            name: 'admin',
            item: [req({ name: 'me', urlRaw: 'https://api.example.com/me' })],
          }),
        ],
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.NESTED_FOLDERS));
});

test('supported: inherited collection-level bearer auth', () => {
  const raw = collection({
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] },
    items: [req({ urlRaw: 'https://api.example.com/x' })],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.INHERITED_AUTH));
});

test('supported: query parameters — enabled entries', () => {
  const raw = collection({
    items: [
      req({
        url: {
          raw: 'https://api.example.com/x?limit=5',
          host: ['api', 'example', 'com'],
          path: ['x'],
          query: [{ key: 'limit', value: '5' }],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.QUERY_PARAMETERS));
});

test('supported: path variables — substituted at parse time', () => {
  const raw = collection({
    items: [
      req({
        name: 'user by id',
        url: {
          raw: 'https://api.example.com/users/:id',
          host: ['api', 'example', 'com'],
          path: ['users', ':id'],
          variable: [{ key: 'id', value: '42' }],
        },
      }),
    ],
  });
  const { parsed, result } = scanFor(raw);
  assert.equal(parsed.requests[0].url, 'https://api.example.com/users/42');
  assert.ok(result.supported.includes(Features.PATH_VARIABLES));
});

test('supported: headers', () => {
  const raw = collection({
    items: [
      req({
        header: [{ key: 'Accept', value: 'application/json' }],
        urlRaw: 'https://api.example.com/x',
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.HEADERS));
});

test('supported: JSON body', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: { mode: 'raw', raw: '{"a":1}', options: { raw: { language: 'json' } } },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.JSON_BODY));
  assert.ok(result.supported.includes(Features.RAW_BODY));
});

test('supported: raw body (non-JSON)', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: { mode: 'raw', raw: 'hello' },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.RAW_BODY));
  assert.ok(!result.supported.includes(Features.JSON_BODY));
});

test('supported: urlencoded body', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }] },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.URLENCODED_BODY));
});

test('supported: form-data text-only fields', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: { mode: 'formdata', formdata: [{ key: 'a', value: '1', type: 'text' }] },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.FORM_DATA_TEXT));
  assert.equal(findWarning(result, Features.FORM_DATA_FILE), null);
});

test('supported: static Cookie header', () => {
  const raw = collection({
    items: [req({
      header: [{ key: 'Cookie', value: 'session=abc; csrf=xyz' }],
      urlRaw: 'https://api.example.com/x',
    })],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.COOKIES_STATIC));
});

test('supported: runtime cookies + response token capture — login endpoint detected', () => {
  const raw = collection({
    items: [
      req({
        name: 'Login',
        method: 'POST',
        urlRaw: '{{baseUrl}}/auth/login',
        body: { mode: 'raw', raw: '{"u":"x"}' },
      }),
      req({
        name: 'Get profile',
        urlRaw: '{{baseUrl}}/me',
        header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.COOKIES_RUNTIME));
  assert.ok(result.supported.includes(Features.RESPONSE_TOKEN_BODY));
  assert.ok(result.supported.includes(Features.RESPONSE_TOKEN_HEADER));
});

test('supported: GraphQL body', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/graphql',
        body: { mode: 'graphql', graphql: { query: '{ me { id } }' } },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.GRAPHQL_BODY));
});

test('supported: pm.environment.set + pm.collectionVariables.set capture statements', () => {
  const raw = collection({
    items: [
      req({
        name: 'Login',
        method: 'POST',
        urlRaw: '{{baseUrl}}/auth/login',
        body: { mode: 'raw', raw: '{"u":"x"}' },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const j = pm.response.json();',
                'pm.environment.set("token", j.access_token);',
                'pm.collectionVariables.set("session_id", j.sessionId);',
              ],
            },
          },
        ],
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.PM_ENVIRONMENT_SET));
  assert.ok(result.supported.includes(Features.PM_COLLECTION_VARIABLES_SET));
});

test('supported: custom token variable names', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: '{{baseUrl}}/x',
        header: [{ key: 'Authorization', value: 'Bearer {{myCustomAccessToken}}' }],
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.ok(result.supported.includes(Features.CUSTOM_TOKEN_NAMES));
});

/* ==================================================================
 * DISABLED VARIABLES / FIELDS — always info, never blocking
 * ================================================================== */

test('info: disabled collection variable is reported without blocking', () => {
  const raw = collection({
    variable: [{ key: 'baseUrl', value: 'x', disabled: true }],
    items: [req({ urlRaw: '{{baseUrl}}/x' })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.DISABLED_VARIABLES);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
  assert.equal(result.hasBlocking, false);
});

test('info: disabled environment variable is reported', () => {
  const raw = collection({ items: [req({ urlRaw: '{{baseUrl}}/x' })] });
  const env = { values: [{ key: 'baseUrl', value: 'x', enabled: false }] };
  const { result } = scanFor(raw, env);
  const w = findWarning(result, Features.DISABLED_VARIABLES);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

test('info: disabled header is reported', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: 'https://api.example.com/x',
        header: [
          { key: 'X-Debug', value: '1', disabled: true },
          { key: 'Accept', value: 'application/json' },
        ],
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.DISABLED_HEADER);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

test('info: disabled query parameter is reported', () => {
  const raw = collection({
    items: [
      req({
        url: {
          raw: 'https://api.example.com/x',
          host: ['api', 'example', 'com'],
          path: ['x'],
          query: [{ key: 'trace', value: '1', disabled: true }],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.DISABLED_QUERY);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

test('info: disabled form-data field is reported', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'a', value: '1', type: 'text' },
            { key: 'b', value: '2', type: 'text', disabled: true },
          ],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.DISABLED_FORM_FIELD);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

/* ==================================================================
 * PATH VARIABLES — unresolved
 * ================================================================== */

test('warn: path variable declared with an empty value', () => {
  const raw = collection({
    items: [
      req({
        name: 'user by id',
        url: {
          raw: 'https://api.example.com/users/:id',
          host: ['api', 'example', 'com'],
          path: ['users', ':id'],
          variable: [{ key: 'id', value: '' }],
        },
      }),
    ],
  });
  const { parsed, result } = scanFor(raw);
  // Empty value falls back to {{id}} placeholder.
  assert.equal(parsed.requests[0].url, 'https://api.example.com/users/{{id}}');
  const w = findWarning(result, Features.PATH_VARIABLE_UNRESOLVED);
  assert.ok(w);
  assert.equal(w.severity, Severity.WARN);
  assert.equal(w.detail.pathVariable, 'id');
});

test('warn: :name referenced in path but not declared under variable[]', () => {
  const raw = collection({
    items: [
      req({
        name: 'stray',
        url: {
          raw: 'https://api.example.com/orders/:orderId',
          host: ['api', 'example', 'com'],
          path: ['orders', ':orderId'],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.PATH_VARIABLE_UNRESOLVED);
  assert.ok(w);
  assert.equal(w.severity, Severity.WARN);
  assert.match(w.reason, /:orderId/);
});

test('applyPathVariables ignores port numbers like :8080', () => {
  const out = applyPathVariables('http://localhost:8080/api/v1/users/:id', [{ key: 'id', value: '42' }]);
  assert.equal(out, 'http://localhost:8080/api/v1/users/42');
});

test('applyPathVariables treats a disabled path variable as unresolved', () => {
  const out = applyPathVariables('https://api.example.com/x/:name', [
    { key: 'name', value: 'v', disabled: true },
  ]);
  assert.equal(out, 'https://api.example.com/x/:name');
});

/* ==================================================================
 * FORM-DATA / BINARY / FILE BODIES
 * ================================================================== */

test('warn: form-data with mixed text + file entries — file fields skipped', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/x',
        body: {
          mode: 'formdata',
          formdata: [
            { key: 'meta', value: '{}', type: 'text' },
            { key: 'upload', type: 'file', src: '/tmp/x.png' },
          ],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.FORM_DATA_FILE);
  assert.ok(w);
  assert.equal(w.severity, Severity.WARN);
  assert.deepEqual(w.detail.fileKeys, ['upload']);
  assert.equal(result.hasBlocking, false);
});

test('blocking: form-data with ONLY file entries — request body would be empty', () => {
  const raw = collection({
    items: [
      req({
        method: 'POST',
        urlRaw: 'https://api.example.com/upload',
        body: {
          mode: 'formdata',
          formdata: [{ key: 'file', type: 'file', src: '/tmp/x.png' }],
        },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.FORM_DATA_FILE);
  assert.ok(w);
  assert.equal(w.severity, Severity.BLOCKING);
  assert.equal(result.hasBlocking, true);
});

test('blocking: file-mode body', () => {
  const raw = collection({
    items: [req({ method: 'POST', urlRaw: 'https://api.example.com/x', body: { mode: 'file' } })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.FILE_BODY);
  assert.ok(w);
  assert.equal(w.severity, Severity.BLOCKING);
});

test('blocking: binary-mode body', () => {
  const raw = collection({
    items: [req({ method: 'POST', urlRaw: 'https://api.example.com/x', body: { mode: 'binary' } })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.BINARY_BODY);
  assert.ok(w);
  assert.equal(w.severity, Severity.BLOCKING);
});

test('warn: unknown body mode', () => {
  const raw = collection({
    items: [req({ method: 'POST', urlRaw: 'https://api.example.com/x', body: { mode: 'protobuf' } })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.UNKNOWN_BODY_MODE);
  assert.ok(w);
  assert.equal(w.severity, Severity.WARN);
});

/* ==================================================================
 * COMPLEX AUTH TYPES
 * ================================================================== */

const BLOCKING_AUTH_CASES = [
  ['awsv4', Features.AWS_SIGV4_AUTH, /AWS Signature v4/],
  ['oauth1', Features.OAUTH1_AUTH, /OAuth 1\.0/],
  ['hawk', Features.HAWK_AUTH, /Hawk/],
  ['ntlm', Features.NTLM_AUTH, /NTLM/],
  ['digest', Features.DIGEST_AUTH, /Digest/],
];
for (const [type, featureId, reasonRe] of BLOCKING_AUTH_CASES) {
  test(`blocking: request-level ${type} auth is refused`, () => {
    const raw = collection({
      items: [
        req({
          urlRaw: 'https://api.example.com/x',
          auth: { type, [type]: [] },
        }),
      ],
    });
    const { result } = scanFor(raw);
    const w = findWarning(result, featureId);
    assert.ok(w);
    assert.equal(w.severity, Severity.BLOCKING);
    assert.match(w.reason, reasonRe);
    assert.equal(w.detail.authType, type);
    assert.equal(result.hasBlocking, true);
  });
}

test('blocking: collection-level awsv4 auth is refused too', () => {
  const raw = collection({
    auth: { type: 'awsv4', awsv4: [] },
    items: [req({ urlRaw: 'https://api.example.com/x' })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.AWS_SIGV4_AUTH);
  assert.ok(w);
  assert.equal(w.severity, Severity.BLOCKING);
  assert.equal(w.detail.scope, 'collection');
});

test('warn: OAuth 2.0 auth — only client-credentials grant supported', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: 'https://api.example.com/x',
        auth: { type: 'oauth2', oauth2: [] },
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.OAUTH2_AUTH);
  assert.ok(w);
  assert.equal(w.severity, Severity.WARN);
});

/* ==================================================================
 * SCRIPTS
 * ================================================================== */

test('blocking: unsupported pre-request script is reported explicitly', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: 'https://api.example.com/x',
        event: [
          {
            listen: 'prerequest',
            script: {
              exec: ['pm.request.headers.add({ key: "X-Ts", value: Date.now() });'],
            },
          },
        ],
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.PRE_REQUEST_SCRIPT_UNSUPPORTED);
  assert.ok(w);
  assert.equal(w.severity, Severity.BLOCKING);
  assert.equal(result.hasBlocking, true);
});

test('info: test script with custom logic beyond pm.*.set is flagged', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: 'https://api.example.com/x',
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'pm.test("shape", function() { pm.expect(pm.response.json()).to.have.property("data"); });',
                'if (pm.response.code !== 200) { console.error("bad response"); throw new Error("stop"); }',
                'const nextId = pm.response.json().nextId;',
                'if (nextId) pm.environment.set("cursor", nextId);',
              ],
            },
          },
        ],
      }),
    ],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.TEST_SCRIPT_CUSTOM);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

/* ==================================================================
 * PROTOCOL PROFILE BEHAVIOR + UNRESOLVED URL VAR
 * ================================================================== */

test('info: protocolProfileBehavior toggles are ignored', () => {
  const raw = collection({
    protocolProfileBehavior: { followRedirects: false, disableBodyPruning: true },
    items: [req({ urlRaw: 'https://api.example.com/x' })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.PROTOCOL_PROFILE_BEHAVIOR);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
});

test('info: {{var}} in URL that no source defines is flagged (non-blocking)', () => {
  const raw = collection({
    items: [req({ urlRaw: 'https://api.example.com/{{tenant}}/x' })],
  });
  const { result } = scanFor(raw);
  const w = findWarning(result, Features.UNRESOLVED_VARIABLE_IN_URL);
  assert.ok(w);
  assert.equal(w.severity, Severity.INFO);
  assert.equal(w.detail.variable, 'tenant');
});

/* ==================================================================
 * SUMMARY + hasBlocking
 * ================================================================== */

test('summary counts per severity are correct and hasBlocking reflects them', () => {
  const raw = collection({
    items: [
      req({
        name: 'aws',
        urlRaw: 'https://api.example.com/x',
        auth: { type: 'awsv4', awsv4: [] },
      }),
      req({
        name: 'files',
        method: 'POST',
        urlRaw: 'https://api.example.com/upload',
        body: {
          mode: 'formdata',
          formdata: [{ key: 'upload', type: 'file' }, { key: 'meta', value: '{}', type: 'text' }],
        },
      }),
      req({
        name: 'plain',
        urlRaw: 'https://api.example.com/plain',
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.equal(result.hasBlocking, true);
  assert.ok(result.summary.blocking >= 1);
  assert.ok(result.summary.warn >= 1);
  assert.equal(result.summary.total, result.warnings.length);
});

test('a clean collection produces zero warnings + zero blocking', () => {
  const raw = collection({
    variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
    items: [
      req({ name: 'health', urlRaw: '{{baseUrl}}/health' }),
      req({
        name: 'users',
        method: 'POST',
        urlRaw: '{{baseUrl}}/users',
        body: { mode: 'raw', raw: '{"n":1}', options: { raw: { language: 'json' } } },
      }),
    ],
  });
  const { result } = scanFor(raw);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.hasBlocking, false);
  assert.equal(result.summary.total, 0);
});

/* ==================================================================
 * WARNING SHAPE CONTRACT
 * ================================================================== */

test('every warning conforms to the { feature, severity, supported, reason, request, detail } shape', () => {
  const raw = collection({
    items: [
      req({
        urlRaw: 'https://api.example.com/x',
        auth: { type: 'awsv4', awsv4: [] },
      }),
    ],
  });
  const { result } = scanFor(raw);
  for (const w of result.warnings) {
    assert.deepEqual(
      Object.keys(w).sort(),
      ['detail', 'feature', 'reason', 'request', 'severity', 'supported']
    );
    assert.ok(['info', 'warn', 'blocking'].includes(w.severity));
    assert.equal(typeof w.reason, 'string');
    assert.equal(typeof w.feature, 'string');
    assert.equal(w.supported, w.severity === 'info');
  }
});
