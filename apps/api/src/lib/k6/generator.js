'use strict';

/**
 * Deterministic Postman -> K6 script generator.
 *
 * Auth orchestration model:
 * -------------------------
 * The generated K6 script behaves like a tiny Postman runtime. There is a
 * shared `data` object returned from setup() that carries:
 *
 *   data.AUTH_TOKEN     // primary bearer
 *   data.ACCESS_TOKEN   // OAuth2 access_token
 *   data.JWT            // jwt / jwt_token / jwtToken
 *   data.ID_TOKEN       // OIDC id_token
 *   data.SESSION_ID     // session id (body or x-session-id header)
 *   data.cookies        // [{name, value}] captured Set-Cookie pairs
 *   data.vars           // { name -> string } captures from pm.environment.set
 *
 * Postman {{var}} placeholders that match a runtime slot's known names
 * (e.g. `{{access_token}}`, `{{jwt}}`, `{{auth_token}}`) are rewritten to
 *
 *     ${data.<SLOT> || __ENV.<NAME> || ''}
 *
 * which gives the exact priority required:
 *   1) runtime-extracted token (from login response),
 *   2) environment / manual __ENV value,
 *   3) empty string (request fails loudly with status 401, never silently).
 *
 * For Authorization, AUTH_TOKEN > ACCESS_TOKEN > JWT > ID_TOKEN form a
 * waterfall so a script that only stores `access_token` still authenticates.
 *
 * Cookie persistence: every captured Set-Cookie from setup() is replayed as
 * a `Cookie` header on subsequent requests that don't already declare one.
 * K6's per-VU cookie jar does not see cookies set during setup(), so we
 * inject them explicitly.
 *
 * Authorization header de-duplication: we never add an Authorization header
 * if the request already declares one.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const { credentialEnvName, redactLoginCredentials } = require('../postman/loginCredentials');
const {
  buildAuthStateAccessorBlock,
  buildEnsureVuLoginBlock,
} = require('./perVuAuthCodegen');
const { buildTimeoutCodegen, DEFAULT_REQUEST_TIMEOUT } = require('./requestTimeout');
const { isDynamicVariable, DYNAMIC_VARIABLE_RUNTIME_JS } = require('../postman/dynamicVariables');
const { normalizeRequestVariables, REQUEST_LOCAL_RUNTIME_JS } = require('../postman/requestLocals');
const { isJsonRawBody, buildJsonAwareRawBody } = require('../postman/jsonBodyCodegen');
const { analyzePrerequestScript, emitPrerequestBlock, PREREQUEST_RUNTIME_JS } = require('../postman/prerequestCodegen');
const { analyzeRequestVariables, UNRESOLVED_SAFETY_RUNTIME_JS } = require('../postman/unresolvedSafety');

const TOKEN_REROUTE_DEFAULT = new Set([
  'AUTH_TOKEN',
  'ACCESS_TOKEN',
  'TOKEN',
  'JWT',
  'JWT_TOKEN',
  'ID_TOKEN',
  'BEARER_TOKEN',
  'BEARERTOKEN',
]);

/**
 * Generic detector for "looks like an auth token" placeholder names. The
 * fix for Bearer {{jwt_token}} / {{global_auth_token}} / {{access_token}}
 * etc. depends on this being NAME-AGNOSTIC: anywhere a placeholder name
 * carries JWT, TOKEN, AUTH, or BEARER, the manual __ENV.AUTH_TOKEN value
 * is used as the ultimate fallback so a single manual override paste
 * unblocks every authenticated request in the collection.
 *
 * SESSION / KEY are deliberately NOT here — those are different runtime
 * slots (SESSION_ID / API_KEY) and conflating them with AUTH_TOKEN would
 * silently break collections that use both.
 */
const TOKEN_NAME_RE = /(?:TOKEN|JWT|AUTH|BEARER)/;

function isTokenShapedName(envName) {
  return typeof envName === 'string' && TOKEN_NAME_RE.test(envName);
}

/**
 * Map a Postman variable name (after toEnvName) to a runtime slot. Order
 * matters: AUTH_TOKEN's reroute waterfall is wider than the other slots'.
 */
const PLACEHOLDER_TO_SLOT = new Map([
  ['AUTH_TOKEN', 'AUTH_TOKEN'],
  ['TOKEN', 'AUTH_TOKEN'],
  ['BEARER_TOKEN', 'AUTH_TOKEN'],
  ['BEARERTOKEN', 'AUTH_TOKEN'],
  ['ACCESS_TOKEN', 'ACCESS_TOKEN'],
  ['ACCESSTOKEN', 'ACCESS_TOKEN'],
  ['JWT', 'JWT'],
  ['JWT_TOKEN', 'JWT'],
  ['JWTTOKEN', 'JWT'],
  ['ID_TOKEN', 'ID_TOKEN'],
  ['IDTOKEN', 'ID_TOKEN'],
  ['SESSION_ID', 'SESSION_ID'],
  ['SESSIONID', 'SESSION_ID'],
  ['SID', 'SESSION_ID'],
  ['SESSION', 'SESSION_ID'],
]);

function toEnvName(varName) {
  return String(varName)
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function escapeForTemplateLiteral(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

function escapeJsonInDouble(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Build the runtime expression for a Postman placeholder.
 *
 * Resolution priority (highest first):
 *   1. __ENV.<NAME>       (manual UI-entered value, locked override)
 *   2. data.<SLOT>        (token extracted at runtime by setup())
 *   3. data.vars[<name>]  (value captured by pm.environment.set)
 *   4. ''                 (empty fallback so the request fails loudly)
 *
 * - For known runtime slots we emit
 *     `(__ENV.<NAME> || data.<SLOT> || '')`
 *   AUTH_TOKEN gets a wider fallback covering the other token slots so a
 *   collection that only captures `access_token` still authenticates when
 *   the user did NOT provide a manual override.
 * - For `vars.<original>` style refs, the manual value still wins:
 *     `(__ENV.<NAME> || data.vars[<name>] || '')`
 * - Anything else stays on `__ENV` only.
 */
function makeInterpolator({
  tokenReroute,
  runtimeEnabled,
  capturedVarNames,
  perVuCredentials = false,
  stateRef = 'data',
  requestIndex = -1,
  requestLocals = null,
  prerequestSets = null,
}) {
  const reroute = tokenReroute || new Set();
  const captured = capturedVarNames || new Set();
  const st = stateRef || 'data';
  const locals = requestLocals || new Map();
  const pmSets = prerequestSets || new Set();
  const reqIdx = requestIndex;

  function buildSources(envName, originalName, isCaptured, safeOriginal) {
    const sources = [];
    if (isDynamicVariable(originalName)) {
      sources.push(`__resolveDynamicVar(${JSON.stringify(originalName)}, __dynCache_${reqIdx})`);
      return sources;
    }
    sources.push('__ENV.' + envName);
    if (pmSets.has(originalName)) {
      sources.push('__getPmVar(' + st + ', \'environment\', ' + JSON.stringify(originalName) + ')');
      sources.push('__getPmVar(' + st + ', \'variables\', ' + JSON.stringify(originalName) + ')');
    }
    if (locals.has(originalName)) {
      const entry = locals.get(originalName);
      if (!entry.hasNestedRefs && entry.value.length > 0) {
        sources.push(JSON.stringify(entry.value));
      }
      if (reqIdx >= 0) {
        sources.push('__getRequestLocal(' + st + ', ' + reqIdx + ', ' + JSON.stringify(originalName) + ')');
      }
    }
    return sources;
  }

  function finalizeExpr(sources, originalName, { isToken = false } = {}) {
    const chain = sources.join(' || ');
    if (isToken) return '${(' + chain + " || '')}";
    return '${__coalesceVar(' + JSON.stringify(originalName) + ', ' + chain + ')}';
  }

  function expr(envName, originalName) {
    if (perVuCredentials && /^LOGIN_/.test(envName)) {
      return '${(__resolveLoginField("' + envName + '") || ' + "''" + ')}';
    }
    const isCaptured = captured.has(originalName);
    const safeOriginal = isCaptured ? escapeJsonInDouble(originalName) : '';

    // Token-shaped placeholders ALWAYS resolve via the manual AUTH_TOKEN
    // override first. This is the core fix for Bearer {{jwt_token}} /
    // {{access_token}} / {{global_auth_token}} / {{token}} etc:
    //
    //   priority = __ENV.<placeholderName>         // env file / collection var
    //           || __ENV.AUTH_TOKEN                // manual UI override
    //           || data.<runtime slot>             // captured at runtime
    //           || data.vars[<original>]           // pm.environment.set capture
    //           || ''                              // empty (request fails loud)
    //
    // We put __ENV.<placeholderName> first so per-placeholder env values
    // still work for non-override flows; but as soon as a manual AUTH_TOKEN
    // exists, that name-agnostic fallback wins because the collection's
    // {{jwt_token}} is normally NOT defined when the user pastes a manual
    // override.
    if (isTokenShapedName(envName)) {
      const slot = PLACEHOLDER_TO_SLOT.get(envName) || 'AUTH_TOKEN';
      const slotChain =
        runtimeEnabled
          ? slot === 'AUTH_TOKEN'
            ? ' || ' + st + '.AUTH_TOKEN || ' + st + '.ACCESS_TOKEN || ' + st + '.JWT || ' + st + '.ID_TOKEN'
            : ' || ' + st + '.' + slot
          : '';
      // Note the explicit AUTH_TOKEN injection — for token-shaped names other
      // than AUTH_TOKEN itself, we still consult AUTH_TOKEN as the manual
      // override.
      // pm.environment.set captures: a collection that calls
      //   pm.environment.set("custom_jwt_token", json.data.token)
      // populates data.vars["custom_jwt_token"] at runtime. We honor that
      // even for token-shaped names so capture rules and runtime-extracted
      // tokens both work.
      const sources = ['__ENV.AUTH_TOKEN'];
      if (runtimeEnabled && slotChain) sources.push(slotChain.replace(/^ \|\| /, ''));
      if (runtimeEnabled && isCaptured) sources.push(st + '.vars["' + safeOriginal + '"]');
      if (envName !== 'AUTH_TOKEN') sources.push('__ENV.' + envName);
      return finalizeExpr(sources, originalName, { isToken: true });
    }
    if (runtimeEnabled && reroute.has(envName)) {
      // Non-token-shaped name in the explicit reroute set (e.g. SESSION_ID)
      // gets the runtime slot fallback, but no AUTH_TOKEN override —
      // SESSION_ID is a different slot.
      const slot = PLACEHOLDER_TO_SLOT.get(envName) || envName;
      return '${(__ENV.' + envName + ' || ' + st + '.' + slot + " || '')}";
    }
    if (isCaptured) {
      const sources = buildSources(envName, originalName, true, safeOriginal);
      sources.push(st + '.vars["' + safeOriginal + '"]');
      return finalizeExpr(sources, originalName);
    }
    const sources = buildSources(envName, originalName, false, safeOriginal);
    return finalizeExpr(sources, originalName);
  }

  function exprForPlaceholder(originalName, { unquotedJson = false } = {}) {
    const envName = toEnvName(originalName);
    const core = expr(envName, originalName);
    if (unquotedJson) {
      return '${__resolveJsonLiteral(' + JSON.stringify(originalName) + ', ' + core.slice(2, -1) + ')}';
    }
    return core;
  }

  return {
    exprForPlaceholder,
    asTemplate(str) {
      if (str == null) return '';
      const input = String(str);
      let out = '';
      let last = 0;
      VAR_RE.lastIndex = 0;
      let m;
      while ((m = VAR_RE.exec(input)) !== null) {
        out += escapeForTemplateLiteral(input.slice(last, m.index));
        const original = m[1].trim();
        out += expr(toEnvName(original), original);
        last = m.index + m[0].length;
      }
      out += escapeForTemplateLiteral(input.slice(last));
      return out;
    },
    asJsonString(str) {
      if (str == null) return '';
      const input = String(str);
      let out = '';
      let last = 0;
      VAR_RE.lastIndex = 0;
      let m;
      while ((m = VAR_RE.exec(input)) !== null) {
        out += escapeJsonInDouble(input.slice(last, m.index));
        const original = m[1].trim();
        out += expr(toEnvName(original), original);
        last = m.index + m[0].length;
      }
      out += escapeJsonInDouble(input.slice(last));
      return out;
    },
  };
}

function collectVarSet(parsed) {
  const set = new Set(parsed.referencedVars || []);
  return Array.from(set).map((v) => ({ original: v, env: toEnvName(v) }));
}

function hasHeaderKey(headers, name) {
  const target = String(name || '').toLowerCase();
  return (headers || []).some(
    (h) => typeof h.key === 'string' && h.key.toLowerCase() === target
  );
}

/** Postman auto-adds Content-Type for raw JSON / urlencoded / graphql bodies. */
function inferDefaultContentType(body) {
  if (!body || !body.mode) return null;
  if (body.mode === 'raw' && isJsonRawBody(body)) return 'application/json';
  if (body.mode === 'graphql') return 'application/json';
  if (body.mode === 'urlencoded') return 'application/x-www-form-urlencoded';
  return null;
}

function buildHeadersBlock(headers, { injectAuthToken, interp, runtimeEnabled, body = null }) {
  const authIndex = headers.findIndex(
    (h) => typeof h.key === 'string' && h.key.toLowerCase() === 'authorization'
  );
  const hasAuth = authIndex >= 0;
  const hasCookie = hasHeaderKey(headers, 'cookie');
  const hasContentType = hasHeaderKey(headers, 'content-type');

  // Phase 2 hardening: a collection with two Authorization headers used to
  // emit both, causing a duplicate object key so the last (unrouted) one
  // silently won over the resolver-routed first one. Track secondary
  // Authorization indices and drop them so exactly one Authorization
  // header — the resolver-routed one — reaches the wire.
  const dropAuthIndices = new Set();
  if (hasAuth) {
    headers.forEach((h, i) => {
      if (
        i !== authIndex &&
        typeof h.key === 'string' &&
        h.key.toLowerCase() === 'authorization'
      ) {
        dropAuthIndices.add(i);
      }
    });
  }

  const lines = [];
  headers.forEach((h, i) => {
    if (dropAuthIndices.has(i)) return;
    const isAuth = i === authIndex;
    const k = escapeJsonInDouble(h.key);

    if (isAuth) {
      // Every Authorization header — regardless of which placeholder name the
      // collection used ({{jwt_token}}, {{global_auth_token}},
      // {{access_token}}, etc.) — flows through __resolveAuthHeader (or the
      // non-runtime equivalent) so a manual __ENV.AUTH_TOKEN from the UI
      // overrides everything. The original header value is rendered as a
      // template literal and passed in as `fallback`, so when the user did
      // NOT provide a manual token the generated script still resolves the
      // collection's placeholder via __ENV the same way as before.
      const fallback = interp.asTemplate(h.value);
      // Capture the FIRST placeholder name in the raw header value so the
      // runtime resolver can log it verbatim — matches the requirement to
      // emit "[auth] placeholder replaced: {{jwt_token}}" with the literal
      // collection name.
      const rawValue = h.value == null ? '' : String(h.value);
      const placeholderMatch = rawValue.match(/\{\{\s*([^}]+?)\s*\}\}/);
      const placeholderHint = placeholderMatch ? placeholderMatch[1].trim() : '';
      const hintArg = placeholderHint
        ? `, "${escapeJsonInDouble(placeholderHint)}"`
        : '';
      const resolver = runtimeEnabled
        ? '__resolveAuthHeader(data, `' + fallback + '`' + hintArg + ')'
        : '__resolveAuthHeaderEnv(`' + fallback + '`' + hintArg + ')';
      lines.push(`      ...__authHeader(${resolver})`);
      return;
    }

    const v = interp.asTemplate(h.value);
    lines.push(`      "${k}": \`${v}\``);
  });

  if (injectAuthToken && !hasAuth) {
    // No Authorization header on the request. Inject one that still defers
    // to the same single resolver, so the manual token wins here too.
    const empty = '``';
    const resolver = runtimeEnabled
      ? `__resolveAuthHeader(data, ${empty})`
      : `__resolveAuthHeaderEnv(${empty})`;
    lines.push(`      ...__authHeader(${resolver})`);
  }

  if (runtimeEnabled && !hasCookie) {
    // Runtime cookie replay: setup() captured Set-Cookie values from the
    // login response. We build a single Cookie header from data.cookies so
    // session-cookie auth works without depending on K6's per-VU jar.
    lines.push(`      ...__runtimeCookieHeader(data)`);
  }

  if (!hasContentType) {
    const inferred = inferDefaultContentType(body);
    if (inferred) {
      lines.push(`      "Content-Type": ${JSON.stringify(inferred)}`);
    }
  }

  if (lines.length === 0) {
    return `    headers: {}`;
  }
  return `    headers: {\n${lines.join(',\n')}\n    }`;
}

function buildBodyExpression(body, { interp, redactCredentials = false }) {
  if (!body) return null;
  switch (body.mode) {
    case 'raw': {
      const raw = redactCredentials ? redactLoginCredentials(body.raw || '') : body.raw || '';
      if (isJsonRawBody(body)) {
        const built = buildJsonAwareRawBody({ ...body, raw }, interp);
        return built.expr;
      }
      const value = interp.asTemplate(raw);
      return `\`${value}\``;
    }
    case 'urlencoded': {
      const obj = body.params
        .map(
          (p) => {
            const envName = credentialEnvName(p.key);
            const value = redactCredentials && envName && typeof p.value === 'string' && !/\{\{[^}]+\}\}/.test(p.value)
              ? `{{${envName}}}`
              : p.value;
            return `      "${escapeJsonInDouble(p.key)}": \`${interp.asTemplate(value)}\``;
          }
        )
        .join(',\n');
      return `{\n${obj}\n    }`;
    }
    case 'formdata': {
      const obj = body.params
        .map(
          (p) => {
            const envName = credentialEnvName(p.key);
            const value = redactCredentials && envName && typeof p.value === 'string' && !/\{\{[^}]+\}\}/.test(p.value)
              ? `{{${envName}}}`
              : p.value;
            return `      "${escapeJsonInDouble(p.key)}": \`${interp.asTemplate(value)}\``;
          }
        )
        .join(',\n');
      return `{\n${obj}\n    }`;
    }
    case 'graphql': {
      const query = interp.asJsonString(body.query || '');
      const vars = body.variables ? interp.asJsonString(String(body.variables)) : '';
      return `\`{"query":"${query}"${vars ? `,"variables":"${vars}"` : ''}}\``;
    }
    default:
      return null;
  }
}

function methodCall(method) {
  const m = (method || 'GET').toLowerCase();
  const supported = ['get', 'post', 'put', 'patch', 'del', 'options', 'head'];
  return supported.includes(m === 'delete' ? 'del' : m) ? (m === 'delete' ? 'del' : m) : null;
}

/**
 * Phase 3 auth strategy taxonomy. This is the *internal* model exposed to
 * the emitted script via a `const AUTH_STRATEGY` at the top. The set is
 * intentionally small so we don't overfit today's flows; future phases can
 * extend this without changing the section layout below.
 *
 *   NONE          request set has no Authorization header expectations
 *   STATIC        Authorization comes from a static source (manual UI
 *                 __ENV.AUTH_TOKEN, environment file, or collection var).
 *                 No setup() login runs. Every VU reads the same value.
 *   SETUP_LOGIN   A login request runs once in setup() and every VU
 *                 shares the captured token. This is what buildAuthFlow()
 *                 currently produces.
 *   PER_VU        (reserved for future) each VU logs in independently.
 */
const AuthStrategy = Object.freeze({
  NONE: 'NONE',
  STATIC: 'STATIC',
  SETUP_LOGIN: 'SETUP_LOGIN',
  PER_VU_LOGIN: 'PER_VU_LOGIN',
});

function deriveAuthStrategy({
  runtimeEnabled,
  injectAuthToken,
  collectionHasAuthHeader,
  authSessionMode,
}) {
  if (authSessionMode === 'MANUAL_TOKEN') return AuthStrategy.STATIC;
  if (authSessionMode === 'PER_VU_LOGIN' && runtimeEnabled) return AuthStrategy.PER_VU_LOGIN;
  if (runtimeEnabled || authSessionMode === 'SHARED_SESSION') return AuthStrategy.SETUP_LOGIN;
  if (injectAuthToken || collectionHasAuthHeader) return AuthStrategy.STATIC;
  return AuthStrategy.NONE;
}

/**
 * Extract a stable, path-only view of a request's URL. Postman URLs often
 * start with `{{baseUrl}}` or a full protocol+host — we strip both so the
 * `api_path` tag is comparable across environments. Query strings and
 * fragments are dropped so the tag cardinality stays bounded.
 */
function extractApiPath(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return '/';
  let s = rawUrl.trim();
  s = s.replace(/^\{\{[^}]+\}\}/, ''); // strip leading placeholder like {{baseUrl}}
  s = s.replace(/^https?:\/\/[^/]+/, ''); // strip explicit scheme + host
  s = s.split('?')[0].split('#')[0];
  // Tag cardinality: replace unresolved placeholders with a stable token.
  s = s.replace(/\{\{[^}]+\}\}/g, ':var');
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

/**
 * A stable per-request slug for the `request_id` tag. Uses the position in
 * the filtered request list so a script that runs 40 requests always
 * produces req_01..req_40 in the same order, independent of Postman names.
 */
function makeRequestId(emitIndex, totalRequests) {
  const width = Math.max(2, String(Math.max(1, totalRequests)).length);
  return 'req_' + String(emitIndex + 1).padStart(width, '0');
}

/**
 * Build the standardized tag map emitted as `params.tags` for every HTTP
 * request. Report identity relies on these — never on the request's
 * display name alone (which may collide across folders).
 */
function buildRequestTags(req, emitIndex, totalRequests) {
  return {
    api_name: String(req.name || '').slice(0, 200),
    api_method: String(req.method || 'GET').toUpperCase(),
    api_path: extractApiPath(req.url),
    folder: Array.isArray(req.folderPath) ? req.folderPath.join('/') : '',
    request_id: makeRequestId(emitIndex, totalRequests),
  };
}

function stringifyTagObject(tags) {
  // Emit as a Postman-safe JS object literal. Each value is JSON.stringify'd
  // so quotes and apostrophes inside request names (e.g. "User's Carts")
  // are safely embedded.
  const entries = Object.entries(tags).map(
    ([k, v]) => `      ${JSON.stringify(k)}: ${JSON.stringify(v)}`
  );
  return `{\n${entries.join(',\n')}\n    }`;
}

function buildRequestLocalSeed(requestVariables) {
  const seed = {};
  for (const [key, entry] of normalizeRequestVariables(requestVariables)) {
    if (!entry.hasNestedRefs) seed[key] = entry.value;
  }
  return seed;
}

function buildRequestBlock(req, options, ctx = {}) {
  const { injectAuthToken, runtimeEnabled } = options;
  const interp = ctx.interp || options.interp;
  const emitIndex = typeof ctx.emitIndex === 'number' ? ctx.emitIndex : 0;
  const totalRequests = typeof ctx.totalRequests === 'number' ? ctx.totalRequests : 1;
  const dependencyDeps = Array.isArray(ctx.dependencyDeps) ? ctx.dependencyDeps : [];
  const depVar = `__dep_${emitIndex}`;
  const urlVar = `__url_${emitIndex}`;
  const bodyVar = `__body_${emitIndex}`;
  const dynCacheVar = `__dynCache_${emitIndex}`;

  const prerequestBlock = ctx.prerequestBlock || '';
  const prerequestPrefix = prerequestBlock
    ? [
        prerequestBlock,
        `    __getAuthState(data).__currentRequestIndex = ${emitIndex};`,
        `    const ${dynCacheVar} = {};`,
      ].join('\n')
    : `    const ${dynCacheVar} = {};`;

  const url = `\`${interp.asTemplate(req.url)}\``;
  const headersBlock = buildHeadersBlock(req.headers, {
    injectAuthToken,
    interp,
    runtimeEnabled,
    body: req.body,
  });
  const authHeader = (req.headers || []).find(
    (h) => typeof h?.key === 'string' && h.key.toLowerCase() === 'authorization'
  );
  const authFallback = authHeader ? interp.asTemplate(authHeader.value) : '';
  const bodyExpr = buildBodyExpression(req.body, { interp, redactCredentials: true });
  const verb = methodCall(req.method);

  const tags = buildRequestTags(req, emitIndex, totalRequests);
  const tagLiteral = stringifyTagObject(tags);
  const tagsVar = `__tags_${emitIndex}`;
  const clsVar = `__cls_${emitIndex}`;

  // Compose the params object with headers + stable tags + explicit
  // timeout. Every request in the script uses the same REQUEST_TIMEOUT
  // constant so users can tune it via __ENV.REQUEST_TIMEOUT without
  // regenerating the script.
  const paramsInner = [
    headersBlock,
    `    tags: ${tagsVar}`,
    `    timeout: __requestTimeout(${JSON.stringify(tags.request_id)}),`,
  ].join(',\n');
  const params = `{\n${paramsInner}\n  }`;

  const folder = (req.folderPath || []).join(' / ');
  const label = `${folder ? folder + ' / ' : ''}${req.name}`;
  const groupHeader = `  group(\`${escapeForTemplateLiteral(label)}\`, () => {`;
  const tagsDecl = `    const ${tagsVar} = __defaultTags(${tagLiteral});`;
  const skipPrefix = JSON.stringify(`[skip] ${label}: `);
  const depGuard = dependencyDeps.length > 0
    ? [
        `    const ${depVar} = __checkDependencyDeps(data, ${JSON.stringify(dependencyDeps)});`,
        `    if (${depVar}.blocked) {`,
        `      __dependencySkipped.add(1, ${tagsVar});`,
        `      console.warn(${skipPrefix} + ${depVar}.reason);`,
        `      return;`,
        `    }`,
      ].join('\n')
    : '';
  const urlGuard = [
    `    const ${urlVar} = ${url};`,
    `    if (__urlHasInvalidRuntimeRefs(${urlVar})) {`,
    `      __dependencySkipped.add(1, ${tagsVar});`,
    `      console.warn(${skipPrefix} + 'unresolved or invalid runtime variable in URL');`,
    `      return;`,
    `    }`,
  ].join('\n');

  const bodyGuard = bodyExpr
    ? [
        `    const ${bodyVar} = ${bodyExpr};`,
        `    if (__hasInvalidRuntimeContent(${bodyVar})) {`,
        `      __dependencySkipped.add(1, ${tagsVar});`,
        `      console.warn(${skipPrefix} + 'unresolved or invalid runtime variable in request body');`,
        `      return;`,
        `    }`,
      ].join('\n')
    : '';

  let call;
  if (verb && verb !== 'get' && verb !== 'head' && verb !== 'options' && bodyExpr) {
    call = `    const res = http.${verb}(\n      ${urlVar},\n      ${bodyVar},\n      ${params}\n    );`;
  } else if ((verb === 'del' || verb === 'put' || verb === 'patch') && !bodyExpr) {
    call = `    const res = http.${verb}(
      ${urlVar},
      null,
      ${params}
    );`;
  } else if (verb && (verb === 'get' || verb === 'head' || verb === 'options' || !bodyExpr)) {
    call = `    const res = http.${verb}(\n      ${urlVar},\n      ${params}\n    );`;
  } else {
    call = `    const res = http.request(\n      "${req.method}",\n      ${urlVar},\n      ${
      bodyExpr || 'null'
    },\n      ${params}\n    );`;
  }

  // Categorized response classification. We keep the historical
  // "status is 2xx" check for backward compatibility with report parsers
  // that grep on the check label, and add explicit transport/status
  // checks whose failures increment tag-scoped Counters.
  //
  // Uses a template literal for the console.warn label so single quotes
  // in request names (e.g. "User's Carts") no longer produce syntactically
  // invalid JS — see Phase 0 known limitation #1.
  const labelJson = JSON.stringify(label);
  const checks = [
    ctx.captureRules && ctx.captureRules.length > 0
      ? `    __captureResponseVars(res, data, ${JSON.stringify(ctx.captureRules)});`
      : '',
    `    const ${clsVar} = __classifyResponse(res);`,
    `    check(res, {`,
    `      ${JSON.stringify(label + ' - status is 2xx')}: (r) => r.status >= 200 && r.status < 300,`,
    `      ${JSON.stringify(label + ' - transport ok')}: () => ${clsVar} !== 'transport_failure',`,
    `      ${JSON.stringify(label + ' - status is expected')}: () => ${clsVar} === 'ok',`,
    `    }, ${tagsVar});`,
    `    if (${clsVar} === 'transport_failure') __transportFailed.add(1, ${tagsVar});`,
    `    else if (${clsVar} === 'unexpected_status') __unexpectedStatus.add(1, ${tagsVar});`,
    ctx.injectsAuth
      ? `    { const __authCls = __classifyAuthForRequest(data, res, \`${authFallback}\`, true);
    if (__authCls === 'AUTH_MISSING') { console.warn(\`[auth] AUTH_MISSING for ${escapeForTemplateLiteral(label)}\`); }
    else if (__authCls === 'AUTH_REJECTED_BY_SERVER') { console.warn(\`[auth] AUTH_PRESENT but server rejected credentials (HTTP \${res.status}) for ${escapeForTemplateLiteral(label)}\`); } }`
      : '',
    `    __pace();`,
    `  });`,
  ]
    .filter(Boolean)
    .join('\n');

  return `${groupHeader}\n${tagsDecl}\n${depGuard}\n${prerequestPrefix}\n${urlGuard}\n${bodyGuard}\n${call}\n${checks}\n`;
}

/**
 * The block of runtime helpers that live between the auth section and the
 * request groups. Emitted verbatim in every script so the request execution
 * pattern is uniform regardless of collection shape.
 */
const REQUEST_EXECUTION_HELPERS_JS = `
function __isTokenShapedVarName(varName) {
  const envKey = String(varName).trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  return /(?:TOKEN|JWT|AUTH|BEARER)/.test(envKey);
}

function __isRuntimeVarAvailable(state, varName) {
  if (!varName) return true;
  const envKey = String(varName).trim().replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase();
  const envVal = __ENV[envKey];
  if (typeof envVal === 'string' && envVal.length > 0 && envVal !== 'undefined' && envVal !== 'null') {
    if (!/\\{\\{[^}]+\\}\\}/.test(envVal)) return true;
  }
  const captured = state && state.vars && state.vars[varName];
  if (typeof captured === 'string' && captured.length > 0) return true;
  // PER_VU_LOGIN captures tokens into AUTH_TOKEN/ACCESS_TOKEN slots via
  // deepFind when pm.environment.set paths are not statically parseable.
  // Dependency guards must treat those slots as satisfying token-shaped vars
  // like {{access_token}} so downstream requests are not skipped.
  if (__isTokenShapedVarName(varName) && state) {
    const runtime = state.AUTH_TOKEN || state.ACCESS_TOKEN || state.JWT || state.ID_TOKEN || '';
    if (typeof runtime === 'string' && runtime.length > 0) return true;
    const promoted = state.vars && (
      state.vars.global_auth_token || state.vars.auth_token || state.vars.access_token ||
      state.vars.jwt_token || state.vars.token || state.vars.custom_token ||
      state.vars.custom_jwt_token || state.vars.myAccessToken
    );
    if (typeof promoted === 'string' && promoted.length > 0) return true;
  }
  return false;
}

function __checkDependencyDeps(data, deps) {
  if (!Array.isArray(deps) || deps.length === 0) return { blocked: false };
  const state = __getAuthState(data);
  for (const dep of deps) {
    if (!dep || !dep.varName) continue;
    if (!__isRuntimeVarAvailable(state, dep.varName)) {
      const producer = dep.producerRequest || 'upstream request';
      return {
        blocked: true,
        missingVar: dep.varName,
        dependency: producer,
        reason: 'Required variable ' + dep.varName + ' was unavailable because upstream request ' + producer + ' did not produce it.',
      };
    }
  }
  return { blocked: false };
}

function __urlHasInvalidRuntimeRefs(resolvedUrl) {
  return __hasInvalidRuntimeContent(resolvedUrl);
}

function __coalesceVar(name, value) {
  if (value == null || value === '' || value === 'undefined' || value === 'null') {
    return '__UNRESOLVED__' + String(name || '');
  }
  return value;
}

function __resolveJsonLiteral(name, value) {
  if (value == null || value === '' || value === 'undefined') return '__UNRESOLVED__' + String(name || '');
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^-?\\d+(?:\\.\\d+)?$/.test(value)) return Number(value);
  return value;
}

function __classifyAuthForRequest(data, res, fallback, requiresAuth) {
  if (!requiresAuth) return 'AUTH_NOT_REQUIRED';
  const hasAuth = __hasAnyAuth(data, fallback);
  if (!hasAuth) return 'AUTH_MISSING';
  if (res && (res.status === 401 || res.status === 403)) return 'AUTH_REJECTED_BY_SERVER';
  return 'AUTH_PRESENT';
}

function __defaultTags(extra) {
  // Phase 6: workload_profile is attached to every emitted request so
  // reports can slice by profile. api_name / api_method / api_path /
  // folder / request_id (Phase 3 identity tags) still come from the
  // per-request \`extra\` map.
  const base = { collection: COLLECTION_NAME, workload_profile: WORKLOAD_PROFILE };
  if (extra && typeof extra === 'object') {
    for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) base[k] = extra[k];
  }
  return base;
}

// Semantic response classifier — see responseClassifier.js for the contract
// and unit tests. k6 error_code 1400+ indicates HTTP status errors (4xx/5xx),
// not transport failures.
${require('./responseClassifier').RESPONSE_CLASSIFIER_JS.trim()}

// Pacing is a scenario-level concern, not a per-request one. This helper
// respects PACING_MS (default 1000ms — matches the historical sleep(1)
// behaviour) and disables the sleep when PACING_MS is 0, which is the
// preferred setting for throughput / stress scenarios where you want K6
// to iterate as fast as the target can respond.
function __pace() {
  if (PACING_MS > 0) sleep(PACING_MS / 1000);
}

function __captureResponseVars(res, data, rules) {
  if (!res || !Array.isArray(rules) || rules.length === 0) return;
  const state = __getAuthState(data);
  if (!state.vars) state.vars = {};
  let body = null;
  try { body = res.json(); } catch (e) { body = null; }
  for (const rule of rules) {
    if (!rule || !rule.varName || !Array.isArray(rule.path)) continue;
    let value = body;
    for (const segment of rule.path) {
      if (value == null || typeof value !== 'object') { value = null; break; }
      value = value[segment];
    }
    if (typeof value === 'string' && value.length > 0) state.vars[rule.varName] = value;
  }
}
`;

/**
 * Emit a single labelled section banner. The section number + title makes
 * the emitted script scannable and, crucially, gives external tooling
 * (linters, diff bots, this project's golden tests) stable anchor points.
 */
function sectionBanner(n, title) {
  const num = String(n).padStart(2, '0');
  return `// === Section ${num}: ${title} ` + '='.repeat(Math.max(3, 60 - title.length));
}

/**
 * Phase 2 centralization: both helper blocks (RUNTIME_HELPERS and
 * ENV_ONLY_HELPERS) share the exact same __normalizeBearer /
 * __hasUnresolvedPlaceholder / __manualOverrideLogged definitions. Keeping
 * them in a single JS string constant means the emitted script has one
 * canonical bearer-normalization implementation regardless of whether auth
 * chaining is on. The manual-override branch (with its safety guards) is
 * also defined once here and inlined verbatim into both resolvers.
 *
 * Safety guards enforced HERE — do not remove without updating the
 * corresponding plan-time helper in apps/api/src/utils/authHeader.js:
 *   - Bearer Bearer ...        → collapsed to a single "Bearer" by __normalizeBearer
 *   - Bearer undefined         → __normalizeBearer('undefined') returns ''
 *   - Bearer null              → __normalizeBearer('null') returns ''
 *   - Bearer {{token}}         → manual branch skipped when value contains {{..}}
 *   - Bearer  (lone scheme)    → __normalizeBearer('Bearer') returns ''
 *   - Authorization dup        → buildHeadersBlock drops secondary Authorization
 *                                headers before this resolver ever runs.
 */
const SHARED_BEARER_HELPERS_JS = `
function __authHeader(value) {
  return value ? { Authorization: value } : {};
}

function __normalizeBearer(token) {
  if (!token || typeof token !== 'string') return '';
  let t = token.replace(/^\\s+|\\s+$/g, '');
  // Reject the string forms of undefined / null before AND after any
  // Bearer prefix strip. Prevents leaking a literal Bearer &lt;undefined&gt; on
  // the wire when the caller stringified a JS undefined into env.
  if (t === 'undefined' || t === 'null') return '';
  while (/^Bearer\\b\\s*/i.test(t)) {
    const next = t.replace(/^Bearer\\b\\s*/i, '').replace(/^\\s+/, '');
    if (next === t) break;
    t = next;
  }
  if (t === 'undefined' || t === 'null') return '';
  return t;
}

// Detect a still-unresolved Postman placeholder in a string. We only treat a
// fallback as "usable" when it doesn't carry a {{var}} we couldn't resolve —
// otherwise we would emit a literal Authorization: Bearer {{global_auth_token}}
// to the wire, which always 401s. We use indexOf rather than a regex literal
// so this helper is trivially analyzable by external tools.
function __hasUnresolvedPlaceholder(s) {
  if (typeof s !== 'string') return false;
  const a = s.indexOf('{{');
  if (a < 0) return false;
  const b = s.indexOf('}}', a + 2);
  return b > a;
}

let __manualOverrideLogged = false;
`;

/**
 * Emit-time inline: the manual-override branch shared by
 * __resolveAuthHeader and __resolveAuthHeaderEnv. Guards the branch against
 * every unsafe manual value (unresolved placeholder, "undefined"/"null",
 * whitespace-only, lone "Bearer"). Falls through to the caller's own
 * runtime / fallback logic when the manual value is unsafe.
 */
const MANUAL_OVERRIDE_BRANCH_JS = `
  if (__ENV.AUTH_TOKEN) {
    // Phase 2 safety guards: skip the manual branch when the user-typed
    // value is unsafe (unresolved placeholder, or normalizes to empty
    // because it's "undefined" / "null" / lone "Bearer" / Bearer-only
    // whitespace). We fall through to the runtime / collection fallback
    // in that case instead of emitting a bogus Authorization header.
    if (!__hasUnresolvedPlaceholder(__ENV.AUTH_TOKEN)) {
      const __manualStripped = __normalizeBearer(__ENV.AUTH_TOKEN);
      if (__manualStripped) {
        if (!__manualOverrideLogged) {
          __manualOverrideLogged = true;
          console.log('[auth] manual token override active');
          console.log('[auth] using manual Authorization header');
          console.log('[auth] skipping env token resolution');
          console.log('[auth] resolved Authorization from manual override');
        }
        if (placeholder) {
          console.log('[auth] placeholder replaced: {{' + placeholder + '}}');
        }
        return 'Bearer ' + __manualStripped;
      }
    }
  }
`;

/**
 * The runtime helpers we emit at the top of the generated script. These run
 * inside the K6 VM and implement the capture / replay logic without ever
 * embedding a literal token. Kept stringified so the generator stays a pure
 * file producer (no eval, no template engine).
 */
const RUNTIME_HELPERS = `
// ---- RUNTIME AUTH STATE ----------------------------------------------------
// Mirrors Postman's pm.environment / pm.collectionVariables mutation behavior.
// setup() builds this object once. Every iteration receives it via the data
// argument and reads from it without re-running the login request.
//
//   data = {
//     AUTH_TOKEN, ACCESS_TOKEN, JWT, ID_TOKEN, SESSION_ID,  // captured tokens
//     cookies: [{ name, value }],                            // Set-Cookie capture
//     vars: { [name]: value },                               // pm.environment.set captures
//   }
//
// Resolution priority is enforced HERE, not just in the interpolator:
//   1. __ENV.AUTH_TOKEN      (manual UI override — locked, wins always)
//   2. data.* (runtime-extracted tokens captured by setup())
//   3. fallback (the original collection-defined Authorization value, with
//      any {{var}} placeholders already resolved against __ENV)
//   4. '' (empty fallback)
//
// __normalizeBearer() is defensive: even if a user pastes "Bearer xyz" or
// "Bearer Bearer xyz", the Authorization header always ends up as exactly
// "Bearer xyz". This is the SAME logic the non-runtime path uses below —
// both share SHARED_BEARER_HELPERS_JS at generation time.
${SHARED_BEARER_HELPERS_JS}

/**
 * Single chokepoint for every Authorization header emitted by the script.
 * Priority order:
 *   1) Manual UI token (__ENV.AUTH_TOKEN)
 *   2) Runtime-extracted tokens captured by setup() (data.*)
 *   3) Whatever the collection put in the Authorization header originally
 * Independent of the placeholder name in the original collection.
 *
 * @param data        runtime state from setup()
 * @param fallback    interpolated header value (with placeholders already
 *                    rendered via __ENV)
 * @param placeholder OPTIONAL: the literal placeholder name from the
 *                    collection (e.g. "jwt_token") — used only for safe,
 *                    name-only debug logging.
 */
function __resolveAuthHeader(data, fallback, placeholder) {
  const state = __getAuthState(data);
  // 1) Manual UI override beats everything, regardless of which placeholder
  // the collection used (jwt_token, global_auth_token, access_token, …).
${MANUAL_OVERRIDE_BRANCH_JS}
  // 2) Runtime-extracted tokens cascade through the captured slots.
  const runtime =
    state.AUTH_TOKEN || state.ACCESS_TOKEN || state.JWT || state.ID_TOKEN || '';
  if (runtime) {
    const __runtimeStripped = __normalizeBearer(runtime);
    if (__runtimeStripped) {
      if (
        typeof fallback === 'string' &&
        fallback.length > 0 &&
        !/^\\s*Bearer\\b/i.test(fallback) &&
        !__hasUnresolvedPlaceholder(fallback)
      ) {
        return __runtimeStripped;
      }
      return 'Bearer ' + __runtimeStripped;
    }
  }
  // 3) Fall back to whatever the collection originally declared (already
  // template-interpolated). If it still has an unresolved placeholder, drop
  // it so the request fails loudly instead of leaking "Bearer {{xxx}}".
  if (typeof fallback === 'string' && fallback.length > 0) {
    if (__hasUnresolvedPlaceholder(fallback)) return '';
    // Re-normalize in case the collection variable carried "Bearer ".
    if (/^\\s*Bearer\\b/i.test(fallback)) {
      const stripped = __normalizeBearer(fallback);
      return stripped ? 'Bearer ' + stripped : '';
    }
    return fallback;
  }
  return '';
}

function __runtimeAuthHeader(data) {
  // Back-compat alias used by previously-generated scripts.
  return __resolveAuthHeader(data, '');
}

function __runtimeCookieHeader(data) {
  const state = __getAuthState(data);
  const cookies = Array.isArray(state.cookies) ? state.cookies : [];
  if (cookies.length === 0) return {};
  const value = cookies.map(c => c.name + '=' + c.value).join('; ');
  return { 'Cookie': value };
}

function __hasAnyAuth(data, fallback) {
  const state = __getAuthState(data);
  // "Any auth" means: either a safe manual token, or any runtime-captured
  // token. An unresolved-placeholder or "undefined"/"null" manual value
  // does NOT count as auth here, matching the resolver's own filtering.
  const manualSafe = !!(
    __ENV.AUTH_TOKEN &&
    !__hasUnresolvedPlaceholder(__ENV.AUTH_TOKEN) &&
    __normalizeBearer(__ENV.AUTH_TOKEN)
  );
  const runtime = state.AUTH_TOKEN || state.ACCESS_TOKEN || state.JWT || state.ID_TOKEN || '';
  const captured = state.vars && (
    state.vars.global_auth_token || state.vars.auth_token || state.vars.access_token ||
    state.vars.jwt_token || state.vars.token
  );
  const environment = __ENV.GLOBAL_AUTH_TOKEN || __ENV.ACCESS_TOKEN || __ENV.JWT_TOKEN || '';
  const fallbackSafe = typeof fallback === 'string' &&
    !__hasUnresolvedPlaceholder(fallback) &&
    __normalizeBearer(fallback);
  return !!(manualSafe || runtime || captured || environment || fallbackSafe);
}
// ---------------------------------------------------------------------------
`;

/**
 * Smaller helper block emitted when runtime auth chaining is OFF. We still
 * funnel every Authorization header through a single resolver so a manual
 * UI token (__ENV.AUTH_TOKEN) overrides whatever placeholder the collection
 * used — the requirement is independent of the auth-flow detection.
 */
const ENV_ONLY_HELPERS = `
// ---- AUTH HEADER RESOLVER (env-only) --------------------------------------
// Every Authorization header in this script is built via this function so a
// manual __ENV.AUTH_TOKEN from the UI takes priority over whatever variable
// name the collection happens to use ({{jwt_token}}, {{global_auth_token}},
// {{access_token}}, …). The fallback argument carries the original
// collection-defined value (already template-interpolated) so we don't lose
// existing behaviour for users who don't set a manual token.
${SHARED_BEARER_HELPERS_JS}

function __resolveAuthHeaderEnv(fallback, placeholder) {
${MANUAL_OVERRIDE_BRANCH_JS}
  if (typeof fallback === 'string' && fallback.length > 0) {
    if (__hasUnresolvedPlaceholder(fallback)) return '';
    if (/^\\s*Bearer\\b/i.test(fallback)) {
      const stripped = __normalizeBearer(fallback);
      return stripped ? 'Bearer ' + stripped : '';
    }
    return fallback;
  }
  return '';
}
// ---------------------------------------------------------------------------
`;

/**
 * Build the runtime extraction logic for setup(). Emitted as a string so the
 * generator remains deterministic (no template engine).
 */
function buildSetupBlock({ login, interp, authFlow }) {
  const url = `\`${interp.asTemplate(login.url)}\``;
  const headersBlock = buildHeadersBlock(login.headers || [], {
    injectAuthToken: false,
    interp,
    runtimeEnabled: false, // login itself never reads from the runtime
  });
  const params = `{\n${headersBlock}\n  }`;
  const bodyExpr = buildBodyExpression(login.body, { interp, redactCredentials: true });
  const verb = methodCall(login.method) || 'request';

  let call;
  if (verb !== 'request' && verb !== 'get' && verb !== 'head' && verb !== 'options' && bodyExpr) {
    call = `  const res = http.${verb}(\n    ${url},\n    ${bodyExpr},\n    ${params}\n  );`;
  } else if (verb !== 'request' && (verb === 'get' || verb === 'head' || verb === 'options' || !bodyExpr)) {
    call = `  const res = http.${verb}(\n    ${url},\n    ${params}\n  );`;
  } else {
    call = `  const res = http.request(\n    "${login.method}",\n    ${url},\n    ${
      bodyExpr || 'null'
    },\n    ${params}\n  );`;
  }

  const tokenKeysJs = JSON.stringify(authFlow.tokenKeys || []);
  const sessionKeysJs = JSON.stringify(authFlow.sessionKeys || []);
  const tokenHeadersJs = JSON.stringify(authFlow.tokenHeaders || []);
  const sessionHeadersJs = JSON.stringify(authFlow.sessionHeaders || []);
  const captureRulesJs = JSON.stringify(authFlow.captureRules || []);

  return [
    `// ---- AUTH FLOW ---------------------------------------------------`,
    `// Runs ONCE before any VU iteration. Calls the detected login API,`,
    `// captures tokens / session ids / cookies from the response, and`,
    `// returns a runtime state object every iteration reads from.`,
    `export function setup() {`,
    `  const tokenKeys = ${tokenKeysJs};`,
    `  const sessionKeys = ${sessionKeysJs};`,
    `  const tokenHeaders = ${tokenHeadersJs};`,
    `  const sessionHeaders = ${sessionHeadersJs};`,
    `  const captureRules = ${captureRulesJs};`,
    `  console.log('[auth] login -> ${escapeJsonInDouble(login.method + ' ' + login.url)}');`,
    call,
    `  const state = {`,
    `    AUTH_TOKEN: '', ACCESS_TOKEN: '', JWT: '', ID_TOKEN: '', SESSION_ID: '',`,
    `    cookies: [], vars: {},`,
    `  };`,
    `  if (res.status < 200 || res.status >= 300) {`,
    `    console.warn('[auth] login failed: status=' + res.status + ' (manual __ENV fallback active)');`,
    `    return state;`,
    `  }`,
    `  let body = null;`,
    `  try { body = res.json(); } catch (e) { body = null; }`,
    ``,
    `  // Recursive deep walker over the response body. Returns the first`,
    `  // string value matching one of the requested keys. Wrapper objects`,
    `  // are walked breadth-first so shallow matches still win.`,
    `  function deepFind(obj, keys, depth) {`,
    `    if (!obj || typeof obj !== 'object' || depth > 8) return null;`,
    `    for (const k of keys) {`,
    `      if (typeof obj[k] === 'string' && obj[k].length > 0) return obj[k];`,
    `    }`,
    `    for (const v of Object.values(obj)) {`,
    `      if (v && typeof v === 'object') {`,
    `        const t = deepFind(v, keys, depth + 1);`,
    `        if (t) return t;`,
    `      }`,
    `    }`,
    `    return null;`,
    `  }`,
    ``,
    `  // Resolve a dotted path like ['data', 'access_token'] against an obj.`,
    `  function resolvePath(obj, path) {`,
    `    if (!obj || !Array.isArray(path)) return null;`,
    `    let cur = obj;`,
    `    for (const seg of path) {`,
    `      if (cur == null || typeof cur !== 'object') return null;`,
    `      cur = cur[seg];`,
    `    }`,
    `    return typeof cur === 'string' ? cur : null;`,
    `  }`,
    ``,
    `  // 1) Honor explicit pm.environment.set(...) capture statements first.`,
    `  for (const rule of captureRules) {`,
    `    if (rule.path && rule.varName) {`,
    `      const v = resolvePath(body, rule.path);`,
    `      if (v) state.vars[rule.varName] = v;`,
    `    }`,
    `    if (rule.headerName) {`,
    `      const hdr = (res.headers || {})[rule.headerName] || (res.headers || {})[rule.headerName.toLowerCase()];`,
    `      if (typeof hdr === 'string' && hdr.length > 0) state.vars[rule.varName || rule.headerName] = hdr;`,
    `    }`,
    `  }`,
    ``,
    `  // 1b) Promote captured token-shaped vars (global_auth_token, jwt_token, …)`,
    `  // into runtime auth slots so __resolveAuthHeader works even when the`,
    `  // collection uses a non-standard Postman variable name.`,
    `  if (!state.AUTH_TOKEN) {`,
    `    const promoted =`,
    `      state.vars.global_auth_token || state.vars.auth_token || state.vars.jwt_token ||`,
    `      state.vars.access_token || state.vars.token || state.vars.custom_token ||`,
    `      state.vars.custom_jwt_token || state.vars.myAccessToken || '';`,
    `    if (promoted) state.AUTH_TOKEN = String(promoted).replace(/^\\s*Bearer\\s+/i, '').trim();`,
    `  }`,
    ``,
    `  // 2) Generic body scan is only a fallback when no explicit capture path exists.`,
    `  if (!captureRules.some(rule => Array.isArray(rule.path) && rule.path.length > 0)) {`,
    `    state.AUTH_TOKEN   = deepFind(body, ['token','authToken','auth_token'], 0) || '';`,
    `    state.ACCESS_TOKEN = deepFind(body, ['access_token','accessToken'], 0) || '';`,
    `    state.JWT          = deepFind(body, ['jwt','jwtToken','jwt_token'], 0) || '';`,
    `    state.ID_TOKEN     = deepFind(body, ['id_token','idToken'], 0) || '';`,
    `  }`,
    `  state.SESSION_ID   = deepFind(body, sessionKeys, 0) || '';`,
    ``,
    `  // 3) Header scan for token / session id when body had nothing.`,
    `  const headers = res.headers || {};`,
    `  function headerVal(name) {`,
    `    const exact = headers[name];`,
    `    if (typeof exact === 'string') return exact;`,
    `    for (const k of Object.keys(headers)) {`,
    `      if (k.toLowerCase() === name.toLowerCase()) return String(headers[k] || '');`,
    `    }`,
    `    return '';`,
    `  }`,
    `  if (!state.AUTH_TOKEN && !state.ACCESS_TOKEN && !state.JWT && !state.ID_TOKEN) {`,
    `    for (const h of tokenHeaders) {`,
    `      const v = headerVal(h);`,
    `      if (v) {`,
    `        const cleaned = v.replace(/^\\s*Bearer\\s+/i, '').trim();`,
    `        if (cleaned) { state.AUTH_TOKEN = cleaned; break; }`,
    `      }`,
    `    }`,
    `  }`,
    `  if (!state.SESSION_ID) {`,
    `    for (const h of sessionHeaders) {`,
    `      const v = headerVal(h);`,
    `      if (v) { state.SESSION_ID = v.trim(); break; }`,
    `    }`,
    `  }`,
    ``,
    `  // 4) Capture Set-Cookie pairs so iterations can replay them.`,
    `  function parseSetCookie(setCookie) {`,
    `    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];`,
    `    const out = [];`,
    `    for (const raw of arr) {`,
    `      if (typeof raw !== 'string' || raw.length === 0) continue;`,
    `      const first = raw.split(';')[0];`,
    `      const eq = first.indexOf('=');`,
    `      if (eq <= 0) continue;`,
    `      const name = first.slice(0, eq).trim();`,
    `      const value = first.slice(eq + 1).trim();`,
    `      if (name) out.push({ name, value });`,
    `    }`,
    `    return out;`,
    `  }`,
    `  // K6 normalizes Set-Cookie under a couple of header keys.`,
    `  const sc = headerVal('Set-Cookie') || headerVal('set-cookie');`,
    `  if (sc) state.cookies = parseSetCookie(sc);`,
    ``,
    `  // 5) Strip a stray "Bearer " prefix if the API embedded it in the value.`,
    `  for (const k of ['AUTH_TOKEN','ACCESS_TOKEN','JWT','ID_TOKEN']) {`,
    `    if (state[k]) state[k] = String(state[k]).replace(/^\\s*Bearer\\s+/i, '').trim();`,
    `  }`,
    ``,
    `  const captured = ['AUTH_TOKEN','ACCESS_TOKEN','JWT','ID_TOKEN','SESSION_ID']`,
    `    .filter(k => state[k]).map(k => k + '(' + state[k].length + ')');`,
    `  console.log('[auth] runtime state: ' + (captured.join(', ') || 'EMPTY -- manual __ENV fallback active') +`,
    `    (state.cookies.length ? ', cookies=' + state.cookies.length : ''));`,
    `  return state;`,
    `}`,
    `// ------------------------------------------------------------------`,
    ``,
  ].join('\n');
}

/**
 * @param {ReturnType<import('../postman/parser').parse>} parsed
 * @param {object} options
 * @param {boolean} [options.injectAuthToken]
 * @param {object} [options.loadProfile]
 * @param {object} [options.authFlow]   buildAuthFlow() output
 */
function generateK6Script(parsed, options = {}) {
  const { injectAuthToken = false } = options;
  // Phase 6: workload profile is the authoritative source for scenarios,
  // executor, and thresholds. If the caller supplied a legacy loadProfile
  // it is routed into the 'custom' profile by normalizeWorkload so the
  // pre-Phase-6 shape keeps working byte-for-byte.
  const {
    normalizeWorkload,
  } = require('./workloadProfiles');
  const workload =
    options.workload && typeof options.workload === 'object'
      ? normalizeWorkload(options.workload)
      : normalizeWorkload(options.loadProfile || null);
  const profile = workload.loadProfile;
  const authFlow = options.authFlow || { enabled: false };
  const authSessionMode =
    options.authSessionMode || workload.authSessionMode || null;
  const credentialReuse =
    options.credentialReuse ?? workload.credentialReuse ?? false;
  const runtimeEnabled = !!authFlow.enabled;
  const perVuMode = authSessionMode === 'PER_VU_LOGIN' && runtimeEnabled;
  const stateRef = perVuMode ? '__getAuthState(data)' : 'data';
  const tokenReroute = new Set(authFlow.tokenRerouteNames || Array.from(TOKEN_REROUTE_DEFAULT));
  const capturedVarNames = new Set(
    [
      ...(authFlow.captureRules || []),
      ...(authFlow.requestCaptureRules || []).flatMap((entry) => entry.rules || []),
    ]
      .map((r) => (r && r.varName ? r.varName : null))
      .filter(Boolean)
  );

  const interp = makeInterpolator({
    tokenReroute,
    runtimeEnabled,
    capturedVarNames,
    stateRef,
  });
  const credentialInterp = makeInterpolator({
    tokenReroute,
    runtimeEnabled: false,
    capturedVarNames,
    perVuCredentials: true,
  });

  const vars = collectVarSet(parsed);
  const collectionHasAuthHeader = parsed.requests.some((r) =>
    (r.headers || []).some(
      (h) => typeof h?.key === 'string' && h.key.toLowerCase() === 'authorization'
    )
  );
  const authStrategy = deriveAuthStrategy({
    runtimeEnabled,
    injectAuthToken,
    collectionHasAuthHeader,
    authSessionMode,
  });

  const totalRequests = parsed.requests.length;
  const timeoutRequests = parsed.requests.map((r, i) => ({
    ...r,
    requestId: makeRequestId(i, totalRequests),
  }));
  const timeoutBundle = buildTimeoutCodegen(
    timeoutRequests,
    options.requestTimeout || options.requestTimeoutDefault
  );
  const scenariosForEmit = JSON.parse(JSON.stringify(workload.scenarios));
  for (const scenario of Object.values(scenariosForEmit)) {
    if (scenario && typeof scenario === 'object') {
      scenario.gracefulStop = timeoutBundle.metadata.gracefulStop;
    }
  }

  // -------------------------------------------------------------------------
  // Standardized section builders. Every generated script follows the same
  // 14-section layout regardless of collection shape. Section banners are
  // emitted even for sections whose content is embedded elsewhere (checks,
  // pacing) so external tooling can locate them by anchor.
  // -------------------------------------------------------------------------

  const header = [
    `// Auto-generated by Performance Agent (deterministic)`,
    `// Collection:    ${parsed.name}`,
    `// Generated:     ${new Date().toISOString()}`,
    `// Requests:      ${parsed.requests.length}`,
    `// Auth strategy: ${authStrategy}`,
    authSessionMode ? `// Auth session:  ${authSessionMode}` : '',
    `// Workload:      ${workload.profile} (executor: ${workload.executor}, vus: ${workload.vus}, hold: ${workload.hold})`,
    `// Timeout:       default ${timeoutBundle.metadata.defaultTimeout} (documented ${DEFAULT_REQUEST_TIMEOUT}); gracefulStop ${timeoutBundle.metadata.gracefulStop}`,
    runtimeEnabled
      ? `// Auth flow:     login=${authFlow.loginRequest?.method || ''} ${
          authFlow.loginRequest?.url || ''
        } -> token injected into ${authFlow.injectionCount || 0} request(s)`
      : `// Auth flow:     none detected`,
    `//`,
    `// All variables are read from K6 environment via __ENV. Pass them at runtime:`,
    `//   k6 run -e BASE_URL=https://api.example.com -e AUTH_TOKEN=xxxxx script.js`,
    `// Auth tokens are NEVER hardcoded.`,
    ``,
  ]
    .filter(Boolean)
    .join('\n');

  // ── Section 01: Imports ─────────────────────────────────────────────────
  const importsBlock = [
    `import http from 'k6/http';`,
    `import { check, group, sleep } from 'k6';`,
    `import { Counter } from 'k6/metrics';`,
  ].join('\n');

  // ── Section 02: Constants and Config ────────────────────────────────────
  // Config is env-driven at run time so a single generated script covers
  // dev / staging / prod without regeneration. Request timeouts follow the
  // documented precedence chain (see requestTimeout.js); default is 120s.
  const constantsBlock = [
    `const COLLECTION_NAME = ${JSON.stringify(parsed.name)};`,
    `const AUTH_STRATEGY = ${JSON.stringify(authStrategy)};`,
    `const WORKLOAD_PROFILE = ${JSON.stringify(workload.profile)};`,
    `const WORKLOAD_EXECUTOR = ${JSON.stringify(workload.executor)};`,
    timeoutBundle.codegen,
    `const PACING_MS = (function () {`,
    `  const raw = __ENV.PACING_MS;`,
    `  if (raw == null || String(raw).trim() === '') return 1000;`,
    `  const n = Number(raw);`,
    `  return Number.isFinite(n) && n >= 0 ? n : 1000;`,
    `})();`,
  ].join('\n');

  // ── Sections 03 + 04: Load / Scenario config + Thresholds ────────────────
  // Phase 6: the generator no longer emits top-level `stages` — K6 rejects
  // scripts that carry both `stages` and `scenarios`. Every workload
  // profile is expressed as exactly one entry in `options.scenarios` and
  // shares the same default export. Threshold expressions are pulled from
  // the profile so an SLA-strict smoke and an SLA-lax spike aren't
  // measured against the same bar.
  const scenariosLiteral = JSON.stringify(scenariosForEmit, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  const optionsBlock = [
    `export const options = {`,
    `  // ── Section 03: Load / Scenario Configuration (profile=${workload.profile}, executor=${workload.executor}) ──`,
    `  scenarios: ${scenariosLiteral},`,
    `  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],`,
    `  // ── Section 04: Thresholds (profile=${workload.profile}) ──`,
    `  thresholds: {`,
    `    http_req_failed: ['rate<${workload.thresholds.errorRate}'],`,
    `    http_req_duration: ['p(95)<${workload.thresholds.p95Ms}'],`,
    `    perf_transport_failed: ['count==0'],`,
    `    perf_unexpected_status: ['count==0'],`,
    `  },`,
    `};`,
  ].join('\n');

  // ── Section 05: Summary Trend / Counter Metrics ──────────────────────────
  // Categorized failure counters. Report tooling can aggregate them by any
  // of the standard request tags (api_name / api_method / api_path /
  // folder / request_id).
  const metricsBlock = [
    `const __transportFailed = new Counter('perf_transport_failed');`,
    `const __unexpectedStatus = new Counter('perf_unexpected_status');`,
    `const __checksFailed = new Counter('perf_check_failed');`,
    `const __dependencySkipped = new Counter('perf_dependency_skipped');`,
  ].join('\n');

  // ── Section 06: Variable Resolution Helpers ──────────────────────────────
  // Variable resolution happens inline via the interpolator (see the
  // apps/api/src/lib/postman/variableResolver + generator interpolator).
  // Every Postman {{var}} is emitted as (__ENV.<NAME> || __ENV.AUTH_TOKEN
  // || '') so unresolved vars degrade to empty strings — never "undefined".
  const varSummary = vars.length
    ? [
        `// Expected env vars (resolved via __ENV at request time):`,
        ...vars.map((v) =>
          v.original.startsWith('$')
            ? `//   ${v.env}   (dynamic: ${v.original})`
            : `//   ${v.env}   (from {{${v.original}}})`
        ),
        injectAuthToken && !runtimeEnabled
          ? `//   AUTH_TOKEN  (injected as Bearer in missing Authorization headers)`
          : '',
        runtimeEnabled
          ? `//   AUTH_TOKEN  (extracted at runtime from login response; __ENV.AUTH_TOKEN is fallback)`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : `// No {{variables}} referenced by the selected requests.`;

  // ── Section 07: Authentication Helpers ──────────────────────────────────
  const runtimeHelpers = runtimeEnabled ? RUNTIME_HELPERS : '';
  const envOnlyHelpers =
    !runtimeEnabled && (injectAuthToken || collectionHasAuthHeader)
      ? ENV_ONLY_HELPERS
      : '';
  const authStateBlock = buildAuthStateAccessorBlock(authSessionMode, credentialReuse);

  const authHelpersBlock = [
    authStateBlock,
    '',
    runtimeHelpers || envOnlyHelpers ||
      `// No Authorization headers required by the selected requests.`,
    perVuMode
      ? buildEnsureVuLoginBlock({
          login: authFlow.loginRequest,
          interp: credentialInterp,
          authFlow,
          methodCall,
          buildHeadersBlock,
          buildBodyExpression,
        })
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  // ── Section 08: Setup ───────────────────────────────────────────────────
  const setupBlock = perVuMode
    ? `// PER_VU_LOGIN: login runs lazily per VU via __ensureVuLogin() — no shared setup().`
    : runtimeEnabled
      ? buildSetupBlock({
          login: authFlow.loginRequest,
          interp,
          authFlow,
        })
      : `// No setup() required for auth strategy ${authStrategy}.`;

  // ── Section 09: Request Execution Helpers ───────────────────────────────
  const requestHelpersBlock = [
    REQUEST_EXECUTION_HELPERS_JS,
    UNRESOLVED_SAFETY_RUNTIME_JS,
    DYNAMIC_VARIABLE_RUNTIME_JS,
    REQUEST_LOCAL_RUNTIME_JS,
    PREREQUEST_RUNTIME_JS,
  ].join('\n\n');

  // ── Section 10: Request Groups ──────────────────────────────────────────
  const injectSet = new Set(authFlow.injectionTargets || []);
  const { buildDependencyGraph } = require('../postman/dependencyGraph');
  const dependencyGraph = buildDependencyGraph(parsed, authFlow);
  // Filtered list preserves request order and drops the login request
  // when it's already handled in setup().
  const filteredWithIndex = parsed.requests
    .map((r, i) => ({ r, i, keep: !(runtimeEnabled && i === authFlow.loginRequestIndex) }))
    .filter((x) => x.keep);
  const emittedTotal = filteredWithIndex.length;
  const requestBlocks = filteredWithIndex
    .map(({ r, i }, emitIndex) => {
      const prerequestScript = (r.prerequests || []).join('\n');
      const prerequestAnalysis = analyzePrerequestScript(prerequestScript);
      const requestLocals = normalizeRequestVariables(r.requestVariables);
      const localSeed = buildRequestLocalSeed(r.requestVariables);
      const prerequestSets = new Set(prerequestAnalysis.setsEnvironment || []);
      const varAnalysis = analyzeRequestVariables(r, {
        capturedVars: capturedVarNames,
        requestLocals,
        prerequestSets,
      });
      const requestInterp = makeInterpolator({
        tokenReroute,
        runtimeEnabled,
        capturedVarNames,
        stateRef,
        requestIndex: emitIndex,
        requestLocals,
        prerequestSets,
      });
      const prerequestEmitted = emitPrerequestBlock(emitIndex, prerequestAnalysis, localSeed);
      return buildRequestBlock(
        r,
        { injectAuthToken, interp: requestInterp, runtimeEnabled },
        {
          injectsAuth: runtimeEnabled && injectSet.has(i),
          emitIndex,
          totalRequests: emittedTotal,
          captureRules: (authFlow.requestCaptureRules || []).find((entry) => entry.index === i)?.rules || [],
          dependencyDeps: dependencyGraph.perRequest[i] || [],
          interp: requestInterp,
          prerequestBlock: prerequestEmitted.block,
          varAnalysis,
        }
      );
    })
    .join('\n');

  // ── Section 13: Default Function ────────────────────────────────────────
  const main = [
    `export default function (data) {`,
    `  data = data || {};`,
    requestBlocks,
    `}`,
  ].join('\n');

  // ── Section 14: Mandatory summary sanitizer (+ optional custom line) ────
  //
  // Phase 6.6: every generated script now sinks the K6 end-of-test summary
  // through handleSummary so setup_data (which contains captured auth
  // tokens for runtime-auth scripts) is stripped BEFORE any on-disk
  // artifact is written.
  //
  // The API's worker-runner sets __ENV.PA_CLEAN_SUMMARY_PATH to a sibling
  // of the raw --summary-export path. handleSummary writes the scrubbed
  // JSON to that clean path; runs.manager then atomically swaps it over
  // the raw file before any parser touches it.
  //
  // SAFETY: this preserves every field parseRunArtifacts reads. The ONLY
  // intentional difference from k6's default output is the absence of
  // setup_data.
  const emitCustomStdout = options.customSummary === true;
  const summaryHookLines = [
    `export function handleSummary(data) {`,
    `  // Copy + strip setup_data. Everything else k6 gives us (options,`,
    `  // state, metrics, root_group) passes through unchanged so downstream`,
    `  // parsers see the same shape they always have.`,
    `  const clean = Object.assign({}, data);`,
    `  delete clean.setup_data;`,
    `  const out = {};`,
    `  if (typeof __ENV.PA_CLEAN_SUMMARY_PATH === 'string' && __ENV.PA_CLEAN_SUMMARY_PATH.length > 0) {`,
    `    out[__ENV.PA_CLEAN_SUMMARY_PATH] = JSON.stringify(clean);`,
    `  }`,
  ];
  if (emitCustomStdout) {
    summaryHookLines.push(
      `  // Optional caller-requested stdout summary line.`,
      `  const total = (data.metrics && data.metrics.http_reqs && data.metrics.http_reqs.count) || 0;`,
      `  const failed = (data.metrics && data.metrics.http_req_failed && data.metrics.http_req_failed.value) || 0;`,
      `  out.stdout = '[custom-summary] requests=' + total + ' fail_rate=' + failed + '\\n';`
    );
  }
  summaryHookLines.push(`  return out;`, `}`);
  const customSummaryBlock = summaryHookLines.join('\n');

  // -------------------------------------------------------------------------
  // Compose. The section banners give every generated script the same
  // scannable structure regardless of the input collection.
  // -------------------------------------------------------------------------
  return [
    header,
    sectionBanner(1, 'Imports'),
    importsBlock,
    '',
    sectionBanner(2, 'Constants and Config'),
    constantsBlock,
    '',
    sectionBanner(3, 'Load / Scenario Configuration'),
    sectionBanner(4, 'Thresholds'),
    optionsBlock,
    '',
    sectionBanner(5, 'Summary Trend / Counter Metrics'),
    metricsBlock,
    '',
    sectionBanner(6, 'Variable Resolution Helpers'),
    varSummary,
    '',
    sectionBanner(7, 'Authentication Helpers'),
    authHelpersBlock,
    '',
    sectionBanner(8, `Setup (auth strategy: ${authStrategy})`),
    setupBlock,
    '',
    sectionBanner(9, 'Request Execution Helpers'),
    requestHelpersBlock,
    '',
    sectionBanner(10, `Request Groups (${emittedTotal} request(s))`),
    sectionBanner(11, 'Checks (embedded per-request)'),
    sectionBanner(12, 'Pacing (embedded per-request via __pace(); PACING_MS default 1000)'),
    sectionBanner(13, 'Default Function'),
    main,
    '',
    sectionBanner(14, 'Custom Summary Hook (opt-in)'),
    customSummaryBlock,
    '',
  ]
    .filter((s) => s != null)
    .join('\n');
}

module.exports = {
  generateK6Script,
  toEnvName,
  TOKEN_REROUTE_DEFAULT,
  AuthStrategy,
  deriveAuthStrategy,
  extractApiPath,
  makeRequestId,
  buildRequestTags,
  makeInterpolator,
  buildBodyExpression,
};
