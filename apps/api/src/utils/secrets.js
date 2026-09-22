'use strict';

/**
 * Helpers for handling secrets (auth tokens, etc.) safely.
 */

/** Mask a token for logging: keeps first 4 and last 4 chars. */
function maskToken(token) {
  if (!token || typeof token !== 'string') return '';
  const s = token.trim();
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/**
 * Strip every leading "Bearer " prefix and surrounding whitespace. We strip
 * defensively in a loop because users sometimes paste "Bearer Bearer xyz"
 * after concatenating snippets — only the raw token must remain. A lone
 * "Bearer" with no token after it is also recognised and removed, so the
 * caller ends up with an empty string instead of accidentally treating
 * "Bearer" itself as the token value.
 */
function normalizeBearer(token) {
  if (!token || typeof token !== 'string') return '';
  let t = token.trim();
  // Phase 2 hardening: reject the string forms of undefined / null on
  // both sides of the Bearer strip. Any stringified JS undefined / null
  // that would otherwise emit "Bearer undefined" collapses to empty
  // here, and the caller's downstream check (`Bearer ${normalized}`)
  // becomes a safe empty-drop instead.
  if (t === 'undefined' || t === 'null') return '';
  while (/^Bearer\b\s*/i.test(t)) {
    const next = t.replace(/^Bearer\b\s*/i, '').trim();
    if (next === t) break;
    t = next;
  }
  if (t === 'undefined' || t === 'null') return '';
  return t;
}

/**
 * Build a complete Authorization header value with exactly one "Bearer "
 * prefix, regardless of what the caller pasted. Returns an empty string if
 * the input is empty so callers can decide whether to drop the header.
 */
function formatBearer(token) {
  const raw = normalizeBearer(token);
  return raw ? `Bearer ${raw}` : '';
}

module.exports = { maskToken, normalizeBearer, formatBearer };
