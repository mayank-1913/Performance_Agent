'use strict';

/**
 * Auth tests: users.store CRUD, password hashing, JWT roundtrip,
 * requireAuth/requireRole middleware behavior, and AUTH_DISABLED bypass.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

async function tempDbPath() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'perf-auth-'));
  return path.join(dir, 'auth.sqlite');
}

/**
 * Reset env + module caches and require all auth modules fresh against a
 * brand new SQLite file. Returns the modules under test as a bundle so
 * each test can opt in to whatever it needs.
 */
function loadFreshAuth({ dbPath, authDisabled = false } = {}) {
  process.env.DB_PATH = dbPath;
  process.env.JWT_SECRET = 'test-secret-for-auth-tests';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.ADMIN_USERNAME = 'admin';
  process.env.ADMIN_PASSWORD = 'admin';
  process.env.AUTH_DISABLED = authDisabled ? '1' : '0';

  delete require.cache[require.resolve('../src/config/env')];
  delete require.cache[require.resolve('../src/config/db')];
  delete require.cache[require.resolve('../src/modules/auth/users.store')];
  delete require.cache[require.resolve('../src/modules/auth/auth.middleware')];

  return {
    env: require('../src/config/env'),
    usersStore: require('../src/modules/auth/users.store'),
    middleware: require('../src/modules/auth/auth.middleware'),
  };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
}

test('admin user is auto-seeded on first DB open', async () => {
  const dbPath = await tempDbPath();
  const { usersStore } = loadFreshAuth({ dbPath });
  const admin = usersStore.findByUsername('admin');
  assert.ok(admin, 'admin user must exist');
  assert.equal(admin.role, 'admin');
});

test('users.store: bcrypt verifyPassword accepts the seeded admin password', async () => {
  const dbPath = await tempDbPath();
  const { usersStore } = loadFreshAuth({ dbPath });
  const admin = usersStore.findByUsername('admin');
  assert.equal(usersStore.verifyPassword(admin, 'admin'), true);
  assert.equal(usersStore.verifyPassword(admin, 'wrong'), false);
  assert.equal(usersStore.verifyPassword(null, 'admin'), false);
});

test('users.store: create / update / remove lifecycle', async () => {
  const dbPath = await tempDbPath();
  const { usersStore } = loadFreshAuth({ dbPath });

  const created = usersStore.create({
    username: 'tester',
    password: 'pw1',
    role: 'user',
  });
  assert.equal(created.username, 'tester');
  assert.equal(created.role, 'user');

  // Public projection must NOT leak the password hash.
  assert.equal(created.password_hash, undefined);

  // Update password + role.
  const updated = usersStore.update(created.id, { password: 'pw2', role: 'admin' });
  assert.equal(updated.role, 'admin');
  const refreshed = usersStore.findById(created.id);
  assert.equal(usersStore.verifyPassword(refreshed, 'pw1'), false);
  assert.equal(usersStore.verifyPassword(refreshed, 'pw2'), true);

  // listPublic includes admin + tester, no hashes.
  const all = usersStore.listPublic();
  assert.ok(all.length >= 2);
  for (const u of all) assert.equal(u.password_hash, undefined);

  // Remove.
  assert.equal(usersStore.remove(created.id), true);
  assert.equal(usersStore.findById(created.id), undefined);
  assert.equal(usersStore.remove('not-an-id'), false);
});

test('users.store: create() validates inputs', async () => {
  const dbPath = await tempDbPath();
  const { usersStore } = loadFreshAuth({ dbPath });
  assert.throws(() => usersStore.create({ username: '', password: 'x' }), /required/);
  assert.throws(() => usersStore.create({ username: 'u', password: '' }), /required/);
  assert.throws(
    () => usersStore.create({ username: 'u', password: 'p', role: 'wizard' }),
    /invalid role/
  );
});

test('signToken / verifyToken roundtrip and reject garbage', async () => {
  const dbPath = await tempDbPath();
  const { usersStore, middleware } = loadFreshAuth({ dbPath });
  const admin = usersStore.findByUsername('admin');
  const token = middleware.signToken(admin);
  const payload = middleware.verifyToken(token);
  assert.equal(payload.username, 'admin');
  assert.equal(payload.role, 'admin');
  assert.equal(payload.sub, admin.id);
  assert.equal(middleware.verifyToken('not-a-token'), null);
  assert.equal(middleware.verifyToken(''), null);
});

test('extractToken reads Authorization header AND ?token= query param', async () => {
  const dbPath = await tempDbPath();
  const { middleware } = loadFreshAuth({ dbPath });

  assert.equal(
    middleware.extractToken({ headers: { authorization: 'Bearer abc.def.ghi' }, query: {} }),
    'abc.def.ghi'
  );
  // Mixed case is tolerated.
  assert.equal(
    middleware.extractToken({ headers: { Authorization: 'bearer XYZ' }, query: {} }),
    'XYZ'
  );
  // Falls back to query string.
  assert.equal(
    middleware.extractToken({ headers: {}, query: { token: 'qtok' } }),
    'qtok'
  );
  // Nothing present.
  assert.equal(middleware.extractToken({ headers: {}, query: {} }), null);
});

test('requireAuth: rejects requests with no token', async () => {
  const dbPath = await tempDbPath();
  const { middleware } = loadFreshAuth({ dbPath });
  const req = { headers: {}, query: {} };
  let captured = null;
  middleware.requireAuth(req, fakeRes(), (err) => (captured = err));
  assert.ok(captured, 'should call next(err)');
  assert.equal(captured.statusCode, 401);
  assert.equal(req.user, undefined);
});

test('requireAuth: accepts a valid token and attaches req.user', async () => {
  const dbPath = await tempDbPath();
  const { usersStore, middleware } = loadFreshAuth({ dbPath });
  const admin = usersStore.findByUsername('admin');
  const token = middleware.signToken(admin);
  const req = { headers: { authorization: `Bearer ${token}` }, query: {} };
  let nextErr = null;
  middleware.requireAuth(req, fakeRes(), (err) => (nextErr = err || null));
  assert.equal(nextErr, null);
  assert.ok(req.user);
  assert.equal(req.user.username, 'admin');
  assert.equal(req.user.role, 'admin');
});

test('requireAuth: AUTH_DISABLED=1 bypasses with a synthetic admin', async () => {
  const dbPath = await tempDbPath();
  const { middleware } = loadFreshAuth({ dbPath, authDisabled: true });
  const req = { headers: {}, query: {} };
  let nextErr = null;
  middleware.requireAuth(req, fakeRes(), (err) => (nextErr = err || null));
  assert.equal(nextErr, null);
  assert.equal(req.user.role, 'admin');
});

test('requireRole: admin bypasses, user is denied for admin-only routes', async () => {
  const dbPath = await tempDbPath();
  const { middleware } = loadFreshAuth({ dbPath });

  const adminReq = { user: { id: '1', username: 'a', role: 'admin' } };
  let err = 'unset';
  middleware.requireRole('admin')(adminReq, fakeRes(), (e) => (err = e || null));
  assert.equal(err, null);

  const userReq = { user: { id: '2', username: 'u', role: 'user' } };
  err = 'unset';
  middleware.requireRole('admin')(userReq, fakeRes(), (e) => (err = e || null));
  assert.ok(err);
  assert.equal(err.statusCode, 403);

  // Admin always passes a "user" role gate too.
  err = 'unset';
  middleware.requireRole('user')(adminReq, fakeRes(), (e) => (err = e || null));
  assert.equal(err, null);

  // Unauthenticated request gets 401.
  err = 'unset';
  middleware.requireRole('user')({}, fakeRes(), (e) => (err = e || null));
  assert.ok(err);
  assert.equal(err.statusCode, 401);
});


/* -------------------------------------------------------------------- */
/* Phase 8 regression: production startup must refuse a weak JWT_SECRET */
/* -------------------------------------------------------------------- */

function loadFreshEnvModule(overrides) {
  const modulePath = require.resolve('../src/config/env');
  delete require.cache[modulePath];
  const prior = {
    NODE_ENV: process.env.NODE_ENV,
    JWT_SECRET: process.env.JWT_SECRET,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  };
  Object.assign(process.env, overrides);
  try {
    return require('../src/config/env');
  } finally {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[modulePath];
  }
}

test('config: development environment tolerates the dev-default JWT secret', () => {
  const cfg = loadFreshEnvModule({
    NODE_ENV: 'development',
    JWT_SECRET: 'CHANGE_ME_DEV_ONLY_DO_NOT_USE_IN_PROD',
  });
  assert.equal(cfg.isProd, false);
  assert.equal(typeof cfg.jwtSecret, 'string');
});

test('config: production startup THROWS on any known unsafe JWT secret', () => {
  const unsafeValues = [
    'CHANGE_ME_DEV_ONLY_DO_NOT_USE_IN_PROD',
    'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
    'local-dev-secret-please-replace',
    'change-me',
    'secret',
    'test-secret',
    'dev',
    'password',
  ];
  for (const v of unsafeValues) {
    assert.throws(
      () => loadFreshEnvModule({ NODE_ENV: 'production', JWT_SECRET: v }),
      /JWT_SECRET/i,
      `expected ${JSON.stringify(v)} to be refused in production`
    );
  }
});

test('config: production startup THROWS when JWT_SECRET is shorter than 32 chars', () => {
  assert.throws(
    () => loadFreshEnvModule({ NODE_ENV: 'production', JWT_SECRET: 'a-real-looking-secret-too-short' }),
    /JWT_SECRET/i
  );
});

test('config: production startup ACCEPTS a strong JWT_SECRET + non-default admin password', () => {
  const strong = 'a'.repeat(48) + 'X9!' + Math.random().toString(36).slice(2, 10);
  const cfg = loadFreshEnvModule({
    NODE_ENV: 'production',
    JWT_SECRET: strong,
    ADMIN_PASSWORD: 'a-real-random-admin-password-9G7k',
  });
  assert.equal(cfg.isProd, true);
  assert.equal(cfg.jwtSecret, strong);
});

test('config: production startup THROWS on the admin/admin default password', () => {
  const strong = 'a'.repeat(48) + 'X9!zz';
  assert.throws(
    () => loadFreshEnvModule({ NODE_ENV: 'production', JWT_SECRET: strong, ADMIN_PASSWORD: 'admin' }),
    /ADMIN_PASSWORD/i
  );
});
