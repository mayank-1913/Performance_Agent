'use strict';

const { parse } = require('../apps/api/src/lib/postman/parser');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');

function gen(body, captures = []) {
  const items = [
    {
      name: 'Login',
      request: { method: 'POST', url: { raw: 'https://x/login' }, header: [] },
      event: [
        {
          listen: 'test',
          script: {
            exec: captures.map((c) => `pm.environment.set("${c}", "cap-${c}");`),
          },
        },
      ],
    },
    {
      name: 'Req',
      request: { method: 'POST', url: { raw: 'https://x/api' }, header: [], body },
    },
  ];
  const parsed = parse({ info: { name: 't' }, item: items });
  const flow = buildAuthFlow(parsed);
  return generateK6Script(parsed, { authFlow: flow });
}

const bodies = [
  ['top-level string', { mode: 'raw', raw: '{"started_at":"{{started_at}}"}' }],
  ['nested', { mode: 'raw', raw: '{"targeting":{"campaign_type":"{{campaign_type}}"}}' }],
  ['array', { mode: 'raw', raw: '{"countries":["{{country1}}","{{country2}}"]}' }],
  ['multi-var', { mode: 'raw', raw: '{"name":"{{prefix}}-{{campaign_name}}-{{suffix}}"}' }],
  ['boolean', { mode: 'raw', raw: '{"connectedtv":{{connectedtv}}}' }],
  ['number', { mode: 'raw', raw: '{"max_daily_cost":{{max_daily_cost}}}' }],
  ['null', { mode: 'raw', raw: '{"geolist_acquisition":{{geolist_acquisition}}}' }],
  ['captured body', { mode: 'raw', raw: '{"campaign_id":"{{campaign_id}}","name":"Updated {{campaign_id}}"}' }],
];

for (const [label, body] of bodies) {
  const code = gen(body, ['campaign_id']);
  const m = code.match(/http\.post\(\s*[^,]+,\s*`([^`]+)`/);
  console.log('---', label);
  console.log(m ? m[1] : 'NO BODY');
}
