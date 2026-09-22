'use strict';

const { execSync } = require('child_process');
const path = require('path');

const script = path.join(
  __dirname,
  '../apps/api/storage/scripts/1a726be1-483b-4bf0-b5e1-776952f515ab.js'
);

const fs = require('fs');
const col = JSON.parse(
  fs.readFileSync(
    path.join(
      __dirname,
      '../apps/api/storage/uploads/1790073175067_e5c4e3d5-33f8-4cac-86b1-09b8ef38de44_Console_API_Monitoring_Mediasmart_postman_collection.json'
    ),
    'utf8'
  )
);
function find(items, name) {
  for (const it of items || []) {
    if (it.name === name && it.request) return it;
    if (it.item) {
      const f = find(it.item, name);
      if (f) return f;
    }
  }
  return null;
}
const loginBody = JSON.parse(find(col.item, 'Login').request.body.raw);
const env = {
  ...process.env,
  REQUEST_TIMEOUT: '120s',
  PACING_MS: '500',
  BASEAPI_URL: 'https://api.mediasmart.io',
  BASE_URL: 'https://console.mediasmart.io',
  LOGIN_USERNAME: loginBody.username,
  LOGIN_PASSWORD: loginBody.password,
};

try {
  execSync(
    `k6 run --iterations 1 --vus 1 --summary-export "${path.join(__dirname, 'replay-summary.json')}" "${script}"`,
    { env, stdio: 'inherit', timeout: 120000 }
  );
} catch (e) {
  process.exitCode = e.status || 1;
}
