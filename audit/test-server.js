'use strict';

/**
 * Phase 6.5 audit — local HTTP test server.
 *
 * Provides deterministic endpoints for the k6 runtime audit. Never used
 * in production; only spun up by scripts under `audit/`. All routes
 * return small JSON bodies so we can assert on request counts / failure
 * modes without depending on any external service.
 *
 * Endpoints:
 *   GET  /health                       → 200 {ok:true}
 *   GET  /slow?ms=500                  → 200 after sleeping ms
 *   GET  /notfound                     → 404
 *   GET  /unauth                       → 401
 *   GET  /badreq                       → 400
 *   GET  /server-error                 → 500
 *   POST /login                        → 200 { access_token: SECRET_TOKEN }
 *   GET  /me                           → 200 if Authorization: Bearer SECRET_TOKEN, else 401
 */

const http = require('http');

const SECRET_TOKEN = 'audit-token-do-not-leak-9f8e7d6c5b4a';

function send(res, status, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
  });
}

function makeServer({ log = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (log) process.stdout.write(`${req.method} ${req.url}\n`);
    try {
      if (path === '/health') return send(res, 200, { ok: true });
      if (path === '/notfound') return send(res, 404, { error: 'not found' });
      if (path === '/unauth') return send(res, 401, { error: 'unauthorized' });
      if (path === '/badreq') return send(res, 400, { error: 'bad request' });
      if (path === '/server-error') return send(res, 500, { error: 'boom' });
      if (path === '/slow') {
        const ms = Math.min(5000, Number(url.searchParams.get('ms')) || 100);
        setTimeout(() => send(res, 200, { slept: ms }), ms);
        return;
      }
      if (path === '/login' && req.method === 'POST') {
        await readBody(req);
        return send(res, 200, { access_token: SECRET_TOKEN, expires_in: 3600 });
      }
      if (path === '/me') {
        const auth = req.headers.authorization || req.headers.Authorization || '';
        if (auth === `Bearer ${SECRET_TOKEN}`) {
          return send(res, 200, { user: 'test', id: 42 });
        }
        return send(res, 401, { error: 'invalid token', received: auth.slice(0, 8) + '…' });
      }
      return send(res, 404, { error: 'route not found', path });
    } catch (err) {
      return send(res, 500, { error: 'server exception', message: err.message });
    }
  });
  return server;
}

function start(port = 3999) {
  return new Promise((resolve, reject) => {
    const server = makeServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port, SECRET_TOKEN }));
  });
}

if (require.main === module) {
  start(Number(process.env.PORT) || 3999).then(({ port }) => {
    console.log(`audit test server listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { makeServer, start, SECRET_TOKEN };
