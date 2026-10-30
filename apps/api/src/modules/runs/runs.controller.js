'use strict';

const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const scriptsStore = require('../scripts/scripts.store');
const reportsStore = require('../reports/reports.store');
const collectionsStore = require('../collections/collections.store');
const environmentsStore = require('../environments/environments.store');
const { isAdmin, canSee } = require('../auth/ownership');

/**
 * Load a script by id and enforce visibility. USER can only reach their own
 * scripts; ADMIN sees everything. Throws 404 so cross-user access doesn't
 * reveal that an id exists.
 */
function getOwnedScript(req, scriptId) {
  const script = scriptsStore.get(scriptId);
  if (!script || !canSee(req, script)) {
    throw ApiError.notFound('Script not found');
  }
  return script;
}

/**
 * Load a run (live or persisted) and enforce visibility against its backing
 * script (for live runs) and persisted manifest ownerUserId.
 */
function getOwnedRun(req, runId) {
  const live = lifecycle.get(runId);
  if (live) {
    const script = live.scriptId ? scriptsStore.get(live.scriptId) : null;
    // The run manifest the dashboard displays is derived from the script,
    // so the script's owner is the authoritative owner for live runs.
    if (script && !canSee(req, script)) return { kind: 'notFound' };
    return { kind: 'live', ctx: live, script };
  }
  const persisted = reportsStore.get(runId);
  if (persisted) {
    if (!canSee(req, persisted)) return { kind: 'notFound' };
    return { kind: 'persisted', manifest: persisted };
  }
  return { kind: 'notFound' };
}
const { parse } = require('../../lib/postman/parser');
const { credentialSourceNames, extractLoginCredentialBindings } = require('../../lib/postman/loginCredentials');
const { toEnvName } = require('../../lib/k6/generator');
const { maskToken, normalizeBearer } = require('../../utils/secrets');
const {
  resolveVariables,
  publicResolution,
  extractCollectionVariables,
  extractEnvironmentVariables,
  isSecretName,
} = require('../../lib/postman/variableResolver');
const {
  resolveAuthorizationHeader,
  diagnose: diagnoseAuth,
} = require('../../utils/authHeader');
const {
  parseCredentialDataset,
  injectCredentialEnvVars,
  summarizeCredentialPlan,
  publicCredentialDataset,
} = require('../../lib/postman/credentialDataset');
const { lifecycle, getReport, getNormalizedReport } = require('./runs.manager');

function getAuthSessionConfig(script) {
  const lp = script?.loadProfile || {};
  return {
    authSessionMode: lp.authSessionMode || null,
    credentialReuse: !!lp.credentialReuse,
    vus: lp.vus || script?.workload?.vus || null,
  };
}

function applyCredentialDataset({ credentialDataset, credentialReuse }, script, cleanSecrets) {
  const authCfg = getAuthSessionConfig(script);
  const reuse =
    credentialReuse != null ? !!credentialReuse : authCfg.credentialReuse;
  if (credentialDataset) {
    const { records, errors } = parseCredentialDataset(credentialDataset);
    if (errors.length > 0) {
      throw ApiError.badRequest('Invalid credential dataset', {
        code: 'INVALID_CREDENTIAL_DATASET',
        details: { issues: errors },
      });
    }
    injectCredentialEnvVars(records, cleanSecrets);
    cleanSecrets.PA_CREDENTIAL_REUSE = reuse ? 'true' : 'false';
    return {
      records,
      plan: summarizeCredentialPlan({
        vus: authCfg.vus || 1,
        records,
        reuse,
        authSessionMode: authCfg.authSessionMode,
      }),
      publicDataset: publicCredentialDataset(records),
    };
  }
  if (authCfg.authSessionMode === 'PER_VU_LOGIN') {
    cleanSecrets.PA_CREDENTIAL_REUSE = reuse ? 'true' : 'false';
  }
  return {
    records: [],
    plan: summarizeCredentialPlan({
      vus: authCfg.vus || 1,
      records: [],
      reuse,
      authSessionMode: authCfg.authSessionMode,
    }),
    publicDataset: [],
  };
}

/**
 * Merge collection + environment values into the K6 spawn env at their
 * proper (lower-than-manual) precedence. Manual overrides in cleanEnv /
 * cleanSecrets are never touched. Values with token-shaped names (or
 * flagged secret by the resolver) go into `secrets` so envInjector will
 * still strip a Bearer prefix on AUTH_TOKEN / JWT_TOKEN. Everything else
 * goes into `env`. Returns metadata about what was backfilled so the
 * caller can trace decisions in logs (still without leaking values).
 */
function backfillFromResolver(resolution, cleanEnv, cleanSecrets) {
  const backfilledEnvKeys = [];
  const backfilledSecretKeys = [];
  if (!resolution || !resolution.values) {
    return { backfilledEnvKeys, backfilledSecretKeys };
  }
  const routeAsSecretRe = /^(AUTH_TOKEN|JWT_TOKEN)$/;
  for (const [envName, value] of Object.entries(resolution.values)) {
    if (resolution.sources[envName] === 'runtime') continue; // already in cleanEnv/cleanSecrets
    if (cleanEnv[envName] != null && String(cleanEnv[envName]).length > 0) continue;
    if (cleanSecrets[envName] != null && String(cleanSecrets[envName]).length > 0) continue;
    if (routeAsSecretRe.test(envName) || isSecretName(envName)) {
      cleanSecrets[envName] = String(value);
      backfilledSecretKeys.push(envName);
    } else {
      cleanEnv[envName] = String(value);
      backfilledEnvKeys.push(envName);
    }
  }
  return { backfilledEnvKeys, backfilledSecretKeys };
}

/**
 * Compute a resolver result for a given script + runtime payload. Returns
 * null if the script has no known collection (defensive; shouldn't happen
 * in normal flows).
 */
function resolveForScript(script, runtimeOverrides, runtimeSecretKeys) {
  if (!script) return null;
  const collection = script.collectionId ? collectionsStore.get(script.collectionId) : null;
  const environment = script.environmentId ? environmentsStore.get(script.environmentId) : null;
  return resolveVariables({
    collectionVariables: collection ? extractCollectionVariables(collection.raw) : null,
    environmentVariables: environment ? extractEnvironmentVariables(environment.raw) : null,
    runtimeOverrides: runtimeOverrides || null,
    referencedVars: script.expectedEnvVars || [],
    runtimeSecretKeys: runtimeSecretKeys || null,
  });
}

function sourceMap(values) {
  const out = new Map();
  for (const item of values || []) {
    if (!item || item.enabled === false || item.disabled === true || item.key == null) continue;
    if (item.value == null || String(item.value).length === 0) continue;
    out.set(toEnvName(item.key), String(item.value));
  }
  return out;
}

/** Resolve literal login credentials only for this spawn; never persist them. */
function injectLoginCredentials(script, cleanEnv, cleanSecrets) {
  if (!script?.collectionId || !script?.authFlow?.enabled) return [];
  const collection = collectionsStore.get(script.collectionId);
  if (!collection) return [];
  const parsed = parse(collection.raw);
  const loginMeta = script.authFlow.login || {};
  const login = parsed.requests.find(
    (request) => request.name === loginMeta.name && request.method === loginMeta.method && request.url === loginMeta.url
  );
  if (!login) return [];

  const environment = script.environmentId ? environmentsStore.get(script.environmentId) : null;
  const envMap = sourceMap(environment ? extractEnvironmentVariables(environment.raw) : []);
  const collectionMap = sourceMap(extractCollectionVariables(collection.raw));
  const requestMap = sourceMap(login.requestVariables);
  const injected = [];

  for (const binding of extractLoginCredentialBindings(login)) {
    const envName = binding.envName;
    if ((cleanEnv[envName] && String(cleanEnv[envName]).length > 0) ||
        (cleanSecrets[envName] && String(cleanSecrets[envName]).length > 0)) continue;

    const reference = typeof binding.value === 'string' && binding.value.match(/\{\{\s*([^}]+?)\s*\}\}/);
    const referenceName = reference ? toEnvName(reference[1]) : '';
    const value =
      (referenceName && (envMap.get(referenceName) || collectionMap.get(referenceName) || requestMap.get(referenceName))) ||
      envMap.get(envName) || collectionMap.get(envName) || requestMap.get(envName) ||
      (reference ? '' : binding.value);
    if (value) {
      cleanSecrets[envName] = String(value);
      if (referenceName && requestMap.has(referenceName) && !cleanSecrets[referenceName] && !cleanEnv[referenceName]) {
        cleanSecrets[referenceName] = String(value);
      }
      injected.push(envName);
    }
  }
  return injected;
}

function removeLoginCredentialSources(script, cleanEnv, cleanSecrets) {
  if (!script?.collectionId || !script?.authFlow?.enabled) return;
  const collection = collectionsStore.get(script.collectionId);
  if (!collection) return;
  const parsed = parse(collection.raw);
  const loginMeta = script.authFlow.login || {};
  const login = parsed.requests.find(
    (request) => request.name === loginMeta.name && request.method === loginMeta.method && request.url === loginMeta.url
  );
  if (!login) return;
  const sourceNames = credentialSourceNames(login).map(toEnvName);
  const usedOutsideLogin = new Set();
  const varRe = /\{\{\s*([^}]+?)\s*\}\}/g;
  parsed.requests.forEach((request) => {
    if (request === login) return;
    const text = [request.url, ...(request.headers || []).flatMap((header) => [header.key, header.value]), request.body?.raw].filter(Boolean).join('\n');
    let match;
    while ((match = varRe.exec(text)) !== null) usedOutsideLogin.add(toEnvName(match[1]));
  });
  for (const sourceName of sourceNames) {
    if (usedOutsideLogin.has(sourceName)) continue;
    for (const key of Object.keys(cleanEnv)) {
      if (toEnvName(key) === sourceName) delete cleanEnv[key];
    }
    for (const key of Object.keys(cleanSecrets)) {
      if (toEnvName(key) === sourceName) delete cleanSecrets[key];
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Token-shaped env var names that the envInjector mirror will populate
 * from a manual AUTH_TOKEN at spawn time. When the user pastes a manual
 * token we treat every one of these as satisfied in the required-env
 * check, otherwise collection-only runs that reference e.g.
 * `{{global_auth_token}}` are falsely blocked with MISSING_ENV_VARS
 * even though the mirror will set GLOBAL_AUTH_TOKEN before K6 spawns.
 *
 * Keep in lockstep with envInjector.buildK6Env / generator.TOKEN_NAME_RE.
 * SESSION / API_KEY are deliberately excluded — those are different
 * runtime slots the mirror never touches.
 */
const TOKEN_SHAPED_ENV_NAME_RE = /(?:TOKEN|JWT|AUTH|BEARER)/;
function isTokenShapedEnvName(name) {
  return typeof name === 'string' && TOKEN_SHAPED_ENV_NAME_RE.test(name);
}

/**
 * Detect which runtime variables are non-empty manual overrides. Any key the
 * user typed a non-empty value for is treated as a locked override and must
 * win over collection / environment / runtime-extracted values.
 */
function detectManualOverrides(env, secrets) {
  const out = new Set();
  const collect = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
      if (v == null) continue;
      const s = String(v).trim();
      if (s.length === 0) continue;
      out.add(k);
    }
  };
  collect(env);
  collect(secrets);
  return Array.from(out);
}

/**
 * Sanitize an env object: drop empty values, normalize Bearer for token-ish
 * keys. Manual values flow through this without being filtered against any
 * allow-list — the user entering a key constitutes consent for that key.
 *
 * Exception: `AUTH_HEADER_VALUE` is the user-provided *complete*
 * Authorization header value. We preserve it exactly as the user typed it
 * (no trim, no Bearer-prefix handling, no case folding). The user is
 * responsible for the entire header value, including scheme. Empty values
 * are still dropped so a stray empty field doesn't produce an empty
 * Authorization header on the wire.
 */
function sanitizeManualEnv(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, raw] of Object.entries(input)) {
    if (raw == null) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    let v = String(raw);
    if (v.length === 0) continue;
    if (k === 'AUTH_HEADER_VALUE') {
      // Verbatim preservation — DO NOT trim, DO NOT strip Bearer.
      out[k] = v;
      continue;
    }
    if (v.trim().length === 0) continue;
    if (k === 'AUTH_TOKEN' || k === 'JWT_TOKEN') {
      v = normalizeBearer(v);
      if (!v) continue; // user pasted "Bearer " with no payload
    }
    out[k] = v;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Run preparation: validate env vars and (optional) manual auth token. */
/*  Returns a masked preview without persisting anything.                */
/* ------------------------------------------------------------------ */
async function prepare(req, res, next) {
  try {
    const {
      scriptId,
      env = {},
      secrets = {},
      authToken,
      credentialDataset,
      credentialReuse,
    } = req.body || {};
    if (!scriptId) throw ApiError.badRequest('scriptId is required');

    const script = getOwnedScript(req, scriptId);

    const cleanEnv = sanitizeManualEnv(env);
    const cleanSecrets = sanitizeManualEnv(secrets);
    // The `authToken` convenience alias is the UI's "Authorization Header
    // Value" field. It is forwarded VERBATIM — no Bearer prefix handling,
    // no trim, no case folding, no scheme coercion. The user supplied the
    // complete header value and the agent must send it exactly.
    if (typeof authToken === 'string' && authToken.length > 0) {
      cleanSecrets.AUTH_HEADER_VALUE = authToken;
    }

    const credentialInfo = applyCredentialDataset(
      { credentialDataset, credentialReuse },
      script,
      cleanSecrets
    );

    const manualOverrides = detectManualOverrides(cleanEnv, cleanSecrets);
    injectLoginCredentials(script, cleanEnv, cleanSecrets);

    // Phase 1: run the resolver against collection + environment + runtime
    // overrides so `missing` reflects the TRUE unresolved set — a variable
    // provided by the collection or environment is not "missing" anymore.
    const runtimeOverrides = { ...cleanEnv, ...cleanSecrets };
    const runtimeSecretKeys = Object.keys(cleanSecrets);
    const resolution = resolveForScript(script, runtimeOverrides, runtimeSecretKeys);

    // Backfill a preview copy of cleanEnv/cleanSecrets so the masked preview
    // shows every value K6 will actually receive (not just manual ones).
    // We backfill onto CLONES here so prepare() remains a dry run.
    const previewEnv = { ...cleanEnv };
    const previewSecrets = { ...cleanSecrets };
    const { backfilledEnvKeys, backfilledSecretKeys } = backfillFromResolver(
      resolution,
      previewEnv,
      previewSecrets
    );
    removeLoginCredentialSources(script, previewEnv, previewSecrets);

    const chainEnabled = script.authFlow?.enabled === true;
    const manualAuthTokenPrep =
      !!cleanSecrets.AUTH_TOKEN || !!cleanEnv.AUTH_TOKEN;
    const manualAuthHeaderValuePrep =
      !!cleanSecrets.AUTH_HEADER_VALUE || !!cleanEnv.AUTH_HEADER_VALUE;
    const manualAuthSatisfiesPrep = manualAuthTokenPrep || manualAuthHeaderValuePrep;
    const merged = { ...previewEnv, ...previewSecrets };
    const expected = (script.expectedEnvVars || []).filter((k) => {
      if (chainEnabled && k === 'AUTH_TOKEN') return false;
      // Mirror start()'s treatment: a manual Authorization value (verbatim
      // AUTH_HEADER_VALUE or token-shaped AUTH_TOKEN) satisfies every
      // token-shaped expected var at K6 spawn time.
      if (manualAuthSatisfiesPrep && isTokenShapedEnvName(k)) return false;
      return true;
    });
    const missing = expected.filter((v) => {
      const val = merged[v];
      return val == null || String(val).length === 0;
    });
    const requiredMissing = missing.filter((v) =>
      v === 'AUTH_TOKEN' ? script.injectAuthToken === true : true
    );

    const maskedEnv = Object.fromEntries(
      Object.entries(merged).map(([k, v]) => [
        k,
        /token|secret|key|jwt|session|auth|bearer|password/i.test(k)
          ? maskToken(String(v))
          : String(v),
      ])
    );

    res.json({
      success: true,
      data: {
        scriptId,
        ready: requiredMissing.length === 0,
        missingEnvVars: requiredMissing,
        env: maskedEnv,
        manualOverrides,
        backfilledFromCollection: backfilledEnvKeys.concat(backfilledSecretKeys)
          .filter((k) => resolution?.sources?.[k] === 'collection'),
        backfilledFromEnvironment: backfilledEnvKeys.concat(backfilledSecretKeys)
          .filter((k) => resolution?.sources?.[k] === 'environment'),
        variableResolution: publicResolution(resolution),
        authSession: credentialInfo.plan,
        credentialDataset: credentialInfo.publicDataset,
        note:
          'Tokens are never persisted. Manual values override collection / environment / runtime-extracted values.',
      },
    });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/*  Start a new run                                                    */
/* ------------------------------------------------------------------ */
async function start(req, res, next) {
  try {
    const {
      scriptId,
      env = {},
      secrets = {},
      authToken,
      credentialDataset,
      credentialReuse,
      force = false,
    } = req.body || {};
    if (!scriptId) throw ApiError.badRequest('scriptId is required');

    const script = getOwnedScript(req, scriptId);

    const cleanEnv = sanitizeManualEnv(env);
    const cleanSecrets = sanitizeManualEnv(secrets);
    // authToken is the UI's "Authorization Header Value" field — forward
    // verbatim with no normalization. See prepare() for rationale.
    if (typeof authToken === 'string' && authToken.length > 0) {
      cleanSecrets.AUTH_HEADER_VALUE = authToken;
    }

    const credentialInfo = applyCredentialDataset(
      { credentialDataset, credentialReuse },
      script,
      cleanSecrets
    );

    const manualOverrides = detectManualOverrides(cleanEnv, cleanSecrets);
    injectLoginCredentials(script, cleanEnv, cleanSecrets);

    // Phase 1: resolve collection + environment + runtime overrides, then
    // backfill collection / environment values into the K6 spawn env at
    // strictly LOWER precedence than manual. This is what makes
    // "collection only" (Case A/D) actually run: values the user defined
    // on the collection now reach K6 automatically.
    const runtimeOverrides = { ...cleanEnv, ...cleanSecrets };
    const runtimeSecretKeys = Object.keys(cleanSecrets);
    const resolution = resolveForScript(script, runtimeOverrides, runtimeSecretKeys);
    const { backfilledEnvKeys, backfilledSecretKeys } = backfillFromResolver(
      resolution,
      cleanEnv,
      cleanSecrets
    );
    removeLoginCredentialSources(script, cleanEnv, cleanSecrets);

    // Validate expected env vars before spawning K6.
    // - If auth chaining is enabled AND no manual AUTH_TOKEN is given,
    //   the token comes from the login response so we drop AUTH_TOKEN
    //   from the required-env check.
    // - A manual AUTH_TOKEN always satisfies the requirement (and will
    //   take priority over the runtime-extracted token inside the script).
    // - Anything supplied by the collection or environment via the
    //   resolver backfill is also considered satisfied.
    const chainEnabled = script.authFlow?.enabled === true;
    const manualAuthToken = !!cleanSecrets.AUTH_TOKEN || !!cleanEnv.AUTH_TOKEN;
    const manualAuthHeaderValue =
      !!cleanSecrets.AUTH_HEADER_VALUE || !!cleanEnv.AUTH_HEADER_VALUE;
    const manualAuthSatisfies = manualAuthToken || manualAuthHeaderValue;
    const expected = (script.expectedEnvVars || []).filter((k) => {
      if (k === 'AUTH_TOKEN' && (chainEnabled || manualAuthSatisfies)) return false;
      // When the user supplies a manual Authorization value (verbatim via
      // AUTH_HEADER_VALUE, or token via AUTH_TOKEN), the K6 resolver uses
      // it for every Authorization header the script emits, independent
      // of the collection's placeholder name. Pre-filter token-shaped
      // expected names so collection-only runs with a manual value
      // aren't falsely blocked with MISSING_ENV_VARS at validation.
      if (manualAuthSatisfies && isTokenShapedEnvName(k)) return false;
      return true;
    });
    const merged = { ...cleanEnv, ...cleanSecrets };
    const missing = expected.filter((k) => {
      const v = merged[k];
      return v == null || String(v).length === 0;
    });

    if (missing.length > 0 && !force) {
      throw new ApiError(400, 'Missing required environment variables', {
        code: 'MISSING_ENV_VARS',
        details: {
          missing,
          hint:
            'Provide values for the listed env vars (or pass `force: true` to start anyway).',
        },
      });
    }

    // Resolver-trace log lines (no secret values, only key names).
    for (const key of manualOverrides) {
      logger.info(`[resolver] ${key} -> manual override`, {
        scriptId,
        masked: /token|secret|key|jwt|session|auth|bearer|password/i.test(key)
          ? maskToken(String(merged[key] || ''))
          : undefined,
      });
    }
    for (const key of backfilledEnvKeys) {
      logger.info(`[resolver] ${key} -> ${resolution.sources[key]}`, { scriptId });
    }
    for (const key of backfilledSecretKeys) {
      logger.info(`[resolver] ${key} -> ${resolution.sources[key]} (secret)`, { scriptId });
    }
    if (chainEnabled && manualAuthToken) {
      logger.info(
        '[auth] manual AUTH_TOKEN provided — runtime extraction will be shadowed',
        { scriptId }
      );
    }

    // Phase 2: plan-time Authorization header resolution. Runs through the
    // centralized resolver so the log line agrees byte-for-byte with the
    // decision the K6 helpers will make at request time. The runtime slot
    // is populated by setup() inside K6 and is unknowable here; we still
    // record whether a manual, env, or collection value would win when
    // no login response is available.
    const authResolution = resolveAuthorizationHeader({
      manualToken:
        cleanSecrets.AUTH_TOKEN || cleanEnv.AUTH_TOKEN || '',
      runtimeToken: '',
      envToken:
        (resolution && resolution.sources && resolution.sources.AUTH_TOKEN === 'environment')
          ? resolution.values.AUTH_TOKEN
          : '',
      collectionToken:
        (resolution && resolution.sources && resolution.sources.AUTH_TOKEN === 'collection')
          ? resolution.values.AUTH_TOKEN
          : '',
    });
    logger.info('[auth] plan-time resolution', {
      scriptId,
      ...diagnoseAuth(authResolution),
      chainEnabled,
    });

    // Phase D.3.1 — D3-2 fix.
    // Advertise which env keys came from the resolver-backfill vs. direct
    // manual UI entry. The K6 runtime uses this marker to let a
    // pre-request pm.environment.set(...) beat a backfilled env value
    // while still letting a user-typed override beat a pm mutation.
    const backfilledKeyList = backfilledEnvKeys
      .concat(backfilledSecretKeys)
      .filter((k) => k && !manualOverrides.includes(k));
    if (backfilledKeyList.length > 0) {
      cleanEnv.PA_BACKFILLED_ENV_KEYS = backfilledKeyList.join(',');
    }

    const ctx = await lifecycle.start({
      script,
      env: cleanEnv,
      secrets: cleanSecrets,
    });
    ctx.authSession = credentialInfo.plan;
    logger.info('Run started', {
      runId: ctx.runId,
      scriptId,
      manualOverrides,
      authSession: credentialInfo.plan,
      providedAuth: cleanSecrets.AUTH_HEADER_VALUE
        ? maskToken(cleanSecrets.AUTH_HEADER_VALUE)
        : cleanSecrets.AUTH_TOKEN
        ? maskToken(cleanSecrets.AUTH_TOKEN)
        : undefined,
      missingEnvVars: missing,
      forced: force === true && missing.length > 0,
    });

    res.status(202).json({ success: true, data: publicRun(ctx) });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/*  Stop a running test                                                */
/* ------------------------------------------------------------------ */
function stop(req, res, next) {
  try {
    const owned = getOwnedRun(req, req.params.runId);
    if (owned.kind === 'notFound') throw ApiError.notFound('Run not found');
    const stopped = lifecycle.stop(req.params.runId, { reason: 'user' });
    if (!stopped) {
      const ctx = lifecycle.get(req.params.runId);
      if (!ctx) throw ApiError.notFound('Run not found');
      return res.json({
        success: true,
        data: { runId: ctx.runId, status: ctx.status, alreadyFinished: true },
      });
    }
    res.json({ success: true, data: { runId: req.params.runId, status: 'stopped' } });
  } catch (err) {
    next(err);
  }
}

/* ------------------------------------------------------------------ */
/*  List / get run metadata                                            */
/* ------------------------------------------------------------------ */
function list(req, res) {
  // Merge the live (active or recently finished, in-memory) runs with the
  // persisted manifests so post-restart history is visible too. Live runs
  // win on duplicates because they may still be updating.
  const admin = isAdmin(req);
  const liveAll = lifecycle.list();
  const live = liveAll
    .filter((ctx) => {
      if (admin) return true;
      const script = ctx.scriptId ? scriptsStore.get(ctx.scriptId) : null;
      return canSee(req, script);
    })
    .map(publicRun);
  const liveIds = new Set(live.map((r) => r.runId));
  const persistedAll = admin
    ? reportsStore.list()
    : reportsStore.listByOwner(req.user.id);
  const persisted = persistedAll
    .filter((m) => !liveIds.has(m.runId))
    .map(persistedToPublicRun);
  const merged = [...live, ...persisted].sort((a, b) =>
    String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
  );
  res.json({ success: true, data: merged });
}

function get(req, res, next) {
  const owned = getOwnedRun(req, req.params.runId);
  if (owned.kind === 'live') return res.json({ success: true, data: publicRun(owned.ctx) });
  if (owned.kind === 'persisted') {
    return res.json({ success: true, data: persistedToPublicRun(owned.manifest) });
  }
  return next(ApiError.notFound('Run not found'));
}

function logs(req, res, next) {
  const owned = getOwnedRun(req, req.params.runId);
  if (owned.kind === 'live') {
    return res.json({
      success: true,
      data: { runId: owned.ctx.runId, lines: lifecycle.getLogs(owned.ctx.runId) },
    });
  }
  if (owned.kind === 'persisted') {
    return res.json({ success: true, data: { runId: req.params.runId, lines: [] } });
  }
  return next(ApiError.notFound('Run not found'));
}

/* ------------------------------------------------------------------ */
/*  SSE stream: status + logs in real time                             */
/* ------------------------------------------------------------------ */
function stream(req, res, next) {
  const { runId } = req.params;
  const owned = getOwnedRun(req, runId);
  if (owned.kind !== 'live') return next(ApiError.notFound('Run not found'));
  const ctx = owned.ctx;

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial snapshot
  send('status', publicRun(ctx));
  for (const entry of lifecycle.getLogs(runId)) {
    send('log', { runId, ...entry });
  }
  if (ctx.status === 'completed' || ctx.status === 'failed' || ctx.status === 'stopped') {
    send('done', publicRun(ctx));
    return res.end();
  }

  const onStatus = (evt) => {
    if (evt.runId !== runId) return;
    send('status', publicRun(lifecycle.get(runId)));
    if (evt.status === 'completed' || evt.status === 'failed' || evt.status === 'stopped') {
      send('done', publicRun(lifecycle.get(runId)));
      cleanup();
      res.end();
    }
  };
  const onLog = (evt) => {
    if (evt.runId !== runId) return;
    send('log', evt);
  };
  const onSummary = (evt) => {
    if (evt.runId !== runId) return;
    send('summary', evt);
  };

  // keep-alive ping every 25s
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);

  function cleanup() {
    clearInterval(ping);
    lifecycle.off('status', onStatus);
    lifecycle.off('log', onLog);
    lifecycle.off('summary', onSummary);
  }

  lifecycle.on('status', onStatus);
  lifecycle.on('log', onLog);
  lifecycle.on('summary', onSummary);
  req.on('close', cleanup);
}

/* ------------------------------------------------------------------ */
function publicRun(ctx) {
  if (!ctx) return null;
  const script = ctx.scriptId ? scriptsStore.get(ctx.scriptId) : null;
  return {
    runId: ctx.runId,
    scriptId: ctx.scriptId,
    status: ctx.status,
    startedAt: ctx.startedAt,
    endedAt: ctx.endedAt,
    durationMs: ctx.durationMs,
    exitCode: ctx.exitCode,
    error: ctx.error || null,
    summary: ctx.summary || null,
    env: ctx.env, // already masked by envInjector
    manualOverrides: ctx.manualOverrides || [],
    bearerNormalized: ctx.bearerNormalized || [],
    selection: script?.selection || null,
    selectedRequests: script?.selectedRequests || null,
    requestCount: script?.requestCount ?? null,
    totalCollectionRequests: script?.totalCollectionRequests ?? null,
    authFlow: script?.authFlow || null,
    artifacts: ctx.artifacts
      ? {
          hasSummary: true,
          hasMetrics: true,
          hasReport: true,
        }
      : null,
  };
}

/**
 * Translate a persisted manifest back into the same shape the run detail page
 * expects, so the existing UI keeps working after a server restart.
 */
function persistedToPublicRun(m) {
  if (!m) return null;
  return {
    runId: m.runId,
    scriptId: m.scriptId,
    status: m.status,
    startedAt: m.startedAt,
    endedAt: m.endedAt,
    durationMs: m.durationMs,
    exitCode: m.exitCode,
    error: m.error || null,
    summary: null,
    env: m.env || null,
    manualOverrides: m.manualOverrides || [],
    selection: m.selection || null,
    selectedRequests: m.selectedRequests || null,
    requestCount: m.requestCount ?? null,
    totalCollectionRequests: m.totalCollectionRequests ?? null,
    authFlow: m.authFlow || null,
    persisted: true,
    collectionId: m.collectionId || null,
    collectionName: m.collectionName || null,
    artifacts: { hasReport: true, hasMetrics: true },
  };
}

/* ------------------------------------------------------------------ */
/*  Phase 4 — rich reporting endpoints                                  */
/* ------------------------------------------------------------------ */

async function summary(req, res, next) {
  try {
    const owned = getOwnedRun(req, req.params.runId);
    if (owned.kind === 'notFound') throw ApiError.notFound('Run not found');
    const ctx = owned.kind === 'live' ? owned.ctx : null;
    const persisted = owned.kind === 'persisted' ? owned.manifest : null;
    if (ctx && (ctx.status === 'queued' || ctx.status === 'running')) {
      return res.json({
        success: true,
        data: {
          ready: false,
          status: ctx.status,
          message: 'Run still in progress; report not available yet.',
        },
      });
    }
    const report = await getReport(req.params.runId);
    if (!report) throw ApiError.notFound('No report artifacts available for this run');
    const status = ctx?.status || persisted?.status;
    const startedAt = ctx?.startedAt || persisted?.startedAt;
    const endedAt = ctx?.endedAt || persisted?.endedAt;
    const durationMs = ctx?.durationMs ?? persisted?.durationMs ?? null;
    // Phase 4: attach the normalized contract as an ADDITIVE field so the
    // legacy shape (top-level summary / thresholds) keeps working for the
    // current UI. New consumers should prefer `.normalized`.
    const normalized = await getNormalizedReport(req.params.runId).catch(() => null);
    res.json({
      success: true,
      data: {
        ready: true,
        runId: req.params.runId,
        status,
        startedAt,
        endedAt,
        durationMs,
        ...report.summary,
        thresholds: report.thresholds,
        normalized,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function metrics(req, res, next) {
  try {
    const owned = getOwnedRun(req, req.params.runId);
    if (owned.kind === 'notFound') throw ApiError.notFound('Run not found');
    const ctx = owned.kind === 'live' ? owned.ctx : null;
    const persisted = owned.kind === 'persisted' ? owned.manifest : null;
    const report = await getReport(req.params.runId);
    if (!report) throw ApiError.notFound('No metrics available for this run');
    // Same additive normalization as above.
    const normalized = await getNormalizedReport(req.params.runId).catch(() => null);
    res.json({
      success: true,
      data: {
        runId: req.params.runId,
        status: ctx?.status || persisted?.status,
        timeseries: report.timeseries,
        requests: report.requests,
        failures: report.failures,
        thresholds: report.thresholds,
        summary: report.summary,
        normalized,
      },
    });
  } catch (err) {
    next(err);
  }
}

async function report(req, res, next) {
  try {
    const owned = getOwnedRun(req, req.params.runId);
    if (owned.kind === 'notFound') throw ApiError.notFound('Run not found');
    const ctx = owned.kind === 'live' ? owned.ctx : null;
    const persisted = owned.kind === 'persisted' ? owned.manifest : null;
    const reportPath = ctx?.artifacts?.reportHtmlPath || persisted?.artifacts?.reportHtmlPath;
    if (!reportPath) throw ApiError.notFound('No report file available');
    const wantDownload = String(req.query.download || '') === '1';
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    };
    if (wantDownload) {
      headers['Content-Disposition'] = `attachment; filename="perf-report-${req.params.runId}.html"`;
    }
    res.set(headers);
    res.sendFile(reportPath, (err) => {
      if (err) next(err);
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { prepare, start, stop, list, get, logs, stream, summary, metrics, report };
