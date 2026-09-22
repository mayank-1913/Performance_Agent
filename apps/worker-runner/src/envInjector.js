'use strict';

/**
 * Builds the environment variable map that K6 will receive.
 *
 * Resolution priority (highest first):
 *   1. Manual UI-entered runtime values (env + secrets passed by the caller)
 *   2. Runtime-extracted auth tokens (handled inside the generated K6 setup())
 *   3. Environment files / collection variables (baked in at generation time
 *      via __ENV references)
 *   4. Empty fallback
 *
 * This module is responsible for step 1 — making sure manual values reach
 * the spawned K6 process untouched (after Bearer normalization for tokens),
 * and forwarding them as the *highest* priority source so the script can
 * detect them and prefer them over runtime-extracted values.
 *
 * Rules:
 * - Any key the user provides in `env` or `secrets` is forwarded. We never
 *   silently drop a manually entered override.
 * - AUTH_TOKEN and JWT_TOKEN have any "Bearer " prefix stripped so the
 *   script can prepend exactly one "Bearer " when emitting an Authorization
 *   header. The script itself adds Bearer back; we do not store it.
 * - The host process env is NOT inherited verbatim. We only pass the minimal
 *   pass-through keys the spawned process actually needs (PATH, etc.).
 */

const RUNTIME_KNOWN_KEYS = new Set([
  'AUTH_TOKEN',
  'JWT_TOKEN',
  'SESSION_ID',
  'HOST_PATH',
  'API_KEY',
]);

const SECRET_KEY_RE =
  /(token|secret|jwt|key|session|auth|bearer|password|pass|passwd|username|email|credential|cookie)/i;
const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Generic token-shape detector for the AUTH_TOKEN mirror logic. SESSION/KEY
// are deliberately excluded — those are different runtime slots.
const TOKEN_NAME_RE = /(?:TOKEN|JWT|AUTH|BEARER)/;
const PASSTHROUGH_ENV_KEYS = new Set([
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'HOME',
  'USERPROFILE',
  'TEMP',
  'TMP',
]);

function normalizeBearer(token) {
  if (!token || typeof token !== 'string') return '';
  // Tolerate any number of leading "Bearer " prefixes plus surrounding
  // whitespace. After this we always store the raw token, never with the
  // scheme. The script (or any auth-header builder) re-attaches "Bearer "
  // exactly once when constructing the header. A lone "Bearer" with nothing
  // after it is also stripped so we don't accidentally treat the scheme
  // itself as the token value.
  let t = token.trim();
  while (/^Bearer\b\s*/i.test(t)) {
    const next = t.replace(/^Bearer\b\s*/i, '').trim();
    if (next === t) break;
    t = next;
  }
  return t;
}

function hasMeaningfulValue(v) {
  return v != null && String(v).length > 0;
}

/**
 * @param {object} params
 * @param {string[]} [params.expectedEnvVars]   Vars the K6 script references
 * @param {Record<string,string>} [params.env]   User-provided public env
 * @param {Record<string,string>} [params.secrets] User-provided secret env
 * @param {NodeJS.ProcessEnv} [params.parentEnv]  Defaults to process.env
 *
 * @returns {{
 *   envMap: Record<string,string>,    // exact env handed to spawn
 *   manualOverrides: string[],        // keys the user explicitly provided
 *   bearerNormalized: string[],       // keys whose Bearer prefix was stripped
 *   tokenMirroredKeys: string[],      // keys mirrored from AUTH_TOKEN
 * }}
 */
function buildK6Env({
  expectedEnvVars = [],
  env = {},
  secrets = {},
  parentEnv = process.env,
} = {}) {
  const out = {
    // Minimal pass-through: the K6 binary needs PATH on most systems, plus a
    // couple of Windows-specific entries to avoid spawn failures.
    PATH: parentEnv.PATH || parentEnv.Path || '',
    SystemRoot: parentEnv.SystemRoot,
    HOME: parentEnv.HOME,
    USERPROFILE: parentEnv.USERPROFILE,
  };

  const overrides = [];
  const bearerNormalized = [];

  // Public env: forward EVERY user-provided key, not just expectedEnvVars.
  // The user explicitly typing a key counts as a locked override that must
  // win over any baked-in collection or environment variable. Keys the
  // script doesn't reference are harmless — K6 simply won't read them.
  for (const [k, raw] of Object.entries(env || {})) {
    if (!hasMeaningfulValue(raw)) continue;
    if (!VALID_ENV_KEY_RE.test(k)) continue; // defensive: reject bogus names
    if (PASSTHROUGH_ENV_KEYS.has(k)) continue; // never let user clobber PATH
    out[k] = String(raw);
    overrides.push(k);
  }

  // Secrets: forward EVERY user-provided key. AUTH_TOKEN / JWT_TOKEN get
  // their Bearer prefix stripped so the script can add it back once.
  for (const [k, raw] of Object.entries(secrets || {})) {
    if (!hasMeaningfulValue(raw)) continue;
    if (!VALID_ENV_KEY_RE.test(k)) continue;
    if (PASSTHROUGH_ENV_KEYS.has(k)) continue;

    let v = String(raw);
    if (k === 'AUTH_TOKEN' || k === 'JWT_TOKEN') {
      const stripped = normalizeBearer(v);
      if (stripped !== v.trim()) bearerNormalized.push(k);
      v = stripped;
      if (!v) continue; // user pasted "Bearer " with nothing after
    }
    out[k] = v;
    if (!overrides.includes(k)) overrides.push(k);
  }

  // -------- AUTH_TOKEN mirror ----------------------------------------------
  // The collection might use ANY token placeholder name ({{jwt_token}},
  // {{access_token}}, {{global_auth_token}}, {{token}}, {{sessionToken}}…).
  // The generator handles current scripts via __resolveAuthHeader, but two
  // cases still need a runtime-side mirror to be bullet-proof:
  //   1) Pre-existing K6 scripts on disk that read __ENV.JWT_TOKEN directly
  //      (i.e. scripts generated before the resolver landed).
  //   2) Token-shaped placeholders that appear OUTSIDE Authorization
  //      headers (URL paths, body fields, custom headers) where the
  //      generator emits __ENV.<NAME> directly.
  //
  // So when the user supplies a manual AUTH_TOKEN we mirror it into every
  // common token-shaped env key the user did NOT explicitly set. This is
  // strictly additive — explicit user-provided values are never overwritten.
  const TOKEN_MIRROR_TARGETS = [
    'AUTH_TOKEN',
    'JWT_TOKEN',
    'JWT',
    'ACCESS_TOKEN',
    'TOKEN',
    'BEARER_TOKEN',
    'BEARERTOKEN',
    'ID_TOKEN',
    'IDTOKEN',
    // Common collection-specific aliases. Adding more here is safe — the
    // mirror only applies when the user did NOT explicitly set the key,
    // and only when AUTH_TOKEN itself is set.
    'GLOBAL_AUTH_TOKEN',
    'GLOBALAUTHTOKEN',
    'JWTTOKEN',
    'ACCESSTOKEN',
  ];
  // Also mirror into every expected env var whose name is token-shaped,
  // so collection-specific names like {{custom_jwt_token_v2}} are covered
  // automatically without us having to know them in advance.
  for (const k of expectedEnvVars || []) {
    if (typeof k !== 'string') continue;
    if (!VALID_ENV_KEY_RE.test(k)) continue;
    if (TOKEN_NAME_RE.test(k) && !TOKEN_MIRROR_TARGETS.includes(k)) {
      TOKEN_MIRROR_TARGETS.push(k);
    }
  }

  const tokenMirroredKeys = [];
  if (hasMeaningfulValue(out.AUTH_TOKEN)) {
    for (const target of TOKEN_MIRROR_TARGETS) {
      if (target === 'AUTH_TOKEN') continue;
      if (PASSTHROUGH_ENV_KEYS.has(target)) continue;
      // Don't clobber an explicit user override.
      if (hasMeaningfulValue(out[target])) continue;
      out[target] = out.AUTH_TOKEN;
      tokenMirroredKeys.push(target);
    }
  }
  // -------------------------------------------------------------------------

  // Final cleanup: drop any empty values we accidentally produced.
  for (const k of Object.keys(out)) {
    if (!hasMeaningfulValue(out[k])) delete out[k];
  }

  return {
    envMap: out,
    manualOverrides: overrides,
    bearerNormalized,
    tokenMirroredKeys,
    // Compatibility: older callers expected expectedEnvVars to be enforced.
    // We no longer drop unknown keys (manual override wins), but we still
    // surface the script's expectations for downstream UIs.
    expectedEnvVars: Array.from(expectedEnvVars || []),
  };
}

/** Mask token-ish values for logging/preview. */
function maskValue(value) {
  if (!value) return '';
  return '[REDACTED]';
}

function maskEnv(envMap) {
  const masked = {};
  for (const [k, v] of Object.entries(envMap || {})) {
    masked[k] = SECRET_KEY_RE.test(k) ? maskValue(v) : v;
  }
  return masked;
}

module.exports = {
  buildK6Env,
  maskEnv,
  normalizeBearer,
  RUNTIME_KNOWN_KEYS,
  // Back-compat alias for any external callers; same set, different name.
  RUNTIME_ALLOWED_KEYS: RUNTIME_KNOWN_KEYS,
  SECRET_KEY_RE,
};
