'use strict';

const { isLoginRequest } = require('./authDetector');

/**
 * Postman -> K6 runtime auth orchestration.
 *
 * What this module produces is the *plan* the generator turns into a real
 * K6 setup() block + per-iteration runtime state. The plan answers four
 * questions for the runner:
 *
 *   1) Which JSON keys, header names, and cookies should the runtime scan
 *      on the login response to capture tokens / session ids?
 *   2) Which runtime variables (AUTH_TOKEN, JWT, ACCESS_TOKEN, SESSION_ID,
 *      cookies, ...) should be exposed to subsequent requests?
 *   3) Which Postman {{var}} placeholders should be rerouted to runtime
 *      state instead of __ENV?
 *   4) Which requests will receive the captured Authorization header?
 *
 * The result mimics Postman's variable-mutation behavior:
 *   - Login runs once, response is parsed, runtime state is populated.
 *   - Subsequent requests resolve Authorization / {{token}} / Set-Cookie
 *     against the runtime state, falling back to __ENV (manual / env file)
 *     when extraction failed.
 */

/**
 * JSON body keys we scan recursively. Ordered roughly by frequency in the
 * wild. The runtime walks the response body breadth-first and additionally
 * descends into well-known wrapper objects.
 */
const TOKEN_KEYS = [
  'access_token',
  'accessToken',
  'token',
  'authToken',
  'auth_token',
  'jwt',
  'jwtToken',
  'jwt_token',
  'id_token',
  'idToken',
  'bearerToken',
  'bearer_token',
  'apiToken',
  'api_token',
  'sessionToken',
  'session_token',
];

/**
 * Body keys we map to the SESSION_ID runtime slot.
 */
const SESSION_KEYS = [
  'sessionId',
  'session_id',
  'sid',
  'session',
];

/**
 * Header names that may carry a token / session id on the login response.
 */
const TOKEN_HEADER_NAMES = [
  'authorization',
  'x-auth-token',
  'x-access-token',
  'x-token',
  'x-jwt',
  'x-jwt-token',
  'x-id-token',
];

const SESSION_HEADER_NAMES = [
  'x-session-id',
  'x-session',
  'session-id',
];

/**
 * Runtime slots the generator emits. Each slot has:
 *   - name: the runtime key on the data object (data.AUTH_TOKEN, etc.)
 *   - placeholders: Postman {{var}} names that resolve to it (after toEnvName)
 */
const RUNTIME_SLOTS = [
  {
    name: 'AUTH_TOKEN',
    placeholders: [
      'AUTH_TOKEN',
      'TOKEN',
      'BEARER_TOKEN',
      'BEARERTOKEN',
    ],
  },
  {
    name: 'ACCESS_TOKEN',
    placeholders: ['ACCESS_TOKEN', 'ACCESSTOKEN'],
  },
  {
    name: 'JWT',
    placeholders: ['JWT', 'JWT_TOKEN', 'JWTTOKEN'],
  },
  {
    name: 'ID_TOKEN',
    placeholders: ['ID_TOKEN', 'IDTOKEN'],
  },
  {
    name: 'SESSION_ID',
    placeholders: ['SESSION_ID', 'SESSIONID', 'SID', 'SESSION'],
  },
];

/**
 * Build a flat reroute map: { POSTMAN_VAR_NAME -> runtime slot } so the
 * generator can decide whether a given {{var}} reference should resolve to
 * a runtime slot. Slot ordering matters: AUTH_TOKEN/ACCESS_TOKEN/JWT/ID_TOKEN
 * all participate in the Authorization header chain.
 */
function buildPlaceholderToSlot() {
  const map = new Map();
  for (const slot of RUNTIME_SLOTS) {
    for (const ph of slot.placeholders) map.set(ph, slot.name);
  }
  return map;
}

/**
 * Inspect a request's `tests` script for explicit capture statements such as
 *   pm.environment.set("token", json.access_token)
 *   pm.collectionVariables.set("session_id", res.json().sessionId)
 * and return any extra response paths the runtime should sniff.
 *
 * We do NOT execute the script — we just regex out (varName, jsonPath) pairs
 * so the runtime engine can capture them deterministically. Postman scripts
 * frequently follow these patterns:
 *   pm.environment.set("token", json.access_token)
 *   pm.environment.set("token", pm.response.json().access_token)
 *   pm.environment.set("token", responseJson.data.token)
 */
function extractCaptureStatements(scripts) {
  if (!Array.isArray(scripts) || scripts.length === 0) return [];
  const text = scripts.join('\n');
  const captures = [];

  // pm.environment.set("name", expr) and pm.collectionVariables.set("name", expr)
  const setRe = /pm\.(?:environment|collectionVariables|globals|variables)\.set\s*\(\s*["']([^"']+)["']\s*,\s*([^)]+)\)/g;
  let m;
  while ((m = setRe.exec(text)) !== null) {
    const varName = m[1].trim();
    const expr = m[2].trim();

    // Try to translate the JS expression into a JSON dotted path on the body.
    // Patterns we support:
    //   json.access_token
    //   responseJson.data.token
    //   pm.response.json().access_token
    //   res.json().data.session.token
    //   jsonData.token
    let path = null;
    const dotChain =
      expr.match(/(?:pm\.response\.json\(\)|response\.json\(\)|res\.json\(\)|jsonData|json|responseJson|body|res|response)\s*((?:\.\w+)+)/);
    if (dotChain) {
      path = dotChain[1].replace(/^\./, '').split('.').filter(Boolean);
    } else {
      // Common Postman shorthand after `const r = pm.response.json()` etc.
      const aliasProp = expr.match(/^([a-zA-Z_]\w*)\.(\w+)/);
      const alias = aliasProp ? aliasProp[1] : null;
      const prop = aliasProp ? aliasProp[2] : null;
      if (
        alias &&
        prop &&
        /^(r|res|json|j|body|response|jsonData|responseJson)$/i.test(alias)
      ) {
        path = [prop];
      }
    }

    captures.push({ varName, path, source: 'pmScript' });
  }

  // pm.response.headers.get('X-Token') -> tells us the response has a header
  const headerRe = /pm\.response\.headers\.get\s*\(\s*["']([^"']+)["']\s*\)/gi;
  while ((m = headerRe.exec(text)) !== null) {
    captures.push({ headerName: m[1].toLowerCase(), source: 'pmScript' });
  }

  return captures;
}

/**
 * Decide which {{var}} placeholders inside a request should be rerouted to
 * runtime slots, given the placeholder->slot map.
 */
function findReferencedRuntimeVars(req, placeholderToSlot) {
  const found = new Set();
  const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const sniff = (s) => {
    if (typeof s !== 'string') return;
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(s)) !== null) {
      const norm = m[1].trim().replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
      if (placeholderToSlot.has(norm)) found.add(norm);
    }
  };
  sniff(req.url);
  for (const h of req.headers || []) {
    sniff(h.key);
    sniff(h.value);
  }
  if (req.body) {
    if (req.body.mode === 'raw') sniff(req.body.raw);
    if (req.body.mode === 'urlencoded' || req.body.mode === 'formdata') {
      for (const p of req.body.params || []) {
        sniff(p.key);
        sniff(p.value);
      }
    }
    if (req.body.mode === 'graphql') {
      sniff(req.body.query);
      if (typeof req.body.variables === 'string') sniff(req.body.variables);
    }
  }
  return found;
}

/**
 * @param {object} parsed - Output of parser.parse() (post-sanitize)
 * @returns {{
 *   enabled: boolean,
 *   loginRequest: object|null,
 *   loginRequestIndex: number,
 *   tokenKeys: string[],
 *   sessionKeys: string[],
 *   tokenHeaders: string[],
 *   sessionHeaders: string[],
 *   captureRules: Array<{varName?:string, headerName?:string, path?:string[]}>,
 *   runtimeSlots: typeof RUNTIME_SLOTS,
 *   tokenRerouteNames: string[],
 *   injectionTargets: number[],
 *   injectionCount: number,
 *   reasons: string[]
 * }}
 */
function collectRuntimeCapturedVarNames(parsed) {
  const requests = parsed?.requests || [];
  const out = new Set();

  for (const req of requests) {
    const scripts = [...(req?.tests || []), ...(req?.prerequests || [])];
    for (const text of scripts) {
      if (typeof text !== 'string') continue;
      const setRe = /pm\.(?:environment|collectionVariables|globals|variables)\.set\s*\(\s*["']([^"']+)["']\s*,/g;
      let match;
      while ((match = setRe.exec(text)) !== null) {
        const name = String(match[1] || '').trim();
        if (name) out.add(name);
      }
    }
  }

  return Array.from(out);
}

function buildAuthFlow(parsed) {
  const requests = parsed?.requests || [];
  const placeholderToSlot = buildPlaceholderToSlot();
  const loginIdx = requests.findIndex(isLoginRequest);
  const reasons = [];

  const requestCaptureRules = requests
    .map((request, index) => ({
      index,
      rules: extractCaptureStatements(request.tests || []),
    }))
    .filter((entry) => entry.rules.length > 0);

  if (loginIdx === -1) {
    return {
      enabled: false,
      loginRequest: null,
      loginRequestIndex: -1,
      tokenKeys: TOKEN_KEYS.slice(),
      sessionKeys: SESSION_KEYS.slice(),
      tokenHeaders: TOKEN_HEADER_NAMES.slice(),
      sessionHeaders: SESSION_HEADER_NAMES.slice(),
      captureRules: [],
      requestCaptureRules,
      runtimeSlots: RUNTIME_SLOTS,
      tokenRerouteNames: Array.from(placeholderToSlot.keys()),
      injectionTargets: [],
      injectionCount: 0,
      reasons: ['No login request detected (URL/name didn\'t match login|signin|authenticate|oauth|token).'],
    };
  }

  const login = requests[loginIdx];
  reasons.push(`Login detected: ${login.method} ${login.url}`);

  // Pull explicit pm.environment.set(...) capture statements off the login
  // request. These take priority over the generic body scan.
  const captureRules = extractCaptureStatements(login.tests || []);
  if (captureRules.length > 0) {
    reasons.push(
      `Found ${captureRules.length} explicit capture statement${
        captureRules.length === 1 ? '' : 's'
      } in the login test script.`
    );
  }

  // Pick injection targets: every non-login request that either declares an
  // Authorization header, or references one of the runtime placeholders, or
  // references a {{Set-Cookie}} style cookie variable, or whose request body
  // / URL embeds a {{token}}-style variable.
  const targets = [];
  requests.forEach((r, i) => {
    if (i === loginIdx) return;
    const headers = r.headers || [];
    const usesAuthHeader = headers.some(
      (h) => typeof h.key === 'string' && h.key.toLowerCase() === 'authorization'
    );
    if (usesAuthHeader) {
      targets.push(i);
      return;
    }
    const refs = findReferencedRuntimeVars(r, placeholderToSlot);
    if (refs.size > 0) targets.push(i);
  });

  reasons.push(`${targets.length} request${targets.length === 1 ? '' : 's'} will receive the token at runtime.`);

  return {
    enabled: true,
    loginRequest: login,
    loginRequestIndex: loginIdx,
    tokenKeys: TOKEN_KEYS.slice(),
    sessionKeys: SESSION_KEYS.slice(),
    tokenHeaders: TOKEN_HEADER_NAMES.slice(),
    sessionHeaders: SESSION_HEADER_NAMES.slice(),
    captureRules,
    requestCaptureRules,
    runtimeSlots: RUNTIME_SLOTS,
    tokenRerouteNames: Array.from(placeholderToSlot.keys()),
    injectionTargets: targets,
    injectionCount: targets.length,
    reasons,
  };
}

module.exports = {
  buildAuthFlow,
  collectRuntimeCapturedVarNames,
  TOKEN_KEYS,
  SESSION_KEYS,
  TOKEN_HEADER_NAMES,
  SESSION_HEADER_NAMES,
  RUNTIME_SLOTS,
  // Back-compat exports preserved so imports elsewhere keep working:
  TOKEN_VAR_NAMES: new Set(RUNTIME_SLOTS.flatMap((s) => s.placeholders)),
  TOKEN_REROUTE_NAMES: new Set(RUNTIME_SLOTS.flatMap((s) => s.placeholders)),
};
