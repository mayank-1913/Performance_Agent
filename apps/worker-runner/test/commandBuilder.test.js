'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildK6CommandArgs,
  validateSpawnInputs,
  buildCommandPreview,
} = require('../src/commandBuilder');

const ABS_WIN = 'C:\\Users\\Mayank Harsora\\Performance Agent\\apps\\api\\storage\\scripts\\abc.js';
const ABS_NIX = '/tmp/perf/scripts/abc.js';
const ABS = process.platform === 'win32' ? ABS_WIN : ABS_NIX;

test('buildK6CommandArgs returns exactly ["run", "<absolute path>"]', () => {
  const args = buildK6CommandArgs({ scriptPath: ABS });
  assert.deepEqual(args, ['run', ABS]);
  assert.equal(args.length, 2, 'must be exactly 2 args (k6 accepts 1 positional)');
});

test('buildK6CommandArgs rejects relative paths', () => {
  assert.throws(() => buildK6CommandArgs({ scriptPath: 'rel/path.js' }), /absolute/);
});

test('buildK6CommandArgs rejects empty/missing input', () => {
  assert.throws(() => buildK6CommandArgs({}), /non-empty/);
  assert.throws(() => buildK6CommandArgs({ scriptPath: '' }), /non-empty/);
  assert.throws(() => buildK6CommandArgs({ scriptPath: null }), /non-empty/);
});

test('buildK6CommandArgs handles workspace path with spaces (regression for "k6 accepts 1 arg(s), received 3")', () => {
  const spaced = process.platform === 'win32'
    ? 'C:\\Users\\Mayank Harsora\\Performance Agent\\apps\\api\\storage\\scripts\\foo.js'
    : '/Users/Mayank Harsora/Performance Agent/scripts/foo.js';
  const args = buildK6CommandArgs({ scriptPath: spaced });
  assert.equal(args.length, 2);
  assert.equal(args[0], 'run');
  assert.equal(args[1], spaced); // single arg, not split on spaces
});

test('validateSpawnInputs accepts a valid invocation', () => {
  assert.doesNotThrow(() =>
    validateSpawnInputs({
      binPath: 'k6',
      scriptPath: ABS,
      env: { AUTH_TOKEN: 'abc', BASE_URL: 'https://example.com' },
      cwd: '/tmp',
    })
  );
});

test('validateSpawnInputs rejects bad env keys', () => {
  assert.throws(
    () =>
      validateSpawnInputs({
        binPath: 'k6',
        scriptPath: ABS,
        env: { '1bad-key': 'x' },
      }),
    /invalid env var name/
  );
});

test('validateSpawnInputs allows passthrough keys (PATH, SystemRoot, etc.)', () => {
  assert.doesNotThrow(() =>
    validateSpawnInputs({
      binPath: 'k6',
      scriptPath: ABS,
      env: { PATH: '/usr/bin', SystemRoot: 'C:\\Windows' },
    })
  );
});

test('validateSpawnInputs rejects non-string/number env values', () => {
  assert.throws(
    () =>
      validateSpawnInputs({
        binPath: 'k6',
        scriptPath: ABS,
        env: { FOO: { not: 'a string' } },
      }),
    /must be a string or number/
  );
});

test('buildCommandPreview redacts secret keys entirely and quotes spaced values', () => {
  const preview = buildCommandPreview({
    binPath: 'k6',
    args: ['run', ABS],
    env: {
      PATH: '/usr/bin',
      BASE_URL: 'https://api.example.com',
      AUTH_TOKEN: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.aBcDeF',
      JWT_TOKEN: 'short',
    },
  });
  assert.match(preview, /AUTH_TOKEN=\[REDACTED\]/);
  assert.match(preview, /JWT_TOKEN=\[REDACTED\]/);
  assert.doesNotMatch(preview, /eyJhbGciOiJIUzI1NiJ9\./, 'full JWT must not appear');
  assert.doesNotMatch(preview, /short/, 'secret values must not appear');
  assert.match(preview, /BASE_URL=https:\/\/api\.example\.com/);
  assert.doesNotMatch(preview, /(^|\s)PATH=/);
  if (/\s/.test(ABS)) {
    assert.match(preview, /"[^"]*\s[^"]*"/);
  }
});
