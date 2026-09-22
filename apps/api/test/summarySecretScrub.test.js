'use strict';

/**
 * Phase 6.5 audit — regression guard for the K6 summary.json setup_data
 * secret leak.
 *
 * K6's `--summary-export` unconditionally serializes the setup() return
 * value under a top-level `setup_data` key. When runtime auth chaining
 * is active, that object holds the captured ACCESS_TOKEN / AUTH_TOKEN /
 * cookies in plaintext. runs.manager.scrubSummarySetupData scrubs the
 * field in place before any code reads the file. This test locks that
 * behaviour in without requiring a live k6 binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { scrubSummarySetupData } = require('../src/modules/runs/runs.manager');

async function tmpFile(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scrub-'));
  const p = path.join(dir, 'summary.json');
  await fs.writeFile(p, contents, 'utf-8');
  return p;
}

test('scrubSummarySetupData removes the top-level setup_data key', async () => {
  const secret = 'audit-test-secret-x91k7z';
  const summary = {
    metrics: { http_reqs: { count: 42 } },
    setup_data: {
      ACCESS_TOKEN: secret,
      cookies: [{ name: 's', value: secret + '-cookie' }],
    },
  };
  const p = await tmpFile(JSON.stringify(summary));
  const result = await scrubSummarySetupData(p);
  assert.equal(result.scrubbed, true);
  const after = JSON.parse(await fs.readFile(p, 'utf-8'));
  assert.equal('setup_data' in after, false, 'setup_data must be gone');
  assert.equal(after.metrics.http_reqs.count, 42, 'unrelated fields must survive');
  // Full-file grep: no secret substring anywhere.
  const raw = await fs.readFile(p, 'utf-8');
  assert.ok(!raw.includes(secret), 'plaintext secret must not remain in file');
});

test('scrubSummarySetupData is a no-op when the file has no setup_data', async () => {
  const p = await tmpFile(JSON.stringify({ metrics: { http_reqs: { count: 1 } } }));
  const result = await scrubSummarySetupData(p);
  assert.equal(result.scrubbed, false);
  const after = JSON.parse(await fs.readFile(p, 'utf-8'));
  assert.equal(after.metrics.http_reqs.count, 1);
});

test('scrubSummarySetupData handles null / missing path gracefully', async () => {
  const r1 = await scrubSummarySetupData(null);
  assert.equal(r1.scrubbed, false);
  const r2 = await scrubSummarySetupData(path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  // A missing file is a soft failure — the function logs and returns
  // { scrubbed: false }; it never throws so the report pipeline keeps
  // moving.
  assert.equal(r2.scrubbed, false);
});

test('scrubSummarySetupData tolerates invalid JSON without throwing', async () => {
  const p = await tmpFile('{not: valid json');
  const result = await scrubSummarySetupData(p);
  assert.equal(result.scrubbed, false);
  assert.ok(result.error, 'error should be surfaced for observability');
});
