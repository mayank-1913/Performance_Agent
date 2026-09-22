'use strict';

/**
 * Pure command/argument builder for the K6 runner.
 *
 * Why this exists:
 *   The previous runner passed env values as separate `-e KEY=value` arguments
 *   AND used `shell: true` on Windows. With a workspace path containing spaces
 *   (e.g. "C:\\Users\\Mayank Harsora\\Performance Agent\\..."), cmd.exe split
 *   the unquoted script path on whitespace, so k6 received 3 positional args
 *   and bailed with: "k6 run accepts 1 arg(s), received 3".
 *
 * Contract now:
 *   - Args = ["run", ...optionalReporterFlags, "<absolute script path>"]
 *   - Env vars are passed via the spawn `env` map (process env), never as args.
 *   - All values are validated before spawn.
 *   - A sanitized, log-safe preview of the command is produced separately.
 *
 * Optional reporter flags (Phase 4):
 *   - summaryExportPath -> ["--summary-export", <abs path>]
 *   - metricsJsonPath   -> ["--out", "json=<abs path>"]
 */

const path = require('path');

const SECRET_KEY_RE =
  /(token|secret|jwt|key|session|auth|bearer|password|pass|passwd|username|email|credential|cookie)/i;
const INTERNAL_ENV_PREFIX_RE = /^PA_/;
const VALID_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertAbsolute(label, value) {
  if (!isNonEmptyString(value)) {
    throw new Error(`buildK6CommandArgs: ${label} must be a non-empty string`);
  }
  if (!path.isAbsolute(value)) {
    throw new Error(`buildK6CommandArgs: ${label} must be absolute (got "${value}")`);
  }
}

/**
 * Build the K6 CLI args for `k6 run [...flags] <scriptPath>`.
 * Throws on invalid inputs. NEVER appends env vars as positional args.
 *
 * @param {object} opts
 * @param {string} opts.scriptPath
 * @param {string} [opts.summaryExportPath] - if set, adds "--summary-export <path>"
 * @param {string} [opts.metricsJsonPath]   - if set, adds "--out json=<path>"
 * @returns {string[]}
 */
function buildK6CommandArgs({ scriptPath, summaryExportPath, metricsJsonPath } = {}) {
  assertAbsolute('scriptPath', scriptPath);
  const args = ['run'];

  if (summaryExportPath) {
    assertAbsolute('summaryExportPath', summaryExportPath);
    args.push('--summary-export', summaryExportPath);
  }
  if (metricsJsonPath) {
    assertAbsolute('metricsJsonPath', metricsJsonPath);
    args.push('--out', `json=${metricsJsonPath}`);
  }

  args.push(scriptPath);
  return args;
}

/**
 * Validate everything that will be handed to child_process.spawn.
 * Throws with a clear message if anything is off.
 */
function validateSpawnInputs({ binPath, scriptPath, env, cwd } = {}) {
  if (!isNonEmptyString(binPath)) {
    throw new Error('validateSpawnInputs: binPath must be a non-empty string');
  }
  if (!isNonEmptyString(scriptPath)) {
    throw new Error('validateSpawnInputs: scriptPath must be a non-empty string');
  }
  if (cwd != null && typeof cwd !== 'string') {
    throw new Error('validateSpawnInputs: cwd must be a string when provided');
  }
  if (env != null) {
    if (typeof env !== 'object' || Array.isArray(env)) {
      throw new Error('validateSpawnInputs: env must be a plain object');
    }
    for (const k of Object.keys(env)) {
      if (PASSTHROUGH_ENV_KEYS.has(k)) continue;
      if (!VALID_ENV_KEY_RE.test(k)) {
        throw new Error(`validateSpawnInputs: invalid env var name "${k}"`);
      }
      const v = env[k];
      if (v != null && typeof v !== 'string' && typeof v !== 'number') {
        throw new Error(
          `validateSpawnInputs: env var "${k}" must be a string or number`
        );
      }
    }
  }
  return true;
}

function isSecretEnvKey(key) {
  return SECRET_KEY_RE.test(key) || INTERNAL_ENV_PREFIX_RE.test(key);
}

/**
 * Build a sanitized, single-line preview of the command for logs.
 * Never prints secret/credential values — only non-secret env values and
 * redacted placeholders for sensitive keys.
 */
function buildCommandPreview({ binPath, args = [], env = {} } = {}) {
  const quote = (s) => {
    const v = String(s ?? '');
    return /\s/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
  };

  const publicEnvParts = [];
  const secretKeys = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (PASSTHROUGH_ENV_KEYS.has(k)) continue;
    if (v == null || String(v).length === 0) continue;
    if (isSecretEnvKey(k)) secretKeys.push(k);
    else publicEnvParts.push(`${k}=${quote(String(v))}`);
  }

  const parts = [...publicEnvParts];
  if (secretKeys.length > 0) {
    parts.push(
      `[${secretKeys.length} secret env var(s): ${secretKeys.map((k) => `${k}=[REDACTED]`).join(', ')}]`
    );
  }
  parts.push(quote(binPath || ''), ...args.map(quote));
  return parts.join(' ');
}

module.exports = {
  buildK6CommandArgs,
  validateSpawnInputs,
  buildCommandPreview,
  isSecretEnvKey,
  SECRET_KEY_RE,
  PASSTHROUGH_ENV_KEYS,
};
