'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { start } = require('./phase7-server');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { parse } = require('../apps/api/src/lib/postman/parser');
const { sanitizeParsedCollection } = require('../apps/api/src/lib/postman/authSanitizer');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');
const { normalizeWorkload } = require('../apps/api/src/lib/k6/workloadProfiles');
const { collection } = require('./phase7-collection');
const { SECRET_TOKEN } = require('./phase7-server');
const { applySelection } = require('../apps/api/src/lib/postman/tree');

(async () => {
  const { server } = await start(4020);
  try {
    const raw = collection({ name: 'leak', baseUrl: 'http://127.0.0.1:4020' });
    const full = sanitizeParsedCollection(parse(raw)).parsed;
    const parsedE = applySelection(full, {
      mode: 'requests',
      requestIndices: [
        full.requests.findIndex((r) => r.name === 'Login'),
        full.requests.findIndex((r) => r.name === 'Get Profile'),
      ].filter((i) => i >= 0),
    }).parsed;
    const w = normalizeWorkload({ profile: 'smoke', overrides: { vus: 1, hold: '2s' } });
    const flow = buildAuthFlow(parsedE);
    const code = generateK6Script(parsedE, { injectAuthToken: true, workload: w, authFlow: flow });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leak-'));
    const scriptPath = path.join(dir, 'l.js');
    fs.writeFileSync(scriptPath, code, 'utf-8');
    const summary = path.join(dir, 's.json');
    const metrics = path.join(dir, 'm.json');
    const clean = summary + '.clean';
    const child = spawn(
      'k6',
      ['run', '--summary-export', summary, '--out', 'json=' + metrics, scriptPath],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PACING_MS: '100', BASE_URL: 'http://127.0.0.1:4020', PA_CLEAN_SUMMARY_PATH: clean } }
    );
    let out = '', err = '';
    child.stdout.on('data', c => out += c);
    child.stderr.on('data', c => err += c);
    await new Promise(r => child.on('close', r));
    console.log('---STDOUT (grepping for token)---');
    for (const line of out.split('\n')) {
      if (line.includes(SECRET_TOKEN)) console.log('LEAK: ' + line.slice(0, 200));
    }
    console.log('---STDERR (grepping for token)---');
    for (const line of err.split('\n')) {
      if (line.includes(SECRET_TOKEN)) console.log('LEAK: ' + line.slice(0, 200));
    }
    console.log('---generated script grep---');
    if (code.includes(SECRET_TOKEN)) console.log('LEAK in emitted script!');
    else console.log('script clean');
    console.log('---k6 stdout tail---');
    console.log(out.split('\n').slice(-6).join('\n'));
  } finally {
    server.close();
  }
})();
