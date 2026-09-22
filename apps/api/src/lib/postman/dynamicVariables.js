'use strict';

/**
 * Postman dynamic variable support.
 *
 * Dynamic variables use the {{$name}} syntax. Values are generated at
 * request runtime and cached per request execution so repeated references
 * within the same request resolve to the same value (Postman semantics).
 */

const SUPPORTED_DYNAMIC = new Set([
  '$timestamp',
  '$isoTimestamp',
  '$guid',
  '$randomUUID',
  '$randomInt',
  '$randomFirstName',
  '$randomLastName',
  '$randomEmail',
  '$randomUserName',
  '$randomPassword',
  '$randomBoolean',
]);

const FIRST_NAMES = ['Alex', 'Jordan', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery'];
const LAST_NAMES = ['Smith', 'Johnson', 'Lee', 'Brown', 'Garcia', 'Patel', 'Kim', 'Nguyen'];

function isDynamicVariable(name) {
  return typeof name === 'string' && name.startsWith('$') && SUPPORTED_DYNAMIC.has(name.trim());
}

function parseRandomIntArgs(name) {
  // Postman: {{$randomInt}} defaults to 0-1000; {{$randomInt min max}} is not standard in all versions.
  return { min: 0, max: 1000 };
}

/**
 * Plan-time resolver for tests and wire comparison.
 * @param {string} name e.g. "$timestamp"
 * @param {{ now?: () => Date, random?: () => number, uuid?: () => string }} [provider]
 * @param {Map<string, unknown>} [cache] per-request cache
 */
function resolveDynamicVariable(name, provider = {}, cache = null) {
  const key = String(name || '').trim();
  if (!SUPPORTED_DYNAMIC.has(key)) {
    return { ok: false, reason: 'UNSUPPORTED_DYNAMIC_VARIABLE', value: null };
  }
  if (cache && cache.has(key)) {
    return { ok: true, source: 'DYNAMIC_RESOLVED', value: cache.get(key) };
  }

  const now = provider.now ? provider.now() : new Date();
  const random = provider.random ? provider.random() : Math.random();
  const uuid = provider.uuid
    ? provider.uuid()
    : '00000000-0000-4000-8000-000000000000';

  let value;
  switch (key) {
    case '$timestamp':
      value = Math.floor(now.getTime() / 1000);
      break;
    case '$isoTimestamp':
      value = now.toISOString();
      break;
    case '$guid':
    case '$randomUUID':
      value = uuid;
      break;
    case '$randomInt': {
      const { min, max } = parseRandomIntArgs(key);
      value = Math.floor(random * (max - min + 1)) + min;
      break;
    }
    case '$randomFirstName':
      value = FIRST_NAMES[Math.floor(random * FIRST_NAMES.length)];
      break;
    case '$randomLastName':
      value = LAST_NAMES[Math.floor(random * LAST_NAMES.length)];
      break;
    case '$randomEmail': {
      const n = Math.floor(random * 1_000_000);
      value = `user${n}@example.test`;
      break;
    }
    case '$randomUserName': {
      const n = Math.floor(random * 1_000_000);
      value = `user_${n}`;
      break;
    }
    case '$randomPassword': {
      const n = Math.floor(random * 1_000_000_000);
      value = `Pw_${n}!`;
      break;
    }
    case '$randomBoolean':
      value = random < 0.5;
      break;
    default:
      return { ok: false, reason: 'UNSUPPORTED_DYNAMIC_VARIABLE', value: null };
  }

  if (cache) cache.set(key, value);
  return { ok: true, source: 'DYNAMIC_RESOLVED', value };
}

/** K6 runtime helper block (emitted into generated scripts). */
const DYNAMIC_VARIABLE_RUNTIME_JS = `
function __resolveDynamicVar(name, cache) {
  const key = String(name || '').trim();
  if (!key || !key.startsWith('$')) return '';
  if (cache && Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];
  let value;
  switch (key) {
    case '$timestamp':
      value = Math.floor(Date.now() / 1000);
      break;
    case '$isoTimestamp':
      value = new Date().toISOString();
      break;
    case '$guid':
    case '$randomUUID':
      value = (__crypto && __crypto.randomUUID) ? __crypto.randomUUID() : String(Date.now()) + '-' + String(Math.random()).slice(2);
      break;
    case '$randomInt':
      value = Math.floor(Math.random() * 1001);
      break;
    case '$randomFirstName':
      value = ['Alex','Jordan','Taylor','Morgan','Casey','Riley','Quinn','Avery'][Math.floor(Math.random() * 8)];
      break;
    case '$randomLastName':
      value = ['Smith','Johnson','Lee','Brown','Garcia','Patel','Kim','Nguyen'][Math.floor(Math.random() * 8)];
      break;
    case '$randomEmail':
      value = 'user' + Math.floor(Math.random() * 1000000) + '@example.test';
      break;
    case '$randomUserName':
      value = 'user_' + Math.floor(Math.random() * 1000000);
      break;
    case '$randomPassword':
      value = 'Pw_' + Math.floor(Math.random() * 1000000000) + '!';
      break;
    case '$randomBoolean':
      value = Math.random() < 0.5;
      break;
    default:
      return '__UNSUPPORTED_DYNAMIC__' + key;
  }
  if (cache) cache[key] = value;
  return value;
}
`.trim();

module.exports = {
  SUPPORTED_DYNAMIC,
  isDynamicVariable,
  resolveDynamicVariable,
  DYNAMIC_VARIABLE_RUNTIME_JS,
};
