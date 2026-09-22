'use strict';

/**
 * Authentication detection across:
 * - Collection-level auth (login flow + auth blocks)
 * - Bearer/API key headers using {{var}} placeholders
 * - Postman environment files (variables that look like tokens)
 *
 * Output drives the UI status: AUTO_MANAGED | ENV_MANAGED | MANUAL_REQUIRED | NONE
 */

const TOKEN_KEY_RE = /(token|jwt|access_token|id_token|bearer|auth)/i;
const LOGIN_PATH_RE = /\b(login|signin|sign-in|authenticate|oauth|token|auth\/login)\b/i;

function isLoginRequest(req) {
  if (!req) return false;
  if (req.method !== 'POST') return false;
  return LOGIN_PATH_RE.test(req.url || '') || LOGIN_PATH_RE.test(req.name || '');
}

function findAuthHeaderValue(headers) {
  if (!Array.isArray(headers)) return null;
  for (const h of headers) {
    if (h && typeof h.key === 'string' && h.key.toLowerCase() === 'authorization') {
      return h.value || '';
    }
  }
  return null;
}

function extractVarsFromString(str) {
  const out = [];
  if (typeof str !== 'string') return out;
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1].trim());
  return out;
}

function inspectEnvironment(env) {
  const result = { provided: false, tokenVars: [], values: {} };
  if (!env || typeof env !== 'object') return result;

  const values = Array.isArray(env.values) ? env.values : [];
  if (values.length === 0) return result;

  result.provided = true;
  for (const v of values) {
    if (!v || !v.key || v.enabled === false) continue;
    const key = String(v.key);
    const value = v.value == null ? '' : String(v.value);
    result.values[key] = value;
    if (TOKEN_KEY_RE.test(key) && value.length > 0) {
      result.tokenVars.push(key);
    }
  }
  return result;
}

/**
 * @param {ReturnType<import('./parser').parse>} parsed
 * @param {object|null} environment - Postman environment export (optional)
 */
function detectAuth(parsed, environment = null) {
  const env = inspectEnvironment(environment);

  // 1) Collection-level auth block
  const collectionAuth = parsed.collectionAuth;
  const hasCollectionAuthBlock = !!(collectionAuth && collectionAuth.type);

  // 2) Login request inside collection
  const loginRequest = parsed.requests.find(isLoginRequest) || null;

  // 3) Bearer-style headers using a {{token}} placeholder
  const referencedTokenVars = new Set();
  const requestsUsingAuthHeader = [];
  for (const req of parsed.requests) {
    const authValue = findAuthHeaderValue(req.headers);
    if (!authValue) continue;
    requestsUsingAuthHeader.push(req);
    for (const v of extractVarsFromString(authValue)) {
      if (TOKEN_KEY_RE.test(v)) referencedTokenVars.add(v);
    }
  }

  // 4) Resolution: which token vars are actually filled in (collection vars or env)
  const definedVars = parsed.definedVars || {};
  const unresolved = [];
  const resolved = [];
  for (const v of referencedTokenVars) {
    const fromCollection = definedVars[v];
    const fromEnv = env.values[v];
    if ((fromCollection && fromCollection.length > 0) || (fromEnv && fromEnv.length > 0)) {
      resolved.push(v);
    } else {
      unresolved.push(v);
    }
  }

  // Decide overall mode
  let mode = 'NONE';
  let manualTokenRequired = false;

  if (hasCollectionAuthBlock || loginRequest) {
    mode = 'AUTO_MANAGED';
  } else if (referencedTokenVars.size > 0) {
    if (resolved.length > 0 && unresolved.length === 0) {
      mode = 'ENV_MANAGED';
    } else if (env.tokenVars.length > 0) {
      mode = 'ENV_MANAGED';
    } else {
      mode = 'MANUAL_REQUIRED';
      manualTokenRequired = true;
    }
  } else if (requestsUsingAuthHeader.length > 0) {
    // Authorization header present but no var (might be hardcoded literal in collection)
    mode = 'AUTO_MANAGED';
  } else {
    mode = 'NONE';
  }

  return {
    mode, // 'AUTO_MANAGED' | 'ENV_MANAGED' | 'MANUAL_REQUIRED' | 'NONE'
    manualTokenRequired,
    collectionAuth: hasCollectionAuthBlock ? { type: collectionAuth.type } : null,
    loginRequest: loginRequest
      ? { name: loginRequest.name, method: loginRequest.method, url: loginRequest.url }
      : null,
    referencedTokenVars: Array.from(referencedTokenVars),
    resolvedTokenVars: resolved,
    unresolvedTokenVars: unresolved,
    environment: {
      provided: env.provided,
      tokenVars: env.tokenVars,
    },
    requestsWithAuthHeader: requestsUsingAuthHeader.length,
    totalRequests: parsed.requests.length,
  };
}

module.exports = { detectAuth, isLoginRequest, TOKEN_KEY_RE };
