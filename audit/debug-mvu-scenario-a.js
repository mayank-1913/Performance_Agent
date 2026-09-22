'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const AGENT_PORT = 4245;
const TARGET_PORT = 4246;

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mvu-a-'));
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = path.join(root, 'db.sqlite');
  process.env.JWT_SECRET = 'mvu-cert-secret-32chars-minimum';
  process.env.ADMIN_USERNAME = 'mvu-cert';
  process.env.ADMIN_PASSWORD = 'mvu-cert';
  process.env.LOG_LEVEL = 'error';

  // Reuse certification module internals via isolated port
  delete require.cache[require.resolve('./multi-vu-auth-certification.js')];
  const certPath = path.join(__dirname, 'multi-vu-auth-certification.js');
  let certSrc = fs.readFileSync(certPath, 'utf8');
  certSrc = certSrc.replace('const AGENT_PORT = 4243;', `const AGENT_PORT = ${AGENT_PORT};`);
  certSrc = certSrc.replace('const TARGET_PORT = 4244;', `const TARGET_PORT = ${TARGET_PORT};`);
  const tmpCert = path.join(root, 'mvu-tmp.js');
  fs.writeFileSync(tmpCert, certSrc);

  const cert = require(tmpCert);
  // Can't easily call runScenario - run trimmed main by patching
}

main();
