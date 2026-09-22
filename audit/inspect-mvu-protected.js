'use strict';

const { parse } = require('../apps/api/src/lib/postman/parser');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');
const { normalizeWorkload } = require('../apps/api/src/lib/k6/workloadProfiles');

const TARGET = 'http://127.0.0.1:4244';
const PASSWORD = 'MULTI_VU_CERT_PASS';

const col = {
  info: { name: 'mvu', schema: 'v2.1' },
  variable: [{ key: 'baseUrl', value: TARGET }],
  item: [
    {
      name: 'Login',
      request: {
        method: 'POST',
        url: { raw: `${TARGET}/login` },
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body: { mode: 'raw', raw: JSON.stringify({ username: 'user-a', password: PASSWORD }) },
      },
      event: [{
        listen: 'test',
        script: { exec: ['const j=pm.response.json();pm.environment.set("access_token",j.token);'] },
      }],
    },
    {
      name: 'Protected',
      request: {
        method: 'GET',
        url: { raw: `${TARGET}/protected` },
        header: [{ key: 'Authorization', value: 'Bearer {{access_token}}' }],
      },
    },
  ],
};

const parsed = parse(col);
const flow = buildAuthFlow(parsed);
const wl = normalizeWorkload({ profile: 'smoke', authSessionMode: 'PER_VU_LOGIN' }, { authFlowEnabled: true });
const code = generateK6Script(parsed, { authFlow: flow, workload: wl, authSessionMode: 'PER_VU_LOGIN' });
const g = code.match(/group\(`[^`]*Protected`[\s\S]*?\n  \}\);/);
console.log('Protected group:\n', g ? g[0] : 'NOT FOUND');
console.log('\nDependency graph producers:', JSON.stringify(flow.requestCaptureRules, null, 2));
