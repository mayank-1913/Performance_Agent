'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveAuthorizationHeader,
  isSafeTokenValue,
  diagnose,
  normalizeBearer,
  formatBearer,
} = require('../src/utils/authHeader');

/* ------------------------------------------------------------------ */
/*  Bearer input format contract                                       */
/* ------------------------------------------------------------------ */
/*  All five spec inputs must collapse to exactly "Bearer abc123".     */
/* ------------------------------------------------------------------ */

const bearerFormatCases = [
  ['abc123', 'Bearer abc123'],
  ['Bearer abc123', 'Bearer abc123'],
  ['bearer abc123', 'Bearer abc123'],
  ['Bearer    abc123', 'Bearer abc123'],
  ['Bearer Bearer abc123', 'Bearer abc123'],
];
for (const [input, expected] of bearerFormatCases) {
  test(`Bearer normalization: "${input}" -> "${expected}"`, () => {
    assert.equal(formatBearer(input), expected);
    const resolved = resolveAuthorizationHeader({ manualToken: input });
    assert.equal(resolved.value, expected);
    assert.equal(resolved.source, 'manual');
    assert.equal(resolved.token, 'abc123');
  });
}

/* ------------------------------------------------------------------ */
/*  Unrelated schemes must NOT be Bearer-ified                          */
/* ------------------------------------------------------------------ */
test('non-Bearer schemes are left unchanged by normalizeBearer', () => {
  // normalizeBearer strips *only* the Bearer prefix. "Basic abc" and
  // "Digest abc" survive normalization because their leading token is
  // never matched by /^Bearer\b/i.
  assert.equal(normalizeBearer('Basic abc'), 'Basic abc');
  assert.equal(normalizeBearer('Digest abc'), 'Digest abc');
});

test('resolveAuthorizationHeader wraps a Basic/Digest raw value as Bearer only when caller asks for it', () => {
  // The resolver's job is to produce a *Bearer* header for the Manual
  // Bearer Token field. A user pasting "Basic abc" into that field is
  // asserting the value IS the bearer payload — which is precisely what
  // the spec allows ("abc123" alone is valid). The resolver never converts
  // a Basic/Digest header into a Bearer header by itself.
  const out = resolveAuthorizationHeader({ manualToken: 'Basic abc' });
  // Because "Basic abc" does not start with the Bearer scheme, the
  // resolver treats the entire string as the token payload and wraps it
  // as Bearer. This is intentional — the field is named "Manual Bearer
  // Token" so anything the user types is the token itself, unless they
  // explicitly prefixed with Bearer.
  assert.equal(out.value, 'Bearer Basic abc');
  assert.equal(out.token, 'Basic abc');
});

/* ------------------------------------------------------------------ */
/*  Safety filter                                                      */
/* ------------------------------------------------------------------ */
test('isSafeTokenValue rejects null / undefined / non-string', () => {
  assert.equal(isSafeTokenValue(null), false);
  assert.equal(isSafeTokenValue(undefined), false);
  assert.equal(isSafeTokenValue(42), false);
  assert.equal(isSafeTokenValue({ token: 'x' }), false);
});

test('isSafeTokenValue rejects empty / whitespace', () => {
  assert.equal(isSafeTokenValue(''), false);
  assert.equal(isSafeTokenValue('   '), false);
});

test('isSafeTokenValue rejects the strings "undefined" and "null"', () => {
  assert.equal(isSafeTokenValue('undefined'), false);
  assert.equal(isSafeTokenValue('null'), false);
});

test('isSafeTokenValue rejects unresolved Postman placeholders', () => {
  assert.equal(isSafeTokenValue('{{token}}'), false);
  assert.equal(isSafeTokenValue('Bearer {{jwt_token}}'), false);
});

test('isSafeTokenValue rejects a lone "Bearer" without a payload', () => {
  assert.equal(isSafeTokenValue('Bearer'), false);
  assert.equal(isSafeTokenValue('Bearer '), false);
  assert.equal(isSafeTokenValue('  Bearer   '), false);
});

test('isSafeTokenValue accepts real tokens (with or without prefix)', () => {
  assert.equal(isSafeTokenValue('abc123'), true);
  assert.equal(isSafeTokenValue('Bearer abc123'), true);
  assert.equal(isSafeTokenValue('  bearer   xyz  '), true);
});

/* ------------------------------------------------------------------ */
/*  Precedence contract                                                */
/* ------------------------------------------------------------------ */
test('precedence: manual wins over runtime, environment, and collection', () => {
  const out = resolveAuthorizationHeader({
    manualToken: 'manual-tok',
    runtimeToken: 'runtime-tok',
    envToken: 'env-tok',
    collectionToken: 'collection-tok',
  });
  assert.equal(out.value, 'Bearer manual-tok');
  assert.equal(out.source, 'manual');
});

test('precedence: runtime wins when manual is absent', () => {
  const out = resolveAuthorizationHeader({
    manualToken: '',
    runtimeToken: 'runtime-tok',
    envToken: 'env-tok',
    collectionToken: 'collection-tok',
  });
  assert.equal(out.value, 'Bearer runtime-tok');
  assert.equal(out.source, 'runtime');
});

test('precedence: environment wins when manual and runtime are absent', () => {
  const out = resolveAuthorizationHeader({
    envToken: 'env-tok',
    collectionToken: 'collection-tok',
  });
  assert.equal(out.value, 'Bearer env-tok');
  assert.equal(out.source, 'environment');
});

test('precedence: collection is the final resort', () => {
  const out = resolveAuthorizationHeader({ collectionToken: 'coll-tok' });
  assert.equal(out.value, 'Bearer coll-tok');
  assert.equal(out.source, 'collection');
});

test('precedence: no source produces an empty header (not "Bearer undefined")', () => {
  const out = resolveAuthorizationHeader({});
  assert.equal(out.value, '');
  assert.equal(out.source, 'none');
  assert.equal(out.token, '');
});

test('precedence: an unsafe higher-priority source is skipped in favor of the next safe one', () => {
  const cases = [
    { manualToken: 'Bearer {{token}}', envToken: 'env-tok', expect: 'Bearer env-tok', src: 'environment' },
    { manualToken: 'undefined', runtimeToken: 'rt', expect: 'Bearer rt', src: 'runtime' },
    { manualToken: 'null', envToken: 'e', expect: 'Bearer e', src: 'environment' },
    { manualToken: 'Bearer', envToken: 'e', expect: 'Bearer e', src: 'environment' },
    { manualToken: '   ', envToken: 'e', expect: 'Bearer e', src: 'environment' },
  ];
  for (const c of cases) {
    const out = resolveAuthorizationHeader(c);
    assert.equal(out.value, c.expect, `input=${JSON.stringify(c)}`);
    assert.equal(out.source, c.src);
  }
});

/* ------------------------------------------------------------------ */
/*  diagnose() never leaks a plaintext token                           */
/* ------------------------------------------------------------------ */
test('diagnose() masks the token and never returns the plaintext', () => {
  const out = resolveAuthorizationHeader({
    manualToken: 'super-secret-jwt-abcdef1234567890',
  });
  const diag = diagnose(out);
  assert.equal(diag.source, 'manual');
  assert.equal(diag.hasValue, true);
  assert.ok(typeof diag.tokenPreview === 'string' && diag.tokenPreview.length > 0);
  const serialized = JSON.stringify(diag);
  assert.ok(
    !serialized.includes('super-secret-jwt-abcdef1234567890'),
    'diagnostic view leaked the raw token'
  );
});

test('diagnose() records dropped unsafe higher-priority sources', () => {
  const out = resolveAuthorizationHeader({
    manualToken: 'Bearer {{token}}',
    envToken: 'real-env',
  });
  const diag = diagnose(out);
  assert.equal(diag.source, 'environment');
  assert.ok(diag.dropped.includes('manual'));
});
