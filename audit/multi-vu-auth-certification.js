'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const AGENT_PORT = 4243;
const TARGET_PORT = 4244;
const TARGET = `http://127.0.0.1:${TARGET_PORT}`;
const PASSWORD = 'MULTI_VU_CERT_PASS';
const BAD_PASSWORD = 'MULTI_VU_BAD_PASS';

let evidence = [];
let scenarioMode = 'normal';

const USERS = [
  { id: 'USER_A', username: 'user-a', token: 'TOKEN_A' },
  { id: 'USER_B', username: 'user-b', token: 'TOKEN_B' },
  { id: 'USER_C', username: 'user-c', token: 'TOKEN_C' },
];

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function read(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
  });
}

function targetServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, TARGET);
    const auth = req.headers.authorization || '';
    const vu = req.headers['x-k6-vu'] || req.headers['x-vu'] || 'unknown';

    if (url.pathname === '/login') {
      const raw = await read(req);
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
      const user = USERS.find((u) => u.username === body.username);
      const passwordOk = body.password === PASSWORD;

      if (scenarioMode === 'M-vu2-login-fail' && body.username === 'user-b') {
        evidence.push({ route: 'LOGIN', vu, status: 401, tokenId: null, username: body.username });
        return send(res, 401, { error: 'invalid credentials' });
      }
      if (!user || !passwordOk) {
        evidence.push({ route: 'LOGIN', vu, status: 401, tokenId: null, username: body.username });
        return send(res, 401, { error: 'invalid credentials' });
      }
      if (scenarioMode === 'N-vu2-no-token' && user.id === 'USER_B') {
        evidence.push({ route: 'LOGIN', vu, status: 200, tokenId: null, tokenHash: null, username: body.username });
        return send(res, 200, { ok: true });
      }
      evidence.push({
        route: 'LOGIN',
        vu,
        status: 200,
        tokenId: user.id,
        tokenHash: tokenHash(user.token),
        username: body.username,
      });
      return send(res, 200, { token: user.token, data: { token: user.token } });
    }

    if (scenarioMode === 'Q-vu3-transport-timeout' && url.pathname === '/protected-hang') {
      evidence.push({ route: 'PROTECTED_HANG', vu, status: 'hang', tokenId: null });
      return;
    }

    const match = USERS.find((u) => auth === `Bearer ${u.token}`);
    if (!match) {
      evidence.push({ route: url.pathname, vu, status: 401, tokenId: null, authHeaderCount: auth ? 1 : 0 });
      return send(res, 401, { error: 'unauthorized' });
    }

    if (url.pathname === '/protected' || url.pathname === '/protected-hang') {
      if (
        (scenarioMode === 'O-vu2-token-expire' || scenarioMode === 'P-vu2-401') &&
        match.id === 'USER_B'
      ) {
        evidence.push({ route: 'PROTECTED', vu, status: 401, tokenId: match.id, tokenHash: tokenHash(match.token) });
        return send(res, 401, { error: 'expired token' });
      }
      evidence.push({ route: 'PROTECTED', vu, status: 200, tokenId: match.id, tokenHash: tokenHash(match.token) });
      return send(res, 200, { ok: true });
    }

    if (url.pathname === '/create' && req.method === 'POST') {
      const id = `CAMPAIGN_${match.id}`;
      evidence.push({ route: 'CREATE', vu, status: 201, tokenId: match.id, campaignId: id });
      return send(res, 201, { id });
    }

    if (url.pathname.startsWith('/campaign/')) {
      const cid = url.pathname.split('/').pop();
      evidence.push({ route: url.pathname, vu, status: 200, tokenId: match.id, campaignId: cid });
      return send(res, 200, { ok: true, campaignId: cid });
    }

    return send(res, 404, { error: 'not found' });
  });
}

function collection({
  tokenName = 'access_token',
  idVar = 'campaign_id',
  credentialMode = 'literal',
  includeHang = false,
} = {}) {
  let loginBody;
  if (credentialMode === 'literal') {
    loginBody = JSON.stringify({ username: 'user-a', password: PASSWORD });
  } else if (credentialMode === 'environment') {
    loginBody = JSON.stringify({ username: '{{username}}', password: '{{password}}' });
  } else {
    loginBody = JSON.stringify({ username: 'user-a', password: PASSWORD });
  }

  const items = [
    {
      name: 'Login',
      request: {
        method: 'POST',
        url: { raw: `${TARGET}/login` },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: loginBody },
      },
      event: [{
        listen: 'test',
        script: { exec: [`const j = pm.response.json(); pm.environment.set("${tokenName}", j.token || j.data?.token || '');`] },
      }],
    },
    {
      name: 'Protected',
      request: {
        method: 'GET',
        url: { raw: `${TARGET}/protected` },
        header: [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }],
      },
    },
    {
      name: 'Create',
      request: {
        method: 'POST',
        url: { raw: `${TARGET}/create` },
        header: [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }],
        body: { mode: 'raw', raw: '{}' },
      },
      event: [{
        listen: 'test',
        script: { exec: [`const r = pm.response.json(); pm.environment.set("${idVar}", r.id);`] },
      }],
    },
    {
      name: 'Edit',
      request: {
        method: 'PUT',
        url: { raw: `${TARGET}/campaign/{{${idVar}}}` },
        header: [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }],
      },
    },
  ];

  if (includeHang) {
    items.push({
      name: 'ProtectedHang',
      request: {
        method: 'GET',
        url: { raw: `${TARGET}/protected-hang` },
        header: [{ key: 'Authorization', value: `Bearer {{${tokenName}}}` }],
      },
    });
  }

  return {
    info: { name: 'multi-vu-cert', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: TARGET }],
    item: items,
  };
}

function environmentFile() {
  return {
    name: 'mvu-cert-env',
    values: [
      { key: 'username', value: 'user-a', enabled: true },
      { key: 'password', value: PASSWORD, enabled: true, type: 'secret' },
    ],
  };
}

function form(field, filename, value) {
  const boundary = `----mvu-${Math.random().toString(36).slice(2)}`;
  return {
    boundary,
    body: [`--${boundary}`, `Content-Disposition: form-data; name="${field}"; filename="${filename}"`, 'Content-Type: application/json', '', JSON.stringify(value), `--${boundary}--`, ''].join('\r\n'),
  };
}

async function api(method, route, value, token) {
  const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: value == null ? undefined : JSON.stringify(value),
  });
  return { status: r.status, json: await r.json() };
}

async function upload(route, field, value, token) {
  const m = form(field, 'cert.json', value);
  const r = await fetch(`http://127.0.0.1:${AGENT_PORT}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${m.boundary}`, Authorization: `Bearer ${token}` },
    body: m.body,
  });
  return { status: r.status, json: await r.json() };
}

async function waitRun(token, id) {
  for (let i = 0; i < 200; i += 1) {
    const r = await api('GET', `/api/v1/runs/${id}`, null, token);
    if (['completed', 'failed', 'stopped'].includes(r.json?.data?.status)) return r.json.data;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('timeout');
}

function credentialDataset(count, overrides = {}) {
  return USERS.slice(0, count).map((u) => ({
    id: u.id,
    username: u.username,
    password: overrides[u.username] || PASSWORD,
  }));
}

function leaks(run) {
  const root = path.resolve(__dirname, '..', 'apps', 'api');
  const files = [];
  const add = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) add(f);
      else files.push(f);
    }
  };
  add(path.join(root, 'storage', 'run-artifacts', run.runId));
  files.push(path.join(root, 'storage', 'run-logs', `${run.runId}.log`));
  const script = path.join(root, 'storage', 'scripts', `${run.scriptId}.js`);
  if (fs.existsSync(script)) files.push(script);
  const tokenValues = USERS.map((u) => u.token);
  function fileLeaks(content) {
    if (content.includes(PASSWORD) || content.includes(BAD_PASSWORD)) return true;
    for (const token of tokenValues) {
      if (
        content.includes(`Bearer ${token}`) ||
        content.includes(`"${token}"`) ||
        content.includes(`'${token}'`)
      ) {
        return true;
      }
    }
    return false;
  }
  return files
    .filter((f) => fs.existsSync(f) && fileLeaks(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(root, f));
}

async function runScenario(label, spec) {
  scenarioMode = spec.scenarioMode || 'normal';
  evidence = [];
  const login = await api('POST', '/api/v1/auth/login', { username: 'mvu-cert', password: 'mvu-cert' });
  const apiToken = login.json.data.token;

  const c = await upload('/api/v1/collections', 'collection', spec.collection || collection(spec.collectionOpts || {}), apiToken);
  let environmentId = null;
  if (spec.useEnvironment) {
    const env = await upload('/api/v1/environments', 'environment', environmentFile(), apiToken);
    environmentId = env.json.data.id;
  }

  const generated = await api('POST', '/api/v1/scripts/generate', {
    collectionId: c.json.data.id,
    ...(environmentId ? { environmentId } : {}),
    options: {
      workload: {
        profile: 'smoke',
        authSessionMode: spec.authSessionMode || 'PER_VU_LOGIN',
        credentialReuse: !!spec.credentialReuse,
        overrides: { vus: spec.vus, hold: spec.hold || '2s' },
      },
      ...(spec.requestTimeout ? { requestTimeout: spec.requestTimeout } : {}),
    },
  }, apiToken);

  if (generated.status !== 201) {
    return { label, generation: 'blocked', status: generated.status, evidence, leaks: [], pass: false };
  }

  const script = generated.json.data;
  const runtime = {
    env: {
      BASE_URL: TARGET,
      ...(spec.env || {}),
    },
    ...(spec.manualToken ? { authToken: spec.manualToken } : {}),
    ...(spec.credentialCount
      ? {
          credentialDataset: JSON.stringify(
            credentialDataset(spec.credentialCount, spec.credentialOverrides || {})
          ),
          credentialReuse: !!spec.credentialReuse,
        }
      : {}),
    ...(spec.secrets || {}),
  };

  const prepare = await api('POST', '/api/v1/runs/prepare', { scriptId: script.id, ...runtime }, apiToken);
  const started = await api('POST', '/api/v1/runs', { scriptId: script.id, ...runtime }, apiToken);
  if (!started.json?.data?.runId) {
    return {
      label,
      generation: 'allowed',
      run: 'blocked',
      startError: started.json?.error || started.json,
      evidence: [...evidence],
      leaks: [],
      pass: false,
    };
  }
  const run = await waitRun(apiToken, started.json.data.runId);

  const result = {
    label,
    authSessionMode: spec.authSessionMode || 'PER_VU_LOGIN',
    vus: spec.vus,
    credentialCount: spec.credentialCount || 0,
    generation: 'allowed',
    run: run.status,
    exitCode: run.exitCode,
    prepare: prepare.json?.data?.authSession || null,
    evidence: [...evidence],
    leaks: leaks(run),
    pass: false,
  };
  result.pass = evaluateScenario(label, result, spec);
  return result;
}

function evaluateScenario(label, result, spec) {
  if (result.leaks?.length) return false;
  if (result.generation === 'blocked') return false;

  const protectedHits = result.evidence.filter((e) => e.route === 'PROTECTED' && e.status === 200);
  const loginHits = result.evidence.filter((e) => e.route === 'LOGIN');
  const createHits = result.evidence.filter((e) => e.route === 'CREATE' && e.status === 201);
  const editHits = result.evidence.filter((e) => e.route?.startsWith('/campaign/'));

  if (label.startsWith('A') || label.startsWith('B') || label.startsWith('C') || label.startsWith('I') || label.startsWith('K')) {
    const tokenIds = protectedHits.map((e) => e.tokenId);
    return tokenIds.length > 0 && new Set(tokenIds).size === tokenIds.length;
  }
  if (label.startsWith('D') || label.startsWith('E')) {
    return result.run === 'completed' || result.run === 'failed';
  }
  if (label === 'F-env-credentials-per-vu-login') {
    return loginHits.filter((e) => e.status === 200).length >= 2 && protectedHits.length >= 2;
  }
  if (label === 'G-collection-credentials-per-vu-login') {
    return loginHits.length >= 2 && protectedHits.length >= 2;
  }
  if (label === 'H-runtime-credential-overrides-per-vu-login') {
    return loginHits.length >= 2 && protectedHits.length >= 2;
  }
  if (label === 'J-custom-captured-id-name') {
    const creates = createHits.filter((e) => e.status === 201);
    const edits = editHits.filter((e) => e.status === 200);
    if (creates.length < 2 || edits.length < 2) return false;
    const createdIds = new Set(creates.map((e) => e.campaignId));
    return edits.every((e) => createdIds.has(e.campaignId));
  }
  if (label === 'L-multi-vu-runtime-id-isolation') {
    const byToken = new Map();
    for (const hit of createHits) byToken.set(hit.tokenId, hit.campaignId);
    const edits = editHits.filter((hit) => hit.status === 200);
    if (edits.length < 2) return false;
    return edits.every((hit) => byToken.get(hit.tokenId) === hit.campaignId);
  }
  if (label === 'M-vu1-login-ok-vu2-login-fail') {
    const vu1Login = loginHits.find((e) => e.username === 'user-a');
    const vu2Login = loginHits.find((e) => e.username === 'user-b');
    const vu1Protected = protectedHits.some((e) => e.tokenId === 'USER_A');
    const vu2Protected = protectedHits.some((e) => e.tokenId === 'USER_B');
    return vu1Login?.status === 200 && vu2Login?.status === 401 && vu1Protected && !vu2Protected;
  }
  if (label === 'N-vu1-token-ok-vu2-token-missing') {
    const vu1Protected = protectedHits.some((e) => e.tokenId === 'USER_A');
    const vu2Protected = protectedHits.some((e) => e.tokenId === 'USER_B');
    const vu2Login = loginHits.find((e) => e.username === 'user-b');
    return vu1Protected && !vu2Protected && vu2Login?.tokenId == null;
  }
  if (label === 'O-one-vu-token-expires' || label === 'P-one-vu-receives-401') {
    const vu1Protected = protectedHits.some((e) => e.tokenId === 'USER_A');
    const vu2Fail = result.evidence.some((e) => e.route === 'PROTECTED' && e.tokenId === 'USER_B' && e.status === 401);
    return vu1Protected && vu2Fail;
  }
  if (label === 'Q-one-vu-transport-timeout') {
    const hang = result.evidence.some((e) => e.route === 'PROTECTED_HANG');
    const vu1Ok = protectedHits.some((e) => e.tokenId === 'USER_A');
    const vu2Ok = protectedHits.some((e) => e.tokenId === 'USER_B');
    return hang && vu1Ok && vu2Ok;
  }
  if (label === 'R-other-vus-continue-independently') {
    const vu1 = protectedHits.some((e) => e.tokenId === 'USER_A');
    const vu3 = protectedHits.some((e) => e.tokenId === 'USER_C');
    const vu2Fail = result.evidence.some(
      (e) => e.route === 'PROTECTED' && e.tokenId === 'USER_B' && e.status === 401
    );
    return vu1 && vu3 && vu2Fail;
  }
  return spec.expectPass === true;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvu-cert-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'mvu-cert-secret-32chars-minimum';
  process.env.ADMIN_USERNAME = 'mvu-cert';
  process.env.ADMIN_PASSWORD = 'mvu-cert';
  process.env.LOG_LEVEL = 'error';

  const target = targetServer();
  await new Promise((resolve) => target.listen(TARGET_PORT, '127.0.0.1', resolve));
  const app = require('../apps/api/src/app');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(AGENT_PORT, '127.0.0.1', resolve));

  try {
    const results = [];
    results.push(await runScenario('A-1vu-per-vu-login', { vus: 1, credentialCount: 1 }));
    results.push(await runScenario('B-2vu-per-vu-login', { vus: 2, credentialCount: 2 }));
    results.push(await runScenario('C-3vu-per-vu-login', { vus: 3, credentialCount: 3 }));
    results.push(await runScenario('D-3vu-shared-session', { vus: 3, authSessionMode: 'SHARED_SESSION', credentialCount: 0 }));
    results.push(await runScenario('E-manual-token-3vu', { vus: 3, authSessionMode: 'MANUAL_TOKEN', manualToken: 'Bearer TOKEN_A' }));
    results.push(await runScenario('F-env-credentials-per-vu-login', {
      vus: 2,
      credentialCount: 2,
      useEnvironment: true,
      collectionOpts: { credentialMode: 'literal' },
    }));
    results.push(await runScenario('G-collection-credentials-per-vu-login', {
      vus: 2,
      credentialCount: 2,
      collectionOpts: { credentialMode: 'literal' },
    }));
    results.push(await runScenario('H-runtime-credential-overrides-per-vu-login', {
      vus: 2,
      credentialCount: 2,
      collectionOpts: { credentialMode: 'literal' },
    }));
    results.push(await runScenario('I-custom-token-var', {
      vus: 2,
      credentialCount: 2,
      collectionOpts: { tokenName: 'jwt_token' },
    }));
    results.push(await runScenario('J-custom-captured-id-name', {
      vus: 2,
      credentialCount: 2,
      collectionOpts: { idVar: 'order_id' },
    }));
    results.push(await runScenario('K-token-isolation-3vu', { vus: 3, credentialCount: 3 }));
    results.push(await runScenario('L-multi-vu-runtime-id-isolation', { vus: 3, credentialCount: 3 }));
    results.push(await runScenario('M-vu1-login-ok-vu2-login-fail', {
      vus: 2,
      credentialCount: 2,
      scenarioMode: 'M-vu2-login-fail',
      credentialOverrides: { 'user-b': BAD_PASSWORD },
    }));
    results.push(await runScenario('N-vu1-token-ok-vu2-token-missing', {
      vus: 2,
      credentialCount: 2,
      scenarioMode: 'N-vu2-no-token',
    }));
    results.push(await runScenario('O-one-vu-token-expires', {
      vus: 2,
      credentialCount: 2,
      scenarioMode: 'O-vu2-token-expire',
    }));
    results.push(await runScenario('P-one-vu-receives-401', {
      vus: 2,
      credentialCount: 2,
      scenarioMode: 'P-vu2-401',
    }));
    results.push(await runScenario('Q-one-vu-transport-timeout', {
      vus: 3,
      credentialCount: 3,
      scenarioMode: 'Q-vu3-transport-timeout',
      collectionOpts: { includeHang: true },
      requestTimeout: '5s',
      env: { REQUEST_TIMEOUT: '5s', PACING_MS: '0' },
      hold: '1s',
    }));
    results.push(await runScenario('R-other-vus-continue-independently', {
      vus: 3,
      credentialCount: 3,
      scenarioMode: 'P-vu2-401',
    }));

    const analyzed = results.map((r) => ({
      label: r.label,
      result: r.pass ? 'PASS' : 'FAIL',
      run: r.run,
      exitCode: r.exitCode,
      evidence: r.evidence.map((e) => ({
        route: e.route,
        vu: e.vu,
        status: e.status,
        tokenId: e.tokenId || null,
        tokenHash: e.tokenHash || null,
        campaignId: e.campaignId || null,
        username: e.username || null,
      })),
      leaks: r.leaks,
    }));

    const pass = analyzed.every((r) => r.result === 'PASS');
    console.log(JSON.stringify({ pass, analyzed }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    server.close();
    target.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
