'use strict';

/**
 * Phase 1 variable resolver.
 *
 * Merges values from three optional sources and produces a normalized,
 * secret-safe resolution result. Environment is optional at every layer:
 * a collection with no environment must still resolve every variable it
 * defines itself, and a collection whose variables all come from the
 * environment must still resolve them without a locally defined value.
 *
 * Precedence for regular variables (highest first):
 *   1. runtime override  (manual UI value entered on /runs/{prepare,start})
 *   2. environment value (Postman environment.values, enabled + non-empty)
 *   3. collection value  (Postman collection.variable, enabled + non-empty)
 *   4. unresolved
 *
 * Precedence for AUTH_TOKEN specifically is documented alongside the K6
 * generator's `__resolveAuthHeader`:
 *   manual AUTH_TOKEN
 *     > runtime-captured token (setup() extraction inside K6)
 *     > environment token
 *     > collection token
 *     > unresolved
 *
 * The resolver contributes the last three levels for auth: the value the
 * script receives via __ENV.<PLACEHOLDER_NAME> may come from either the
 * environment or the collection, with environment winning on collision.
 * The two runtime-side levels (manual __ENV.AUTH_TOKEN and setup() capture)
 * are enforced by the generator's runtime helpers, not by this module.
 *
 * The result is deliberately shaped to be safe to return over the wire:
 *  - `entries[]` exposes name, envName, source, resolved, secret, hasValue
 *    but NEVER a value. Secret metadata lets the UI show "***" markers
 *    without ever holding the plaintext.
 *  - `values` (envName -> value) is INTERNAL. Callers hand it to the
 *    worker-runner's spawn env; API responses should serialize `.entries`
 *    and NEVER `.values`.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Keys the API considers sensitive. Kept intentionally aligned with
 * envInjector.SECRET_KEY_RE / runs.controller mask regex so the whole
 * pipeline agrees on which values must be masked in logs.
 */
const SECRET_KEY_RE = /(token|secret|jwt|key|session|auth|bearer|password)/i;

/** Same normalization the K6 generator uses. Copied (not imported) to keep
 *  this module free of generator-side dependencies. */
function toEnvName(varName) {
  return String(varName == null ? '' : varName)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function isSecretName(name) {
  return SECRET_KEY_RE.test(String(name || ''));
}

function hasMeaningfulValue(v) {
  return v != null && String(v).length > 0;
}

/**
 * Normalize a source input into an array of `{ key, value, enabled }` items.
 * Accepts:
 *   - null / undefined
 *   - array of { key, value, enabled, disabled, type }
 *   - plain object map { key: value }
 * Postman uses `enabled=false` on env values and `disabled=true` on
 * collection variables. We treat both as "disabled".
 */
function normalizeSource(input) {
  if (input == null) return [];
  if (Array.isArray(input)) {
    return input
      .filter((v) => v && typeof v === 'object' && v.key != null)
      .map((v) => ({
        key: String(v.key),
        value: v.value == null ? '' : String(v.value),
        enabled: v.enabled !== false && v.disabled !== true,
      }));
  }
  if (typeof input === 'object') {
    return Object.entries(input)
      .filter(([k]) => k != null)
      .map(([k, val]) => ({
        key: String(k),
        value: val == null ? '' : String(val),
        enabled: true,
      }));
  }
  return [];
}

/**
 * Collapse a source list to a single value per envName, applying
 * Postman-like "last enabled non-empty wins" rules and reporting duplicates.
 */
function collapseSource(items, sourceLabel, duplicates) {
  const byEnv = new Map(); // envName -> { originalName, value, hadDup }
  const dupSeen = new Map();
  for (const it of items) {
    if (!it.enabled) continue;
    if (!hasMeaningfulValue(it.value)) continue;
    const envName = toEnvName(it.key);
    if (!envName) continue;
    if (byEnv.has(envName)) {
      const count = (dupSeen.get(envName) || 1) + 1;
      dupSeen.set(envName, count);
    }
    byEnv.set(envName, { originalName: it.key, value: it.value });
  }
  for (const [envName, count] of dupSeen.entries()) {
    duplicates.push({ scope: sourceLabel, envName, count });
  }
  return byEnv;
}

/**
 * @param {object} params
 * @param {Array|Object} [params.collectionVariables]
 *        Postman `collection.variable` (array) OR a `{key: value}` map.
 * @param {Array|Object} [params.environmentVariables]
 *        Postman `environment.values` (array) OR a `{key: value}` map. Pass
 *        `null` / omit entirely when no environment file is provided.
 * @param {Object} [params.runtimeOverrides]
 *        Flat map of `{ ENV_NAME: value }` from the run-start payload.
 * @param {string[]} [params.referencedVars]
 *        Raw Postman variable names referenced by the (selected) requests.
 *        When provided, `unresolved` reflects these; when omitted, the
 *        resolver returns all defined variables and `unresolved` is empty.
 * @param {Set<string>|string[]} [params.runtimeSecretKeys]
 *        Env names the caller has explicitly marked as sensitive (e.g. the
 *        `secrets` payload sent alongside `env`). Combined with the
 *        SECRET_KEY_RE heuristic to decide the `secret` flag on entries.
 *
 * @returns {{
 *   values: Record<string,string>,
 *   sources: Record<string,'runtime'|'environment'|'collection'>,
 *   entries: Array<{
 *     name: string,
 *     envName: string,
 *     originalName: string,
 *     source: 'runtime'|'environment'|'collection'|'unresolved',
 *     resolved: boolean,
 *     secret: boolean,
 *     hasValue: boolean,
 *     referenced: boolean,
 *   }>,
 *   unresolved: string[],
 *   duplicates: Array<{ scope: string, envName: string, count: number }>,
 *   warnings: string[],
 *   environmentProvided: boolean,
 * }}
 */
function resolveVariables({
  collectionVariables = null,
  environmentVariables = null,
  runtimeOverrides = null,
  referencedVars = null,
  runtimeSecretKeys = null,
} = {}) {
  const duplicates = [];
  const warnings = [];

  const envSourceProvided =
    environmentVariables != null &&
    !(Array.isArray(environmentVariables) && environmentVariables.length === 0);

  const collectionList = normalizeSource(collectionVariables);
  const environmentList = normalizeSource(environmentVariables);
  const runtimeList = normalizeSource(runtimeOverrides);

  const collectionMap = collapseSource(collectionList, 'collection', duplicates);
  const environmentMap = collapseSource(environmentList, 'environment', duplicates);
  const runtimeMap = collapseSource(runtimeList, 'runtime', duplicates);

  const explicitSecrets = new Set();
  if (runtimeSecretKeys) {
    const arr = runtimeSecretKeys instanceof Set
      ? Array.from(runtimeSecretKeys)
      : Array.isArray(runtimeSecretKeys)
        ? runtimeSecretKeys
        : [];
    for (const k of arr) {
      const envName = toEnvName(k);
      if (envName) explicitSecrets.add(envName);
    }
  }

  // Union of every envName seen anywhere + referenced names.
  const allEnvNames = new Set([
    ...collectionMap.keys(),
    ...environmentMap.keys(),
    ...runtimeMap.keys(),
  ]);

  const referencedEnvNames = new Set(
    (Array.isArray(referencedVars) ? referencedVars : [])
      .map(toEnvName)
      .filter(Boolean)
  );
  for (const n of referencedEnvNames) allEnvNames.add(n);

  const values = {};
  const sources = {};
  const entries = [];
  const unresolved = [];

  for (const envName of allEnvNames) {
    let source = 'unresolved';
    let value = '';
    let originalName = envName;

    if (runtimeMap.has(envName)) {
      const item = runtimeMap.get(envName);
      source = 'runtime';
      value = item.value;
      originalName = item.originalName;
    } else if (environmentMap.has(envName)) {
      const item = environmentMap.get(envName);
      source = 'environment';
      value = item.value;
      originalName = item.originalName;
    } else if (collectionMap.has(envName)) {
      const item = collectionMap.get(envName);
      source = 'collection';
      value = item.value;
      originalName = item.originalName;
    } else {
      // Not resolved by any source — but we still surface it in `entries`
      // when it was explicitly referenced (or defined disabled/empty and
      // therefore skipped in collapseSource). Prefer the runtime original
      // name if any, then environment, then collection.
      const anyItem =
        runtimeList.find((i) => toEnvName(i.key) === envName) ||
        environmentList.find((i) => toEnvName(i.key) === envName) ||
        collectionList.find((i) => toEnvName(i.key) === envName);
      if (anyItem) originalName = anyItem.key;
    }

    const resolved = source !== 'unresolved';
    const secret = explicitSecrets.has(envName) || isSecretName(envName) || isSecretName(originalName);
    const referenced = referencedEnvNames.has(envName);

    if (resolved) {
      values[envName] = value;
      sources[envName] = source;
    } else if (referenced) {
      unresolved.push(envName);
    }

    entries.push({
      name: originalName,
      envName,
      originalName,
      source,
      resolved,
      secret,
      hasValue: hasMeaningfulValue(value),
      referenced,
    });
  }

  // Stable, deterministic ordering for downstream consumers.
  entries.sort((a, b) => a.envName.localeCompare(b.envName));
  unresolved.sort();

  if (!envSourceProvided && collectionMap.size === 0 && runtimeMap.size === 0 && referencedEnvNames.size > 0) {
    warnings.push(
      'No collection variables, no environment file, and no runtime overrides were supplied, ' +
      'but the collection references variables. Provide values via runtime overrides or an environment.'
    );
  }

  return {
    values,
    sources,
    entries,
    unresolved,
    duplicates,
    warnings,
    environmentProvided: envSourceProvided,
  };
}

/**
 * Public-safe view: strip the `values` map, keep everything else. Use this
 * whenever a resolver result is placed on an HTTP response.
 */
function publicResolution(result) {
  if (!result) return null;
  return {
    entries: result.entries,
    sources: result.sources,
    unresolved: result.unresolved,
    duplicates: result.duplicates,
    warnings: result.warnings,
    environmentProvided: result.environmentProvided,
  };
}

/**
 * Convenience: pull the `collection.variable` list off a raw Postman
 * collection object (which is what `collections.store` keeps in memory).
 */
function extractCollectionVariables(rawCollection) {
  if (!rawCollection || typeof rawCollection !== 'object') return [];
  return Array.isArray(rawCollection.variable) ? rawCollection.variable : [];
}

/**
 * Convenience: pull the `values` list off a raw Postman environment export.
 */
function extractEnvironmentVariables(rawEnvironment) {
  if (!rawEnvironment || typeof rawEnvironment !== 'object') return [];
  return Array.isArray(rawEnvironment.values) ? rawEnvironment.values : [];
}

module.exports = {
  resolveVariables,
  publicResolution,
  extractCollectionVariables,
  extractEnvironmentVariables,
  toEnvName,
  isSecretName,
  SECRET_KEY_RE,
  VAR_RE,
};
