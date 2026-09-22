'use strict';

/**
 * Phase 7 realistic test server.
 *
 * Extends the Phase 6.5 audit server with everything needed to certify
 * the full Postman feature matrix against a real k6 process:
 *   - GET / POST / PUT / PATCH / DELETE
 *   - path variables:      /users/:id, /orders/:orderId/items/:itemId
 *   - query variables:     /search?q=&limit=&tenant=
 *   - JSON body echo:      returns { received: <body>, method: <verb> }
 *   - urlencoded echo:     returns 200 iff a specific form field is present
 *   - cookies:             /session/set sets a cookie; /session/read echoes it
 *   - graphql:             POST /graphql accepts { query, variables }
 *   - custom auth header:  /custom-auth accepts X-Auth-Token: <token>
 *   - login/protected:     /login → { access_token }; /me expects Bearer token
 *   - failure endpoints:   /unauth (401), /badreq (400), /notfound (404),
 *                          /server-error (500), /slow?ms= (adjustable)
 *   - manual sentinel:     /manual-only accepts ONLY the manual sentinel
 *
 * Every "sensitive" value used by the server is a Phase 7 FAKE constant
 * that would be trivial to grep for in artifacts if it ever leaked.
 */

const http = require('http');

const SECRET_TOKEN     = 'PHASE7_ACCESS_TOKEN_FAKE_abc123';
const MANUAL_SENTINEL  = 'PHASE7_MANUAL_TOKEN_FAKE_xyz789';
const COOKIE_VALUE     = 'PHASE7_COOKIE_FAKE_zzz111';

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

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const kv of header.split(';')) {
    const [k, ...rest] = kv.trim().split('=');
    if (k) out[k] = rest.join('=');
  }
  return out;
}

function makeServer({ log = false } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    const method = req.method;
    if (log) process.stdout.write(`${method} ${req.url}\n`);
    try {
      // health + failure endpoints
      if (p === '/health') return send(res, 200, { ok: true, method });
      if (p === '/notfound') return send(res, 404, { error: 'not found' });
      if (p === '/unauth') return send(res, 401, { error: 'unauthorized' });
      if (p === '/badreq') return send(res, 400, { error: 'bad request' });
      if (p === '/server-error') return send(res, 500, { error: 'boom' });
      if (p === '/slow') {
        const ms = Math.min(5000, Number(url.searchParams.get('ms')) || 100);
        setTimeout(() => send(res, 200, { slept: ms }), ms);
        return;
      }

      // login + auth
      if (p === '/login' && method === 'POST') {
        await readBody(req);
        return send(res, 200, { access_token: SECRET_TOKEN, expires_in: 3600 });
      }
      if (p === '/me') {
        const auth = req.headers.authorization || '';
        if (auth === `Bearer ${SECRET_TOKEN}` || auth === `Bearer ${MANUAL_SENTINEL}`) {
          return send(res, 200, { user: 'test', id: 42, viaAuth: auth.slice(0, 6) + '…' });
        }
        return send(res, 401, { error: 'invalid token' });
      }
      if (p === '/manual-only') {
        // ONLY accepts the manual sentinel. Proves manual token wins over
        // the login-captured token when both are set.
        const auth = req.headers.authorization || '';
        if (auth === `Bearer ${MANUAL_SENTINEL}`) {
          return send(res, 200, { ok: true });
        }
        return send(res, 401, { error: 'expected manual sentinel', got: auth.slice(0, 8) + '…' });
      }
      if (p === '/custom-auth') {
        // Custom header auth — X-Auth-Token instead of Authorization.
        const t = req.headers['x-auth-token'] || '';
        if (t === SECRET_TOKEN || t === MANUAL_SENTINEL) {
          return send(res, 200, { ok: true, header: 'X-Auth-Token' });
        }
        return send(res, 401, { error: 'invalid X-Auth-Token' });
      }

      // path-variable routes
      const userIdMatch = p.match(/^\/users\/([^/]+)$/);
      if (userIdMatch) {
        const id = userIdMatch[1];
        if (method === 'GET')    return send(res, 200, { id, method });
        if (method === 'PUT')    return send(res, 200, { id, method, updated: true });
        if (method === 'PATCH')  return send(res, 200, { id, method, patched: true });
        if (method === 'DELETE') return send(res, 204, '');
      }
      const orderMatch = p.match(/^\/orders\/([^/]+)\/items\/([^/]+)$/);
      if (orderMatch) {
        return send(res, 200, { orderId: orderMatch[1], itemId: orderMatch[2], method });
      }

      // query-variable route
      if (p === '/search') {
        return send(res, 200, {
          q: url.searchParams.get('q'),
          limit: url.searchParams.get('limit'),
          tenant: url.searchParams.get('tenant'),
        });
      }

      // JSON body echo
      if (p === '/echo' && method === 'POST') {
        const raw = await readBody(req);
        try {
          return send(res, 200, { received: JSON.parse(raw), method });
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
      }

      // urlencoded echo
      if (p === '/form' && method === 'POST') {
        const raw = await readBody(req);
        const params = Object.fromEntries(new URLSearchParams(raw));
        // Verify at least one expected field is present.
        if (params.name && params.tenant) {
          return send(res, 200, { params, method });
        }
        return send(res, 400, { error: 'missing name or tenant', got: Object.keys(params) });
      }

      // cookies
      if (p === '/session/set') {
        return send(res, 200, { set: true }, {
          'Set-Cookie': `SESSION=${COOKIE_VALUE}; Path=/; HttpOnly`,
        });
      }
      if (p === '/session/read') {
        const cookies = parseCookies(req.headers.cookie);
        if (cookies.SESSION === COOKIE_VALUE) {
          return send(res, 200, { ok: true, hadCookie: true });
        }
        return send(res, 401, { error: 'no session cookie', got: Object.keys(cookies) });
      }

      // graphql
      if (p === '/graphql' && method === 'POST') {
        const raw = await readBody(req);
        try {
          const body = JSON.parse(raw);
          if (typeof body.query === 'string') {
            return send(res, 200, { data: { ok: true, len: body.query.length } });
          }
          return send(res, 400, { error: 'missing query field' });
        } catch {
          return send(res, 400, { error: 'invalid JSON' });
        }
      }

      return send(res, 404, { error: 'route not found', path: p, method });
    } catch (err) {
      return send(res, 500, { error: 'server exception', message: err.message });
    }
  });
}

function start(port) {
  return new Promise((resolve, reject) => {
    const server = makeServer();
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port }));
  });
}

module.exports = {
  makeServer,
  start,
  SECRET_TOKEN,
  MANUAL_SENTINEL,
  COOKIE_VALUE,
};
