'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

let tmpDir;
let dbPath;

before(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perf-db-'));
  dbPath = path.join(tmpDir, 'test.sqlite');
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'test-secret';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin';
});

after(async () => {
  // Best-effort cleanup
  try {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('SQLite database file is auto-created and admin is seeded', () => {
  // Defer require until env is configured
  const { getDb } = require('../src/config/db');
  const db = getDb();
  assert.ok(fs.existsSync(dbPath), 'sqlite file must be created on disk');
  const row = db
    .prepare('SELECT username, role FROM users WHERE username = ?')
    .get('admin');
  assert.equal(row.username, 'admin');
  assert.equal(row.role, 'admin');
});

test('users.store: verifyPassword + create + listPublic', () => {
  const usersStore = require('../src/modules/auth/users.store');
  const admin = usersStore.findByUsername('admin');
  assert.ok(admin);
  assert.equal(usersStore.verifyPassword(admin, 'admin'), true);
  assert.equal(usersStore.verifyPassword(admin, 'wrong'), false);

  const u = usersStore.create({ username: 'tester', password: 'pw', role: 'user' });
  assert.equal(u.username, 'tester');
  assert.equal(u.role, 'user');
  const all = usersStore.listPublic();
  assert.ok(all.length >= 2);
});

test('JWT roundtrip via auth.middleware', () => {
  const { signToken, verifyToken } = require('../src/modules/auth/auth.middleware');
  const usersStore = require('../src/modules/auth/users.store');
  const admin = usersStore.findByUsername('admin');
  const token = signToken(admin);
  const payload = verifyToken(token);
  assert.equal(payload.username, 'admin');
  assert.equal(payload.role, 'admin');
  assert.equal(verifyToken('not-a-token'), null);
});

test('reports store survives across instances (i.e. a process restart proxy)', () => {
  const reportsStore = require('../src/modules/reports/reports.store');
  reportsStore.add({
    id: 'r1',
    runId: 'r1',
    scriptId: 's1',
    status: 'completed',
    collectionName: 'C',
    startedAt: '2026-01-01T00:00:00Z',
    endedAt: '2026-01-01T00:01:00Z',
    durationMs: 60000,
    exitCode: 0,
    displayMethod: 'GET',
    displayApiName: 'API A',
    metrics: { totalRequests: 1, failedRequests: 0, errorRate: 0 },
    thresholds: { passed: 1, failed: 0, total: 1 },
    artifacts: {
      dir: '/tmp/x',
      reportHtmlPath: '/tmp/x/report.html',
    },
    createdAt: '2026-01-01T00:01:00Z',
  });

  // Drop the require cache for the store to simulate a fresh import.
  delete require.cache[require.resolve('../src/modules/reports/reports.store')];
  const fresh = require('../src/modules/reports/reports.store');
  const items = fresh.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'r1');
  assert.equal(items[0].displayApiName, 'API A');

  fresh.remove('r1');
  assert.equal(fresh.list().length, 0);
});

test('collections store keeps raw JSON on disk, not in DB', () => {
  // Reset the store cache so it reads cleanly with the configured DB.
  delete require.cache[require.resolve('../src/modules/collections/collections.store')];
  const collectionsStore = require('../src/modules/collections/collections.store');

  const id = 'col-1';
  collectionsStore.add({
    id,
    originalName: 'demo.json',
    storedName: 'demo.json',
    filePath: '/tmp/demo.json',
    mimetype: 'application/json',
    sizeBytes: 5,
    uploadedAt: '2026-01-01T00:00:00Z',
    summary: { name: 'Demo', requestCount: 1, folderCount: 0 },
    auth: null,
    raw: { info: { name: 'Demo' }, item: [] },
  });

  // Raw must exist on disk in the storage/collections-raw directory of THIS test workspace.
  const rawDir = path.resolve(
    __dirname,
    '..',
    'storage',
    'collections-raw'
  );
  const rawFile = path.join(rawDir, `${id}.json`);
  assert.ok(fs.existsSync(rawFile), 'raw collection must be persisted to disk');

  const got = collectionsStore.get(id);
  assert.equal(got.summary.name, 'Demo');
  // The lazy `raw` getter rehydrates from disk.
  assert.deepEqual(got.raw.info.name, 'Demo');

  // Cleanup
  collectionsStore.remove(id);
  assert.ok(!fs.existsSync(rawFile), 'raw file must be removed on delete');
});
