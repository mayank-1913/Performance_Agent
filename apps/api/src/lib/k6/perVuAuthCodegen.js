'use strict';

function esc(str) {
  return String(str ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Emit __getAuthState and (for PER_VU_LOGIN) per-VU isolated login state.
 */
function buildAuthStateAccessorBlock(authSessionMode, credentialReuse) {
  const mode = authSessionMode || 'SHARED_SESSION';
  const reuse = credentialReuse ? 'true' : 'false';

  if (mode !== 'PER_VU_LOGIN') {
    return [
      `const AUTH_SESSION_MODE = ${JSON.stringify(mode)};`,
      `const PA_CREDENTIAL_REUSE = ${JSON.stringify(reuse)};`,
      `function __getAuthState(data) { return data || {}; }`,
    ].join('\n');
  }

  return [
    `const AUTH_SESSION_MODE = ${JSON.stringify(mode)};`,
    `const PA_CREDENTIAL_REUSE = ${JSON.stringify(reuse)};`,
    `// Per-VU isolated auth state. Module-level in K6 = one instance per VU.`,
    `let __vuState = null;`,
    ``,
    `function __getCredentialIndexForVu() {`,
    `  const count = Number(__ENV.PA_CREDENTIAL_COUNT || '0');`,
    `  if (!Number.isFinite(count) || count <= 0) return -1;`,
    `  const vuIdx = __VU - 1;`,
    `  const reuse = PA_CREDENTIAL_REUSE === 'true';`,
    `  if (!reuse && vuIdx >= count) return -1;`,
    `  return reuse ? vuIdx % count : vuIdx;`,
    `}`,
    ``,
    `function __getCredentialField(envName) {`,
    `  const idx = __getCredentialIndexForVu();`,
    `  if (idx < 0) return '';`,
    `  const key = 'PA_CRED_' + idx + '_' + envName;`,
    `  const v = __ENV[key];`,
    `  return v == null ? '' : String(v);`,
    `}`,
    ``,
    `function __resolveLoginField(envName) {`,
    `  const cred = __getCredentialField(envName);`,
    `  if (cred) return cred;`,
    `  const v = __ENV[envName];`,
    `  return v == null ? '' : String(v);`,
    `}`,
    ``,
    `function __getAuthState(data) {`,
    `  if (AUTH_SESSION_MODE !== 'PER_VU_LOGIN') return data || {};`,
    `  return __ensureVuLogin();`,
    `}`,
  ].join('\n');
}

/**
 * Build __ensureVuLogin() containing the login HTTP call and token extraction.
 * Only emitted for PER_VU_LOGIN mode.
 */
function buildEnsureVuLoginBlock({
  login,
  interp,
  authFlow,
  methodCall,
  buildHeadersBlock,
  buildBodyExpression,
}) {
  const url = `\`${interp.asTemplate(login.url)}\``;
  const headersBlock = buildHeadersBlock(login.headers || [], {
    injectAuthToken: false,
    interp,
    runtimeEnabled: false,
  });
  const params = `{\n${headersBlock}\n  }`;
  const bodyExpr = buildBodyExpression(login.body, {
    interp,
    redactCredentials: true,
  });
  const verb = methodCall(login.method) || 'request';

  let call;
  if (verb !== 'request' && verb !== 'get' && verb !== 'head' && verb !== 'options' && bodyExpr) {
    call = `  const res = http.${verb}(\n    ${url},\n    ${bodyExpr},\n    ${params}\n  );`;
  } else if (verb !== 'request' && (verb === 'get' || verb === 'head' || verb === 'options' || !bodyExpr)) {
    call = `  const res = http.${verb}(\n    ${url},\n    ${params}\n  );`;
  } else {
    call = `  const res = http.request(\n    "${login.method}",\n    ${url},\n    ${bodyExpr || 'null'},\n    ${params}\n  );`;
  }

  const captureRulesJs = JSON.stringify(authFlow.captureRules || []);

  return [
    `function __ensureVuLogin() {`,
    `  if (__vuState && __vuState.__loggedIn) return __vuState;`,
    `  const credIdx = __getCredentialIndexForVu();`,
    `  if (Number(__ENV.PA_CREDENTIAL_COUNT || '0') > 0 && credIdx < 0) {`,
    `    console.warn('[auth] VU ' + __VU + ' has no credential record (reuse=' + PA_CREDENTIAL_REUSE + ')');`,
    `    __vuState = { AUTH_TOKEN: '', ACCESS_TOKEN: '', JWT: '', ID_TOKEN: '', SESSION_ID: '', cookies: [], vars: {}, __loggedIn: true, __loginFailed: true };`,
    `    return __vuState;`,
    `  }`,
    `  const captureRules = ${captureRulesJs};`,
    `  console.log('[auth] VU ' + __VU + ' login -> ${esc(login.method + ' ' + login.url)}' + (credIdx >= 0 ? ' (credential #' + (credIdx + 1) + ')' : ''));`,
    call,
    `  const state = {`,
    `    AUTH_TOKEN: '', ACCESS_TOKEN: '', JWT: '', ID_TOKEN: '', SESSION_ID: '',`,
    `    cookies: [], vars: {}, __loggedIn: true, __loginFailed: false,`,
    `  };`,
    `  if (res.status < 200 || res.status >= 300) {`,
    `    console.warn('[auth] VU ' + __VU + ' login failed: status=' + res.status);`,
    `    state.__loginFailed = true;`,
    `    __vuState = state;`,
    `    return __vuState;`,
    `  }`,
    `  let body = null;`,
    `  try { body = res.json(); } catch (e) { body = null; }`,
    `  function deepFind(obj, keys, depth) {`,
    `    if (!obj || typeof obj !== 'object' || depth > 8) return null;`,
    `    for (const k of keys) { if (typeof obj[k] === 'string' && obj[k].length > 0) return obj[k]; }`,
    `    for (const v of Object.values(obj)) {`,
    `      if (v && typeof v === 'object') { const t = deepFind(v, keys, depth + 1); if (t) return t; }`,
    `    }`,
    `    return null;`,
    `  }`,
    `  function resolvePath(obj, path) {`,
    `    if (!obj || !Array.isArray(path)) return null;`,
    `    let cur = obj;`,
    `    for (const seg of path) { if (cur == null || typeof cur !== 'object') return null; cur = cur[seg]; }`,
    `    return typeof cur === 'string' ? cur : null;`,
    `  }`,
    `  for (const rule of captureRules) {`,
    `    if (rule.path && rule.varName) {`,
    `      const v = resolvePath(body, rule.path);`,
    `      if (v) state.vars[rule.varName] = v;`,
    `    }`,
    `  }`,
    `  if (!state.AUTH_TOKEN) {`,
    `    const promoted =`,
    `      state.vars.global_auth_token || state.vars.auth_token || state.vars.jwt_token ||`,
    `      state.vars.access_token || state.vars.token || state.vars.custom_token ||`,
    `      state.vars.custom_jwt_token || state.vars.myAccessToken || '';`,
    `    if (promoted) state.AUTH_TOKEN = String(promoted).replace(/^\\s*Bearer\\s+/i, '').trim();`,
    `  }`,
    `  if (!captureRules.some(rule => Array.isArray(rule.path) && rule.path.length > 0)) {`,
    `    state.AUTH_TOKEN   = deepFind(body, ['token','authToken','auth_token'], 0) || '';`,
    `    state.ACCESS_TOKEN = deepFind(body, ['access_token','accessToken'], 0) || '';`,
    `    state.JWT          = deepFind(body, ['jwt','jwtToken','jwt_token'], 0) || '';`,
    `    state.ID_TOKEN     = deepFind(body, ['id_token','idToken'], 0) || '';`,
    `  }`,
    `  for (const k of ['AUTH_TOKEN','ACCESS_TOKEN','JWT','ID_TOKEN']) {`,
    `    if (state[k]) state[k] = String(state[k]).replace(/^\\s*Bearer\\s+/i, '').trim();`,
    `  }`,
    `  const tokenLen = (state.AUTH_TOKEN || state.ACCESS_TOKEN || state.JWT || state.ID_TOKEN || '').length;`,
    `  console.log('[auth] VU ' + __VU + ' token captured (len=' + tokenLen + ')');`,
    `  __vuState = state;`,
    `  return __vuState;`,
    `}`,
  ].join('\n');
}

module.exports = {
  buildAuthStateAccessorBlock,
  buildEnsureVuLoginBlock,
};
