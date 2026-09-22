'use strict';
const { parse } = require('../apps/api/src/lib/postman/parser');
const { generateK6Script } = require('../apps/api/src/lib/k6/generator');
const { buildAuthFlow } = require('../apps/api/src/lib/postman/authFlow');

const parsedE = parse({
  info: { name: 'fixture-e' },
  item: [
    { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
    {
      name: 'Dyn',
      request: {
        method: 'POST',
        url: { raw: 'https://example.test/t/{{$timestamp}}' },
        body: { mode: 'raw', raw: '{"id":"{{$randomUUID}}","ts":"{{$timestamp}}"}' },
      },
    },
  ],
});
const codeE = generateK6Script(parsedE, { authFlow: buildAuthFlow(parsedE) });
const hits = codeE.match(/\{\{\$timestamp\}\}/g);
console.log('E hits', hits ? hits.length : 0);
console.log('E has resolveDynamic', /__resolveDynamicVar/.test(codeE));
const m = codeE.match(/group\(`Dyn`[\s\S]{0,1200}/);
console.log(m ? m[0] : 'no dyn group');

const body =
  '{"outer":{"inner":"{{runtime_id}}"},"items":["{{item_id}}",{{numeric_value}}],"enabled":{{enabled}}}';
const parsedD = parse({
  info: { name: 'fixture-d' },
  item: [
    { name: 'Login', request: { method: 'POST', url: { raw: 'https://example.test/login' }, header: [] } },
    {
      name: 'Post',
      request: {
        method: 'POST',
        url: { raw: 'https://example.test/x' },
        body: { mode: 'raw', raw: body, language: 'json' },
      },
    },
  ],
});
const codeD = generateK6Script(parsedD, { authFlow: buildAuthFlow(parsedD) });
console.log('D resolveJson', /__resolveJsonLiteral/.test(codeD));
const md = codeD.match(/const __body_\d+ = (`[^`]+`)/);
console.log('D body', md ? md[1].slice(0, 300) : 'none');
