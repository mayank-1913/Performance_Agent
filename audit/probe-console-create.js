'use strict';

const fs = require('fs');
const path = require('path');

const COLLECTION = path.join(
  __dirname,
  '../apps/api/storage/uploads/1790073175067_e5c4e3d5-33f8-4cac-86b1-09b8ef38de44_Console_API_Monitoring_Mediasmart_postman_collection.json'
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

function redact(text) {
  return String(text || '')
    .replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"<redacted>"')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>')
    .slice(0, 2000);
}

async function main() {
  const col = JSON.parse(fs.readFileSync(COLLECTION, 'utf8'));
  const login = find(col.item, 'Login');
  const create = find(col.item, 'createCampaign');
  const loginBody = JSON.parse(login.request.body.raw);

  const lr = await fetch('https://api.mediasmart.io/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loginBody),
  });
  const lj = await lr.json();
  const token = lj.token;

  const today = new Date();
  const future = new Date(today);
  future.setDate(today.getDate() + 7);
  const toYMD = (d) => d.toISOString().split('T')[0];

  const body = JSON.parse(create.request.body.raw);
  body.started_at = toYMD(today);
  body.finished_at = toYMD(future);

  const cr = await fetch('https://api.mediasmart.io/api/v2/campaign', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: token,
    },
    body: JSON.stringify(body),
  });
  const text = await cr.text();

  console.log(
    JSON.stringify(
      {
        loginStatus: lr.status,
        tokenPresent: !!token,
        createStatus: cr.status,
        createBody: redact(text),
        started_at: body.started_at,
        finished_at: body.finished_at,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
