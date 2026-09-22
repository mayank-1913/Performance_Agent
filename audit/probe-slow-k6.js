'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const port = 9876;
const s = http.createServer((req, res) => {
  console.log('server hit', req.url);
  if (req.url === '/slow-200') {
    setTimeout(() => { res.writeHead(200); res.end('ok'); }, 3500);
    return;
  }
  if (req.url === '/hang') return;
  res.end();
});

async function runK6(pathname, timeout) {
  const script = [
    "import http from 'k6/http';",
    'export const options = { vus: 1, iterations: 1 };',
    'export default function () {',
    `  const res = http.get('http://127.0.0.1:${port}${pathname}', { timeout: '${timeout}' });`,
    "  console.log('${pathname} status=' + res.status + ' dur=' + res.timings.duration + ' err=' + res.error);",
    '}',
  ].join('\n');
  const file = path.join(__dirname, 'probe-slow-k6-script.js');
  fs.writeFileSync(file, script);
  const p = spawnSync('k6', ['run', file], { encoding: 'utf8' });
  const line = (p.stdout + p.stderr).split('\n').find((l) => l.includes('status='));
  console.log(pathname, line || p.status);
}

s.listen(port, async () => {
  await runK6('/hang', '5s');
  await runK6('/slow-200', '10s');
  s.close();
});
