'use strict';

const { parse } = require('../src/lib/postman/parser');
const { detectAuth } = require('../src/lib/postman/authDetector');
const { generateK6Script } = require('../src/lib/k6/generator');

const sample = {
  info: {
    name: 'Sample',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [
    {
      name: 'Login',
      request: {
        method: 'POST',
        url: '{{baseUrl}}/auth/login',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: '{"username":"{{user}}","password":"{{pass}}"}' },
      },
    },
    {
      name: 'GetUser',
      request: {
        method: 'GET',
        url: '{{baseUrl}}/users/{{userId}}',
        header: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
      },
    },
    {
      name: 'CreateOrder',
      request: {
        method: 'POST',
        url: '{{baseUrl}}/orders',
        header: [
          { key: 'Authorization', value: 'Bearer {{token}}' },
          { key: 'Content-Type', value: 'application/json' },
        ],
        body: { mode: 'raw', raw: '{"id":"{{orderId}}"}' },
      },
    },
  ],
  variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
};

const parsed = parse(sample);
console.log('Parsed requests:', parsed.requests.length);
console.log('Referenced vars:', parsed.referencedVars);

console.log('\n=== Auth (no env) ===');
const authNoEnv = detectAuth(parsed, null);
console.log(JSON.stringify(authNoEnv, null, 2));

console.log('\n=== Auth (with env containing token) ===');
const authWithEnv = detectAuth(parsed, {
  values: [{ key: 'token', value: 'env-token-value', enabled: true }],
});
console.log(JSON.stringify(authWithEnv, null, 2));

console.log('\n=== Generated K6 script (with injectAuthToken) ===');
const code = generateK6Script(parsed, {
  injectAuthToken: true,
  loadProfile: { vus: 10, rampUp: '10s', hold: '30s', rampDown: '10s' },
});
console.log(code);
