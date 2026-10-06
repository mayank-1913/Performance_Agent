'use strict';

// Focused tests for D2: Postman URL assembly must not drop the scheme
// when `url.protocol` is absent but `url.raw` carries an explicit
// http:// or https:// prefix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/lib/postman/parser');

function wrap(url, name = 'r', method = 'GET') {
  return {
    info: { name: 'url-scheme-fixture', schema: 'v2.1' },
    item: [{ name, request: { method, url, header: [] } }],
  };
}

function parseOne(url) {
  const parsed = parse(wrap(url));
  return parsed.requests[0];
}

test('D2-1: structured host/path + raw https URL preserves https', () => {
  const req = parseOne({
    raw: 'https://api.example.com/users/:id',
    host: ['api', 'example', 'com'],
    path: ['users', ':id'],
    variable: [{ key: 'id', value: '42' }],
  });
  assert.equal(req.url, 'https://api.example.com/users/42');
});

test('D2-2: structured host/path + raw http URL preserves http', () => {
  const req = parseOne({
    raw: 'http://api.example.com/users/:id',
    host: ['api', 'example', 'com'],
    path: ['users', ':id'],
    variable: [{ key: 'id', value: '7' }],
  });
  assert.equal(req.url, 'http://api.example.com/users/7');
});

test('D2-3: explicit url.protocol keeps precedence over raw', () => {
  const req = parseOne({
    raw: 'http://api.example.com/users',
    protocol: 'https',
    host: ['api', 'example', 'com'],
    path: ['users'],
  });
  assert.equal(req.url, 'https://api.example.com/users');
});

test('D2-4: variable path segment preserves scheme', () => {
  const req = parseOne({
    raw: 'https://api.example.com/items/{{itemId}}',
    host: ['api', 'example', 'com'],
    path: ['items', '{{itemId}}'],
  });
  assert.equal(req.url, 'https://api.example.com/items/{{itemId}}');
});

test('D2-5: variable in host is preserved and keeps scheme from raw', () => {
  const req = parseOne({
    raw: 'https://{{serviceHost}}/health',
    host: ['{{serviceHost}}'],
    path: ['health'],
  });
  assert.equal(req.url, 'https://{{serviceHost}}/health');
});

test('D2-6: query parameters survive on structured URL with scheme fallback', () => {
  const req = parseOne({
    raw: 'https://api.example.com/search?q=k6&limit=5',
    host: ['api', 'example', 'com'],
    path: ['search'],
    query: [
      { key: 'q', value: 'k6' },
      { key: 'limit', value: '5' },
    ],
  });
  assert.equal(req.url, 'https://api.example.com/search?q=k6&limit=5');
});

test('D2-7: raw-only URL is returned unchanged', () => {
  const req = parseOne({ raw: 'https://api.example.com/raw-only' });
  assert.equal(req.url, 'https://api.example.com/raw-only');
});

test('D2-8: no raw and no protocol => no scheme fabricated', () => {
  const req = parseOne({
    host: ['api', 'example', 'com'],
    path: ['no-scheme'],
  });
  // We must NOT invent https://; leaving the URL schema-less is the
  // documented pre-existing behavior for malformed exports.
  assert.equal(req.url, 'api.example.com/no-scheme');
});

test('D2-9: unknown scheme in raw is NOT propagated (http/https only)', () => {
  const req = parseOne({
    raw: 'ftp://files.example.com/x',
    host: ['files', 'example', 'com'],
    path: ['x'],
  });
  // ftp is intentionally not allowed through the fallback.
  assert.equal(req.url, 'files.example.com/x');
});

test('D2-10: path variable declared empty falls back to {{name}} and keeps scheme', () => {
  const req = parseOne({
    raw: 'https://api.example.com/users/:id',
    host: ['api', 'example', 'com'],
    path: ['users', ':id'],
    variable: [{ key: 'id', value: '' }],
  });
  assert.equal(req.url, 'https://api.example.com/users/{{id}}');
});
