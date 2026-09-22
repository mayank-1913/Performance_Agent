'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildCommandPreview } = require('../src/commandBuilder');
const { redactLine, parseIterationLifecycle } = require('../src/streamHandler');

const ABS =
  process.platform === 'win32'
    ? 'C:\\Users\\Mayank Harsora\\Performance Agent\\apps\\api\\storage\\scripts\\abc.js'
    : '/tmp/perf/scripts/abc.js';

const FAKE_PASSWORD = 'Maya-Super-Secret-Password-1913';
const FAKE_USERNAME = 'mayank.harsora@mediasmart.io';
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aBcDeF';

test('buildCommandPreview never prints credential values', () => {
  const preview = buildCommandPreview({
    binPath: 'k6.exe',
    args: ['run', ABS],
    env: {
      BASE_URL: 'https://apinightly.mediasmart.io',
      REQUEST_TIMEOUT: '120s',
      LOGIN_USERNAME: FAKE_USERNAME,
      LOGIN_PASSWORD: FAKE_PASSWORD,
      EMAIL: 'test@example.com',
      AUTH_TOKEN: FAKE_TOKEN,
      PA_CLEAN_SUMMARY_PATH: '/tmp/summary.json.clean',
    },
  });
  assert.doesNotMatch(preview, new RegExp(FAKE_PASSWORD));
  assert.doesNotMatch(preview, new RegExp(FAKE_USERNAME));
  assert.doesNotMatch(preview, new RegExp(FAKE_TOKEN));
  assert.match(preview, /LOGIN_PASSWORD=\[REDACTED\]/);
  assert.match(preview, /LOGIN_USERNAME=\[REDACTED\]/);
  assert.match(preview, /REQUEST_TIMEOUT=120s/);
  assert.match(preview, /BASE_URL=https:\/\/apinightly\.mediasmart\.io/);
});

test('redactLine scrubs secret env assignments from streamed output', () => {
  const line = `$ BASE_URL=https://api.example.com LOGIN_USERNAME=${FAKE_USERNAME} LOGIN_PASSWORD=${FAKE_PASSWORD} k6 run script.js`;
  const redacted = redactLine(line);
  assert.doesNotMatch(redacted, new RegExp(FAKE_PASSWORD));
  assert.doesNotMatch(redacted, new RegExp(FAKE_USERNAME));
  assert.match(redacted, /LOGIN_PASSWORD=\[REDACTED\]/);
});

test('parseIterationLifecycle reads k6 stdout status line', () => {
  const lines = [
    'running (3m29.0s), 01/10 VUs, 0 complete and 9 interrupted iterations',
    'running (3m31.6s), 00/10 VUs, 0 complete and 10 interrupted iterations',
  ];
  const parsed = parseIterationLifecycle(lines);
  assert.equal(parsed.completedIterations, 0);
  assert.equal(parsed.interruptedIterations, 10);
});
