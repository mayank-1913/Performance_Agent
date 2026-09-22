'use strict';

const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ApiError = require('../../utils/ApiError');
const logger = require('../../config/logger');
const env = require('../../config/env');
const collectionsStore = require('../collections/collections.store');
const environmentsStore = require('../environments/environments.store');
const scriptsStore = require('./scripts.store');
const { parse } = require('../../lib/postman/parser');
const { detectAuth } = require('../../lib/postman/authDetector');
const {
  sanitizeParsedCollection,
  assertNoSecretsInScript,
} = require('../../lib/postman/authSanitizer');
const { applySelection } = require('../../lib/postman/tree');
const { buildAuthFlow, collectRuntimeCapturedVarNames } = require('../../lib/postman/authFlow');
const { generateK6Script, toEnvName } = require('../../lib/k6/generator');
const { buildTimeoutMetadata } = require('../../lib/k6/requestTimeout');
const {
  resolveVariables,
  publicResolution,
  extractCollectionVariables,
  extractEnvironmentVariables,
} = require('../../lib/postman/variableResolver');
const { scanCompatibility } = require('../../lib/postman/compatibility');
const {
  normalizeWorkload,
  publicWorkload,
  PROFILES: WORKLOAD_PROFILES,
} = require('../../lib/k6/workloadProfiles');

const scriptsDir = path.resolve(__dirname, '..', '..', '..', 'storage', 'scripts');

async function ensureDir() {
  await fs.mkdir(scriptsDir, { recursive: true });
}

function defaultProfile() {
  return { vus: 5, rampUp: '30s', hold: '1m', rampDown: '30s' };
}

/**
 * Phase 6: normalize any workload / loadProfile input into the canonical
 * shape. Accepts (in priority order): `options.workload` (Phase 6 shape),
 * `options.loadProfile` (legacy), or nothing (defaults). Errors thrown by
 * the normalizer are converted to ApiError.badRequest so the client gets
 * a stable 400 with a structured code.
 */
function resolveWorkload(options, context = {}) {
  const raw = options && (options.workload || options.loadProfile) || null;
  const src =
    raw && typeof raw === 'object'
      ? {
          ...raw,
          authSessionMode:
            options?.workload?.authSessionMode ?? options?.authSessionMode ?? raw.authSessionMode,
          credentialReuse:
            options?.workload?.credentialReuse ?? options?.credentialReuse ?? raw.credentialReuse,
        }
      : raw;
  try {
    return normalizeWorkload(src, context);
  } catch (err) {
    throw new ApiError(400, err.message || 'Invalid workload profile', {
      code: 'INVALID_WORKLOAD',
      details: {
        supportedProfiles: WORKLOAD_PROFILES.slice(),
        hint:
          'Pass options.workload = { profile: "load", overrides: { vus, rampUp, hold, rampDown } } ' +
          'or the legacy options.loadProfile = { vus, rampUp, hold, rampDown }.',
      },
    });
  }
}

function validateSelection(selection) {
  if (selection == null) return { mode: 'all' };
  if (typeof selection !== 'object') {
    throw ApiError.badRequest('selection must be an object');
  }
  const mode = selection.mode || 'all';
  if (!['all', 'requests', 'folder', 'single'].includes(mode)) {
    throw ApiError.badRequest(
      'selection.mode must be one of: all, requests, folder, single'
    );
  }
  if (mode === 'single') {
    if (!Number.isInteger(selection.requestIndex) || selection.requestIndex < 0) {
      throw ApiError.badRequest('selection.requestIndex must be a non-negative integer');
    }
    return { mode, requestIndex: selection.requestIndex };
  }
  if (mode === 'requests') {
    if (!Array.isArray(selection.requestIndices)) {
      throw ApiError.badRequest('selection.requestIndices must be an array');
    }
    const cleaned = Array.from(
      new Set(
        selection.requestIndices
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0)
      )
    ).sort((a, b) => a - b);
    if (cleaned.length === 0) {
      throw ApiError.badRequest('selection.requestIndices must contain at least one index');
    }
    return { mode, requestIndices: cleaned };
  }
  if (mode === 'folder') {
    if (!Array.isArray(selection.folderPath) || selection.folderPath.length === 0) {
      throw ApiError.badRequest('selection.folderPath must be a non-empty array of folder names');
    }
    return { mode, folderPath: selection.folderPath.map(String) };
  }
  return { mode: 'all' };
}

function validateProfile(p) {
  if (!p) return defaultProfile();
  const out = { ...defaultProfile(), ...p };
  if (!Number.isFinite(out.vus) || out.vus < 1 || out.vus > 1000) {
    throw ApiError.badRequest('vus must be a number between 1 and 1000');
  }
  for (const k of ['rampUp', 'hold', 'rampDown']) {
    if (typeof out[k] !== 'string' || !/^\d+(ms|s|m|h)$/.test(out[k])) {
      throw ApiError.badRequest(`${k} must match a duration like "30s", "2m"`);
    }
  }
  return out;
}

async function generate(req, res, next) {
  try {
    const { collectionId, environmentId, options = {}, selection } = req.body || {};
    if (!collectionId) throw ApiError.badRequest('collectionId is required');

    const record = collectionsStore.get(collectionId);
    if (!record) throw ApiError.notFound('Collection not found');

    let environmentRaw = null;
    let environmentRecord = null;
    if (environmentId) {
      environmentRecord = environmentsStore.get(environmentId);
      if (!environmentRecord) throw ApiError.notFound('Environment not found');
      environmentRaw = environmentRecord.raw;
    }

    const parsedRaw = parse(record.raw);
    const sanitization = sanitizeParsedCollection(parsedRaw);
    const fullParsed = sanitization.parsed;

    // Resolve the user's selection AFTER sanitization but BEFORE auth detection,
    // so unresolved tokens reflect the actually-selected APIs (e.g. picking a
    // single login request shouldn't scream about every other endpoint's
    // `{{token}}`).
    const validatedSelection = validateSelection(selection);
    const { parsed, selectedIndices } = applySelection(fullParsed, validatedSelection);
    if ((parsed.requests || []).length === 0) {
      throw ApiError.badRequest('Selection produced 0 requests. Pick at least one API.');
    }

    const auth = detectAuth(parsed, environmentRaw);

    // Phase 5: scan the (filtered) collection for Postman features that
    // don't translate reliably to K6. Warnings are non-blocking metadata;
    // BLOCKING severity refuses generation with a structured 400 so the
    // UI can render the offending feature list without guessing.
    const compatibility = scanCompatibility({
      rawCollection: record.raw,
      parsed,
      rawEnvironment: environmentRaw,
    });
    if (compatibility.hasBlocking && options.acknowledgeBlockingWarnings !== true) {
      throw new ApiError(400, 'Postman collection uses features that cannot be executed safely by K6.', {
        code: 'UNSUPPORTED_POSTMAN_FEATURES',
        details: {
          summary: compatibility.summary,
          warnings: compatibility.warnings,
          hint:
            'Remove or replace the flagged requests, or pass ' +
            '`options.acknowledgeBlockingWarnings: true` to force generation ' +
            '(the resulting K6 script will send those requests with an empty ' +
            'or unsigned body and is expected to fail).',
        },
      });
    }

    // Phase 1: resolve variables now so we can surface a rich, secret-safe
    // resolution map on the script record. This is additive metadata —
    // existing consumers (UI, tests) ignore it. The `values` map is used at
    // run start to seed collection/env values into K6's spawn env; it is
    // NEVER baked into the generated JS source (the generator only emits
    // __ENV.<NAME> references).
    const variableResolution = resolveVariables({
      collectionVariables: extractCollectionVariables(record.raw),
      environmentVariables: environmentRaw
        ? extractEnvironmentVariables(environmentRaw)
        : null,
      runtimeOverrides: null,
      referencedVars: parsed.referencedVars,
    });

    // Build the auth-flow plan from the FILTERED selection. If only the login
    // request is selected, chaining is meaningless -> disabled.
    const userOptedOut = options.autoChainAuth === false;
    const flowCandidate = buildAuthFlow(parsed);
    let authFlow =
      !userOptedOut &&
      flowCandidate.enabled &&
      flowCandidate.injectionCount > 0
        ? flowCandidate
        : { ...flowCandidate, enabled: false };

    // If sanitization injected AUTH_TOKEN / API_KEY placeholders, force the
    // injectAuthToken flag on so the runner expects those env vars.
    let injectAuthToken =
      options.injectAuthToken === true ||
      sanitization.injectedTokens.includes('AUTH_TOKEN') ||
      authFlow.enabled ||
      (auth.manualTokenRequired && options.injectAuthToken !== false);

    const workload = resolveWorkload(options, {
      authFlowEnabled: authFlow.enabled,
      injectAuthToken,
    });

    // MANUAL_TOKEN explicitly disables automatic login even when detected.
    if (workload.authSessionMode === 'MANUAL_TOKEN') {
      authFlow = { ...authFlow, enabled: false };
      injectAuthToken = true;
    }
    // The legacy validator runs against the resolved loadProfile — this
    // preserves the historical 400 errors on obviously broken payloads
    // even when the caller went through the new `workload` field.
    const loadProfile = validateProfile(workload.loadProfile);

    const timeoutRequests = parsed.requests.map((r, i) => ({
      ...r,
      requestId: 'req_' + String(i + 1).padStart(Math.max(2, String(parsed.requests.length).length), '0'),
    }));
    const requestTimeout = buildTimeoutMetadata({
      requests: timeoutRequests,
      agentDefault: options.requestTimeout || options.requestTimeoutDefault,
    });

    const code = generateK6Script(parsed, {
      injectAuthToken,
      loadProfile,
      workload,
      authFlow,
      authSessionMode: workload.authSessionMode,
      credentialReuse: workload.credentialReuse,
    });

    // Hard guard: literal JWTs / Bearer tokens must never survive into the
    // persisted script file. If this throws, sanitization missed something.
    assertNoSecretsInScript(code);

    await ensureDir();
    const id = uuidv4();
    const fileName = `${id}.js`;
    const filePath = path.join(scriptsDir, fileName);
    await fs.writeFile(filePath, code, 'utf-8');

    const runtimeCapturedNames = new Set(
      (collectRuntimeCapturedVarNames(parsed) || []).map((name) => toEnvName(name))
    );

    const expectedEnvVars = Array.from(
      new Set([
        ...parsed.referencedVars.map(toEnvName),
        ...(injectAuthToken ? ['AUTH_TOKEN'] : []),
        ...sanitization.injectedTokens,
      ])
    ).filter((envName) => {
      if (runtimeCapturedNames.has(envName)) return false;
      if (variableResolution?.sources?.[envName]) return false;
      if (envName === 'AUTH_TOKEN' && authFlow.enabled) return false;
      return true;
    });

    const selectedRequestsMeta = selectedIndices.map((i) => {
      const r = fullParsed.requests[i];
      return {
        index: i,
        name: r?.name || '',
        method: r?.method || '',
        url: r?.url || '',
        folderPath: r?.folderPath || [],
      };
    });

    // Build a public-safe view of the auth flow for the UI / run history.
    const authFlowPublic = authFlow.enabled
      ? {
          enabled: true,
          login: {
            // Index here is in the FILTERED list. We surface the full request
            // metadata so the UI can render the diagram without re-parsing.
            name: authFlow.loginRequest?.name || '',
            method: authFlow.loginRequest?.method || '',
            url: authFlow.loginRequest?.url || '',
          },
          tokenKeys: authFlow.tokenKeys,
          injectionCount: authFlow.injectionCount,
          // Map filtered indices back to selectedRequestsMeta entries
          injectionTargets: (authFlow.injectionTargets || []).map((filteredIdx) => {
            const r = parsed.requests[filteredIdx];
            return {
              name: r?.name || '',
              method: r?.method || '',
              url: r?.url || '',
              folderPath: r?.folderPath || [],
            };
          }),
          reasons: authFlow.reasons || [],
        }
      : { enabled: false, reasons: flowCandidate.reasons || [] };

    const scriptRecord = {
      id,
      collectionId,
      environmentId: environmentId || null,
      fileName,
      filePath,
      sizeBytes: Buffer.byteLength(code, 'utf-8'),
      createdAt: new Date().toISOString(),
      auth,
      injectAuthToken,
      loadProfile: {
        ...loadProfile,
        authSessionMode: workload.authSessionMode || null,
        credentialReuse: !!workload.credentialReuse,
      },
      expectedEnvVars,
      requestCount: parsed.requests.length,
      totalCollectionRequests: fullParsed.requests.length,
      selection: {
        ...validatedSelection,
        resolvedIndices: selectedIndices,
        requestCount: parsed.requests.length,
      },
      selectedRequests: selectedRequestsMeta,
      sanitization: {
        sanitized: sanitization.sanitized,
        injectedTokens: sanitization.injectedTokens,
        findingsCount: sanitization.findings.length,
      },
      authFlow: authFlowPublic,
      workload: publicWorkload(workload),
      requestTimeout,
      pacingMs: 1000,
      variableResolution: publicResolution(variableResolution),
      compatibility: {
        summary: compatibility.summary,
        supported: compatibility.supported,
        warnings: compatibility.warnings,
        acknowledgedBlocking:
          options.acknowledgeBlockingWarnings === true && compatibility.hasBlocking,
      },
    };
    scriptsStore.add(scriptRecord);

    logger.info('K6 script generated', {
      id,
      collectionId,
      environmentId: environmentId || null,
      selectionMode: validatedSelection.mode,
      selectedRequests: parsed.requests.length,
      totalRequests: fullParsed.requests.length,
      authMode: auth.mode,
      injectAuthToken,
      sanitizedSecrets: sanitization.findings.length,
      authFlow: authFlowPublic.enabled
        ? {
            login: `${authFlowPublic.login.method} ${authFlowPublic.login.url}`,
            injectionCount: authFlowPublic.injectionCount,
          }
        : 'disabled',
    });

    res.status(201).json({
      success: true,
      data: {
        ...publicScript(scriptRecord),
        code,
      },
    });
  } catch (err) {
    next(err);
  }
}

function publicScript(s) {
  if (!s) return null;
  const { filePath, ...safe } = s;
  return safe;
}

async function getScript(req, res, next) {
  try {
    const s = scriptsStore.get(req.params.id);
    if (!s) throw ApiError.notFound('Script not found');
    const code = await fs.readFile(s.filePath, 'utf-8');
    res.json({ success: true, data: { ...publicScript(s), code } });
  } catch (err) {
    next(err);
  }
}

function listScripts(req, res) {
  const { collectionId } = req.query;
  const items = collectionId
    ? scriptsStore.listByCollection(String(collectionId))
    : scriptsStore.list();
  res.json({ success: true, data: items.map(publicScript) });
}

async function downloadScript(req, res, next) {
  try {
    const s = scriptsStore.get(req.params.id);
    if (!s) throw ApiError.notFound('Script not found');
    res.setHeader('Content-Type', 'application/javascript');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="perf-agent-${s.id}.js"`
    );
    const code = await fs.readFile(s.filePath, 'utf-8');
    res.send(code);
  } catch (err) {
    next(err);
  }
}

module.exports = { generate, getScript, listScripts, downloadScript };
