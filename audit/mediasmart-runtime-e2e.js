'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { parse } = require('../apps/api/src/lib/postman/parser');

const COLLECTION_PATH = path.resolve(
  __dirname,
  '..',
  'apps',
  'api',
  'storage',
  'uploads',
  '1789627482335_83580a15-b954-4074-b703-8c2d70bb386f_Nightly_API_Monitoring_Mediasmart_postman_collection.json'
);
const AGENT_PORT = 4221;
const TARGET_PORT = 4222;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const REQUIRED_NAMES = new Set(['Login', 'GetStatus', 'GetCountries', 'GetRegions', 'GetCities', 'CreateCTVCampaign', 'ToUpdateCampaign', 'DeleteCTVCampaign']);
const evidence = [];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req) { return new Promise((resolve) => { let text = ''; req.on('data', (chunk) => { text += chunk; }); req.on('end', () => resolve(text)); }); }

function targetServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, TARGET);
    const authHeaders = req.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length;
    if (url.pathname.includes('{{') || url.pathname.includes('undefined')) return send(res, 400, { error: 'unresolved placeholder' });
    if (url.pathname === '/api/login' && req.method === 'POST') {
      await readBody(req);
      evidence.push({ name: 'LOGIN', status: 200, authReceived: false, authHeaderCount: authHeaders, credentialSource: 'literal' });
      return send(res, 200, { username: 'mayank.harsora', token: 'MEDIASMART_RUNTIME_TOKEN' });
    }
    const authValue = req.headers.authorization || '';
    const authorized =
      authHeaders === 1 &&
      (authValue === 'Bearer MEDIASMART_RUNTIME_TOKEN' || authValue === 'MEDIASMART_RUNTIME_TOKEN');
    if (!authorized) return send(res, 401, { error: 'authorization' });
    if (url.pathname === '/api/v2/campaign' && req.method === 'POST') {
      evidence.push({ name: 'CREATE', status: 201, authReceived: true, authHeaderCount: authHeaders, campaignIdExtracted: true });
      return send(res, 201, { id: 'CAMPAIGN_123', created_at: 'audit' });
    }
    const campaign = url.pathname.match(/\/campaign\/([^/]+)/);
    if (campaign && campaign[1] !== 'CAMPAIGN_123') return send(res, 400, { error: 'campaign id' });
    const match = evidenceName(url.pathname, req.method);
    const status = match === 'DELETE' ? 200 : 200;
    evidence.push({ name: match || 'DEPENDENT', status, authReceived: true, authHeaderCount: authHeaders, campaignId: campaign ? campaign[1] : null });
    return send(res, status, { ok: true, id: campaign ? campaign[1] : undefined });
  });
}
function evidenceName(pathname, method) {
  if (pathname === '/status') return 'GetStatus';
  if (pathname.includes('/geolists')) return 'GetCountries';
  if (pathname.includes('/dictionary/regions')) return 'GetRegions';
  if (pathname.includes('/dictionary/cities')) return 'GetCities';
  if (pathname.includes('/campaign/') && method === 'PUT') {
    return evidence.some((item) => item.name === 'EDIT') ? 'DELETE' : 'EDIT';
  }
  return null;
}
function rewriteHosts(value) {
  if (typeof value === 'string') return value.replace(/https?:\/\/[^/]+/g, TARGET);
  if (Array.isArray(value)) return value.map(rewriteHosts);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteHosts(v)]));
  return value;
}
function rewriteCollection(collection) {
  const clone = rewriteHosts(collection);
  const walk = (items) => (items || []).map((item) => {
    if (Array.isArray(item.item)) return { ...item, item: walk(item.item) };
    if (item.request) return { ...item, request: { ...item.request, url: rewriteHosts(item.request.url) } };
    return item;
  });
  return { ...clone, item: walk(collection.item) };
}
function formData(field, filename, value) {
  const boundary = `----mediasmart-${Math.random().toString(36).slice(2)}`;
  return { boundary, body: [`--${boundary}`, `Content-Disposition: form-data; name="${field}"; filename="${filename}"`, 'Content-Type: application/json', '', JSON.stringify(value), `--${boundary}--`, ''].join('\r\n') };
}
async function api(method, pathName, body, token) {
  const response = await fetch(`http://127.0.0.1:${AGENT_PORT}${pathName}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body == null ? undefined : JSON.stringify(body) });
  return { status: response.status, json: await response.json() };
}
async function upload(field, filename, value, token, endpoint) {
  const data = formData(field, filename, value);
  const response = await fetch(`http://127.0.0.1:${AGENT_PORT}${endpoint}`, { method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${data.boundary}`, Authorization: `Bearer ${token}` }, body: data.body });
  return { status: response.status, json: await response.json() };
}
async function waitRun(token, id) {
  for (let i = 0; i < 160; i += 1) {
    const result = await api('GET', `/api/v1/runs/${id}`, null, token);
    if (['completed', 'failed', 'stopped'].includes(result.json?.data?.status)) return result.json.data;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('run timeout');
}
function scan(run, values) {
  const root = path.resolve(__dirname, '..', 'apps', 'api');
  const files = [];
  const addTree = (dir) => { if (!fs.existsSync(dir)) return; for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) addTree(file); else files.push(file); } };
  addTree(path.join(root, 'storage', 'run-artifacts', run.runId));
  files.push(path.join(root, 'storage', 'run-logs', `${run.runId}.log`));
  const scriptPath = path.join(root, 'storage', 'scripts', `${run.scriptId}.js`);
  if (fs.existsSync(scriptPath)) files.push(scriptPath);
  return files.filter((file) => fs.existsSync(file) && values.some((value) => fs.readFileSync(file, 'utf8').includes(value))).map((file) => path.relative(root, file));
}

async function main() {
  const collectionSource = readJson(COLLECTION_PATH);
  const collection = rewriteCollection(collectionSource);
  const parsed = parse(collection);
  const selectedIndices = parsed.requests.map((request, index) => REQUIRED_NAMES.has(request.name) ? index : -1).filter((index) => index >= 0);
  const credentials = [];
  const loginRaw = JSON.parse(parsed.requests.find((request) => request.name === 'Login').body.raw);
  credentials.push(loginRaw.username, loginRaw.password, 'MEDIASMART_RUNTIME_TOKEN');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mediasmart-runtime-'));
  process.env.NODE_ENV = 'test'; process.env.DB_PATH = path.join(root, 'db.sqlite'); process.env.JWT_SECRET = 'mediasmart-audit'; process.env.ADMIN_USERNAME = 'audit'; process.env.ADMIN_PASSWORD = 'audit-password'; process.env.LOG_LEVEL = 'error';
  const target = targetServer(); await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve));
  const app = require('../apps/api/src/app'); const server = http.createServer(app); await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));
  try {
    const login = await api('POST', '/api/v1/auth/login', { username: 'audit', password: 'audit-password' });
    const token = login.json?.data?.token;
    const uploadedCollection = await upload('collection', 'mediasmart.json', collection, token, '/api/v1/collections');
    const generated = await api('POST', '/api/v1/scripts/generate', {
      collectionId: uploadedCollection.json.data.id,
      selection: { mode: 'requests', requestIndices: selectedIndices },
      options: { workload: { profile: 'smoke', overrides: { vus: 1, hold: '3s' } } },
    }, token);
    const script = generated.json.data;
    if (script.expectedEnvVars.includes('LOGIN_USERNAME') || script.expectedEnvVars.includes('LOGIN_PASSWORD')) throw new Error('login credentials incorrectly required as manual env vars');
    const runtimeEnv = {
      BASE_URL: TARGET,
      BASEAPI_URL: TARGET,
      NEXD_BASEURL: TARGET,
      DASHBOARD_CLOUDURL: TARGET,
    };
    const runtimeSecrets = {
      LOGIN_USERNAME: loginRaw.username,
      LOGIN_PASSWORD: loginRaw.password,
    };
    const prepared = await api('POST', '/api/v1/runs/prepare', { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets }, token);
    if (!prepared.json.data.ready) throw new Error(`prepare not ready: ${JSON.stringify(prepared.json.data.missingEnvVars)}`);
    const started = await api('POST', '/api/v1/runs', { scriptId: script.id, env: runtimeEnv, secrets: runtimeSecrets }, token);
    const run = await waitRun(token, started.json.data.runId);
    const leaks = scan(run, credentials);
    console.log(JSON.stringify({ status: run.status, exitCode: run.exitCode, expectedEnvVars: script.expectedEnvVars, evidence, credentialSource: { username: 'literal', password: 'literal' }, leaks }, null, 2));
    if (run.status !== 'completed' || run.exitCode !== 0 || leaks.length > 0 || evidence.some((item) => item.status < 200 || item.status >= 300 || (item.authReceived && item.authHeaderCount !== 1))) process.exitCode = 1;
  } finally { server.close(); target.close(); }
}
main().catch((error) => { console.error(`[mediasmart-runtime] FAIL ${error.message}`); process.exitCode = 1; });
