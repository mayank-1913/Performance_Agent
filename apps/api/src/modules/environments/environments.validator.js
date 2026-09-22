'use strict';

const SECRET_KEY_RE = /(token|jwt|access_token|id_token|bearer|auth|secret|key|password|session)/i;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Validate a Postman environment export.
 *
 * @param {object} parsed  Parsed JSON
 * @returns {{
 *   valid: boolean,
 *   issues: Array<{severity:'error'|'warning'|'info', code:string, message:string, vars?:string[]}>,
 *   variables: Array<{key:string, hasValue:boolean, secret:boolean, enabled:boolean, type?:string}>
 * }}
 */
function validateEnvironment(parsed) {
  const issues = [];

  if (!parsed || typeof parsed !== 'object') {
    return {
      valid: false,
      issues: [{ severity: 'error', code: 'INVALID_JSON', message: 'File is not a JSON object.' }],
      variables: [],
    };
  }

  if (typeof parsed.name !== 'string' || parsed.name.length === 0) {
    issues.push({
      severity: 'error',
      code: 'MISSING_NAME',
      message: 'Environment is missing a "name" field.',
    });
  }

  if (!Array.isArray(parsed.values)) {
    issues.push({
      severity: 'error',
      code: 'MISSING_VALUES',
      message: 'Environment is missing a "values" array.',
    });
    return { valid: false, issues, variables: [] };
  }

  // Optional schema check (Postman env exports usually have _postman_variable_scope or similar)
  const schema = parsed._postman_variable_scope || parsed.scope;
  if (schema && schema !== 'environment' && schema !== 'globals') {
    issues.push({
      severity: 'warning',
      code: 'UNUSUAL_SCOPE',
      message: `Unexpected variable scope "${schema}". Continuing anyway.`,
    });
  }

  const seen = new Map(); // key -> count
  const variables = [];

  for (let i = 0; i < parsed.values.length; i++) {
    const v = parsed.values[i];
    if (!v || typeof v !== 'object') {
      issues.push({
        severity: 'warning',
        code: 'MALFORMED_ENTRY',
        message: `Entry at index ${i} is not an object and was skipped.`,
      });
      continue;
    }
    const key = v.key == null ? '' : String(v.key);
    if (key.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'EMPTY_KEY',
        message: `Entry at index ${i} has an empty key.`,
      });
      continue;
    }
    if (!KEY_RE.test(key)) {
      issues.push({
        severity: 'warning',
        code: 'INVALID_KEY_NAME',
        message: `Variable "${key}" is not a typical environment variable name.`,
        vars: [key],
      });
    }
    seen.set(key, (seen.get(key) || 0) + 1);

    const enabled = v.enabled !== false;
    const value = v.value == null ? '' : String(v.value);
    const isSecret = SECRET_KEY_RE.test(key) || v.type === 'secret';

    variables.push({
      key,
      hasValue: value.length > 0,
      enabled,
      secret: isSecret,
      type: v.type || (isSecret ? 'secret' : 'default'),
    });

    if (enabled && isSecret && value.length === 0) {
      issues.push({
        severity: 'warning',
        code: 'EMPTY_SECRET',
        message: `Sensitive variable "${key}" is enabled but has no value.`,
        vars: [key],
      });
    }
  }

  // Duplicate key detection
  const dupes = Array.from(seen.entries())
    .filter(([, count]) => count > 1)
    .map(([k]) => k);
  if (dupes.length > 0) {
    issues.push({
      severity: 'warning',
      code: 'DUPLICATE_KEYS',
      message: `Duplicate variable keys: ${dupes.join(', ')}. Postman uses the last occurrence.`,
      vars: dupes,
    });
  }

  if (variables.length === 0) {
    issues.push({
      severity: 'warning',
      code: 'EMPTY_ENVIRONMENT',
      message: 'Environment has no usable variables.',
    });
  }

  const valid = !issues.some((i) => i.severity === 'error');
  return { valid, issues, variables };
}

module.exports = { validateEnvironment, SECRET_KEY_RE };
