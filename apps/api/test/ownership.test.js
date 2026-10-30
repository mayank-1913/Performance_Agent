'use strict';

/**
 * Phase 9 — ownership, RBAC and IDOR tests. Exercises every protected
 * resource end-to-end over real HTTP against a fresh app instance:
 *
 *   - ADMIN sees everything, both of its own and other users' resources.
 *   - USER sees only their own rows; cross-user access returns 404 (IDOR).
 *   - USER cannot DELETE anything (403 at the route layer, before the
 *     ownership check); hiding the UI button is defence-in-depth.
 *   - A USER cannot elevate themselves to ADMIN by posting role in the
 *     body of /auth/users or /auth/users/:id.
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

let tmp;
let server;
let base;
let PORT;

/* ---------- small http client ---------- */
function pickPort() {
  // Random port in a high range to avoid clashing with other suites.
  return 4600 + Math.floor(Math.random() * 400);
}
async function json(method, route, { token, body } = {}) {
  const r = await fetch(`${base}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await r.json();
  } catch {
    /* non-json */
  }
  return { status: r.status, json: data };
}
async function login(username, password) {
  const r = await json('POST', '/api/v1/auth/login', {
    body: { username, password },
  });
  if (r.status !== 200) {
    throw new Error(`login failed for ${username}: ${JSON.stringify(r.json)}`);
  }
  return r.json.data.token;
}
async function uploadCollection(token, name) {
  const payload = {
    info: { name, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [
      {
        name: 'ping',
        request: { method: 'GET', url: 'https://example.com/ping' },
      },
    ],
  };
  const boundary = '----own' + Math.random().toString(36).slice(2, 8);
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="collection"; filename="c.json"',
      'Content-Type: application/json',
      '',
      JSON.stringify(payload),
      `--${boundary}--`,
      '',
    ].join('\r\n')
  );
  const r = await fetch(`${base}/api/v1/collections`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`upload failed: ${JSON.stringify(j)}`);
  return j.data;
}
async function uploadEnvironment(token, name) {
  const payload = {
    name,
    values: [{ key: 'baseUrl', value: 'https://example.com', enabled: true }],
  };
  const boundary = '----own' + Math.random().toString(36).slice(2, 8);
  const body = Buffer.from(
    [
      `--${boundary}`,
      'Content-Disposition: form-data; name="environment"; filename="e.json"',
      'Content-Type: application/json',
      '',
      JSON.stringify(payload),
      `--${boundary}--`,
      '',
    ].join('\r\n')
  );
  const r = await fetch(`${base}/api/v1/environments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const j = await r.json();
  if (r.status !== 201) throw new Error(`env upload failed: ${JSON.stringify(j)}`);
  return j.data;
}
async function generateScript(token, collectionId) {
  const r = await json('POST', '/api/v1/scripts/generate', {
    token,
    body: { collectionId },
  });
  if (r.status !== 201) throw new Error(`generate failed: ${JSON.stringify(r.json)}`);
  return r.json.data;
}

/* ---------- setup ---------- */
let adminToken, userAToken, userBToken, userAId, userBId;
let collA, collB, envA, envB, scriptA, scriptB;

before(async () => {
  PORT = pickPort();
  base = `http://127.0.0.1:${PORT}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(tmp, 'db.sqlite');
  process.env.JWT_SECRET = 'ownership-test-secret-at-least-32-chars-xxxxxx';
  process.env.ADMIN_USERNAME = 'root';
  process.env.ADMIN_PASSWORD = 'root-pass';
  process.env.LOG_LEVEL = 'error';
  // Keep storage dirs inside the tmp dir so this test doesn't touch the
  // developer's local workspace.
  process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

  // Clear require cache so the app picks up our env.
  for (const k of Object.keys(require.cache)) {
    if (/perf-api|apps[\\/]+api[\\/]+src/.test(k)) delete require.cache[k];
  }
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

  // Admin login + create two normal users.
  adminToken = await login('root', 'root-pass');
  const makeA = await json('POST', '/api/v1/auth/users', {
    token: adminToken,
    body: { username: 'alice', password: 'alice-pw', role: 'user' },
  });
  assert.equal(makeA.status, 201, JSON.stringify(makeA.json));
  userAId = makeA.json.data.id;
  const makeB = await json('POST', '/api/v1/auth/users', {
    token: adminToken,
    body: { username: 'bob', password: 'bob-pw', role: 'user' },
  });
  assert.equal(makeB.status, 201, JSON.stringify(makeB.json));
  userBId = makeB.json.data.id;

  userAToken = await login('alice', 'alice-pw');
  userBToken = await login('bob', 'bob-pw');

  // Each user owns a collection + env + script.
  collA = await uploadCollection(userAToken, 'alice-collection');
  envA = await uploadEnvironment(userAToken, 'alice-env');
  scriptA = await generateScript(userAToken, collA.id);

  collB = await uploadCollection(userBToken, 'bob-collection');
  envB = await uploadEnvironment(userBToken, 'bob-env');
  scriptB = await generateScript(userBToken, collB.id);
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  try {
    await fsp.rm(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/* ---------------------------------------------------------------- */
/*  AUTH + USER MANAGEMENT                                           */
/* ---------------------------------------------------------------- */

test('auth: /auth/me returns the authenticated identity + role', async () => {
  const me = await json('GET', '/api/v1/auth/me', { token: userAToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.user.username, 'alice');
  assert.equal(me.json.data.user.role, 'user');
});

test('rbac: USER cannot list users', async () => {
  const r = await json('GET', '/api/v1/auth/users', { token: userAToken });
  assert.equal(r.status, 403);
});

test('rbac: USER cannot create or delete users', async () => {
  const create = await json('POST', '/api/v1/auth/users', {
    token: userAToken,
    body: { username: 'rogue', password: 'x', role: 'admin' },
  });
  assert.equal(create.status, 403);

  const del = await json('DELETE', `/api/v1/auth/users/${userBId}`, { token: userAToken });
  assert.equal(del.status, 403);
});

test('rbac: USER cannot elevate themselves via PUT role=admin', async () => {
  const r = await json('PUT', `/api/v1/auth/users/${userAId}`, {
    token: userAToken,
    body: { role: 'admin' },
  });
  assert.equal(r.status, 403);
  // And confirm the role did not change.
  const me = await json('GET', '/api/v1/auth/me', { token: userAToken });
  assert.equal(me.json.data.user.role, 'user');
});

/* ---------------------------------------------------------------- */
/*  LIST FILTERING                                                   */
/* ---------------------------------------------------------------- */

test('collections: USER list returns only own; ADMIN list returns all', async () => {
  const aliceList = await json('GET', '/api/v1/collections', { token: userAToken });
  assert.equal(aliceList.status, 200);
  const aliceIds = aliceList.json.data.map((c) => c.id);
  assert.ok(aliceIds.includes(collA.id));
  assert.ok(!aliceIds.includes(collB.id), 'alice must not see bob collection');

  const adminList = await json('GET', '/api/v1/collections', { token: adminToken });
  const adminIds = adminList.json.data.map((c) => c.id);
  assert.ok(adminIds.includes(collA.id) && adminIds.includes(collB.id));
});

test('environments: USER list is scoped; ADMIN list is global', async () => {
  const alice = await json('GET', '/api/v1/environments', { token: userAToken });
  const ids = alice.json.data.map((e) => e.id);
  assert.ok(ids.includes(envA.id) && !ids.includes(envB.id));

  const admin = await json('GET', '/api/v1/environments', { token: adminToken });
  const adminIds = admin.json.data.map((e) => e.id);
  assert.ok(adminIds.includes(envA.id) && adminIds.includes(envB.id));
});

test('scripts: USER list is scoped; ADMIN list is global', async () => {
  const alice = await json('GET', '/api/v1/scripts', { token: userAToken });
  const ids = alice.json.data.map((s) => s.id);
  assert.ok(ids.includes(scriptA.id) && !ids.includes(scriptB.id));

  const admin = await json('GET', '/api/v1/scripts', { token: adminToken });
  const adminIds = admin.json.data.map((s) => s.id);
  assert.ok(adminIds.includes(scriptA.id) && adminIds.includes(scriptB.id));
});

/* ---------------------------------------------------------------- */
/*  IDOR — GET BY ID                                                 */
/* ---------------------------------------------------------------- */

test('IDOR: alice GET bob collection -> 404', async () => {
  const r = await json('GET', `/api/v1/collections/${collB.id}`, { token: userAToken });
  assert.equal(r.status, 404);
});

test('IDOR: alice GET bob environment -> 404', async () => {
  const r = await json('GET', `/api/v1/environments/${envB.id}`, { token: userAToken });
  assert.equal(r.status, 404);
});

test('IDOR: alice GET bob script -> 404', async () => {
  const r = await json('GET', `/api/v1/scripts/${scriptB.id}`, { token: userAToken });
  assert.equal(r.status, 404);
  const dl = await json('GET', `/api/v1/scripts/${scriptB.id}/download`, { token: userAToken });
  assert.equal(dl.status, 404);
});

test('IDOR: alice cannot generate a script against bob collection', async () => {
  const r = await json('POST', '/api/v1/scripts/generate', {
    token: userAToken,
    body: { collectionId: collB.id },
  });
  assert.equal(r.status, 404);
});

test('IDOR: alice cannot use bob environment in her own generate call', async () => {
  const r = await json('POST', '/api/v1/scripts/generate', {
    token: userAToken,
    body: { collectionId: collA.id, environmentId: envB.id },
  });
  assert.equal(r.status, 404);
});

test('IDOR: alice cannot prepare a run with bob script', async () => {
  const r = await json('POST', '/api/v1/runs/prepare', {
    token: userAToken,
    body: { scriptId: scriptB.id },
  });
  assert.equal(r.status, 404);
});

/* ---------------------------------------------------------------- */
/*  DELETE RESTRICTION                                                */
/* ---------------------------------------------------------------- */

test('delete: USER cannot DELETE collections (403)', async () => {
  const r = await json('DELETE', `/api/v1/collections/${collA.id}`, { token: userAToken });
  assert.equal(r.status, 403);
});

test('delete: USER cannot DELETE environments (403)', async () => {
  const r = await json('DELETE', `/api/v1/environments/${envA.id}`, { token: userAToken });
  assert.equal(r.status, 403);
});

test('delete: USER cannot DELETE reports (403)', async () => {
  // We don't have a real report in this suite (would require k6), but the
  // route-level role gate must still refuse before the handler runs.
  const r = await json('DELETE', '/api/v1/reports/does-not-exist', { token: userAToken });
  assert.equal(r.status, 403);
});

test('delete: USER cannot DELETE bob collection either (still 403, not 404)', async () => {
  // The route-level `requireRole('admin')` runs BEFORE the handler, so a
  // normal user hitting any id — their own or someone else's — gets 403.
  // This matters: USER must never be able to probe existence via delete.
  const r = await json('DELETE', `/api/v1/collections/${collB.id}`, { token: userAToken });
  assert.equal(r.status, 403);
});

test('delete: ADMIN can delete any user resource', async () => {
  // Create a throwaway collection owned by alice, then let admin delete it.
  const throwaway = await uploadCollection(userAToken, 'tmp');
  const r = await json('DELETE', `/api/v1/collections/${throwaway.id}`, { token: adminToken });
  assert.equal(r.status, 200);
  // And alice no longer sees it.
  const after = await json('GET', `/api/v1/collections/${throwaway.id}`, { token: userAToken });
  assert.equal(after.status, 404);
});

/* ---------------------------------------------------------------- */
/*  OWNERSHIP STAMPING SOURCE                                         */
/* ---------------------------------------------------------------- */

test('ownership: body-provided ownerId does NOT override authenticated identity', async () => {
  // Try to upload a collection as alice but ask for admin ownership.
  // The multipart upload only accepts the `collection` file; there's no
  // way to pass an ownerId. This test documents the invariant.
  const uploaded = await uploadCollection(userAToken, 'owner-stamp-check');
  const admin = await json('GET', `/api/v1/collections/${uploaded.id}`, { token: adminToken });
  assert.equal(admin.status, 200);
  const bobView = await json('GET', `/api/v1/collections/${uploaded.id}`, { token: userBToken });
  // Not alice -> 404 for bob.
  assert.equal(bobView.status, 404);
});
