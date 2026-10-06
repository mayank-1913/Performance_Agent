'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parse } = require('../src/lib/postman/parser');
const { buildAuthFlow } = require('../src/lib/postman/authFlow');
const { buildExecutionModel } = require('../src/lib/postman/executionModel');
const { generateK6Script } = require('../src/lib/k6/generator');

function chainCollection() {
  return {
    info: { name: 'compiler-k6', schema: 'v2.1' },
    variable: [{ key: 'baseUrl', value: 'https://collection.example.test' }],
    item: [
      {
        name: 'Login',
        request: {
          method: 'POST',
          header: [{ key: 'Content-Type', value: 'application/json' }],
          url: { raw: '{{baseUrl}}/auth/login' },
          body: { mode: 'raw', raw: '{"user":"{{username}}","password":"{{password}}"}' },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("access_token", json.token);',
              ],
            },
          },
        ],
      },
      {
        name: 'CreateCampaign',
        request: {
          method: 'POST',
          header: [
            { key: 'Authorization', value: 'Bearer {{access_token}}' },
            { key: 'Content-Type', value: 'application/json' },
          ],
          url: { raw: '{{baseUrl}}/campaigns' },
          body: {
            mode: 'raw',
            raw: '{"name":"{{$randomUserName}}","active":true,"count":2,"nested":{"ok":null}}',
            options: { raw: { language: 'json' } },
          },
        },
        event: [
          {
            listen: 'test',
            script: {
              exec: [
                'const json = pm.response.json();',
                'pm.environment.set("campaign_id", json.data.id);',
              ],
            },
          },
        ],
      },
      {
        name: 'GetCampaign',
        request: {
          method: 'GET',
          header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
          url: { raw: '{{baseUrl}}/campaigns/{{campaign_id}}' },
        },
      },
      {
        name: 'UnrelatedHealth',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/health' },
        },
      },
      {
        name: 'UnsupportedUnselected',
        request: {
          method: 'POST',
          header: [],
          url: { raw: '{{baseUrl}}/eval' },
        },
        event: [
          {
            listen: 'prerequest',
            script: { exec: ['eval("bad")'] },
          },
        ],
      },
    ],
  };
}

function envFile() {
  return {
    name: 'staging',
    values: [
      { key: 'baseUrl', value: 'https://env.example.test', enabled: true },
      { key: 'username', value: 'env-user', enabled: true },
      { key: 'password', value: 'env-pass', enabled: true },
    ],
  };
}

function generateFrom(raw, rawEnvironment, selection) {
  const parsed = parse(raw);
  const model = buildExecutionModel({
    parsed,
    rawCollection: raw,
    rawEnvironment,
    selection,
  });
  const code = generateK6Script(parsed, {
    authFlow: model.authFlow,
    executionModel: model,
    injectAuthToken: false,
  });
  return { parsed, model, code };
}

function parsesAsESM(code) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compiler-k6-'));
  const file = path.join(tmp, 'script.mjs');
  fs.writeFileSync(file, code, 'utf-8');
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf-8' });
  return { ok: r.status === 0, stderr: r.stderr || '' };
}

function assertCompilerShape(code, { envUrl = null, collectionUrl }) {
  const check = parsesAsESM(code);
  assert.ok(check.ok, check.stderr);
  assert.match(code, /group\(`Login`,/);
  assert.match(code, /group\(`CreateCampaign`,/);
  assert.match(code, /group\(`GetCampaign`,/);
  assert.match(code, /group\(`UnrelatedHealth`,/);
  assert.match(code, /__shouldExecuteRequest\(/);
  assert.match(code, /__getCompiledVar\(/);
  assert.match(code, /__resolveDynamicVar\("\$randomUserName"/);
  assert.match(code, /__captureResponseVars\(/);
  assert.match(code, /campaign_id/);
  assert.match(code, /__checkDependencyDeps/);
  assert.match(code, /"api_name": "GetCampaign"/);
  assert.match(code, /"api_method": "GET"/);
  assert.match(code, /workload_profile/);
  if (envUrl) {
    assert.match(code, new RegExp(envUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(code, new RegExp(collectionUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

test('collection only → generated executable K6 script', () => {
  const raw = chainCollection();
  const { code, model } = generateFrom(raw, null, { mode: 'all' });
  assertCompilerShape(code, { collectionUrl: 'https://collection.example.test' });
  assert.equal(model.environmentProvided, false);
  assert.match(code, /__COMPILED_COLLECTION_VARS = \{"baseUrl":"https:\/\/collection\.example\.test"\}/);
  assert.match(code, /__COMPILED_ENVIRONMENT_VARS = \{\}/);
  assert.match(code, /__getCompiledVar\("baseUrl"/);
});

test('collection + environment → generated executable K6 script', () => {
  const raw = chainCollection();
  const { code, model } = generateFrom(raw, envFile(), { mode: 'all' });
  assertCompilerShape(code, {
    collectionUrl: 'https://collection.example.test',
    envUrl: 'https://env.example.test',
  });
  assert.equal(model.environmentProvided, true);
  assert.match(code, /"baseUrl":"https:\/\/env\.example\.test"/);
  assert.match(code, /"username":"env-user"/);
  assert.match(code, /__getCompiledVar\("baseUrl"/);
  assert.match(code, /__getCompiledVar\("username"/);
});

test('selected GetCampaign executes Login + CreateCampaign and skips unrelated', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCampaign');
  const { code, model } = generateFrom(raw, envFile(), { mode: 'single', requestIndex: getIdx });
  assert.deepEqual(
    model.requests.filter((r) => r.execute).map((r) => r.name),
    ['Login', 'CreateCampaign', 'GetCampaign']
  );
  assert.match(code, /__EXECUTABLE_INDICES = \[0,1,2\]/);
  assert.match(code, /__SELECTED_INDICES = \[2\]/);
  assert.match(code, /group\(`UnrelatedHealth`,/);
  assert.match(code, /group\(`UnsupportedUnselected`,/);
});

test('unselected unsupported request is still represented and does not prevent generation', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCampaign');
  const { code } = generateFrom(raw, null, { mode: 'single', requestIndex: getIdx });
  const check = parsesAsESM(code);
  assert.ok(check.ok, check.stderr);
  assert.match(code, /group\(`UnsupportedUnselected`,/);
  assert.match(code, /__shouldExecuteRequest\(4\)/);
});

function fileCollection() {
  return {
    info: { name: 'file-assets', schema: 'v2.1' },
    item: [
      {
        name: 'Ping',
        request: { method: 'GET', header: [], url: { raw: 'https://example.test/ping' } },
      },
      {
        name: 'CloudUpload',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/cloud' },
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'meta', value: 'x', type: 'text' },
              { key: 'file', type: 'file', src: 'postman-cloud:///1f0a2a13-dead-beef' },
            ],
          },
        },
      },
      {
        name: 'LocalUpload',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/local' },
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'file', type: 'file', src: '/tmp/upload.bin' },
            ],
          },
        },
      },
    ],
  };
}

test('postman-cloud:// does not emit open()', () => {
  const { code, model } = generateFrom(fileCollection(), null, { mode: 'all' });
  assert.doesNotMatch(code, /open\("postman-cloud:/);
  const cloud = model.requests.find((r) => r.name === 'CloudUpload');
  assert.equal(cloud.assets[0].available, false);
  assert.match(code, /required runtime file asset is unavailable/);
});

test('unselected cloud-file request cannot break script loading', () => {
  const { code } = generateFrom(fileCollection(), null, { mode: 'single', requestIndex: 0 });
  const check = parsesAsESM(code);
  assert.ok(check.ok, check.stderr);
  assert.doesNotMatch(code, /open\("postman-cloud:/);
  assert.match(code, /group\(`CloudUpload`,/);
  assert.match(code, /__SELECTED_INDICES = \[0\]/);
});

test('valid local file still emits open()', () => {
  const { code, model } = generateFrom(fileCollection(), null, { mode: 'all' });
  assert.match(code, /open\("\/tmp\/upload\.bin", 'b'\)/);
  const local = model.requests.find((r) => r.name === 'LocalUpload');
  assert.equal(local.assets[0].available, true);
  assert.match(code, /http\.file\(__fileAsset_2_file/);
});

test('generated script expands nested environment {{variable}} at runtime', () => {
  const raw = {
    info: { name: 'nested-env', schema: 'v2.1' },
    item: [
      {
        name: 'Whoami',
        request: {
          method: 'GET',
          header: [],
          url: { raw: '{{baseUrl}}/users/{{email}}' },
        },
      },
    ],
  };
  const env = {
    values: [
      { key: 'baseUrl', value: 'https://api.example.test', enabled: true },
      { key: 'email', value: 'testuser+{{idSuffix}}@example.com', enabled: true },
      { key: 'idSuffix', value: '42', enabled: true },
    ],
  };
  const { code } = generateFrom(raw, env, { mode: 'all' });
  assert.match(code, /"email":"testuser\+\{\{idSuffix\}\}@example\.com"/);
  assert.match(code, /"idSuffix":"42"/);
  assert.match(code, /function __expandNestedVars/);
  assert.match(code, /__getCompiledVar\("email"/);
});

test('generated script keeps nested dynamic variables as runtime generation', () => {
  const raw = {
    info: { name: 'nested-dyn', schema: 'v2.1' },
    item: [
      {
        name: 'Signup',
        request: {
          method: 'POST',
          header: [],
          url: { raw: '{{baseUrl}}/signup' },
          body: { mode: 'raw', raw: '{"user":"{{username}}"}', options: { raw: { language: 'json' } } },
        },
      },
    ],
  };
  const env = {
    values: [
      { key: 'baseUrl', value: 'https://api.example.test', enabled: true },
      { key: 'username', value: 'user_{{$randomUserName}}', enabled: true },
    ],
  };
  const { code } = generateFrom(raw, env, { mode: 'all' });
  assert.match(code, /"username":"user_\{\{\$randomUserName\}\}"/);
  assert.doesNotMatch(code, /"username":"user_\d+"/);
  assert.match(code, /__resolveDynamicVar/);
  assert.match(code, /__expandCompiledValue/);
});
