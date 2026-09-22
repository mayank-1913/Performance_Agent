'use strict';

/**
 * Postman request-local variables (collection item.variable[]).
 *
 * Postman precedence at request time (highest first):
 *   1. Manual runtime override (__ENV from UI / run payload)
 *   2. Pre-request script mutations (pm.environment / pm.variables / pm.collectionVariables)
 *   3. Request-local initial values (item.variable)
 *   4. Runtime-captured values (data.vars from pm.*.set in tests / upstream)
 *   5. Environment variables (__ENV backfill)
 *   6. Collection variables (__ENV backfill)
 *   7. Dynamic variables ({{$timestamp}}, etc.)
 *
 * Auth token precedence remains specialized in the generator and is unchanged.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function normalizeRequestVariables(requestVariables) {
  const map = new Map();
  for (const item of requestVariables || []) {
    if (!item || item.disabled === true || !item.key) continue;
    const key = String(item.key);
    const value = item.value == null ? '' : String(item.value);
    map.set(key, {
      key,
      value,
      hasNestedRefs: /\{\{[^}]+\}\}/.test(value),
    });
  }
  return map;
}

function listRequestLocalKeys(requestVariables) {
  return Array.from(normalizeRequestVariables(requestVariables).keys());
}

/**
 * K6 runtime helper: per-request local values + prerequest mutations.
 * Stored on auth state as state.requestLocals[requestIndex][name].
 */
const REQUEST_LOCAL_RUNTIME_JS = `
function __ensureRequestLocals(state, requestIndex) {
  if (!state.requestLocals) state.requestLocals = {};
  if (!state.requestLocals[requestIndex]) state.requestLocals[requestIndex] = {};
  return state.requestLocals[requestIndex];
}

function __seedRequestLocals(state, requestIndex, seed) {
  const bucket = __ensureRequestLocals(state, requestIndex);
  if (!seed || typeof seed !== 'object') return bucket;
  for (const k of Object.keys(seed)) {
    if (bucket[k] == null || bucket[k] === '') bucket[k] = seed[k];
  }
  return bucket;
}

function __getRequestLocal(state, requestIndex, name) {
  if (!name) return '';
  const bucket = state.requestLocals && state.requestLocals[requestIndex];
  if (bucket && bucket[name] != null && String(bucket[name]).length > 0) return String(bucket[name]);
  return '';
}

function __getPmVar(state, scope, name) {
  if (!state.pm || !scope || !name) return '';
  const bucket = state.pm[scope];
  if (!bucket || bucket[name] == null) return '';
  const v = bucket[name];
  if (v === true || v === false || v === null) return v;
  return String(v);
}
`.trim();

module.exports = {
  VAR_RE,
  normalizeRequestVariables,
  listRequestLocalKeys,
  REQUEST_LOCAL_RUNTIME_JS,
};
