'use strict';

// Focused tests for D1: inline `new Date().<chain>` support in the
// pre-request translator. These are additive to bodyVariableResolution's
// existing coverage of the intermediate-variable form.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { analyzePrerequestScript } = require('../src/lib/postman/prerequestCodegen');

test('D1-1: pm.environment.set + new Date().toISOString().split("T")[0] is translated', () => {
  const result = analyzePrerequestScript(
    'pm.environment.set("started_at", new Date().toISOString().split("T")[0]);'
  );
  assert.equal(result.translatable, true, result.reason || '');
  assert.deepEqual(result.setsEnvironment, ['started_at']);
  const joined = result.k6Lines.join('\n');
  assert.match(joined, /__pmSet\(state, 'environment', "started_at"/);
  assert.match(joined, /new Date\(\)\.toISOString\(\)\.split\('T'\)\[0\]/);
});

test('D1-2: pm.environment.set + bare new Date().toISOString() is translated', () => {
  const result = analyzePrerequestScript(
    'pm.environment.set("timestamp", new Date().toISOString());'
  );
  assert.equal(result.translatable, true, result.reason || '');
  assert.deepEqual(result.setsEnvironment, ['timestamp']);
  const joined = result.k6Lines.join('\n');
  assert.match(joined, /__pmSet\(state, 'environment', "timestamp"/);
  assert.match(joined, /new Date\(\)\.toISOString\(\)/);
  assert.doesNotMatch(joined, /split/);
});

test('D1-3: intermediate-variable form keeps working', () => {
  const script = [
    'const today = new Date();',
    'const future = new Date();',
    'future.setDate(today.getDate() + 7);',
    'const toYMD = (d) => d.toISOString().split("T")[0];',
    'pm.environment.set("startDate", toYMD(today));',
    'pm.environment.set("endDate", toYMD(future));',
  ].join('\n');
  const result = analyzePrerequestScript(script);
  assert.equal(result.translatable, true, result.reason || '');
  assert.deepEqual(result.setsEnvironment.sort(), ['endDate', 'startDate']);
});

test('D1-4: unsupported arbitrary JS is still rejected', () => {
  // eval must stay forbidden.
  const r1 = analyzePrerequestScript(
    'pm.environment.set("x", eval("1+1"));'
  );
  assert.equal(r1.translatable, false);

  // require must stay forbidden.
  const r2 = analyzePrerequestScript(
    'const fs = require("fs"); pm.environment.set("x", "y");'
  );
  assert.equal(r2.translatable, false);

  // unknown chained method on Date must not silently translate.
  const r3 = analyzePrerequestScript(
    'pm.environment.set("x", new Date().toLocaleString("en-US"));'
  );
  assert.equal(r3.translatable, false);
});
