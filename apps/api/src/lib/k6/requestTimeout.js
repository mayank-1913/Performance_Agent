'use strict';

/**
 * Request timeout resolution for generated K6 scripts.
 *
 * Precedence (highest → lowest):
 *   1. Explicit Postman per-request timeout (when exported in collection JSON)
 *   2. Runtime per-request override: __ENV.REQUEST_TIMEOUT_<REQUEST_ID>
 *   3. Runtime global override: __ENV.REQUEST_TIMEOUT
 *   4. Generator default embedded at script creation: PA_DEFAULT_REQUEST_TIMEOUT
 *   5. Documented safe global default: 120s (DEFAULT_REQUEST_TIMEOUT)
 *
 * Timeouts are never infinite. Values outside the supported range are clamped.
 */

const DEFAULT_REQUEST_TIMEOUT = '120s';
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000; // 10 minutes — generous but bounded

const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/i;

function durationToMs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 0 ? Math.round(raw) : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(DURATION_RE);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  switch (m[2].toLowerCase()) {
    case 'ms':
      return Math.round(n);
    case 's':
      return Math.round(n * 1000);
    case 'm':
      return Math.round(n * 60 * 1000);
    case 'h':
      return Math.round(n * 60 * 60 * 1000);
    default:
      return null;
  }
}

function msToDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REQUEST_TIMEOUT;
  const clamped = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(n)));
  if (clamped % 1000 === 0 && clamped >= 1000) {
    return `${clamped / 1000}s`;
  }
  return `${clamped}ms`;
}

function clampDuration(raw) {
  const ms = durationToMs(raw);
  if (ms == null) return null;
  return msToDuration(ms);
}

/**
 * Extract a Postman request timeout in milliseconds from a raw Postman item
 * or a normalized parser request row.
 */
function extractPostmanRequestTimeoutMs(source) {
  if (!source || typeof source !== 'object') return null;

  const candidates = [
    source.timeoutMs,
    source.timeout,
    source.requestTimeout,
    source.protocolProfileBehavior?.requestTimeout,
    source.request?.timeout,
    source.request?.protocolProfileBehavior?.requestTimeout,
  ];

  for (const c of candidates) {
    const ms = durationToMs(c);
    if (ms != null) return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, ms));
  }
  return null;
}

/**
 * Resolve the effective timeout string for a single request at generation time.
 * Runtime __ENV.REQUEST_TIMEOUT is applied in the emitted script — this
 * resolves the Postman + generator-default layer only.
 */
function resolveGeneratedRequestTimeout({ postmanTimeoutMs, agentDefault }) {
  if (postmanTimeoutMs != null) {
    return msToDuration(postmanTimeoutMs);
  }
  const agent = clampDuration(agentDefault);
  if (agent) return agent;
  return DEFAULT_REQUEST_TIMEOUT;
}

/**
 * Build metadata describing timeout configuration for reports.
 */
function buildTimeoutMetadata({ requests, agentDefault }) {
  const perRequest = {};
  let hasPerRequest = false;
  for (const req of requests || []) {
    const id = req.requestId || req.id;
    if (!id) continue;
    const postmanMs = extractPostmanRequestTimeoutMs(req);
    const resolved = resolveGeneratedRequestTimeout({
      postmanTimeoutMs: postmanMs,
      agentDefault,
    });
    perRequest[id] = {
      postmanTimeout: postmanMs != null ? msToDuration(postmanMs) : null,
      generatedDefault: resolved,
    };
    if (postmanMs != null) hasPerRequest = true;
  }
  const globalDefault = clampDuration(agentDefault) || DEFAULT_REQUEST_TIMEOUT;
  return {
    defaultTimeout: globalDefault,
    documentedDefault: DEFAULT_REQUEST_TIMEOUT,
    precedence: [
      'postman_per_request',
      'runtime_REQUEST_TIMEOUT_<REQUEST_ID>',
      'runtime_REQUEST_TIMEOUT',
      'PA_DEFAULT_REQUEST_TIMEOUT',
      'documented_default_120s',
    ],
    perRequest: hasPerRequest ? perRequest : null,
    gracefulStop: globalDefault,
  };
}

/**
 * Emit JS constants + resolver used by generated K6 scripts.
 */
function buildTimeoutCodegen(requests, agentDefault) {
  const meta = buildTimeoutMetadata({ requests, agentDefault });
  const postmanMap = {};
  for (const req of requests || []) {
    const id = req.requestId;
    if (!id) continue;
    const ms = extractPostmanRequestTimeoutMs(req);
    if (ms != null) postmanMap[id] = msToDuration(ms);
  }

  const lines = [
    `// Request timeout precedence:`,
    `//   1) Postman per-request timeout (when exported)`,
    `//   2) __ENV.REQUEST_TIMEOUT_<REQUEST_ID>`,
    `//   3) __ENV.REQUEST_TIMEOUT`,
    `//   4) __ENV.PA_DEFAULT_REQUEST_TIMEOUT (set at script generation: ${meta.defaultTimeout})`,
    `//   5) documented default ${DEFAULT_REQUEST_TIMEOUT}`,
    `const DEFAULT_REQUEST_TIMEOUT = ${JSON.stringify(DEFAULT_REQUEST_TIMEOUT)};`,
    `const PA_DEFAULT_REQUEST_TIMEOUT = ${JSON.stringify(meta.defaultTimeout)};`,
    `const __POSTMAN_REQUEST_TIMEOUT = ${JSON.stringify(postmanMap)};`,
    `function __requestTimeout(requestId) {`,
    `  const id = requestId || '';`,
    `  const postman = id && __POSTMAN_REQUEST_TIMEOUT[id];`,
    `  if (postman) return postman;`,
    `  const perKey = id ? 'REQUEST_TIMEOUT_' + id.toUpperCase() : '';`,
    `  const per = perKey && typeof __ENV[perKey] === 'string' ? __ENV[perKey].trim() : '';`,
    `  if (per) return per;`,
    `  const global = typeof __ENV.REQUEST_TIMEOUT === 'string' ? __ENV.REQUEST_TIMEOUT.trim() : '';`,
    `  if (global) return global;`,
    `  const gen = typeof __ENV.PA_DEFAULT_REQUEST_TIMEOUT === 'string' ? __ENV.PA_DEFAULT_REQUEST_TIMEOUT.trim() : '';`,
    `  if (gen) return gen;`,
    `  return DEFAULT_REQUEST_TIMEOUT;`,
    `}`,
  ];
  return { codegen: lines.join('\n'), metadata: meta };
}

module.exports = {
  DEFAULT_REQUEST_TIMEOUT,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  durationToMs,
  msToDuration,
  clampDuration,
  extractPostmanRequestTimeoutMs,
  resolveGeneratedRequestTimeout,
  buildTimeoutMetadata,
  buildTimeoutCodegen,
};
