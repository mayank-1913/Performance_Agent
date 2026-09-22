'use strict';

/**
 * Generic multi-user credential dataset for PER_VU_LOGIN mode.
 *
 * Records are plain objects with arbitrary field names (username, email,
 * password, pass, etc.). The collection's login request structure remains
 * authoritative — these records supply values at run time.
 */

const {
  extractLoginCredentialBindings,
  credentialEnvName,
} = require('./loginCredentials');
const { toEnvName } = require('../k6/generator');

function normalizeCredentialFields(fields) {
  const normalized = {};
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null) continue;
    const s = String(v).trim();
    if (!s) continue;
    const envName = credentialEnvName(k) || toEnvName(k);
    normalized[envName] = s;
  }
  return normalized;
}

const SECRET_FIELD_RE = /(password|passwd|pass|secret|token|jwt|key|auth|bearer)/i;

function isSecretField(name) {
  return SECRET_FIELD_RE.test(String(name || ''));
}

/**
 * Parse a credential dataset from JSON (array or { records: [] }).
 * Never throws on empty input — returns { records: [], errors: [] }.
 */
function parseCredentialDataset(raw) {
  const errors = [];
  if (raw == null || raw === '') {
    return { records: [], errors };
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    return { records: [], errors: ['Credential dataset is not valid JSON'] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.records)
      ? parsed.records
      : null;
  if (!list) {
    return { records: [], errors: ['Credential dataset must be a JSON array or { records: [] }'] };
  }
  const records = [];
  list.forEach((item, idx) => {
    if (!item || typeof item !== 'object') {
      errors.push(`Record ${idx + 1}: must be an object`);
      return;
    }
    const fields =
      item.fields && typeof item.fields === 'object' ? item.fields : item;
    const normalized = normalizeCredentialFields(fields);
    if (Object.keys(normalized).length === 0) {
      errors.push(`Record ${idx + 1}: contains no non-empty fields`);
      return;
    }
    records.push({
      id: item.id ? String(item.id) : `user-${idx + 1}`,
      fields: normalized,
    });
  });
  return { records, errors };
}

/**
 * Map VU index (1-based) to a credential record index.
 * When reuse is false and vuIndex > recordCount, returns null.
 */
function mapVuToCredentialIndex(vuIndex, recordCount, reuse = false) {
  const vu = Number(vuIndex);
  const count = Number(recordCount);
  if (!Number.isFinite(vu) || vu < 1 || !Number.isFinite(count) || count < 1) {
    return null;
  }
  const zeroBased = vu - 1;
  if (!reuse && zeroBased >= count) return null;
  return reuse ? zeroBased % count : zeroBased;
}

/**
 * Build a public-safe summary for run preparation / reports.
 * Never includes credential values.
 */
function summarizeCredentialPlan({ vus, records, reuse, authSessionMode }) {
  const recordCount = Array.isArray(records) ? records.length : 0;
  const configuredVus = Number(vus) || 0;
  let sufficient = true;
  let warning = null;
  if (authSessionMode === 'PER_VU_LOGIN' && recordCount > 0 && !reuse) {
    if (configuredVus > recordCount) {
      sufficient = false;
      warning = `${configuredVus} VUs configured but only ${recordCount} credential records available (reuse disabled)`;
    }
  }
  return {
    authenticationMode: authSessionMode || null,
    configuredVus,
    credentialRecords: recordCount,
    credentialReuse: !!reuse,
    credentialSufficient: sufficient,
    warning,
    recordIds: (records || []).map((r) => r.id),
  };
}

/**
 * Serialize dataset for K6 spawn env (values only in secrets path).
 */
function serializeForRuntime(records) {
  return JSON.stringify({
    records: (records || []).map((r) => ({
      id: r.id,
      fields: r.fields,
    })),
  });
}

/**
 * Public view — ids and field NAMES only, no values.
 */
function publicCredentialDataset(records) {
  return (records || []).map((r) => ({
    id: r.id,
    fieldNames: Object.keys(r.fields || {}),
    secretFieldNames: Object.keys(r.fields || {}).filter(isSecretField),
  }));
}

/**
 * Inject per-record credential fields into spawn secrets as indexed env vars
 * so the generated script can read them without parsing JSON in K6.
 * Pattern: PA_CRED_<index>_<ENV_NAME>
 */
function injectCredentialEnvVars(records, cleanSecrets) {
  const injected = [];
  (records || []).forEach((record, idx) => {
    const fields = normalizeCredentialFields(record.fields || record);
    for (const [envName, value] of Object.entries(fields)) {
      const key = `PA_CRED_${idx}_${envName}`;
      cleanSecrets[key] = String(value);
      injected.push(key);
    }
  });
  if (records && records.length > 0) {
    cleanSecrets.PA_CREDENTIAL_COUNT = String(records.length);
  }
  return injected;
}

/**
 * Extract expected credential field env names from a login request.
 */
function expectedCredentialFields(loginRequest) {
  if (!loginRequest) return [];
  const bindings = extractLoginCredentialBindings(loginRequest);
  return bindings.map((b) => b.envName);
}

module.exports = {
  parseCredentialDataset,
  mapVuToCredentialIndex,
  summarizeCredentialPlan,
  serializeForRuntime,
  publicCredentialDataset,
  injectCredentialEnvVars,
  expectedCredentialFields,
  isSecretField,
};
