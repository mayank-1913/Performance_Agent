'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeParsedCollection,
  sanitizeHeader,
  assertNoSecretsInScript,
  bearerContainsLiteral,
} = require('../src/lib/postman/authSanitizer');
const { generateK6Script } = require('../src/lib/k6/generator');

const SAMPLE_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

function makeParsed(headers, { url = 'https://api.example.com/v1/users' } = {}) {
  return {
    name: 'test',
    requests: [
      {
        name: 'Get users',
        folderPath: [],
        method: 'GET',
        url,
        headers,
        body: null,
        auth: null,
      },
    ],
    referencedVars: [],
    definedVars: {},
    collectionAuth: null,
  };
}

test('bearerContainsLiteral detects a JWT bearer', () => {
  assert.equal(bearerContainsLiteral(`Bearer ${SAMPLE_JWT}`), true);
});

test('bearerContainsLiteral leaves placeholder bearers alone', () => {
  assert.equal(bearerContainsLiteral('Bearer {{token}}'), false);
  assert.equal(bearerContainsLiteral('Bearer {{AUTH_TOKEN}}'), false);
});

test('sanitizeHeader replaces a literal Bearer JWT with {{AUTH_TOKEN}}', () => {
  const { header, replacedWith } = sanitizeHeader({
    key: 'Authorization',
    value: `Bearer ${SAMPLE_JWT}`,
  });
  assert.equal(replacedWith, 'AUTH_TOKEN');
  assert.equal(header.value, 'Bearer {{AUTH_TOKEN}}');
});

test('sanitizeHeader leaves header with placeholder unchanged', () => {
  const { header, replacedWith } = sanitizeHeader({
    key: 'Authorization',
    value: 'Bearer {{access_token}}',
  });
  assert.equal(replacedWith, null);
  assert.equal(header.value, 'Bearer {{access_token}}');
});

test('sanitizeHeader replaces literal X-API-Key', () => {
  const { header, replacedWith } = sanitizeHeader({
    key: 'X-API-Key',
    value: 'sk_live_super_secret_value_12345',
  });
  assert.equal(replacedWith, 'API_KEY');
  assert.equal(header.value, '{{API_KEY}}');
});

test('sanitizeParsedCollection records injected tokens and adds them to referencedVars', () => {
  const parsed = makeParsed([
    { key: 'Authorization', value: `Bearer ${SAMPLE_JWT}` },
    { key: 'Content-Type', value: 'application/json' },
  ]);
  const result = sanitizeParsedCollection(parsed);
  assert.equal(result.sanitized, true);
  assert.deepEqual(result.injectedTokens, ['AUTH_TOKEN']);
  assert.equal(
    result.parsed.requests[0].headers.find((h) => h.key === 'Authorization').value,
    'Bearer {{AUTH_TOKEN}}'
  );
  assert.ok(result.parsed.referencedVars.includes('AUTH_TOKEN'));
});

test('generated K6 script never contains a raw JWT after sanitization', () => {
  const parsed = makeParsed([{ key: 'Authorization', value: `Bearer ${SAMPLE_JWT}` }]);
  const sanitized = sanitizeParsedCollection(parsed).parsed;
  const code = generateK6Script(sanitized, { injectAuthToken: true });
  // The literal JWT must not appear anywhere in the generated script.
  assert.doesNotMatch(code, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\./, 'JWT must be stripped');
  // The Authorization header must reference the runtime token (chained or
  // env). After the placeholder-agnostic refactor, every Authorization line
  // flows through the resolver and the inner template falls back to
  // __ENV.AUTH_TOKEN. AUTH_TOKEN itself is the sanitizer's chosen
  // placeholder, so the inner template is `Bearer ${(__ENV.AUTH_TOKEN ||
  // data.AUTH_TOKEN || ... || '')}` — confirm the resolver wrapper *and*
  // the AUTH_TOKEN reference are present.
  assert.match(code, /__resolveAuthHeader(?:Env)?\(/);
  assert.match(code, /__ENV\.AUTH_TOKEN/);
  // Hard guard must pass.
  assert.doesNotThrow(() => assertNoSecretsInScript(code));
});

test('assertNoSecretsInScript throws if a JWT slips through', () => {
  const dirty = `const auth = "Bearer ${SAMPLE_JWT}";`;
  assert.throws(() => assertNoSecretsInScript(dirty), /JWT|Bearer/);
});

test('assertNoSecretsInScript passes templated bearer references', () => {
  const clean = 'const auth = `Bearer ${__ENV.AUTH_TOKEN}`;';
  assert.doesNotThrow(() => assertNoSecretsInScript(clean));
});

test('sanitizeParsedCollection sanitizes collection-level bearer auth blocks', () => {
  const parsed = {
    name: 'X',
    requests: [],
    referencedVars: [],
    definedVars: {},
    collectionAuth: {
      type: 'bearer',
      bearer: [{ key: 'token', value: SAMPLE_JWT, type: 'string' }],
    },
  };
  const result = sanitizeParsedCollection(parsed);
  assert.equal(result.sanitized, true);
  assert.deepEqual(result.injectedTokens, ['AUTH_TOKEN']);
  assert.equal(result.parsed.collectionAuth.bearer[0].value, '{{AUTH_TOKEN}}');
});
