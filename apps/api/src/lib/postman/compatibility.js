'use strict';

/**
 * Phase 5 — Postman compatibility scanner.
 *
 * Inspects a raw Postman v2.1 collection + its parsed representation
 * (post-sanitizer, post-selection) and returns a structured compatibility
 * report the caller can surface to the user before generating a K6 script.
 *
 * Design rules:
 *   - Every warning is a plain data record — no throwing, no side effects.
 *   - Warnings carry enough context (feature id + request identity + human
 *     reason + severity) to display in the UI without the caller needing
 *     to re-parse anything.
 *   - The scanner is DETECT-ONLY. It never rewrites the parsed collection.
 *     If a feature is unsupported the scanner says so and the caller
 *     decides whether to block generation.
 *   - Severity taxonomy:
 *       'info'      the feature is present + supported (or an anodyne
 *                   note like "disabled variable observed"). Purely
 *                   informational; safe to ignore.
 *       'warn'      the feature is partially supported OR skipped. The
 *                   emitted K6 script will run but the behaviour may
 *                   differ from Postman's. Callers SHOULD surface these
 *                   to the user.
 *       'blocking'  the emitted K6 script would be semantically wrong
 *                   (empty request body, unsigned protected request,
 *                   uninterpretable binary payload…). Callers MUST refuse
 *                   to generate until the user acknowledges or removes
 *                   the offending request.
 *   - Rule of thumb — block only when execution would be unsafe OR
 *     meaningless. Everything else is a warn.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

/* ------------------------------------------------------------------ */
/*  Feature identifiers + severity                                     */
/* ------------------------------------------------------------------ */

const Severity = Object.freeze({
  INFO: 'info',
  WARN: 'warn',
  BLOCKING: 'blocking',
});

const F = Object.freeze({
  // Supported / positively detected features
  COLLECTION_VARIABLES:        'collection_variables',
  ENVIRONMENT_VARIABLES:       'environment_variables',
  NESTED_FOLDERS:              'nested_folders',
  INHERITED_AUTH:              'inherited_auth',
  QUERY_PARAMETERS:            'query_parameters',
  PATH_VARIABLES:              'path_variables',
  HEADERS:                     'headers',
  JSON_BODY:                   'json_body',
  RAW_BODY:                    'raw_body',
  URLENCODED_BODY:             'urlencoded_body',
  FORM_DATA_TEXT:              'form_data_text',
  COOKIES_STATIC:              'cookies_static',
  COOKIES_RUNTIME:             'cookies_runtime',
  GRAPHQL_BODY:                'graphql_body',
  RESPONSE_TOKEN_BODY:         'response_token_body',
  RESPONSE_TOKEN_HEADER:       'response_token_header',
  PM_ENVIRONMENT_SET:          'pm_environment_set',
  PM_COLLECTION_VARIABLES_SET: 'pm_collection_variables_set',
  DISABLED_VARIABLES:          'disabled_variables',
  CUSTOM_TOKEN_NAMES:          'custom_token_names',
  // Partial / unsupported features
  FORM_DATA_FILE:              'form_data_file',
  BINARY_BODY:                 'binary_body',
  FILE_BODY:                   'file_body',
  UNKNOWN_BODY_MODE:           'unknown_body_mode',
  DIGEST_AUTH:                 'digest_auth',
  OAUTH1_AUTH:                 'oauth1_auth',
  OAUTH2_AUTH:                 'oauth2_auth',
  AWS_SIGV4_AUTH:              'aws_sigv4_auth',
  HAWK_AUTH:                   'hawk_auth',
  NTLM_AUTH:                   'ntlm_auth',
  APIKEY_AUTH:                 'apikey_auth',
  BASIC_AUTH:                  'basic_auth',
  PRE_REQUEST_SCRIPT:          'pre_request_script',
  PRE_REQUEST_SCRIPT_SUPPORTED:'pre_request_script_supported',
  PRE_REQUEST_SCRIPT_UNSUPPORTED:'pre_request_script_unsupported',
  TEST_SCRIPT_CUSTOM:          'test_script_custom',
  PROTOCOL_PROFILE_BEHAVIOR:   'protocol_profile_behavior',
  DISABLED_HEADER:             'disabled_header',
  DISABLED_QUERY:              'disabled_query',
  DISABLED_FORM_FIELD:         'disabled_form_field',
  PATH_VARIABLE_UNRESOLVED:    'path_variable_unresolved',
  URL_MISSING:                 'url_missing',
  UNRESOLVED_VARIABLE_IN_URL:  'unresolved_variable_in_url',
});

/* ------------------------------------------------------------------ */
/*  Auth type descriptors                                              */
/* ------------------------------------------------------------------ */

// Auth types that the current runtime CAN'T sign correctly. When any of
// these are active on a request in the selection, generation is blocked.
const UNSUPPORTED_AUTH_TYPES = Object.freeze({
  awsv4:    { feature: F.AWS_SIGV4_AUTH, label: 'AWS Signature v4' },
  oauth1:   { feature: F.OAUTH1_AUTH,    label: 'OAuth 1.0' },
  hawk:     { feature: F.HAWK_AUTH,      label: 'Hawk' },
  ntlm:     { feature: F.NTLM_AUTH,      label: 'NTLM' },
  digest:   { feature: F.DIGEST_AUTH,    label: 'Digest' },
});

// Auth types the sanitizer + generator translate reliably. These are
// reported as `info` when detected.
const SUPPORTED_AUTH_TYPES = Object.freeze({
  bearer: { feature: 'bearer_auth', label: 'Bearer token' },
  basic:  { feature: F.BASIC_AUTH,  label: 'HTTP Basic' },
  apikey: { feature: F.APIKEY_AUTH, label: 'API key' },
  noauth: null,
});

// OAuth2 is a mixed bag — client-credentials flow is partially supported
// via the login-detection path, but implicit / auth-code / password
// grants require browser interaction. Emit a warning and let the user
// decide.
const OAUTH2_TYPE = { feature: F.OAUTH2_AUTH, label: 'OAuth 2.0' };

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function isNonEmptyArray(v) {
  return Array.isArray(v) && v.length > 0;
}

function collectionHasNestedFolders(items, depth = 0) {
  if (!Array.isArray(items)) return false;
  for (const it of items) {
    if (Array.isArray(it?.item)) {
      if (depth >= 1) return true; // folder inside folder
      if (collectionHasNestedFolders(it.item, depth + 1)) return true;
    }
  }
  return false;
}

function pushWarn(list, warning) {
  list.push({
    feature: warning.feature,
    severity: warning.severity,
    supported: warning.severity === Severity.INFO,
    reason: warning.reason,
    request: warning.request || null,
    detail: warning.detail || null,
  });
}

function requestIdentity(req, index) {
  if (!req) return null;
  return {
    index: typeof index === 'number' ? index : null,
    name: req.name || '',
    method: req.method || '',
    url: req.url || '',
    folderPath: Array.isArray(req.folderPath) ? req.folderPath.slice() : [],
  };
}

function findMatchingRawItem(rawItems, name) {
  if (!Array.isArray(rawItems) || !name) return null;
  for (const it of rawItems) {
    if (it && it.name === name && it.request) return it;
    if (Array.isArray(it?.item)) {
      const nested = findMatchingRawItem(it.item, name);
      if (nested) return nested;
    }
  }
  return null;
}

function referencedVarNames(str) {
  if (typeof str !== 'string' || !str) return [];
  const out = [];
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(str)) !== null) out.push(m[1].trim());
  return out;
}

/* ------------------------------------------------------------------ */
/*  Per-feature detectors                                              */
/* ------------------------------------------------------------------ */

function scanCollectionLevel({ rawCollection, parsed, warnings, supported }) {
  // Collection variables
  if (isNonEmptyArray(rawCollection?.variable)) {
    supported.add(F.COLLECTION_VARIABLES);
    for (const v of rawCollection.variable) {
      if (v && v.disabled === true) {
        pushWarn(warnings, {
          feature: F.DISABLED_VARIABLES,
          severity: Severity.INFO,
          reason: `Collection variable "${v.key}" is disabled and will not be forwarded.`,
        });
      }
    }
  }

  // Nested folders
  if (collectionHasNestedFolders(rawCollection?.item)) {
    supported.add(F.NESTED_FOLDERS);
  }

  // Collection-level auth (inherited by children without their own auth)
  if (rawCollection?.auth && rawCollection.auth.type) {
    supported.add(F.INHERITED_AUTH);
    const type = String(rawCollection.auth.type).toLowerCase();
    if (UNSUPPORTED_AUTH_TYPES[type]) {
      const desc = UNSUPPORTED_AUTH_TYPES[type];
      pushWarn(warnings, {
        feature: desc.feature,
        severity: Severity.BLOCKING,
        reason: `Collection-level auth uses ${desc.label}, which cannot be signed by the K6 runtime.`,
        detail: { authType: type, scope: 'collection' },
      });
    } else if (type === 'oauth2') {
      pushWarn(warnings, {
        feature: OAUTH2_TYPE.feature,
        severity: Severity.WARN,
        reason: 'Collection-level auth uses OAuth 2.0. Only the client-credentials / password grant is translated via the login-detection path; interactive grants (implicit, authorization-code, PKCE) will not be executed.',
        detail: { authType: type, scope: 'collection' },
      });
    }
  }

  // protocolProfileBehavior — Postman-specific runtime toggles the K6
  // runtime doesn't model (disableBodyPruning, followRedirects, etc.)
  if (
    rawCollection?.protocolProfileBehavior &&
    typeof rawCollection.protocolProfileBehavior === 'object' &&
    Object.keys(rawCollection.protocolProfileBehavior).length > 0
  ) {
    pushWarn(warnings, {
      feature: F.PROTOCOL_PROFILE_BEHAVIOR,
      severity: Severity.INFO,
      reason: 'Collection declares protocolProfileBehavior overrides (Postman-specific). The K6 script uses its own defaults; these flags are ignored.',
      detail: Object.keys(rawCollection.protocolProfileBehavior),
    });
  }
}

function scanEnvironment({ rawEnvironment, warnings, supported }) {
  if (!rawEnvironment) return;
  if (isNonEmptyArray(rawEnvironment.values)) {
    supported.add(F.ENVIRONMENT_VARIABLES);
    for (const v of rawEnvironment.values) {
      if (v && v.enabled === false) {
        pushWarn(warnings, {
          feature: F.DISABLED_VARIABLES,
          severity: Severity.INFO,
          reason: `Environment variable "${v.key}" is disabled and will not be forwarded.`,
        });
      }
    }
  }
}

function scanRequestUrl({ req, index, rawRequest, warnings, supported }) {
  const url = req.url;
  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    pushWarn(warnings, {
      feature: F.URL_MISSING,
      severity: Severity.BLOCKING,
      reason: 'Request has no URL. K6 cannot execute an empty request.',
      request: requestIdentity(req, index),
    });
    return;
  }

  // Query parameters — detected when the raw URL object had a `query`
  // array with at least one enabled entry OR the raw string carries a "?".
  const rawUrl = rawRequest?.request?.url;
  const rawQuery = Array.isArray(rawUrl?.query) ? rawUrl.query : null;
  if (rawQuery && rawQuery.length > 0) {
    supported.add(F.QUERY_PARAMETERS);
    for (const q of rawQuery) {
      if (q && q.disabled === true) {
        pushWarn(warnings, {
          feature: F.DISABLED_QUERY,
          severity: Severity.INFO,
          reason: `Query parameter "${q.key}" on "${req.name}" is disabled; it will be omitted.`,
          request: requestIdentity(req, index),
        });
      }
    }
  } else if (url.includes('?')) {
    supported.add(F.QUERY_PARAMETERS);
  }

  // Path variables — Postman v2.1 declares them under url.variable[] and
  // references them as :name in the path. See parser.js for the
  // substitution logic.
  const rawPathVars = Array.isArray(rawUrl?.variable) ? rawUrl.variable : [];
  const declaredPathVarNames = rawPathVars
    .filter((v) => v && v.key)
    .map((v) => String(v.key));
  const referencedPathVarNames = Array.from(
    new Set(
      (String(url).match(/:([A-Za-z_][A-Za-z0-9_-]*)/g) || []).map((s) =>
        s.slice(1)
      )
    )
  );
  if (declaredPathVarNames.length > 0 || referencedPathVarNames.length > 0) {
    supported.add(F.PATH_VARIABLES);
  }
  for (const v of rawPathVars) {
    if (!v || !v.key) continue;
    const value = v.value == null ? '' : String(v.value);
    if (v.disabled === true) {
      pushWarn(warnings, {
        feature: F.DISABLED_VARIABLES,
        severity: Severity.INFO,
        reason: `Path variable ":${v.key}" on "${req.name}" is disabled.`,
        request: requestIdentity(req, index),
      });
    } else if (!value) {
      pushWarn(warnings, {
        feature: F.PATH_VARIABLE_UNRESOLVED,
        severity: Severity.WARN,
        reason: `Path variable ":${v.key}" on "${req.name}" has no value. The generated URL will fall back to __ENV.${envify(v.key)} at runtime.`,
        request: requestIdentity(req, index),
        detail: { pathVariable: v.key },
      });
    }
  }
  // A `:name` in the path that isn't declared under variable[] is a
  // dangling reference — K6 will send it verbatim to the wire.
  for (const name of referencedPathVarNames) {
    if (declaredPathVarNames.includes(name)) continue;
    pushWarn(warnings, {
      feature: F.PATH_VARIABLE_UNRESOLVED,
      severity: Severity.WARN,
      reason: `URL for "${req.name}" references ":${name}" but no matching path variable is declared. The generated URL will contain the literal ":${name}" fragment unless an env var overrides it.`,
      request: requestIdentity(req, index),
      detail: { pathVariable: name },
    });
  }
}

function envify(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function scanRequestHeaders({ req, index, rawRequest, warnings, supported }) {
  if (isNonEmptyArray(req.headers)) supported.add(F.HEADERS);
  const rawHeaders = Array.isArray(rawRequest?.request?.header)
    ? rawRequest.request.header
    : [];
  for (const h of rawHeaders) {
    if (h && h.disabled === true) {
      pushWarn(warnings, {
        feature: F.DISABLED_HEADER,
        severity: Severity.INFO,
        reason: `Header "${h.key}" on "${req.name}" is disabled; it will be omitted.`,
        request: requestIdentity(req, index),
      });
    }
  }
  // Static Cookie header vs runtime cookie replay
  for (const h of req.headers || []) {
    if (typeof h?.key === 'string' && h.key.toLowerCase() === 'cookie') {
      supported.add(F.COOKIES_STATIC);
    }
  }
}

function scanRequestBody({ req, index, rawRequest, warnings, supported }) {
  const rawBody = rawRequest?.request?.body || null;
  const body = req.body;
  if (!rawBody) return;
  const mode = String(rawBody.mode || '');
  switch (mode) {
    case 'raw': {
      supported.add(F.RAW_BODY);
      const lang = rawBody?.options?.raw?.language;
      if (lang && String(lang).toLowerCase() === 'json') {
        supported.add(F.JSON_BODY);
      } else if (typeof body?.raw === 'string' && body.raw.trim().startsWith('{')) {
        supported.add(F.JSON_BODY);
      }
      break;
    }
    case 'urlencoded':
      supported.add(F.URLENCODED_BODY);
      for (const p of rawBody.urlencoded || []) {
        if (p && p.disabled === true) {
          pushWarn(warnings, {
            feature: F.DISABLED_FORM_FIELD,
            severity: Severity.INFO,
            reason: `Body param "${p.key}" on "${req.name}" is disabled; it will be omitted.`,
            request: requestIdentity(req, index),
          });
        }
      }
      break;
    case 'formdata': {
      const entries = Array.isArray(rawBody.formdata) ? rawBody.formdata : [];
      const textEntries = entries.filter((p) => p && p.type !== 'file' && p.disabled !== true);
      const fileEntries = entries.filter((p) => p && p.type === 'file');
      if (textEntries.length > 0) supported.add(F.FORM_DATA_TEXT);
      for (const p of entries) {
        if (p && p.disabled === true) {
          pushWarn(warnings, {
            feature: F.DISABLED_FORM_FIELD,
            severity: Severity.INFO,
            reason: `Form-data field "${p.key}" on "${req.name}" is disabled; it will be omitted.`,
            request: requestIdentity(req, index),
          });
        }
      }
      if (fileEntries.length > 0) {
        const onlyFiles = textEntries.length === 0;
        const fileKeys = fileEntries.map((p) => p.key || '').join(', ');
        pushWarn(warnings, {
          feature: F.FORM_DATA_FILE,
          severity: onlyFiles ? Severity.BLOCKING : Severity.WARN,
          reason: onlyFiles
            ? `Form-data request "${req.name}" contains only file fields (${fileKeys}). File uploads are not translated to K6 — the generated request body would be empty, so the test is meaningless.`
            : `Form-data request "${req.name}" contains file fields (${fileKeys}). File uploads are omitted from the K6 script; only text fields are sent.`,
          request: requestIdentity(req, index),
          detail: { fileKeys: fileEntries.map((p) => p.key || '') },
        });
      }
      break;
    }
    case 'graphql':
      supported.add(F.GRAPHQL_BODY);
      break;
    case 'file':
      pushWarn(warnings, {
        feature: F.FILE_BODY,
        severity: Severity.BLOCKING,
        reason: `Request "${req.name}" uses a file body (mode="file"). The K6 script cannot include arbitrary local files — the request would be sent with an empty body.`,
        request: requestIdentity(req, index),
      });
      break;
    case 'binary':
      pushWarn(warnings, {
        feature: F.BINARY_BODY,
        severity: Severity.BLOCKING,
        reason: `Request "${req.name}" uses a binary body. Binary payloads are not translated to K6 — the request would be sent empty.`,
        request: requestIdentity(req, index),
      });
      break;
    default:
      if (mode) {
        pushWarn(warnings, {
          feature: F.UNKNOWN_BODY_MODE,
          severity: Severity.WARN,
          reason: `Request "${req.name}" uses an unrecognised body mode "${mode}". The body will be sent empty.`,
          request: requestIdentity(req, index),
          detail: { mode },
        });
      }
      break;
  }
}

function scanRequestAuth({ req, index, rawRequest, warnings, supported }) {
  const auth = rawRequest?.request?.auth || req.auth || null;
  if (!auth || !auth.type) return;
  const type = String(auth.type).toLowerCase();
  if (UNSUPPORTED_AUTH_TYPES[type]) {
    const desc = UNSUPPORTED_AUTH_TYPES[type];
    pushWarn(warnings, {
      feature: desc.feature,
      severity: Severity.BLOCKING,
      reason: `Request "${req.name}" uses ${desc.label} authentication. The K6 runtime cannot sign this request; running it would send an unsigned call that always fails.`,
      request: requestIdentity(req, index),
      detail: { authType: type },
    });
  } else if (type === 'oauth2') {
    pushWarn(warnings, {
      feature: OAUTH2_TYPE.feature,
      severity: Severity.WARN,
      reason: `Request "${req.name}" uses OAuth 2.0. Only the client-credentials / password grant is translated via the login-detection path; interactive grants require a manual token.`,
      request: requestIdentity(req, index),
      detail: { authType: type },
    });
  } else if (type === 'bearer') {
    supported.add('bearer_auth');
  } else if (type === 'basic') {
    supported.add(F.BASIC_AUTH);
  } else if (type === 'apikey') {
    supported.add(F.APIKEY_AUTH);
  }
}

function scanRequestScripts({ req, index, rawRequest, warnings, supported }) {
  const { analyzePrerequestScript } = require('./prerequestCodegen');
  const prerequests = Array.isArray(req.prerequests) ? req.prerequests : [];
  const tests = Array.isArray(req.tests) ? req.tests : [];
  const prerequestText = prerequests.filter((s) => typeof s === 'string' && s.trim().length > 0).join('\n');
  if (prerequestText.length > 0) {
    const analysis = analyzePrerequestScript(prerequestText);
    if (analysis.translatable) {
      supported.add(F.PRE_REQUEST_SCRIPT_SUPPORTED);
      pushWarn(warnings, {
        feature: F.PRE_REQUEST_SCRIPT_SUPPORTED,
        severity: Severity.INFO,
        reason: `Request "${req.name}" has a pre-request script that will be translated into safe K6 runtime operations (${analysis.k6Lines.length} statement(s)).`,
        request: requestIdentity(req, index),
      });
    } else {
      pushWarn(warnings, {
        feature: F.PRE_REQUEST_SCRIPT_UNSUPPORTED,
        severity: Severity.BLOCKING,
        reason:
          `Request "${req.name}" has an unsupported pre-request script. ` +
          (analysis.reason || 'Unsupported JavaScript in pre-request script') +
          (analysis.unsupported.length ? ` Unsupported: ${analysis.unsupported.slice(0, 3).join(' | ')}` : ''),
        request: requestIdentity(req, index),
      });
    }
  }
  // Test scripts: the auth-flow module already extracts pm.*.set calls.
  // Any OTHER logic in test scripts (custom assertions, chained requests
  // via pm.sendRequest, …) is skipped and reported as INFO.
  const scriptText = tests.join('\n');
  if (scriptText.length > 0) {
    const hasCapture = /pm\.(environment|collectionVariables|globals|variables)\.set/.test(scriptText);
    if (hasCapture) {
      supported.add(F.PM_ENVIRONMENT_SET);
      if (/pm\.collectionVariables\.set/.test(scriptText)) {
        supported.add(F.PM_COLLECTION_VARIABLES_SET);
      }
    }
    const nonCaptureNoise = scriptText
      .replace(/pm\.(environment|collectionVariables|globals|variables)\.set\s*\([^)]*\)\s*;?/g, '')
      .replace(/pm\.test\s*\([^)]*(?:\)[^{]*\{[\s\S]*?\}\s*\)|\)[^;]*;?)/g, '')
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
      .trim();
    if (nonCaptureNoise.length > 40) {
      pushWarn(warnings, {
        feature: F.TEST_SCRIPT_CUSTOM,
        severity: Severity.INFO,
        reason: `Request "${req.name}" has custom test-script logic beyond pm.*.set / pm.test calls. Only pm.*.set statements are honoured; the rest is skipped.`,
        request: requestIdentity(req, index),
      });
    }
  }
}

function scanUnresolvedVarsInUrl({ req, index, definedVars, envVars, warnings }) {
  if (!req.url) return;
  const referenced = Array.from(new Set(referencedVarNames(req.url)));
  for (const name of referenced) {
    if (definedVars.has(name) || envVars.has(name)) continue;
    // Not resolved by collection or environment. This is only an info
    // note here — the runtime can still receive it as a manual override
    // via /runs/prepare. Blocking would be too aggressive.
    pushWarn(warnings, {
      feature: F.UNRESOLVED_VARIABLE_IN_URL,
      severity: Severity.INFO,
      reason: `URL of "${req.name}" references {{${name}}}. No collection or environment value defines it; provide it via runtime override or expect an empty substitution at runtime.`,
      request: requestIdentity(req, index),
      detail: { variable: name },
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Public entry: scanCompatibility                                    */
/* ------------------------------------------------------------------ */

/**
 * @param {object} args
 * @param {object} args.rawCollection       Raw Postman v2.1 collection
 * @param {object} args.parsed              parser.parse() output (post-sanitizer, post-selection)
 * @param {object} [args.rawEnvironment]    Raw Postman environment export (optional)
 * @returns {{
 *   warnings: Array<{
 *     feature: string,
 *     severity: 'info'|'warn'|'blocking',
 *     supported: boolean,
 *     reason: string,
 *     request: object|null,
 *     detail: object|null,
 *   }>,
 *   supported: string[],
 *   hasBlocking: boolean,
 *   summary: { info: number, warn: number, blocking: number, total: number },
 * }}
 */
function scanCompatibility({ rawCollection, parsed, rawEnvironment = null } = {}) {
  const warnings = [];
  const supported = new Set();

  if (!rawCollection || !parsed) {
    return {
      warnings,
      supported: [],
      hasBlocking: false,
      summary: { info: 0, warn: 0, blocking: 0, total: 0 },
    };
  }

  scanCollectionLevel({ rawCollection, parsed, warnings, supported });
  scanEnvironment({ rawEnvironment, warnings, supported });

  // Precompute definition sets so URL/variable scanning is O(1) per lookup.
  const definedVars = new Set(Object.keys(parsed.definedVars || {}));
  const envVars = new Set(
    (rawEnvironment?.values || [])
      .filter((v) => v && v.enabled !== false && v.key)
      .map((v) => String(v.key))
  );

  // Custom token names: any referenced variable that includes token/jwt/
  // access/bearer but isn't one of the standard names is worth flagging as
  // "supported thanks to Phase 2's name-agnostic resolver".
  const stdTokenNames = new Set([
    'AUTH_TOKEN', 'JWT_TOKEN', 'JWT', 'ACCESS_TOKEN', 'ID_TOKEN', 'TOKEN', 'BEARER_TOKEN',
    'authToken', 'auth_token', 'accessToken', 'access_token', 'jwt', 'jwt_token',
    'jwtToken', 'idToken', 'id_token', 'token', 'bearerToken', 'bearer_token',
  ]);
  for (const v of parsed.referencedVars || []) {
    if (!/token|jwt|auth|bearer/i.test(v)) continue;
    if (!stdTokenNames.has(v)) {
      supported.add(F.CUSTOM_TOKEN_NAMES);
      break;
    }
  }

  // Per-request scans.
  const rawItems = rawCollection.item || [];
  parsed.requests.forEach((req, i) => {
    const rawRequest = findMatchingRawItem(rawItems, req.name);
    scanRequestUrl({ req, index: i, rawRequest, warnings, supported });
    scanRequestHeaders({ req, index: i, rawRequest, warnings, supported });
    scanRequestBody({ req, index: i, rawRequest, warnings, supported });
    scanRequestAuth({ req, index: i, rawRequest, warnings, supported });
    scanRequestScripts({ req, index: i, rawRequest, warnings, supported });
    scanUnresolvedVarsInUrl({ req, index: i, definedVars, envVars, warnings });
  });

  // Detect runtime cookie replay + response header/body token capture. These
  // are supported features surfaced by the login-detection path; we mark
  // them supported when the collection contains a plausible login POST.
  const hasLogin = parsed.requests.some((r) => {
    if (r.method !== 'POST') return false;
    return /\b(login|signin|sign-in|authenticate|oauth|token|auth\/login)\b/i.test(
      (r.url || '') + ' ' + (r.name || '')
    );
  });
  if (hasLogin) {
    supported.add(F.RESPONSE_TOKEN_BODY);
    supported.add(F.RESPONSE_TOKEN_HEADER);
    supported.add(F.COOKIES_RUNTIME);
  }

  const summary = warnings.reduce(
    (acc, w) => {
      acc[w.severity] = (acc[w.severity] || 0) + 1;
      acc.total += 1;
      return acc;
    },
    { info: 0, warn: 0, blocking: 0, total: 0 }
  );

  return {
    warnings,
    supported: Array.from(supported).sort(),
    hasBlocking: summary.blocking > 0,
    summary,
  };
}

module.exports = {
  scanCompatibility,
  Severity,
  Features: F,
  UNSUPPORTED_AUTH_TYPES,
  SUPPORTED_AUTH_TYPES,
};
