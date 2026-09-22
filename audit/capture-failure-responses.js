'use strict';

/**
 * One-shot diagnostic: replay failing Mediasmart requests and capture
 * redacted response bodies. Does not persist secrets.
 */

const fs = require('fs');
const path = require('path');

const COLLECTION = path.join(
  __dirname,
  '../apps/api/storage/uploads/1789627482335_83580a15-b954-4074-b703-8c2d70bb386f_Nightly_API_Monitoring_Mediasmart_postman_collection.json'
);
const ENVIRONMENT = path.join(
  __dirname,
  '../apps/api/storage/uploads/1789627527568_cf0af232-3c12-4dc3-bf46-48c76d65b987_Nightly_Mediasmart_API_Environment_postman_environment.json'
);

function envMap(raw) {
  const out = {};
  for (const v of raw.values || []) {
    if (v.enabled === false || v.value == null || String(v.value).length === 0) continue;
    out[v.key] = String(v.value);
  }
  return out;
}

function redactBody(text) {
  if (!text) return text;
  let s = String(text);
  s = s.replace(/"token"\s*:\s*"[^"]+"/gi, '"token":"<redacted>"');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer <redacted>');
  return s.slice(0, 4000);
}

function findRequest(collection, name) {
  function walk(items) {
    for (const it of items || []) {
      if (it.name === name && it.request) return it.request;
      if (it.item) {
        const f = walk(it.item);
        if (f) return f;
      }
    }
    return null;
  }
  return walk(collection.item);
}

async function requestJson(method, url, { headers = {}, body = null, timeoutMs = 120000 } = {}) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    const durationMs = Date.now() - started;
    let contentType = res.headers.get('content-type');
    let parsedJson = null;
    try {
      parsedJson = JSON.parse(text);
    } catch {
      parsedJson = null;
    }
    return {
      status: res.status,
      contentType,
      durationMs,
      headers: {
        'content-type': contentType,
      },
      body: redactBody(text),
      parsedJson,
      timeout: false,
    };
  } catch (err) {
    return {
      status: null,
      durationMs: Date.now() - started,
      timeout: err.name === 'AbortError',
      error: err.message,
      body: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const collection = JSON.parse(fs.readFileSync(COLLECTION, 'utf8'));
  const environment = JSON.parse(fs.readFileSync(ENVIRONMENT, 'utf8'));
  const env = envMap(environment);

  const loginReq = findRequest(collection, 'Login');
  const realLogin = await requestJson('POST', loginReq.url.raw, {
    headers: { 'Content-Type': 'application/json' },
    body: loginReq.body.raw,
  });
  const token =
    (realLogin.parsedJson && realLogin.parsedJson.token) ||
    env.global_auth_token ||
    null;

  const authHeader = token ? { Authorization: String(token) } : {};

  const createBody = JSON.parse(findRequest(collection, 'CreateCTVCampaign').body.raw);
  const results = {
    capturedAt: new Date().toISOString(),
    login: {
      status: realLogin.status,
      durationMs: realLogin.durationMs,
      tokenPresent: !!token,
      tokenLength: token ? String(token).length : 0,
    },
    failures: [],
  };

  const probes = [
    {
      label: 'POST /api/v2/campaign (CreateCTVCampaign)',
      method: 'POST',
      url: 'https://apinightly.mediasmart.io/api/v2/campaign',
      body: JSON.stringify(createBody),
    },
    {
      label: 'POST analytics/report',
      method: 'POST',
      url: 'https://apinightly.mediasmart.io/analytics/report',
      body: JSON.stringify({
        from: env.from || '2024-01-01',
        to: env.to || '2024-12-31',
        campaigns: [],
      }),
    },
    {
      label: 'POST location_audience',
      method: 'POST',
      url: 'https://apinightly.mediasmart.io/api/location_audience',
      body: '{}',
    },
    {
      label: 'POST /api/v2/creative',
      method: 'POST',
      url: 'https://apinightly.mediasmart.io/api/v2/creative',
      body: '{}',
    },
    {
      label: 'POST /api/deals',
      method: 'POST',
      url: 'https://apinightly.mediasmart.io/api/deals',
      body: '{}',
    },
    {
      label: 'GET /api/v2/analytics/unique-users',
      method: 'GET',
      url:
        'https://apinightly.mediasmart.io/api/v2/analytics/unique-users?campaign=olm8nzspfnboq8gbqaxhnkiq3ynnhoz5&from=2024-01-01&to=2024-12-31&kpi=impression&&format=csv',
    },
  ];

  for (const probe of probes) {
    const res = await requestJson(probe.method, probe.url, {
      headers: {
        ...authHeader,
        'Content-Type': 'application/json',
      },
      body: probe.method === 'GET' ? null : probe.body,
    });
    results.failures.push({
      label: probe.label,
      requestBodyPreview: probe.body ? redactBody(probe.body).slice(0, 500) : null,
      ...res,
    });
  }

  const outPath = path.join(__dirname, 'mediasmart-failure-response-capture.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log('Wrote', outPath);
  for (const f of results.failures) {
    console.log(`\n=== ${f.label} ===`);
    console.log('status:', f.status, 'durationMs:', f.durationMs, 'timeout:', f.timeout);
    console.log('content-type:', f.headers?.['content-type']);
    console.log('body:', (f.body || f.error || '').slice(0, 800));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
