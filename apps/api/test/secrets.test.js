'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { maskToken, normalizeBearer, formatBearer } = require('../src/utils/secrets');

test('normalizeBearer strips a single Bearer prefix', () => {
  assert.equal(normalizeBearer('Bearer abc123'), 'abc123');
});

test('normalizeBearer strips multiple Bearer prefixes (defensive)', () => {
  assert.equal(normalizeBearer('Bearer Bearer eyJabc'), 'eyJabc');
  assert.equal(normalizeBearer('   Bearer    Bearer eyJabc  '), 'eyJabc');
});

test('normalizeBearer handles empty / non-string inputs', () => {
  assert.equal(normalizeBearer(''), '');
  assert.equal(normalizeBearer(null), '');
  assert.equal(normalizeBearer(undefined), '');
  assert.equal(normalizeBearer(42), '');
});

test('normalizeBearer leaves a raw token untouched', () => {
  const raw = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig';
  assert.equal(normalizeBearer(raw), raw);
});

test('formatBearer produces exactly one Bearer prefix from a raw token', () => {
  assert.equal(formatBearer('abc123'), 'Bearer abc123');
});

test('formatBearer produces exactly one Bearer prefix from a Bearer-prefixed token', () => {
  assert.equal(formatBearer('Bearer abc123'), 'Bearer abc123');
});

test('formatBearer handles double-prefixed values without producing Bearer Bearer', () => {
  assert.equal(formatBearer('Bearer Bearer abc'), 'Bearer abc');
});

test('formatBearer returns empty string when input is empty', () => {
  assert.equal(formatBearer(''), '');
  assert.equal(formatBearer('   '), '');
  assert.equal(formatBearer('Bearer    '), '');
});

test('maskToken keeps first/last 4 chars and stars short tokens', () => {
  // Long token: keep the first 4 and last 4, with an ellipsis in between.
  assert.equal(maskToken('eyJhbGciOiJIUzI1NiI'), 'eyJh...1NiI');
  // Short token (<= 8 chars): everything turns into stars.
  assert.equal(maskToken('shortok'), '*'.repeat(7));
});
