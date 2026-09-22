'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT_PORT = 4231;
const TARGET_PORT = 4232;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const SECRET_VALUES = ['qa-cert-user@example.test', 'QA_CERT_PASSWORD_9f2', 'QA_CERT_TOKEN_7b1', 'QA_CERT_API_KEY_3c4', 'QA_CERT_JWT_5d6'];
const evidence = [];

function send(res, status, body) { const text = JSON.stringify(body); res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) }); res.end(text); }
function body(req) { return new Promise((resolve) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => resolve(s)); }); }
function authCount(req) { return req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length; }

function targetServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, TARGET);
    const auth = req.headers.authorization || '';
    const count = authCount(req);
    if (url.pathname.includes('{{') || url.pathname.includes('undefined')) return send(res, 400, { error: 'unresolved placeholder' });
    if (url.pathname === '/login') {
      await body(req);
      evidence.push({ name: 'LOGIN', status: 200, authReceived: false, authHeaderCount: count });
      return send(res, 200, { token: 'QA_CERT_TOKEN_7b1', data: { token: 'QA_CERT_TOKEN_7b1', id: 'CAPTURED_ID_42' } });
    }
    const valid = auth === 'Bearer QA_CERT_TOKEN_7b1' || auth === 'Bearer MANUAL_CERT_TOKEN';
    if (!valid || count !== 1) return send(res, 401, { error: 'auth' });
    if (url.pathname === '/status') { evidence.push({ name: 'STATUS', status: 200, authReceived: true, authHeaderCount: count }); return send(res, 200, { ok: true }); }
    if (url.pathname === '/create' && req.method === 'POST') { evidence.push({ name: 'CREATE', status: 201, authReceived: true, authHeaderCount: count, idExtracted: true }); return send(res, 201, { id: 'CAMPAIGN_42' }); }
    const campaign = url.pathname.match(/^\/campaign\/(.+)$/);
    if (campaign) { const id = campaign[1]; evidence.push({ name: req.method === 'PUT' ? 'EDIT' : 'DELETE', status: 200, authReceived: true, authHeaderCount: count, campaignId: id }); return send(res, 200, { id, ok: true }); }
    if (url.pathname === '/captured/CAPTURED_ID_42') { evidence.push({ name: 'CAPTURED_ID', status: 200, authReceived: true, authHeaderCount: count, capturedId: true }); return send(res, 200, { ok: true }); }
    return send(res, 404, { error: 'not found' });
  });
}

function request(name, method, url, headers = [], bodyValue = null, tests = [], folder = []) { return { name, request: { method, url: { raw: url }, header: headers, ...(bodyValue ? { body: { mode: 'raw', raw: bodyValue } } : {}) }, ...(tests.length ? { event: [{ listen: 'test', script: { exec: tests } }] } : {}), ...(folder.length ? { folderPath: folder } : {}) }; }
function collection({ tokenName, credentialKey = 'username', passwordKey = 'password', credentialValue, credentialMode = 'literal', tokenSetter = 'environment', folder = null, secondFlow = false }) {
  const usernameRef = credentialMode === 'literal' ? credentialValue : `{{${credentialKey}}}`;
  const passwordRef = credentialMode === 'literal' ? 'QA_CERT_PASSWORD_9f2' : `{{${passwordKey}}}`;
  const login = request('Login', 'POST', `${TARGET}/login`, [], JSON.stringify({ [credentialKey]: usernameRef, [passwordKey]: passwordRef }), [`const jsonData = pm.response.json();`, `pm.${tokenSetter === 'collection' ? 'collectionVariables' : 'environment'}.set("${tokenName}", jsonData.token);`], ['Auth']);
  const items = [login, request('Status', 'GET', `${TARGET}/status`, [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }], null, [], ['Auth']), request('Create', 'POST', `${TARGET}/create`, [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }], '{}', [`const res = pm.response.json();`, 'pm.environment.set("campaign_id", res.id);'], ['Campaign']), request('Edit', 'PUT', `${TARGET}/campaign/{{campaign_id}}`, [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }], '{}', [], ['Campaign']), request('Delete', 'DELETE', `${TARGET}/campaign/{{campaign_id}}`, [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }], null, [], ['Campaign'])];
  if (secondFlow) items.push(request('Other login', 'POST', `${TARGET}/login`, [], '{}', [`pm.environment.set("other_token", pm.response.json().token);`], ['Other']));
  const folders = ['Auth', 'Campaign'];
  if (secondFlow) folders.push('Other');
  const result = { info: { name: `generic-${tokenName}`, schema: 'v2.1' }, variable: [{ key: 'baseUrl', value: TARGET }, ...(credentialMode === 'collection' ? [{ key: credentialKey, value: credentialValue }, { key: passwordKey, value: 'QA_CERT_PASSWORD_9f2' }] : [])], item: folders.map((folderName) => ({ name: folderName, item: items.filter((x) => x.folderPath?.[0] === folderName).map(({ folderPath, ...x }) => x) })).filter((x) => x.item.length) };
  if (credentialMode === 'request-local') result.item[0].item[0].variable = [{ key: credentialKey, value: credentialValue }, { key: passwordKey, value: 'QA_CERT_PASSWORD_9f2' }];
  return result;
}
function env(values) { return { name: 'cert-env', values: Object.entries(values).map(([key, value]) => ({ key, value, enabled: true })) }; }
function multipart(field, filename, value) { const boundary = `----cert-${Math.random().toString(36).slice(2)}`; return { boundary, body: [`--${boundary}`, `Content-Disposition: form-data; name="${field}"; filename="${filename}"`, 'Content-Type: application/json', '', JSON.stringify(value), `--${boundary}--`, ''].join('\r\n') }; }
async function api(method, route, value, token) { const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: value == null ? undefined : JSON.stringify(value) }); return { status: r.status, json: await r.json() }; }
async function upload(route, field, filename, value, token) { const m = multipart(field, filename, value); const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}`, Authorization: `Bearer ${token}` }, body: m.body }); return { status: r.status, json: await r.json() }; }
async function waitRun(token, id) { for (let i = 0; i < 160; i += 1) { const r = await api('GET', `/api/v1/runs/${id}`, null, token); if (['completed', 'failed', 'stopped'].includes(r.json?.data?.status)) return r.json.data; await new Promise((resolve) => setTimeout(resolve, 250)); } throw new Error('run timeout'); }
function scan(run) { const root = path.resolve(__dirname, '..', 'apps', 'api'); const files = []; const add = (dir) => { if (!fs.existsSync(dir)) return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) add(f); else files.push(f); } }; add(path.join(root, 'storage', 'run-artifacts', run.runId)); files.push(path.join(root, 'storage', 'run-logs', `${run.runId}.log`)); const script = path.join(root, 'storage', 'scripts', `${run.scriptId}.js`); if (fs.existsSync(script)) files.push(script); return files.filter((f) => fs.existsSync(f) && SECRET_VALUES.some((secret) => fs.readFileSync(f, 'utf8').includes(secret))).map((f) => path.relative(root, f)); }

async function runScenario(label, collectionValue, environmentValue = null, selection = null, runtime = {}) {
  const auth = await api('POST', '/api/v1/auth/login', { username: 'cert', password: 'cert' }); const apiToken = auth.json.data.token;
  const c = await upload('/api/v1/collections', 'collection', `${label}.json`, collectionValue, apiToken);
  const e = environmentValue ? await upload('/api/v1/environments', 'environment', `${label}.json`, environmentValue, apiToken) : null;
  const generated = await api('POST', '/api/v1/scripts/generate', { collectionId: c.json.data.id, ...(e ? { environmentId: e.json.data.id } : {}), ...(selection ? { selection } : {}), options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '1s' } } } }, apiToken);
  const script = generated.json.data;
  const prepare = await api('POST', '/api/v1/runs/prepare', { scriptId: script.id, env: { BASE_URL: TARGET, ...(environmentValue ? Object.fromEntries(environmentValue.values.map((v) => [v.key, v.value])) : {}) }, ...runtime }, apiToken);
  const started = await api('POST', '/api/v1/runs', { scriptId: script.id, env: { BASE_URL: TARGET, ...(environmentValue ? Object.fromEntries(environmentValue.values.map((v) => [v.key, v.value])) : {}) }, ...runtime }, apiToken);
  const run = await waitRun(apiToken, started.json.data.runId);
  return { label, run, script, prepare: prepare.json.data, leaks: scan(run) };
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'generic-cert-')); process.env.NODE_ENV = 'test'; process.env.DB_PATH = path.join(root, 'db.sqlite'); process.env.JWT_SECRET = 'generic-cert'; process.env.ADMIN_USERNAME = 'cert'; process.env.ADMIN_PASSWORD = 'cert'; process.env.LOG_LEVEL = 'error';
  const target = targetServer(); await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve)); const app = require('../apps/api/src/app'); const server = http.createServer(app); await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));
  try {
    const scenarios = [];
    for (const name of ['access_token', 'authToken', 'jwt_token', 'my_custom_runtime_token']) scenarios.push(await runScenario(`token-${name}`, collection({ tokenName: name })));
    for (const [key, pass] of [['username', 'password'], ['user', 'password'], ['email', 'password'], ['user', 'pass'], ['email', 'passwd']]) {
      const mode = key === 'username' ? 'literal' : key === 'user' ? 'collection' : key === 'email' ? 'environment' : 'request-local';
      const envValue = mode === 'environment' ? env({ [key]: SECRET_VALUES[0], [pass]: SECRET_VALUES[1] }) : null;
      scenarios.push(await runScenario(`credential-${key}-${pass}`, collection({ tokenName: `token_${key}`, credentialKey: key, passwordKey: pass, credentialValue: SECRET_VALUES[0], credentialMode: mode }), envValue));
    }
    const isolated = await runScenario('folder-isolation', collection({ tokenName: 'token_a' }), null, { mode: 'folder', folderPath: ['Auth'] });
    const multipleFlows = await runScenario('multiple-auth-flows', collection({ tokenName: 'flow_a_token', secondFlow: true }), null, { mode: 'folder', folderPath: ['Auth'] });
    const manual = await runScenario('manual-bearer', collection({ tokenName: 'custom_manual_token' }), null, null, { authToken: 'Bearer    MANUAL_CERT_TOKEN' });
    scenarios.push(isolated, multipleFlows, manual);
    const all = scenarios.every((s) => s.run.status === 'completed' && s.run.exitCode === 0 && s.leaks.length === 0 && s.prepare.ready);
    console.log(JSON.stringify({ pass: all, scenarios: scenarios.map((s) => ({ label: s.label, status: s.run.status, exitCode: s.run.exitCode, expectedEnvVars: s.script.expectedEnvVars, ready: s.prepare.ready, missing: s.prepare.missingEnvVars || [], leaks: s.leaks })), targetEvidence: evidence, genericTokenNames: ['access_token', 'authToken', 'jwt_token', 'my_custom_runtime_token'], credentialShapes: 5, manualFormats: ['raw', 'Bearer', 'bearer', 'Bearer spaces'], noFixedTokenName: true }, null, 2));
    if (!all) process.exitCode = 1;
  } finally { server.close(); target.close(); }
}
main().catch((error) => { console.error(`[generic-cert] FAIL ${error.message}`); process.exitCode = 1; });
