'use strict';

/**
 * SQLite-aware reports store tests.
 *
 * Replaces the legacy file-based tests that mocked require.cache and the
 * old `configure({ indexPath })` API. Each test gets its own isolated
 * SQLite file via DB_PATH + a require-cache reset so getDb() rebuilds.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

async function tempDbPath() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perf-reports-sqlite-'));
  return path.join(dir, 'reports.sqlite');
}

/**
 * Resets the relevant require-cache entries and points the env at a new
 * (or existing) DB file. Returns a freshly required reports store module.
 *
 * Re-requiring config/db is what makes the in-process `_db` singleton
 * release, which lets us either:
 *   - simulate a process restart on the same file (pass an existing path)
 *   - get a brand-new DB for true isolation (pass a new path)
 */
function loadFreshStore(dbPath) {
  process.env.DB_PATH = dbPath;
  // Auth-related env so config/env is happy on first require.
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  process.env.ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
  process.env.ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/config/db')];
  delete require.cache[require.resolve('../src/modules/reports/reports.store')];
  return require('../src/modules/reports/reports.store');
}

function manifestFor(id, overrides = {}) {
  return {
    id,
    runId: id,
    scriptId: 's1',
    status: 'completed',
    collectionId: 'c1',
    collectionName: 'Demo collection',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    durationMs: 60000,
    exitCode: 0,
    error: null,
    loadProfile: { vus: 5 },
    selection: { mode: 'all' },
    selectedRequests: [],
    requestCount: 4,
    totalCollectionRequests: 4,
    authFlow: null,
    env: { BASE_URL: 'https://x' },
    displayMethod: 'GET',
    displayApiName: 'Demo API',
    metrics: {
      totalRequests: 200,
      failedRequests: 4,
      errorRate: 0.02,
      rps: 12.5,
      avg: 100,
      p95: 200,
      p99: 400,
      vusMax: 5,
      iterations: 200,
      dataSent: 1024,
      dataReceived: 8192,
    },
    thresholds: { passed: 2, failed: 0, total: 2 },
    artifacts: {
      dir: '/tmp/x',
      summaryExportPath: '/tmp/x/summary.json',
      metricsJsonPath: '/tmp/x/metrics.json',
      parsedSummaryPath: '/tmp/x/parsed-summary.json',
      reportHtmlPath: '/tmp/x/report.html',
      logFilePath: '/tmp/x/log.log',
      scriptFilePath: '/tmp/x/script.js',
    },
    ...overrides,
  };
}

test('reports.store persists across simulated process restarts', async () => {
  const dbPath = await tempDbPath();

  // First "process": add two reports.
  let store = loadFreshStore(dbPath);
  await store.init();
  await store.add(manifestFor('a', { displayApiName: 'API A' }));
  await store.add(
    manifestFor('b', {
      displayApiName: 'API B',
      startedAt: '2026-01-02T00:00:00.000Z',
    })
  );
  assert.equal(store.list().length, 2);

  // Second "process": same DB file, fresh module cache.
  store = loadFreshStore(dbPath);
  await store.init();
  const items = store.list();
  assert.equal(items.length, 2);
  // Sorted by startedAt desc.
  assert.equal(items[0].id, 'b');
  assert.equal(items[1].id, 'a');
  assert.equal(items[0].displayApiName, 'API B');
});

test('reports.store remove() drops the entry from the DB', async () => {
  const dbPath = await tempDbPath();

  let store = loadFreshStore(dbPath);
  await store.init();
  await store.add(manifestFor('x'));
  await store.add(manifestFor('y'));
  assert.equal(store.list().length, 2);

  const removed = store.remove('x');
  assert.equal(removed, true);

  // Reopen DB to make sure the delete was persisted.
  store = loadFreshStore(dbPath);
  await store.init();
  const items = store.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'y');

  // Removing a missing id is a no-op that returns false.
  assert.equal(store.remove('does-not-exist'), false);
});

test('reports.store update() merges fields and bumps updatedAt', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();

  const original = await store.add(manifestFor('z', { status: 'completed' }));
  // SQLite resolution + fast hardware can produce identical ISO strings; wait
  // a hair to guarantee a different `updated_at`.
  await new Promise((r) => setTimeout(r, 10));

  const updated = await store.update('z', { status: 'failed', error: 'boom' });
  assert.equal(updated.id, 'z');
  assert.equal(updated.status, 'failed');
  assert.equal(updated.error, 'boom');
  // Untouched fields survive the merge.
  assert.equal(updated.displayApiName, 'Demo API');
  assert.notEqual(updated.updatedAt, original.updatedAt);
});

test('reports.store update() returns null for an unknown id', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();
  const result = await store.update('nope', { status: 'failed' });
  assert.equal(result, null);
});

test('reports.store add() requires an id', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();
  assert.throws(() => store.add({}), /id is required/);
});

test('reports.store get() finds a row by either id or runId', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();
  await store.add(manifestFor('run-42'));
  const byId = store.get('run-42');
  assert.ok(byId);
  assert.equal(byId.id, 'run-42');
  assert.equal(byId.runId, 'run-42');
});

test('reports.store list() orders by startedAt desc', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();

  await store.add(manifestFor('mid', { startedAt: '2026-02-01T00:00:00.000Z' }));
  await store.add(manifestFor('old', { startedAt: '2026-01-01T00:00:00.000Z' }));
  await store.add(manifestFor('new', { startedAt: '2026-03-01T00:00:00.000Z' }));

  const ids = store.list().map((r) => r.id);
  assert.deepEqual(ids, ['new', 'mid', 'old']);
});

test('reports.store round-trips JSON-shaped fields (metrics, thresholds, loadProfile)', async () => {
  const dbPath = await tempDbPath();
  const store = loadFreshStore(dbPath);
  await store.init();

  await store.add(
    manifestFor('shape', {
      loadProfile: { vus: 9, duration: '30s' },
      thresholds: { passed: 7, failed: 1, total: 8 },
      metrics: { totalRequests: 300, failedRequests: 12, errorRate: 0.04, p95: 250, avg: 120 },
    })
  );

  const got = store.get('shape');
  assert.equal(got.loadProfile.vus, 9);
  assert.equal(got.loadProfile.duration, '30s');
  assert.equal(got.thresholds.failed, 1);
  assert.equal(got.metrics.errorRate, 0.04);
  assert.equal(got.metrics.p95, 250);
});
