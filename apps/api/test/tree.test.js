'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/lib/postman/parser');
const { buildTree, resolveSelection, applySelection } = require('../src/lib/postman/tree');
const { generateK6Script } = require('../src/lib/k6/generator');

function makeCollection() {
  return {
    info: { name: 'Demo', schema: 'https://schema.postman.com/v2.1.0/collection.json' },
    item: [
      {
        name: 'Auth',
        item: [
          {
            name: 'Login',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }],
              url: { raw: 'https://api.example.com/login' },
              body: { mode: 'raw', raw: '{}' },
            },
          },
        ],
      },
      {
        name: 'Users',
        item: [
          {
            name: 'List users',
            request: {
              method: 'GET',
              header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
              url: { raw: 'https://api.example.com/users' },
            },
          },
          {
            name: 'Create user',
            request: {
              method: 'POST',
              header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
              url: { raw: 'https://api.example.com/users' },
              body: { mode: 'raw', raw: '{"name":"x"}' },
            },
          },
          {
            name: 'Subfolder',
            item: [
              {
                name: 'Get user',
                request: {
                  method: 'GET',
                  header: [],
                  url: { raw: 'https://api.example.com/users/{{userId}}' },
                },
              },
            ],
          },
        ],
      },
      {
        name: 'Health',
        request: {
          method: 'GET',
          header: [],
          url: { raw: 'https://api.example.com/health' },
        },
      },
    ],
  };
}

test('buildTree assigns request indices in collection order', () => {
  const collection = makeCollection();
  const parsed = parse(collection);
  const tree = buildTree(collection, parsed);

  assert.equal(tree.totalRequests, 5);
  // Order: Login, List users, Create user, Get user, Health
  assert.deepEqual(
    parsed.requests.map((r) => r.name),
    ['Login', 'List users', 'Create user', 'Get user', 'Health']
  );

  // Top-level: Auth folder, Users folder, Health request
  assert.equal(tree.tree[0].type, 'folder');
  assert.equal(tree.tree[0].name, 'Auth');
  assert.equal(tree.tree[1].name, 'Users');
  assert.equal(tree.tree[1].requestCount, 3);
  assert.equal(tree.tree[2].type, 'request');
  assert.equal(tree.tree[2].requestIndex, 4);
});

test('resolveSelection returns all indices when mode=all', () => {
  const parsed = parse(makeCollection());
  const set = resolveSelection({ mode: 'all' }, parsed.requests);
  assert.deepEqual([...set].sort(), [0, 1, 2, 3, 4]);
});

test('resolveSelection mode=single picks exactly one index', () => {
  const parsed = parse(makeCollection());
  const set = resolveSelection({ mode: 'single', requestIndex: 2 }, parsed.requests);
  assert.deepEqual([...set], [2]);
});

test('resolveSelection mode=requests filters arbitrary indices', () => {
  const parsed = parse(makeCollection());
  const set = resolveSelection(
    { mode: 'requests', requestIndices: [0, 4, 99] },
    parsed.requests
  );
  assert.deepEqual([...set].sort(), [0, 4]);
});

test('resolveSelection mode=folder picks all descendants', () => {
  const parsed = parse(makeCollection());
  const set = resolveSelection({ mode: 'folder', folderPath: ['Users'] }, parsed.requests);
  // Users has: List users (1), Create user (2), Subfolder/Get user (3)
  assert.deepEqual([...set].sort(), [1, 2, 3]);
});

test('resolveSelection mode=folder works for nested folders', () => {
  const parsed = parse(makeCollection());
  const set = resolveSelection(
    { mode: 'folder', folderPath: ['Users', 'Subfolder'] },
    parsed.requests
  );
  assert.deepEqual([...set], [3]);
});

test('applySelection preserves collection order and recomputes referencedVars', () => {
  const parsed = parse(makeCollection());
  const { parsed: filtered, selectedIndices } = applySelection(parsed, {
    mode: 'requests',
    requestIndices: [4, 1], // out of order on purpose
  });
  assert.deepEqual(selectedIndices, [1, 4]);
  assert.deepEqual(
    filtered.requests.map((r) => r.name),
    ['List users', 'Health']
  );
  // {{token}} is referenced by request 1 only; it must still appear.
  assert.ok(filtered.referencedVars.includes('token'));
  // {{userId}} is only referenced by request 3, which was filtered out.
  assert.ok(!filtered.referencedVars.includes('userId'));
});

test('generated K6 script for a single-request selection has only that one group', () => {
  const parsed = parse(makeCollection());
  const { parsed: filtered } = applySelection(parsed, {
    mode: 'single',
    requestIndex: 4, // Health
  });
  const code = generateK6Script(filtered, { injectAuthToken: false });
  // Only one group block
  const groupMatches = code.match(/group\(`/g) || [];
  assert.equal(groupMatches.length, 1);
  assert.match(code, /Health/);
  assert.doesNotMatch(code, /List users/);
  assert.doesNotMatch(code, /Create user/);
});

test('applySelection refuses unknown indices silently', () => {
  const parsed = parse(makeCollection());
  const { selectedIndices } = applySelection(parsed, {
    mode: 'requests',
    requestIndices: [-1, 99, 2],
  });
  assert.deepEqual(selectedIndices, [2]);
});
