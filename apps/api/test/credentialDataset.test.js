'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseCredentialDataset,
  mapVuToCredentialIndex,
  summarizeCredentialPlan,
  injectCredentialEnvVars,
  publicCredentialDataset,
} = require('../src/lib/postman/credentialDataset');

test('parseCredentialDataset accepts array of user records', () => {
  const { records, errors } = parseCredentialDataset(
    JSON.stringify([
      { id: 'a', username: 'user-a', password: 'secret-a' },
      { id: 'b', email: 'b@example.com', pass: 'secret-b' },
    ])
  );
  assert.equal(errors.length, 0);
  assert.equal(records.length, 2);
  assert.ok(records[0].fields.LOGIN_USERNAME);
  assert.ok(records[0].fields.LOGIN_PASSWORD);
  assert.ok(records[1].fields.LOGIN_EMAIL);
  assert.ok(records[1].fields.LOGIN_PASSWORD);
});

test('mapVuToCredentialIndex rejects overflow when reuse disabled', () => {
  assert.equal(mapVuToCredentialIndex(1, 2, false), 0);
  assert.equal(mapVuToCredentialIndex(2, 2, false), 1);
  assert.equal(mapVuToCredentialIndex(3, 2, false), null);
});

test('mapVuToCredentialIndex wraps when reuse enabled', () => {
  assert.equal(mapVuToCredentialIndex(3, 2, true), 0);
});

test('injectCredentialEnvVars never exposes values in public view', () => {
  const records = [
    { id: 'u1', fields: { LOGIN_USERNAME: 'alice', LOGIN_PASSWORD: 'pw1' } },
  ];
  const secrets = {};
  injectCredentialEnvVars(records, secrets);
  assert.equal(secrets.PA_CRED_0_LOGIN_USERNAME, 'alice');
  const pub = publicCredentialDataset(records);
  assert.deepEqual(pub[0].fieldNames, ['LOGIN_USERNAME', 'LOGIN_PASSWORD']);
  assert.ok(!JSON.stringify(pub).includes('alice'));
  assert.ok(!JSON.stringify(pub).includes('pw1'));
});

test('summarizeCredentialPlan reports insufficient credentials without values', () => {
  const plan = summarizeCredentialPlan({
    vus: 5,
    records: [{ id: 'a', fields: { X: '1' } }, { id: 'b', fields: { X: '2' } }],
    reuse: false,
    authSessionMode: 'PER_VU_LOGIN',
  });
  assert.equal(plan.authenticationMode, 'PER_VU_LOGIN');
  assert.equal(plan.configuredVus, 5);
  assert.equal(plan.credentialRecords, 2);
  assert.equal(plan.credentialReuse, false);
  assert.equal(plan.credentialSufficient, false);
  assert.ok(plan.warning);
});
