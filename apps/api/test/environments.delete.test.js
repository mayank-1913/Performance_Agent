'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

let tmp;
let server;
let token;
const PORT = 4351;

async function api(method, route, body) {
  const r = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, json };
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'env-del-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(tmp, 'db.sqlite');
  process.env.JWT_SECRET = 'env-delete-test-secret-32chars-min';
  process.env.ADMIN_USERNAME = 'env-del';
  process.env.ADMIN_PASSWORD = 'env-del-pass';
  process.env.LOG_LEVEL = 'error';
  const app = require('../src/app');
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  const login = await fetch(`http://127.0.0.1:${PORT}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'env-del', password: 'env-del-pass' }),
  });
  const body = await login.json();
  token = body.data.token;
});

after(() => {
  if (server) server.close();
});

test('DELETE /environments/:id removes environment and clears script references', async () => {
  const envPayload = {
    name: 'delete-me',
    values: [{ key: 'baseUrl', value: 'https://example.com', enabled: true }],
  };
  const boundary = '----envdel';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="environment"; filename="env.json"',
    'Content-Type: application/json',
    '',
    JSON.stringify(envPayload),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const upload = await fetch(`http://127.0.0.1:${PORT}/api/v1/environments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  assert.equal(upload.status, 201);
  const env = (await upload.json()).data;

  const scriptsStore = require('../src/modules/scripts/scripts.store');
  scriptsStore.add({
    id: 'script-with-env',
    collectionId: 'col-x',
    environmentId: env.id,
    fileName: 'x.js',
    filePath: path.join(tmp, 'x.js'),
    createdAt: new Date().toISOString(),
    injectAuthToken: false,
    expectedEnvVars: [],
    requestCount: 1,
  });
  fs.writeFileSync(path.join(tmp, 'x.js'), '// stub');

  const del = await api('DELETE', `/api/v1/environments/${env.id}`);
  assert.equal(del.status, 200);
  assert.equal(del.json.data.id, env.id);
  assert.ok(del.json.data.clearedScriptReferences >= 1);

  const get = await api('GET', `/api/v1/environments/${env.id}`);
  assert.equal(get.status, 404);

  const script = scriptsStore.get('script-with-env');
  assert.equal(script.environmentId, null);
});

test('DELETE /environments/:id does not expose secret values in response', async () => {
  const envPayload = {
    name: 'secret-env',
    values: [{ key: 'api_token', value: 'SUPER_SECRET_TOKEN_VALUE', enabled: true }],
  };
  const boundary = '----envdel2';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="environment"; filename="env.json"',
    'Content-Type: application/json',
    '',
    JSON.stringify(envPayload),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  const upload = await fetch(`http://127.0.0.1:${PORT}/api/v1/environments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  });
  const env = (await upload.json()).data;
  const del = await api('DELETE', `/api/v1/environments/${env.id}`);
  const text = JSON.stringify(del.json);
  assert.ok(!text.includes('SUPER_SECRET_TOKEN_VALUE'));
});
