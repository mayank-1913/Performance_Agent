'use strict';

/**
 * Phase 2 centralized Authorization header resolver (plan-time).
 *
 * There are two places where the "which token wins?" question is answered:
 *
 *   1. Inside the generated K6 script, at request time — implemented by
 *      the `__resolveAuthHeader` / `__resolveAuthHeaderEnv` helpers the
 *      generator emits.
 *   2. Inside the API process, at plan time — implemented here.
 *
 * Both must agree on the SAME precedence and the SAME safety filter. This
 * module is the single source of truth for the plan-time side. It is
 * exercised directly by `runs.controller` (for diagnostic logging without
 * secret leakage) and by `manualToken.integration.test.js` (as the
 * behavioural mirror of the emitted K6 helpers).
 *
 * Precedence (highest first):
 *   1. manualToken     the value the UI pasted into the Manual Bearer field
 *                      (also called __ENV.AUTH_TOKEN inside K6)
 *   2. runtimeToken    the token setup() captured from the login response
 *   3. envToken        Postman environment.values entry
 *   4. collectionToken Postman collection.variable entry
 *
 * The output is always exactly `Bearer <token>` with one space, or `""`
 * when no source produced a safe token. Never `Bearer Bearer …`, never
 * `Bearer undefined`, never `Bearer {{token}}`, never `Bearer ` alone.
 */

const { normalizeBearer, formatBearer, maskToken } = require('./secrets');

const UNRESOLVED_PLACEHOLDER_RE = /\{\{[^}]+\}\}/;
const LONE_BEARER_RE = /^\s*Bearer\s*$/i;

/**
 * Decide whether a raw token candidate is safe to promote into an
 * Authorization header. Guards against the exact pitfalls listed in the
 * Phase 2 spec:
 *   - null / undefined / non-string
 *   - the literal strings "undefined" and "null" (common stringify bug)
 *   - empty / whitespace-only
 *   - a Postman placeholder that never got resolved
 *   - the scheme keyword "Bearer" alone with no payload
 *
 * A value that is safe here still goes through `normalizeBearer` before
 * being embedded in the header, so any leading `Bearer ` prefixes are
 * removed and re-added exactly once by the caller.
 */
function isSafeTokenValue(v) {
  if (v == null) return false;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length === 0) return false;
  if (s === 'undefined' || s === 'null') return false;
  if (UNRESOLVED_PLACEHOLDER_RE.test(s)) return false;
  if (LONE_BEARER_RE.test(s)) return false;
  return true;
}

/**
 * Resolve the Authorization header from the four possible sources.
 *
 * @param {object} args
 * @param {string} [args.manualToken]     UI paste / __ENV.AUTH_TOKEN
 * @param {string} [args.runtimeToken]    setup()-captured token
 * @param {string} [args.envToken]        Postman environment value
 * @param {string} [args.collectionToken] Postman collection variable value
 *
 * @returns {{
 *   value: string,           // full "Bearer <token>" header, or ""
 *   source: 'manual'|'runtime'|'environment'|'collection'|'none',
 *   token: string,           // normalized raw token (no scheme prefix), or ""
 *   dropped: string[],       // sources rejected by isSafeTokenValue
 * }}
 */
function resolveAuthorizationHeader({
  manualToken = '',
  runtimeToken = '',
  envToken = '',
  collectionToken = '',
} = {}) {
  const chain = [
    ['manual', manualToken],
    ['runtime', runtimeToken],
    ['environment', envToken],
    ['collection', collectionToken],
  ];

  const dropped = [];
  for (const [source, raw] of chain) {
    if (!isSafeTokenValue(raw)) {
      // Only record a rejection when the caller actually attempted to
      // supply a value; empty inputs are the neutral "no source here" case.
      if (raw != null && String(raw).trim().length > 0) dropped.push(source);
      continue;
    }
    const normalized = normalizeBearer(raw);
    if (!normalized) {
      // Post-normalization the value collapsed (e.g. "Bearer   Bearer   ").
      dropped.push(source);
      continue;
    }
    return {
      value: `Bearer ${normalized}`,
      source,
      token: normalized,
      dropped,
    };
  }
  return { value: '', source: 'none', token: '', dropped };
}

/**
 * Build a safe-to-log diagnostic summary of a resolution result. Never
 * exposes the raw token — only its masked preview and metadata. Suitable
 * for winston.info() / structured logs.
 */
function diagnose(result) {
  if (!result) {
    return { source: 'none', hasValue: false, tokenPreview: '', dropped: [] };
  }
  return {
    source: result.source,
    hasValue: !!result.value,
    tokenPreview: result.token ? maskToken(result.token) : '',
    dropped: Array.isArray(result.dropped) ? result.dropped : [],
  };
}

module.exports = {
  resolveAuthorizationHeader,
  isSafeTokenValue,
  diagnose,
  // Re-export for callers that want a one-stop shop.
  normalizeBearer,
  formatBearer,
  maskToken,
  UNRESOLVED_PLACEHOLDER_RE,
  LONE_BEARER_RE,
};
