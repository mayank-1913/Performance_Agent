'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase8-smoke-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(runRoot, 'db.sqlite');
process.env.JWT_SECRET = 'phase8-smoke-secret';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin';
process.env.LOG_LEVEL = 'error';

console.error('[phase8-smoke] booting api');
const app = require('../apps/api/src/app');

const server = http.createServer(app);
server.on('error', (err) => { console.error('server err', err.message); process.exit(2); });
server.listen(4200, '127.0.0.1', async () => {
  console.error('[phase8-smoke] listening');
  try {
    const res = await fetch('http://127.0.0.1:4200/api/v1/health');
    const j = await res.json();
    console.error('[phase8-smoke] /health status=' + res.status + ' body=' + JSON.stringify(j));
    const login = await fetch('http://127.0.0.1:4200/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin' }),
    });
    console.error('[phase8-smoke] login status=' + login.status);
    const lj = await login.json();
    console.error('[phase8-smoke] login body=' + JSON.stringify(lj).slice(0, 200));
  } catch (e) {
    console.error('smoke err', e.stack || e);
  } finally {
    server.close(() => process.exit(0));
  }
});
