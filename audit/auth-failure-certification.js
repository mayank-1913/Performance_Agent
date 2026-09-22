'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT_PORT = 4241;
const TARGET_PORT = 4242;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const SECRET = 'FAIL_CERT_PASSWORD_7x';
let mode = 'success';
let evidence = [];

function send(res, status, body) { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text); }
function read(req) { return new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); }); }
function authCount(req) { return req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length; }
function targetServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, TARGET); const count = authCount(req); const auth = req.headers.authorization || '';
    if (url.pathname.includes('{{') || url.pathname.includes('undefined') || url.pathname.includes('/null')) return send(res, 400, { error: 'unresolved placeholder' });
    if (url.pathname === '/login') {
      await read(req);
      if (mode === 'login401') { evidence.push({ name: 'LOGIN', status: 401, authReceived: false, authHeaderCount: count }); return send(res, 401, { error: 'invalid credentials' }); }
      const token = mode === 'noToken' ? undefined : 'FAIL_RUNTIME_TOKEN';
      evidence.push({ name: 'LOGIN', status: 200, tokenExtracted: !!token && mode !== 'missingCapture', authReceived: false, authHeaderCount: count });
      return send(res, 200, token ? { token, data: { token, id: 'FAIL_ID' } } : { ok: true });
    }
    const authorized = count === 1 && (auth === 'Bearer FAIL_RUNTIME_TOKEN' || auth === 'Bearer MANUAL_FAIL_TOKEN');
    if (!authorized) { evidence.push({ name: url.pathname, status: 401, authReceived: false, authHeaderCount: count, classification: 'authentication' }); return send(res, 401, { error: 'unauthorized' }); }
    if (mode === 'subsequent401') { evidence.push({ name: url.pathname, status: 401, authReceived: true, authHeaderCount: count, classification: 'authentication' }); return send(res, 401, { error: 'expired token' }); }
    if (url.pathname === '/protected') { evidence.push({ name: 'PROTECTED', status: 200, authReceived: true, authHeaderCount: count }); return send(res, 200, { ok: true }); }
    if (url.pathname === '/create' && req.method === 'POST') { evidence.push({ name: 'CREATE', status: 201, authReceived: true, authHeaderCount: count, idExtracted: true }); return send(res, 201, { id: 'FAIL_CAMPAIGN' }); }
    if (url.pathname.startsWith('/campaign/')) { evidence.push({ name: req.method === 'PUT' ? 'EDIT' : 'DELETE', status: 200, authReceived: true, authHeaderCount: count, campaignId: url.pathname.split('/').pop() }); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'not found' });
  });
}
function collection({ tokenName = 'custom_fail_token', credentials = true, capturePath = 'token', folder = false, duplicateAuth = false }) {
  const loginBody = credentials ? JSON.stringify({ username: 'fail-cert-user', password: SECRET }) : JSON.stringify({ username: '{{missing_user}}', password: '{{missing_password}}' });
  const login = { name: 'Login', request: { method: 'POST', url: { raw: `${TARGET}/login` }, header: [], body: { mode: 'raw', raw: loginBody } }, event: [{ listen: 'test', script: { exec: [`const jsonData = pm.response.json(); pm.environment.set("${tokenName}", jsonData.${capturePath});`] } }] };
  const authHeaders = [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }]; if (duplicateAuth) authHeaders.push({ key: 'Authorization', value: `Bearer {{${tokenName}}}` });
  const items = [login, { name: 'Protected', request: { method: 'GET', url: { raw: `${TARGET}/protected` }, header: authHeaders } }, { name: 'Create', request: { method: 'POST', url: { raw: `${TARGET}/create` }, header: authHeaders, body: { mode: 'raw', raw: '{}' } }, event: [{ listen: 'test', script: { exec: ['const res = pm.response.json(); pm.environment.set("custom_id", res.id);'] } }] }, { name: 'Edit', request: { method: 'PUT', url: { raw: `${TARGET}/campaign/{{custom_id}}` }, header: authHeaders } }, { name: 'Delete', request: { method: 'DELETE', url: { raw: `${TARGET}/campaign/{{custom_id}}` }, header: authHeaders } }];
  return { info: { name: 'failure-cert', schema: 'v2.1' }, variable: [{ key: 'baseUrl', value: TARGET }], item: folder ? [{ name: 'Selected', item: items.slice(0, 3) }, { name: 'Unselected', item: [{ name: 'Unrelated', request: { method: 'GET', url: { raw: `${TARGET}/{{unrelated_missing}}` }, header: [] } }] }] : items };
}
function form(field, filename, value) { const boundary = `----fail-${Math.random().toString(36).slice(2)}`; return { boundary, body: [`--${boundary}`, `Content-Disposition: form-data; name="${field}"; filename="${filename}"`, 'Content-Type: application/json', '', JSON.stringify(value), `--${boundary}--`, ''].join('\r\n') }; }
async function api(method, route, value, token) { const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: value == null ? undefined : JSON.stringify(value) }); return { status: r.status, json: await r.json() }; }
async function upload(route, field, value, token) { const m = form(field, 'cert.json', value); const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}`, Authorization: `Bearer ${token}` }, body: m.body }); return { status: r.status, json: await r.json() }; }
async function wait(token, id) { for (let i = 0; i < 160; i += 1) { const r = await api('GET', `/api/v1/runs/${id}`, null, token); if (['completed', 'failed', 'stopped'].includes(r.json?.data?.status)) return r.json.data; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error('timeout'); }
function leaks(run) { const root = path.resolve(__dirname, '..', 'apps', 'api'); const files = []; const add = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) add(f); else files.push(f); } }; add(path.join(root, 'storage', 'run-artifacts', run.runId)); files.push(path.join(root, 'storage', 'run-logs', `${run.runId}.log`)); const script = path.join(root, 'storage', 'scripts', `${run.scriptId}.js`); if (fs.existsSync(script)) files.push(script); return files.filter((f) => fs.existsSync(f) && fs.readFileSync(f, 'utf8').includes(SECRET)).map((f) => path.relative(root, f)); }

async function scenario(label, spec, runtime = {}) {
  evidence = []; mode = spec.mode || 'success';
  const login = await api('POST', '/api/v1/auth/login', { username: 'fail-cert', password: 'fail-cert' }); const apiToken = login.json.data.token;
  const c = await upload('/api/v1/collections', 'collection', spec.collection || collection(spec), apiToken); const generated = await api('POST', '/api/v1/scripts/generate', { collectionId: c.json.data.id, ...(spec.selection ? { selection: spec.selection } : {}), options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '1s' } } } }, apiToken);
  if (generated.status !== 201) return { label, generation: 'blocked', status: generated.status, code: generated.json?.error?.code || generated.json?.code || null, evidence, leaks: [] };
  const script = generated.json.data; const prepare = await api('POST', '/api/v1/runs/prepare', { scriptId: script.id, env: { BASE_URL: TARGET }, ...runtime }, apiToken);
  if (!prepare.json.data.ready) return { label, generation: 'allowed', run: 'blocked', missing: prepare.json.data.missingEnvVars, evidence, leaks: [] };
  const started = await api('POST', '/api/v1/runs', { scriptId: script.id, env: { BASE_URL: TARGET }, ...runtime }, apiToken); const run = await wait(apiToken, started.json.data.runId);
  return { label, generation: 'allowed', run: run.status, exitCode: run.exitCode, evidence, leaks: leaks(run) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'failure-cert-')); process.env.NODE_ENV = 'test'; process.env.DB_PATH = path.join(root, 'db.sqlite'); process.env.JWT_SECRET = 'failure-cert'; process.env.ADMIN_USERNAME = 'fail-cert'; process.env.ADMIN_PASSWORD = 'fail-cert'; process.env.LOG_LEVEL = 'error';
  const target = targetServer(); await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve)); const app = require('../apps/api/src/app'); const server = http.createServer(app); await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));
  try {
    const results = [];
    results.push(await scenario('login-401', { mode: 'login401' }));
    results.push(await scenario('login-200-no-token', { mode: 'noToken' }));
    results.push(await scenario('missing-capture-path', { mode: 'missingCapture', capturePath: 'missing_token' }));
    results.push(await scenario('unresolved-credentials', { credentials: false }));
    results.push(await scenario('subsequent-api-401', { mode: 'subsequent401' }));
    results.push(await scenario('selected-folder-isolation', { folder: true, selection: { mode: 'folder', folderPath: ['Selected'] } }));
    results.push(await scenario('manual-token-precedence', { folder: true, selection: { mode: 'folder', folderPath: ['Selected'] } }, { authToken: 'Bearer    MANUAL_FAIL_TOKEN' }));
    results.push(await scenario('captured-before-environment', { folder: true, selection: { mode: 'folder', folderPath: ['Selected'] } }, { env: { CUSTOM_FAIL_TOKEN: 'wrong-environment-token' } }));
    results.push(await scenario('invalid-manual-token', {}, { authToken: 'expired-token' }));
    results.push(await scenario('duplicate-authorization', { folder: true, duplicateAuth: true, selection: { mode: 'folder', folderPath: ['Selected'] } }));
    results.push(await scenario('empty-token', { folder: true, mode: 'noToken', selection: { mode: 'folder', folderPath: ['Selected'] } }));
    const unsupported = { info: { name: 'unsupported-auth', schema: 'v2.1' }, item: [{ name: 'Login', request: { method: 'GET', url: { raw: `${TARGET}/login` }, auth: { type: 'digest', digest: [{ key: 'username', value: 'x' }] } } }] };
    results.push(await scenario('unsupported-auth-scheme', { collection: unsupported }));
    const pass = results.every((r) => !r.leaks?.length && ((r.label === 'unresolved-credentials' && r.run === 'blocked') || (r.label === 'unsupported-auth-scheme' && r.generation === 'blocked') || r.run === 'completed' || r.run === 'failed'));
    console.log(JSON.stringify({ pass, results }, null, 2)); if (!pass) process.exitCode = 1;
  } finally { server.close(); target.close(); }
}
main().catch((error) => { console.error(`[failure-cert] FAIL ${error.message}`); process.exitCode = 1; });
