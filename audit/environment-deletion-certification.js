'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT_PORT = 4245;
const SECRET = 'ENV_DEL_CERT_SECRET';

async function api(port, method, route, body, token) {
  const r = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  return { status: r.status, json };
}

function uploadEnv(port, token, payload) {
  const boundary = '----envdelcert';
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="environment"; filename="env.json"',
    'Content-Type: application/json',
    '',
    JSON.stringify(payload),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  return fetch(`http://127.0.0.1:${port}/api/v1/environments`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      Authorization: `Bearer ${token}`,
    },
    body,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'env-del-cert-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'env-del-cert-secret-32chars';
  process.env.ADMIN_USERNAME = 'env-del-cert';
  process.env.ADMIN_PASSWORD = 'env-del-cert';
  process.env.LOG_LEVEL = 'error';

  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const login = await api(AGENT_PORT, 'POST', '/api/v1/auth/login', {
      username: 'env-del-cert',
      password: 'env-del-cert',
    });
    const token = login.json.data.token;

    const env = await uploadEnv(AGENT_PORT, token, {
      name: 'deletion-cert',
      values: [{ key: 'api_secret', value: SECRET, enabled: true }],
    });
    const envId = env.json.data.id;

    const collectionsStore = require('../apps/api/src/modules/collections/collections.store');
    const { v4: uuidv4 } = require('uuid');
    const collectionId = uuidv4();
    collectionsStore.add({
      id: collectionId,
      originalName: 'cert.json',
      summary: { name: 'env-del-col', requestCount: 1 },
      raw: { info: { name: 'env-del-col', schema: 'v2.1' }, item: [{ name: 'H', request: { method: 'GET', url: { raw: 'https://example.com' } } }] },
    });

    const generated = await api(AGENT_PORT, 'POST', '/api/v1/scripts/generate', {
      collectionId,
      environmentId: envId,
      options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '1s' } } },
    }, token);

    const del = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/environments/${envId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    const delBody = await del.json();
    const get = await api(AGENT_PORT, 'GET', `/api/v1/environments/${envId}`, null, token);
    const scriptsStore = require('../apps/api/src/modules/scripts/scripts.store');
    const script = scriptsStore.get(generated.json.data.id);

    const responseText = JSON.stringify(delBody);
    const pass =
      del.status === 200 &&
      get.status === 404 &&
      script.environmentId === null &&
      !responseText.includes(SECRET);

    console.log(JSON.stringify({
      pass,
      deleteStatus: del.status,
      getAfterDelete: get.status,
      scriptEnvCleared: script.environmentId === null,
      secretLeaked: responseText.includes(SECRET),
    }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
