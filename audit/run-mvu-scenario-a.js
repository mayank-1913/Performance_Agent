'use strict';

/**
 * Isolated PER_VU scenario A debugger — runs one certification scenario and prints k6 skip/auth lines.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const AGENT_PORT = 4247;
const TARGET_PORT = 4248;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const PASSWORD = 'MULTI_VU_CERT_PASS';

const USERS = [{ id: 'USER_A', username: 'user-a', token: 'TOKEN_A' }];

function targetServer() {
  const evidence = [];
  return {
    evidence,
    server: http.createServer(async (req, res) => {
      const url = new URL(req.url, TARGET);
      const auth = req.headers.authorization || '';
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const hit = { route: url.pathname, auth: auth.slice(0, 20), method: req.method };
        evidence.push(hit);
        if (url.pathname === '/login') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ token: 'TOKEN_A' }));
        }
        if (auth === 'Bearer TOKEN_A') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized', got: auth.slice(0, 30) }));
      });
    }),
  };
}

async function api(method, route, body, token) {
  const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body == null ? undefined : JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvu-a-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'mvu-cert-secret-32chars-minimum';
  process.env.ADMIN_USERNAME = 'mvu-cert';
  process.env.ADMIN_PASSWORD = 'mvu-cert';
  process.env.LOG_LEVEL = 'error';

  const { server: target, evidence } = targetServer();
  await new Promise((r) => target.listen(TARGET_PORT, '127.0.0.1', r));
  const app = require('../apps/api/src/app');
  const agent = http.createServer(app);
  await new Promise((r) => agent.listen(AGENT_PORT, '127.0.0.1', r));

  const collection = {
    info: { name: 'mvu-a', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          url: { raw: `${TARGET}/login` },
          header: [{ key: 'Content-Type', value: 'application/json' }],
          body: { mode: 'raw', raw: JSON.stringify({ username: 'user-a', password: PASSWORD }) },
        },
        event: [{
          listen: 'test',
          script: { exec: ['const j = pm.response.json(); pm.environment.set("access_token", j.token);'] },
        }],
      },
      {
        name: 'Protected',
        request: {
          method: 'GET',
          url: { raw: `${TARGET}/protected` },
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
        },
      },
    ],
  };

  try {
    const login = await api('POST', '/api/v1/auth/login', { username: 'mvu-cert', password: 'mvu-cert' });
    const token = login.json.data.token;
    const boundary = `----mvu-${Date.now()}`;
    const uploadBody = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="collection"; filename="c.json"',
      'Content-Type: application/json',
      '',
      JSON.stringify(collection),
      `--${boundary}--`,
      '',
    ].join('\r\n');
    const up = await fetch(`http://127.0.0.1:${AGENT_PORT}/api/v1/collections`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, Authorization: `Bearer ${token}` },
      body: uploadBody,
    });
    const collectionId = (await up.json()).data.id;

    const gen = await api('POST', '/api/v1/scripts/generate', {
      collectionId,
      options: {
        workload: { profile: 'smoke', authSessionMode: 'PER_VU_LOGIN', overrides: { vus: 1, hold: '3s' } },
      },
    }, token);

    const script = gen.json.data;
    const scriptPath = path.join(__dirname, '../apps/api/storage/scripts', `${script.id}.js`);
    const credDataset = JSON.stringify([{ id: 'USER_A', username: 'user-a', password: PASSWORD }]);

    const k6 = spawn('k6', ['run', '--vus', '1', '--duration', '3s', `"${scriptPath}"`], {
      env: {
        ...process.env,
        BASE_URL: TARGET,
        PA_CREDENTIAL_COUNT: '1',
        PA_CRED_0_LOGIN_USERNAME: 'user-a',
        PA_CRED_0_LOGIN_PASSWORD: PASSWORD,
        PACING_MS: '0',
      },
      shell: true,
    });
    let out = '';
    k6.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    k6.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    await new Promise((r) => k6.on('close', r));

    console.log('\n--- target evidence ---');
    console.log(JSON.stringify(evidence, null, 2));
    console.log('\n--- skip/auth lines ---');
    for (const line of out.split(/\r?\n/)) {
      if (/\[skip\]|\[auth\]|AUTH_/.test(line)) console.log(line);
    }
  } finally {
    agent.close();
    target.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
