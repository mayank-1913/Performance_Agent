'use strict';

/**
 * Explicit authentication / session modes for multi-VU performance testing.
 *
 * These modes are workload-level configuration — never collection-specific.
 *
 *   PER_VU_LOGIN   — each VU logs in independently with isolated tokens/state
 *   SHARED_SESSION — one login in setup(), token shared across all VUs
 *   MANUAL_TOKEN   — user-supplied token only; no automatic login
 */

const AUTH_SESSION_MODES = Object.freeze({
  PER_VU_LOGIN: 'PER_VU_LOGIN',
  SHARED_SESSION: 'SHARED_SESSION',
  MANUAL_TOKEN: 'MANUAL_TOKEN',
});

const MODE_LIST = Object.freeze(Object.values(AUTH_SESSION_MODES));

/**
 * Resolve the effective auth session mode from explicit user input and the
 * detected auth flow. Backward-compatible defaults preserve existing behaviour
 * when no mode is supplied.
 *
 * @param {object} opts
 * @param {string|null} [opts.authSessionMode]
 * @param {boolean} [opts.authFlowEnabled]
 * @param {boolean} [opts.injectAuthToken]
 * @returns {string|null}
 */
function resolveAuthSessionMode({
  authSessionMode,
  authFlowEnabled = false,
  injectAuthToken = false,
} = {}) {
  if (authSessionMode && MODE_LIST.includes(authSessionMode)) {
    return authSessionMode;
  }
  if (injectAuthToken && !authFlowEnabled) return AUTH_SESSION_MODES.MANUAL_TOKEN;
  if (authFlowEnabled) return AUTH_SESSION_MODES.SHARED_SESSION;
  return null;
}

function normalizeAuthSessionConfig(input = {}, context = {}) {
  const mode = resolveAuthSessionMode({
    authSessionMode: input.authSessionMode,
    authFlowEnabled: context.authFlowEnabled,
    injectAuthToken: context.injectAuthToken,
  });
  const credentialReuse =
    input.credentialReuse === true || input.credentialReuse === 'true';
  return {
    authSessionMode: mode,
    credentialReuse,
  };
}

function publicAuthSessionConfig(config) {
  if (!config) return null;
  return {
    authSessionMode: config.authSessionMode || null,
    credentialReuse: !!config.credentialReuse,
  };
}

module.exports = {
  AUTH_SESSION_MODES,
  AUTH_SESSION_MODE_LIST: MODE_LIST,
  resolveAuthSessionMode,
  normalizeAuthSessionConfig,
  publicAuthSessionConfig,
};
