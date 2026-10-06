'use strict';

/**
 * Unified Postman executable runtime model.
 *
 * Compiles a parsed collection (mandatory) plus an optional environment
 * into the plan the K6 generator emits. Reuses the existing variable
 * resolver, auth-flow planner, dependency graph, and tree selection.
 *
 * The model keeps EVERY collection request in original order. Runtime
 * selection + transitive dependencies decide which requests execute.
 */

const { resolveSelection } = require('./tree');
const { buildAuthFlow } = require('./authFlow');
const { buildDependencyGraph, extractReferencedVars } = require('./dependencyGraph');
const {
  resolveVariables,
  extractCollectionVariables,
  extractEnvironmentVariables,
} = require('./variableResolver');
const { analyzePrerequestScript } = require('./prerequestCodegen');
const { analyzeRequestVariables } = require('./unresolvedSafety');

// Minimal context passed to analyzeRequestVariables when all we care about
// is detecting unsupported Postman dynamic variables ({{$futureDyn}}).
// classifyPlaceholder short-circuits on the $-prefix branch and never reads
// these ctx fields for dynamic names, so empty Sets are sufficient.
const EMPTY_PLACEHOLDER_CTX = {
  manualOverrides: new Set(),
  prerequestSets: new Set(),
  requestLocals: new Set(),
  capturedVars: new Set(),
  environmentVars: new Set(),
  collectionVars: new Set(),
};

/**
 * True only for src values that can be passed to k6 open() as a local path.
 * URIs (postman-cloud://, http(s)://, file://, …), empty, and missing src
 * are required runtime assets — never filesystem paths.
 */
function isUsableLocalFilePath(src) {
  if (src == null) return false;
  const s = String(src).trim();
  if (!s) return false;
  if (/:\/\//.test(s)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s) && !/^[a-zA-Z]:[\\/]/.test(s)) return false;
  return true;
}

function collectDefinedOriginalNames(collectionList, environmentList) {
  const names = new Set();
  const take = (list) => {
    for (const item of list || []) {
      if (!item || item.key == null) continue;
      if (item.enabled === false || item.disabled === true) continue;
      names.add(String(item.key));
    }
  };
  take(collectionList);
  take(environmentList);
  return Array.from(names).sort();
}

function enabledVarMap(list) {
  const out = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || item.key == null) continue;
    const enabled = item.enabled !== false && item.disabled !== true;
    if (!enabled) continue;
    const value = item.value == null ? '' : String(item.value);
    if (value.length === 0) continue;
    out[String(item.key)] = value;
  }
  return out;
}

function looksLikeAuthConsumer(req) {
  const headers = req?.headers || [];
  if (
    headers.some(
      (h) => h && typeof h.key === 'string' && h.key.toLowerCase() === 'authorization'
    )
  ) {
    return true;
  }
  if (req?.auth && req.auth.type && String(req.auth.type).toLowerCase() !== 'noauth') {
    return true;
  }
  const refs = extractReferencedVars(req);
  for (const name of refs) {
    if (/(token|jwt|auth|bearer|session)/i.test(String(name))) return true;
  }
  return false;
}

function collectFileAssets(req) {
  const assets = [];
  const body = req?.body;
  if (!body) return assets;
  if (body.mode === 'formdata') {
    for (const p of body.params || []) {
      if (p && p.type === 'file') {
        const src = p.src == null ? '' : String(p.src);
        assets.push({
          kind: 'formdata_file',
          field: p.key,
          src,
          available: isUsableLocalFilePath(src),
        });
      }
    }
  } else if (body.mode === 'file' || body.mode === 'binary') {
    const src = body.src == null ? '' : String(body.src);
    assets.push({
      kind: body.mode,
      field: null,
      src,
      available: isUsableLocalFilePath(src),
    });
  }
  return assets;
}

/**
 * Selected requests plus producers of captured variables they consume,
 * walking until the closure is stable. Login is included only when a
 * selected/executable request actually depends on authentication.
 */
function expandExecutableIndices(selectedIndices, parsed, dependencyGraph, authFlow) {
  const n = (parsed.requests || []).length;
  const executable = new Set(
    (selectedIndices || []).filter((i) => Number.isInteger(i) && i >= 0 && i < n)
  );
  const loginIdx =
    authFlow && Number.isInteger(authFlow.loginRequestIndex) ? authFlow.loginRequestIndex : -1;
  const injectionTargets = new Set(authFlow?.injectionTargets || []);

  let changed = true;
  while (changed) {
    changed = false;
    for (const idx of Array.from(executable)) {
      const deps = (dependencyGraph.perRequest && dependencyGraph.perRequest[idx]) || [];
      for (const dep of deps) {
        const producer = dep?.producerIndex;
        if (Number.isInteger(producer) && producer >= 0 && producer < n && !executable.has(producer)) {
          executable.add(producer);
          changed = true;
        }
      }
      if (loginIdx >= 0 && loginIdx < idx && !executable.has(loginIdx)) {
        if (injectionTargets.has(idx) || looksLikeAuthConsumer(parsed.requests[idx])) {
          executable.add(loginIdx);
          changed = true;
        }
      }
    }
  }

  return Array.from(executable).sort((a, b) => a - b);
}

const SUPPORTED_PROTOCOL_KEYS = new Set([
  'strictSSL',
  'followAuthorizationHeader',
  'disableBodyPruning',
  'disabledSystemHeaders',
]);

function requestCompatibilityIssues(req) {
  const issues = [];
  const prerequestText = (req.prerequests || [])
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
  if (prerequestText) {
    const analysis = analyzePrerequestScript(prerequestText);
    if (!analysis.translatable) {
      issues.push({
        kind: 'pre_request_unsupported',
        reason: analysis.reason || 'Unsupported pre-request script',
        unsupported: analysis.unsupported || [],
      });
    }
  }
  const ppb = req.protocolProfileBehavior;
  if (ppb && typeof ppb === 'object') {
    if (ppb.strictSSL === false) {
      issues.push({
        kind: 'protocol_profile_unsupported',
        feature: 'strictSSL',
        reason: 'k6 cannot disable TLS verification for a single request. strictSSL:false is reported and is not applied.',
      });
    }
    if (Object.prototype.hasOwnProperty.call(ppb, 'followAuthorizationHeader')) {
      issues.push({
        kind: 'protocol_profile_unsupported',
        feature: 'followAuthorizationHeader',
        reason: 'k6 cannot retain or strip Authorization across redirects per request. followAuthorizationHeader is reported and is not applied.',
      });
    }
    for (const key of Object.keys(ppb)) {
      if (SUPPORTED_PROTOCOL_KEYS.has(key)) continue;
      issues.push({
        kind: 'protocol_profile_unsupported',
        feature: key,
        reason: `protocolProfileBehavior.${key} is not applied.`,
      });
    }
  }
  const assets = collectFileAssets(req);
  const missing = assets.filter((a) => !a.available);
  if (missing.length > 0) {
    issues.push({
      kind: 'required_runtime_asset',
      reason: 'Request references file/multipart assets that are not available to the compiler',
      assets: missing,
    });
  }
  // Unsupported Postman dynamic variables ({{$futureDyn}}). At runtime these
  // would resolve to the __UNSUPPORTED_DYNAMIC__$name sentinel. The sentinel
  // is caught by the generator's URL / body guards, but headers have no
  // equivalent guard — a sentinel there would reach the wire. We surface
  // the issue at plan time so buildExecutionModel can remove the request
  // from executableIndices and the request block's selectionGuard
  // short-circuits BEFORE URL, body, or headers are evaluated. This also
  // keeps the dependency-skip cascade intact: downstream consumers of a
  // skipped producer are naturally blocked at runtime via __checkDependencyDeps.
  const varAnalysis = analyzeRequestVariables(req, EMPTY_PLACEHOLDER_CTX);
  if (varAnalysis && varAnalysis.unsupportedDynamic && varAnalysis.unsupportedDynamic.length > 0) {
    issues.push({
      kind: 'unsupported_dynamic_variable',
      reason: 'Request references dynamic variable(s) not supported by the compiler',
      variables: varAnalysis.unsupportedDynamic.slice(),
    });
  }
  return { issues, assets };
}

/**
 * @param {object} args
 * @param {object} args.parsed parsed collection (full, unfiltered)
 * @param {object} [args.rawCollection]
 * @param {object|null} [args.rawEnvironment]
 * @param {object} [args.selection]
 * @param {object} [args.authFlow] precomputed; otherwise buildAuthFlow(parsed)
 */
function buildExecutionModel({
  parsed,
  rawCollection = null,
  rawEnvironment = null,
  selection = { mode: 'all' },
  authFlow = null,
} = {}) {
  if (!parsed || !Array.isArray(parsed.requests)) {
    throw new Error('buildExecutionModel requires parsed.requests');
  }

  const selectedSet = resolveSelection(selection, parsed.requests);
  const selectedIndices = Array.from(selectedSet).sort((a, b) => a - b);

  const resolvedAuthFlow = authFlow || buildAuthFlow(parsed);
  const dependencyGraph = buildDependencyGraph(parsed, resolvedAuthFlow);
  const rawExecutableIndices = expandExecutableIndices(
    selectedIndices,
    parsed,
    dependencyGraph,
    resolvedAuthFlow
  );

  // Pre-compute compat issues per request so we can filter out requests
  // whose unsupported dynamic variables would otherwise push a sentinel on
  // the wire. We only compute for indices actually in the closure to avoid
  // paying for unselected requests.
  const perIndexCompat = new Map();
  for (const idx of rawExecutableIndices) {
    perIndexCompat.set(idx, requestCompatibilityIssues(parsed.requests[idx]));
  }
  const dynamicallyBlocked = new Set();
  for (const idx of rawExecutableIndices) {
    const compat = perIndexCompat.get(idx);
    if (compat && compat.issues.some((i) => i.kind === 'unsupported_dynamic_variable')) {
      dynamicallyBlocked.add(idx);
    }
  }
  const executableIndices = rawExecutableIndices.filter((i) => !dynamicallyBlocked.has(i));
  const executableSet = new Set(executableIndices);

  const collectionList = extractCollectionVariables(rawCollection || { variable: Object.entries(parsed.definedVars || {}).map(([key, value]) => ({ key, value })) });
  const environmentList = rawEnvironment ? extractEnvironmentVariables(rawEnvironment) : null;

  const variableResolution = resolveVariables({
    collectionVariables: collectionList,
    environmentVariables: environmentList,
    runtimeOverrides: null,
    referencedVars: parsed.referencedVars,
  });

  const compiledCollectionVars = enabledVarMap(collectionList);
  const compiledEnvironmentVars = enabledVarMap(environmentList || []);
  const definedVariableNames = collectDefinedOriginalNames(collectionList, environmentList || []);

  const requests = parsed.requests.map((req, index) => {
    const selected = selectedSet.has(index);
    const execute = executableSet.has(index);
    // Reuse compat issues computed above when available; fall back for
    // requests outside the closure (unselected) that were skipped there.
    const { issues, assets } = perIndexCompat.has(index)
      ? perIndexCompat.get(index)
      : requestCompatibilityIssues(req);
    let skipReason = null;
    if (dynamicallyBlocked.has(index)) {
      // Explicit, more informative reason than 'unselected' so UI/report
      // can tell the user WHY the request did not run.
      skipReason = 'unsupported_dynamic_variable';
    } else if (!execute) {
      skipReason = 'unselected';
    }
    const missingAssets = assets.filter((a) => !a.available);
    const unsupportedPre = issues.some((issue) => issue.kind === 'pre_request_unsupported');
    if (execute && unsupportedPre) {
      skipReason = 'pre_request_unsupported';
    } else if (execute && missingAssets.length > 0) {
      skipReason = 'required_runtime_asset';
    }
    return {
      index,
      name: req.name,
      method: req.method,
      url: req.url,
      folderPath: req.folderPath || [],
      selected,
      execute,
      isDependency: execute && !selected,
      skipReason,
      dependencies: (dependencyGraph.perRequest[index] || []).slice(),
      captureRules: (resolvedAuthFlow.requestCaptureRules || []).find((e) => e.index === index)?.rules || [],
      assets,
      issues,
    };
  });

  const loginExecutable =
    resolvedAuthFlow.loginRequestIndex >= 0 &&
    executableSet.has(resolvedAuthFlow.loginRequestIndex);

  return {
    parsed,
    selectedIndices,
    executableIndices,
    compiledCollectionVars,
    compiledEnvironmentVars,
    definedVariableNames,
    variableResolution,
    dependencyGraph,
    authFlow: {
      ...resolvedAuthFlow,
      enabled: !!(resolvedAuthFlow.enabled && loginExecutable),
    },
    authFlowDetected: resolvedAuthFlow,
    environmentProvided: !!(rawEnvironment && typeof rawEnvironment === 'object'),
    requests,
  };
}

module.exports = {
  buildExecutionModel,
  expandExecutableIndices,
  collectFileAssets,
  looksLikeAuthConsumer,
  enabledVarMap,
  collectDefinedOriginalNames,
  isUsableLocalFilePath,
};
