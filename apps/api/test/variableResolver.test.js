'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveVariables,
  publicResolution,
  extractCollectionVariables,
  extractEnvironmentVariables,
  toEnvName,
} = require('../src/lib/postman/variableResolver');

/* Helpers ---------------------------------------------------------------- */

const collectionVars = (obj) =>
  Object.entries(obj).map(([key, value]) => ({ key, value, type: 'string' }));

const envValues = (obj) =>
  Object.entries(obj).map(([key, value]) => ({ key, value, enabled: true, type: 'default' }));

function findEntry(res, envName) {
  return res.entries.find((e) => e.envName === envName) || null;
}

/* --------------------------------------------------------------------- */
/* Case A — collection only                                              */
/* --------------------------------------------------------------------- */
test('Case A: collection variables only resolve without an environment', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://api.example.com', apiVersion: 'v2' }),
    environmentVariables: null,
    runtimeOverrides: null,
    referencedVars: ['baseUrl', 'apiVersion'],
  });
  assert.equal(res.environmentProvided, false);
  assert.equal(res.unresolved.length, 0);
  assert.deepEqual(res.values, {
    BASE_URL: 'https://api.example.com',
    API_VERSION: 'v2',
  });
  assert.equal(res.sources.BASE_URL, 'collection');
  assert.equal(res.sources.API_VERSION, 'collection');
  assert.equal(findEntry(res, 'BASE_URL').secret, false);
  assert.equal(res.warnings.length, 0);
});

/* --------------------------------------------------------------------- */
/* Case B / environment only                                             */
/* --------------------------------------------------------------------- */
test('Environment only: env values resolve when the collection defines nothing', () => {
  const res = resolveVariables({
    collectionVariables: null,
    environmentVariables: envValues({ baseUrl: 'https://staging.example.com' }),
    runtimeOverrides: null,
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.environmentProvided, true);
  assert.equal(res.values.BASE_URL, 'https://staging.example.com');
  assert.equal(res.sources.BASE_URL, 'environment');
  assert.deepEqual(res.unresolved, []);
});

/* --------------------------------------------------------------------- */
/* Case B — collection + environment (no collision)                      */
/* --------------------------------------------------------------------- */
test('Collection + environment: both contribute values with no collision', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ apiVersion: 'v1' }),
    environmentVariables: envValues({ baseUrl: 'https://env.example.com' }),
    referencedVars: ['baseUrl', 'apiVersion'],
  });
  assert.equal(res.sources.BASE_URL, 'environment');
  assert.equal(res.sources.API_VERSION, 'collection');
  assert.deepEqual(res.unresolved, []);
});

/* --------------------------------------------------------------------- */
/* Environment overrides collection on collision                         */
/* --------------------------------------------------------------------- */
test('Environment overrides collection when the same variable is defined in both', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://collection-default.example.com' }),
    environmentVariables: envValues({ baseUrl: 'https://env-override.example.com' }),
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.values.BASE_URL, 'https://env-override.example.com');
  assert.equal(res.sources.BASE_URL, 'environment');
});

/* --------------------------------------------------------------------- */
/* Collection variable stays when environment does not contain it        */
/* --------------------------------------------------------------------- */
test('Collection variable remains when environment does not contain it', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ apiVersion: 'v3', region: 'us-east-1' }),
    environmentVariables: envValues({ baseUrl: 'https://api.example.com' }),
    referencedVars: ['baseUrl', 'apiVersion', 'region'],
  });
  assert.equal(res.values.API_VERSION, 'v3');
  assert.equal(res.sources.API_VERSION, 'collection');
  assert.equal(res.values.REGION, 'us-east-1');
  assert.equal(res.sources.REGION, 'collection');
  assert.equal(res.values.BASE_URL, 'https://api.example.com');
  assert.equal(res.sources.BASE_URL, 'environment');
});

/* --------------------------------------------------------------------- */
/* Disabled env variable is ignored (falls through to collection)        */
/* --------------------------------------------------------------------- */
test('Disabled environment variable is ignored and falls through to the collection', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://collection.example.com' }),
    environmentVariables: [
      { key: 'baseUrl', value: 'https://disabled-env.example.com', enabled: false, type: 'default' },
    ],
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.values.BASE_URL, 'https://collection.example.com');
  assert.equal(res.sources.BASE_URL, 'collection');
});

/* --------------------------------------------------------------------- */
/* Empty env variable falls through to collection                        */
/* --------------------------------------------------------------------- */
test('Empty environment variable falls through to the collection value', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://collection.example.com' }),
    environmentVariables: [
      { key: 'baseUrl', value: '', enabled: true, type: 'default' },
    ],
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.values.BASE_URL, 'https://collection.example.com');
  assert.equal(res.sources.BASE_URL, 'collection');
});

/* --------------------------------------------------------------------- */
/* Unresolved variable                                                   */
/* --------------------------------------------------------------------- */
test('Unresolved: a referenced variable no source defines shows up in unresolved', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://api.example.com' }),
    environmentVariables: null,
    referencedVars: ['baseUrl', 'missingThing'],
  });
  assert.deepEqual(res.unresolved, ['MISSING_THING']);
  const entry = findEntry(res, 'MISSING_THING');
  assert.equal(entry.resolved, false);
  assert.equal(entry.source, 'unresolved');
  assert.equal(entry.referenced, true);
});

/* --------------------------------------------------------------------- */
/* Manual runtime override wins over environment and collection          */
/* --------------------------------------------------------------------- */
test('Manual runtime override wins over environment and collection', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://collection.example.com' }),
    environmentVariables: envValues({ baseUrl: 'https://env.example.com' }),
    runtimeOverrides: { BASE_URL: 'https://manual.example.com' },
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.values.BASE_URL, 'https://manual.example.com');
  assert.equal(res.sources.BASE_URL, 'runtime');
});

/* --------------------------------------------------------------------- */
/* AUTH_TOKEN precedence                                                 */
/* --------------------------------------------------------------------- */
test('AUTH_TOKEN precedence: runtime beats environment beats collection', () => {
  const runtime = resolveVariables({
    collectionVariables: collectionVars({ AUTH_TOKEN: 'collection-token' }),
    environmentVariables: envValues({ AUTH_TOKEN: 'env-token' }),
    runtimeOverrides: { AUTH_TOKEN: 'manual-token' },
    referencedVars: ['AUTH_TOKEN'],
  });
  assert.equal(runtime.values.AUTH_TOKEN, 'manual-token');
  assert.equal(runtime.sources.AUTH_TOKEN, 'runtime');
  assert.equal(findEntry(runtime, 'AUTH_TOKEN').secret, true);

  const envOnly = resolveVariables({
    collectionVariables: collectionVars({ AUTH_TOKEN: 'collection-token' }),
    environmentVariables: envValues({ AUTH_TOKEN: 'env-token' }),
    referencedVars: ['AUTH_TOKEN'],
  });
  assert.equal(envOnly.values.AUTH_TOKEN, 'env-token');
  assert.equal(envOnly.sources.AUTH_TOKEN, 'environment');

  const collectionOnly = resolveVariables({
    collectionVariables: collectionVars({ AUTH_TOKEN: 'collection-token' }),
    environmentVariables: null,
    referencedVars: ['AUTH_TOKEN'],
  });
  assert.equal(collectionOnly.values.AUTH_TOKEN, 'collection-token');
  assert.equal(collectionOnly.sources.AUTH_TOKEN, 'collection');
});

/* --------------------------------------------------------------------- */
/* Duplicate environment keys                                            */
/* --------------------------------------------------------------------- */
test('Duplicate environment keys: last enabled non-empty wins and a duplicate is reported', () => {
  const res = resolveVariables({
    collectionVariables: null,
    environmentVariables: [
      { key: 'baseUrl', value: 'https://first.example.com', enabled: true, type: 'default' },
      { key: 'baseUrl', value: 'https://second.example.com', enabled: true, type: 'default' },
    ],
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.values.BASE_URL, 'https://second.example.com');
  assert.deepEqual(
    res.duplicates.map((d) => ({ scope: d.scope, envName: d.envName, count: d.count })),
    [{ scope: 'environment', envName: 'BASE_URL', count: 2 }]
  );
});

/* --------------------------------------------------------------------- */
/* Hyphen / underscore normalization                                     */
/* --------------------------------------------------------------------- */
test('Variable names with hyphens / underscores normalize to the same envName', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ 'api-key': 'from-hyphen' }),
    environmentVariables: envValues({ api_key: 'from-underscore' }),
    referencedVars: ['api-key', 'apiKey'],
  });
  // Environment wins on the collision, and both hyphen and camelCase
  // references resolve to the same envName.
  assert.equal(res.values.API_KEY, 'from-underscore');
  assert.equal(res.sources.API_KEY, 'environment');
  assert.deepEqual(res.unresolved, []);
});

/* --------------------------------------------------------------------- */
/* Secret masking metadata                                               */
/* --------------------------------------------------------------------- */
test('Secret detection: token-shaped keys are flagged as secret', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://api.example.com' }),
    environmentVariables: envValues({ JWT_TOKEN: 'a.b.c', api_password: 'p' }),
    referencedVars: ['baseUrl', 'JWT_TOKEN', 'api_password'],
  });
  assert.equal(findEntry(res, 'BASE_URL').secret, false);
  assert.equal(findEntry(res, 'JWT_TOKEN').secret, true);
  assert.equal(findEntry(res, 'API_PASSWORD').secret, true);
});

/* --------------------------------------------------------------------- */
/* publicResolution strips values                                        */
/* --------------------------------------------------------------------- */
test('publicResolution() never exposes plaintext values', () => {
  const res = resolveVariables({
    collectionVariables: null,
    environmentVariables: envValues({ AUTH_TOKEN: 'top-secret-token' }),
    referencedVars: ['AUTH_TOKEN'],
  });
  const pub = publicResolution(res);
  assert.equal(typeof pub, 'object');
  assert.equal(pub.values, undefined);
  const serialized = JSON.stringify(pub);
  assert.ok(!serialized.includes('top-secret-token'), 'public view leaked a secret value');
});

/* --------------------------------------------------------------------- */
/* No false warning when collection alone resolves everything            */
/* --------------------------------------------------------------------- */
test('No environment + collection resolves everything => no warning', () => {
  const res = resolveVariables({
    collectionVariables: collectionVars({ baseUrl: 'https://api.example.com' }),
    environmentVariables: null,
    referencedVars: ['baseUrl'],
  });
  assert.equal(res.environmentProvided, false);
  assert.equal(res.warnings.length, 0);
  assert.deepEqual(res.unresolved, []);
});

/* --------------------------------------------------------------------- */
/* Convenience extractors                                                */
/* --------------------------------------------------------------------- */
test('extractCollectionVariables / extractEnvironmentVariables pull the right arrays', () => {
  const rawCollection = { variable: [{ key: 'baseUrl', value: 'https://a' }] };
  const rawEnv = { values: [{ key: 'apiKey', value: 'x', enabled: true }] };
  assert.deepEqual(extractCollectionVariables(rawCollection), rawCollection.variable);
  assert.deepEqual(extractEnvironmentVariables(rawEnv), rawEnv.values);
  assert.deepEqual(extractCollectionVariables(null), []);
  assert.deepEqual(extractEnvironmentVariables(null), []);
});

/* --------------------------------------------------------------------- */
/* toEnvName remains identical to generator.toEnvName behaviour          */
/* --------------------------------------------------------------------- */
test('toEnvName normalization matches the K6 generator convention', () => {
  assert.equal(toEnvName('baseUrl'), 'BASE_URL');
  assert.equal(toEnvName('api-key'), 'API_KEY');
  assert.equal(toEnvName('api_key'), 'API_KEY');
  assert.equal(toEnvName('  spaced name  '), 'SPACED_NAME');
  assert.equal(toEnvName('ALREADY_UPPER'), 'ALREADY_UPPER');
});
