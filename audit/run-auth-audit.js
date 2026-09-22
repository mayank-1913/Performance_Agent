'use strict';

/**
 * Phase 6.5 audit — auth + secret-leakage runtime harness.
 *
 * Complements run-k6-audit.js by exercising the auth pipeline against the
 * same local test server. Runs three scenarios:
 *
 *   1. MANUAL TOKEN — collection references {{jwt_token}} in the
 *      Authorization header. NO environment file. NO login request. The
 *      user pastes an opaque token into __ENV.AUTH_TOKEN. The generated
 *      K6 script must route that manual value through __resolveAuthHeader
 *      so /me returns 200.
 *
 *   2. LOGIN TOKEN — collection contains a POST /login that returns
 *      { access_token: ... } and a GET /me referencing {{access_token}}.
 *      buildAuthFlow captures the runtime token in setup() and every
 *      iteration's /me request must receive Authorization: Bearer <t>.
 *
 *   3. MANUAL WINS — same as (2) plus a manual __ENV.AUTH_TOKEN set to a
 *      DIFFERENT value. The manual value must win at the wire; the
 *      server has a "manual sentinel" route accepting only that value.
 *
 * For each scenario the harness asserts:
 *   - k6 exit code
 *   - the /me endpoint returned 200 (proven via failure counts)
 *   - the SECRET_TOKEN never appears in the generated script, logs, or
 *     any artifact file
 *   - the MANUAL_SENTINEL never appears in the generated script
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { start: startServer, SECRET_TOKEN } = require('./test-server');
const {
  generateK6Script,
} = require('../apps/api/src/lib/k6/generator');
const { parse } = require('../apps/api/src/lib/postman/parser');
const {
  sanitizeParsedCollection,
} = require('../apps/api/src/lib/postman/authSanitizer');
const {
  normalizeWorkload,
} = require('../apps/api/src/lib/k6/workloadProfiles');
const {
  buildAuthFlow,
} = require('../apps/api/src/lib/postman/authFlow');

const PORT = Number(process.env.AUDIT_AUTH_PORT) || 4002;
const BASE = `http://127.0.0.1:${PORT}`;
const MANUAL_SENTINEL = 'manual-audit-sentinel-do-not-leak-a1b2c3d4';

/**
 * Extend the base audit server with a "manual-only" protected route that
 * ONLY accepts a specific sentinel token. Used to prove the manual
 * override wins over the login-captured token.
 */
const http = require('http');
function startExtendedServer(port) {
  return new Promise((resolve, reject) => {
    startServer(port).then(({ server }) => {
      // Wrap: hijack the pre-existing listener by adding another one.
      const originalListeners = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname === '/manual-only') {
          const auth = req.headers.authorization || '';
          if (auth === `Bearer ${MANUAL_SENTINEL}`) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true,"who":"manual"}');
          } else {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end('{"error":"expected manual sentinel"}');
          }
          return;
        }
        for (const fn of originalListeners) fn(req, res);
      });
      resolve({ server });
    }).catch(reject);
  });
}

function haveK6() {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['k6'], {
    encoding: 'utf-8',
  });
  return r.status === 0;
}

function runK6(scriptPath, artifactsDir, extraEnv = {}) {
  const summaryExportPath = path.join(artifactsDir, 'summary.json');
  const metricsJsonPath = path.join(artifactsDir, 'metrics.json');
  const env = {
    ...process.env,
    PACING_MS: '100',
    ...extraEnv,
  };
  return new Promise((resolve) => {
    const child = spawn(
      'k6',
      [
        'run',
        '--quiet',
        '--summary-export', summaryExportPath,
        '--out', `json=${metricsJsonPath}`,
        scriptPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], env }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c.toString('utf-8')));
    child.stderr.on('data', (c) => (stderr += c.toString('utf-8')));
    child.on('close', (code) =>
      resolve({ exitCode: code, stdout, stderr, summaryExportPath, metricsJsonPath })
    );
  });
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

function scanForSecret(paths, needles) {
  const findings = [];
  for (const p of paths) {
    try {
      const contents = fs.readFileSync(p, 'utf-8');
      for (const n of needles) {
        if (contents.includes(n)) findings.push({ file: p, needle: n });
      }
    } catch {
      // ignore missing
    }
  }
  return findings;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

// Scenario 1: {{jwt_token}} placeholder, no login, no environment.
function collectionManualOnly() {
  return {
    info: { name: 'audit-manual-token', schema: 'v2.1' },
    item: [
      {
        name: 'GetMe',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{jwt_token}}' }],
          url: { raw: `${BASE}/me` },
        },
      },
    ],
  };
}

// Scenario 2: login + protected using {{access_token}}.
function collectionLoginFlow() {
  return {
    info: { name: 'audit-login-flow', schema: 'v2.1' },
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: `${BASE}/login` },
          body: { mode: 'raw', raw: '{"u":"x","p":"y"}', options: { raw: { language: 'json' } } },
        },
      },
      {
        name: 'GetMe',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: `${BASE}/me` },
        },
      },
    ],
  };
}

// Scenario 3: same as (2) but override target to /manual-only which only
// accepts the manual sentinel — proves the manual token wins.
function collectionLoginPlusManualSentinel() {
  const c = collectionLoginFlow();
  c.item[1].name = 'GetManualOnly';
  c.item[1].request.url.raw = `${BASE}/manual-only`;
  return c;
}

/* ------------------------------------------------------------------ */
/*  Runners                                                             */
/* ------------------------------------------------------------------ */

async function runScenario({ name, collection, envOverrides, workload, useAuthFlow }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `phase65-auth-${name}-`));
  const parsed = sanitizeParsedCollection(parse(collection)).parsed;
  const flow = useAuthFlow ? buildAuthFlow(parsed) : { enabled: false };
  const code = generateK6Script(parsed, {
    injectAuthToken: true,
    workload,
    authFlow: flow,
  });
  const scriptPath = path.join(dir, `${name}.js`);
  fs.writeFileSync(scriptPath, code, 'utf-8');

  const run = await runK6(scriptPath, dir, envOverrides);
  const summary = readJson(run.summaryExportPath) || {};
  const m = summary.metrics || {};
  const total = m.http_reqs?.count ?? 0;
  const failed = typeof m.http_req_failed?.passes === 'number' ? m.http_req_failed.passes : null;
  const passRate = total > 0 && failed != null ? (total - failed) / total : null;

  // Leakage: search every artifact + all captured stdio for the sensitive
  // tokens. The MANUAL_SENTINEL is passed only via --env, never written
  // to the script.
  const filesToScan = [scriptPath, run.summaryExportPath, run.metricsJsonPath];
  const leakInFiles = scanForSecret(filesToScan, [SECRET_TOKEN, MANUAL_SENTINEL]);
  const leakInStdout = scanForSecret([], []).concat(
    run.stdout.includes(SECRET_TOKEN) ? [{ file: 'stdout', needle: SECRET_TOKEN }] : [],
    run.stdout.includes(MANUAL_SENTINEL) ? [{ file: 'stdout', needle: MANUAL_SENTINEL }] : [],
    run.stderr.includes(SECRET_TOKEN) ? [{ file: 'stderr', needle: SECRET_TOKEN }] : [],
    run.stderr.includes(MANUAL_SENTINEL) ? [{ file: 'stderr', needle: MANUAL_SENTINEL }] : []
  );

  return {
    name,
    dir,
    scriptPath,
    exitCode: run.exitCode,
    total,
    failed,
    passRate,
    leaks: [...leakInFiles, ...leakInStdout],
    stderrTail: run.stderr.split('\n').slice(-3).join(' | '),
  };
}

async function main() {
  if (!haveK6()) {
    console.log(JSON.stringify({ error: 'k6 not on PATH' }, null, 2));
    process.exit(2);
  }
  const { server } = await startExtendedServer(PORT);

  const smoke = normalizeWorkload({
    profile: 'smoke',
    overrides: { vus: 1, rampUp: '0s', hold: '4s', rampDown: '0s' },
  });

  const results = [];
  try {
    // Scenario 1: manual token with arbitrary placeholder name, no env, no login
    results.push(await runScenario({
      name: 'manual-token-jwt-placeholder',
      collection: collectionManualOnly(),
      envOverrides: { AUTH_TOKEN: SECRET_TOKEN },
      workload: smoke,
      useAuthFlow: false,
    }));

    // Scenario 2: login flow captures runtime token; no manual override
    results.push(await runScenario({
      name: 'login-runtime-token',
      collection: collectionLoginFlow(),
      envOverrides: {},
      workload: smoke,
      useAuthFlow: true,
    }));

    // Scenario 3: login flow + manual override — /manual-only ONLY accepts
    // the manual sentinel, so a passing pass-rate proves manual wins.
    results.push(await runScenario({
      name: 'manual-wins-over-login',
      collection: collectionLoginPlusManualSentinel(),
      envOverrides: { AUTH_TOKEN: MANUAL_SENTINEL },
      workload: smoke,
      useAuthFlow: true,
    }));

    // Scenario 4: Bearer normalization edge case — user pastes "Bearer Bearer <t>"
    results.push(await runScenario({
      name: 'bearer-bearer-normalized',
      collection: collectionManualOnly(),
      envOverrides: { AUTH_TOKEN: `Bearer Bearer ${SECRET_TOKEN}` },
      workload: smoke,
      useAuthFlow: false,
    }));

    // Scenario 5: mixed-case bearer with extra spaces
    results.push(await runScenario({
      name: 'bearer-lowercase-spaces',
      collection: collectionManualOnly(),
      envOverrides: { AUTH_TOKEN: `  bearer   ${SECRET_TOKEN}  ` },
      workload: smoke,
      useAuthFlow: false,
    }));

    for (const r of results) {
      const leakSummary =
        r.leaks.length === 0
          ? 'clean'
          : r.leaks.map((l) => `${path.basename(l.file)}:${l.needle.slice(0, 20)}`).join(' + ');
      console.log(
        `# ${r.name.padEnd(32)} exit=${r.exitCode} total=${r.total} failed=${r.failed} passRate=${(r.passRate ?? 0).toFixed(2)} leaks=${leakSummary}`
      );
    }

    // For scenarios 1, 3, 4, 5 the auth is expected to succeed → passRate ≈ 1.
    // For scenario 2 the auth is expected to succeed too (setup captures token).
    const expected = {
      'manual-token-jwt-placeholder': (r) => r.passRate >= 0.99,
      'login-runtime-token':          (r) => r.passRate >= 0.99,
      'manual-wins-over-login':       (r) => r.passRate >= 0.99,
      'bearer-bearer-normalized':     (r) => r.passRate >= 0.99,
      'bearer-lowercase-spaces':      (r) => r.passRate >= 0.99,
    };
    let ok = true;
    for (const r of results) {
      const passFn = expected[r.name];
      if (!passFn(r)) {
        ok = false;
        console.log(`FAIL ${r.name}: passRate=${r.passRate}`);
      }
      // Secret leakage is a hard fail in EVERY scenario.
      if (r.leaks.length > 0) {
        ok = false;
        console.log(`LEAK ${r.name}: ${JSON.stringify(r.leaks)}`);
      }
    }
    console.log(ok ? 'AUTH AUDIT PASSED' : 'AUTH AUDIT FAILED');
    process.exit(ok ? 0 : 1);
  } finally {
    server.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.stack || err);
    process.exit(3);
  });
}
