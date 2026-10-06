'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parse } = require('../src/lib/postman/parser');
const { scanCompatibility, Features } = require('../src/lib/postman/compatibility');
const {
  buildExecutionModel,
  collectFileAssets,
  isUsableLocalFilePath,
} = require('../src/lib/postman/executionModel');

function chainCollection() {
  return {
    info: { name: 'compiler-chain', schema: 'v2.1' },
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
            raw: '{"name":"{{$randomUserName}}","active":true,"count":2}',
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

test('collection-only: collection values compile and environment is optional', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const model = buildExecutionModel({
    parsed,
    rawCollection: raw,
    rawEnvironment: null,
    selection: { mode: 'all' },
  });
  assert.equal(model.environmentProvided, false);
  assert.equal(model.compiledCollectionVars.baseUrl, 'https://collection.example.test');
  assert.equal(model.compiledEnvironmentVars.baseUrl, undefined);
  assert.equal(model.variableResolution.unresolved.includes('BASE_URL'), false);
  assert.equal(model.requests.length, parsed.requests.length);
});

test('collection+environment: environment overrides collection on collision', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const model = buildExecutionModel({
    parsed,
    rawCollection: raw,
    rawEnvironment: envFile(),
    selection: { mode: 'all' },
  });
  assert.equal(model.environmentProvided, true);
  assert.equal(model.compiledEnvironmentVars.baseUrl, 'https://env.example.test');
  assert.equal(model.compiledCollectionVars.baseUrl, 'https://collection.example.test');
  assert.equal(model.variableResolution.sources.BASE_URL, 'environment');
  assert.equal(model.variableResolution.values.USERNAME, 'env-user');
});

test('selection expands generic auth + capture dependencies and skips unrelated', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCampaign');
  const model = buildExecutionModel({
    parsed,
    rawCollection: raw,
    rawEnvironment: envFile(),
    selection: { mode: 'single', requestIndex: getIdx },
  });
  const byName = Object.fromEntries(model.requests.map((r) => [r.name, r]));
  assert.equal(byName.GetCampaign.selected, true);
  assert.equal(byName.GetCampaign.execute, true);
  assert.equal(byName.CreateCampaign.execute, true);
  assert.equal(byName.CreateCampaign.isDependency, true);
  assert.equal(byName.Login.execute, true);
  assert.equal(byName.UnrelatedHealth.execute, false);
  assert.equal(byName.UnsupportedUnselected.execute, false);
});

test('unselected unsupported pre-request does not block generation of selected requests', () => {
  const raw = chainCollection();
  const parsed = parse(raw);
  const getIdx = parsed.requests.findIndex((r) => r.name === 'GetCampaign');
  const model = buildExecutionModel({
    parsed,
    rawCollection: raw,
    selection: { mode: 'single', requestIndex: getIdx },
  });
  const result = scanCompatibility({
    rawCollection: raw,
    parsed,
    blockingRequestIndices: model.executableIndices,
  });
  const unsupported = result.warnings.find((w) => w.feature === Features.PRE_REQUEST_SCRIPT_UNSUPPORTED);
  assert.ok(unsupported);
  assert.equal(unsupported.severity, 'blocking');
  assert.equal(result.hasBlocking, false);
});

test('postman-cloud src is a required runtime asset, not a local file', () => {
  assert.equal(isUsableLocalFilePath('postman-cloud:///1f0a2a13-6c0b-4a40-849a-ff673a7159d7'), false);
  assert.equal(isUsableLocalFilePath(''), false);
  assert.equal(isUsableLocalFilePath(null), false);
  assert.equal(isUsableLocalFilePath('https://example.test/a.bin'), false);
  assert.equal(isUsableLocalFilePath('/tmp/upload.bin'), true);
  const assets = collectFileAssets({
    body: {
      mode: 'formdata',
      params: [{ key: 'file', type: 'file', src: 'postman-cloud:///abc' }],
    },
  });
  assert.equal(assets[0].available, false);
});

test('parser keeps form-data file fields instead of dropping them', () => {
  const raw = {
    info: { name: 'files', schema: 'v2.1' },
    item: [
      {
        name: 'Upload',
        request: {
          method: 'POST',
          url: { raw: 'https://example.test/upload' },
          body: {
            mode: 'formdata',
            formdata: [
              { key: 'meta', value: 'x', type: 'text' },
              { key: 'file', type: 'file', src: '' },
            ],
          },
        },
      },
    ],
  };
  const parsed = parse(raw);
  const files = parsed.requests[0].body.params.filter((p) => p.type === 'file');
  assert.equal(files.length, 1);
  assert.equal(files[0].key, 'file');
});
