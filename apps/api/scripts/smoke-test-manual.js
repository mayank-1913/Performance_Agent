'use strict';

const { parse } = require('../src/lib/postman/parser');
const { detectAuth } = require('../src/lib/postman/authDetector');
const { generateK6Script } = require('../src/lib/k6/generator');
const { maskToken } = require('../src/utils/secrets');

// Collection has Authorization headers but NO login flow and NO env -> MANUAL_REQUIRED
const sample = {
  info: { name: 'NoLogin', schema: 'v2.1.0' },
  item: [
    {
      name: 'GetMe',
      request: {
        method: 'GET',
        url: '{{baseUrl}}/me',
        header: [{ key: 'Authorization', value: 'Bearer {{accessToken}}' }],
      },
    },
  ],
  variable: [{ key: 'baseUrl', value: 'https://api.example.com' }],
};

const parsed = parse(sample);
const auth = detectAuth(parsed, null);
console.log('AUTH MODE:', auth.mode);
console.log('manualTokenRequired:', auth.manualTokenRequired);
console.log('unresolved:', auth.unresolvedTokenVars);

console.log('\n--- script with injectAuthToken ---');
console.log(generateK6Script(parsed, { injectAuthToken: true }));

console.log('\n--- secrets.maskToken ---');
console.log(maskToken('eyJhbGciOiJIUzI1NiJ9.payload.sig'));
