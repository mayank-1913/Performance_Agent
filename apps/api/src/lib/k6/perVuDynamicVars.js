'use strict';

/**
 * Per-VU dynamic test data.
 *
 * Independent of authentication. A workload may opt into generating
 * selected variable values ONCE per virtual user at K6 runtime, then
 * reuse the same value for every request executed by that VU. Different
 * VUs receive different values.
 *
 * Config shape:
 *
 *   dynamicVariables: {
 *     mode: 'DISABLED' | 'PER_VU',
 *     variables: [
 *       { name: 'Test_did',       generator: 'uuid' },
 *       { name: 'Test_ip',        generator: 'ipv4' },
 *       { name: 'Test_useragent', generator: 'userAgent' },
 *     ],
 *   }
 *
 * `name` is the Postman placeholder name (what sits between `{{` and `}}`
 * in the collection). `generator` is one of the supported producers below.
 *
 * Runtime behavior inside the generated K6 script:
 *   - The emitted script keeps a module-scoped cache populated lazily on
 *     first access per VU. K6 instantiates a fresh JS runtime for every
 *     VU, so module-scoped state is naturally VU-local.
 *   - `__getPerVuVar(name)` returns the cached value and generates on
 *     the first call per VU.
 *   - The interpolator emits `__getPerVuVar(...)` as the HIGHEST-priority
 *     source for a configured variable so any static env / collection
 *     value with the same name is shadowed. This matches the task spec
 *     ("ensure the request URL uses the generated value rather than the
 *     static environment value").
 */

const SUPPORTED_GENERATORS = Object.freeze([
  'uuid',
  'ipv4',
  'userAgent',
  'randomInt',
  'timestamp',
]);

const GENERATOR_LABELS = Object.freeze({
  uuid: 'UUID v4',
  ipv4: 'Random IPv4',
  userAgent: 'Random User-Agent',
  randomInt: 'Random integer (0–1,000,000)',
  timestamp: 'Unix timestamp (seconds)',
});

const DEFAULT_CONFIG = Object.freeze({
  mode: 'DISABLED',
  variables: Object.freeze([]),
});

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Normalize a user-supplied dynamicVariables config into a safe, canonical
 * shape. Invalid entries are dropped silently (API callers already get
 * schema validation at the controller edge).
 */
function normalizeDynamicVariables(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONFIG };
  const mode = raw.mode === 'PER_VU' ? 'PER_VU' : 'DISABLED';
  if (mode === 'DISABLED') return { mode, variables: [] };
  const seen = new Set();
  const variables = [];
  const rawList = Array.isArray(raw.variables) ? raw.variables : [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!name || !VAR_NAME_RE.test(name)) continue;
    if (seen.has(name)) continue;
    const generator = typeof entry.generator === 'string' ? entry.generator : '';
    if (!SUPPORTED_GENERATORS.includes(generator)) continue;
    seen.add(name);
    variables.push({ name, generator });
  }
  return { mode: variables.length > 0 ? 'PER_VU' : 'DISABLED', variables };
}

function isEnabled(config) {
  return !!(config && config.mode === 'PER_VU' && Array.isArray(config.variables) && config.variables.length > 0);
}

function placeholderNames(config) {
  if (!isEnabled(config)) return [];
  return config.variables.map((v) => v.name);
}

/**
 * Build the K6 runtime block.
 *
 * Emits:
 *   - `const __PER_VU_DYNAMIC_SPEC = {...}`: map of placeholder-name →
 *     generator id, used only for documentation and debug visibility.
 *   - `let __perVuDynamicCache = null`: module-scoped per-VU cache.
 *   - `function __generatePerVuValue(gen)`: producer dispatch.
 *   - `function __getPerVuVar(name)`: cache-aware accessor used by the
 *     interpolator.
 */
function buildPerVuDynamicRuntimeJs(config) {
  const normalized = normalizeDynamicVariables(config);
  if (!isEnabled(normalized)) return '';
  const specLiteral = JSON.stringify(
    Object.fromEntries(normalized.variables.map((v) => [v.name, v.generator]))
  );
  return [
    `// ---- PER-VU DYNAMIC TEST DATA ---------------------------------------------`,
    `// Independent of authentication. Each VU generates one value per`,
    `// configured variable on first access and reuses it for every request`,
    `// in that VU's execution. K6 runs each VU in an isolated JS runtime so`,
    `// module-scoped state is naturally VU-local.`,
    `const __PER_VU_DYNAMIC_SPEC = ${specLiteral};`,
    `let __perVuDynamicCache = null;`,
    ``,
    `function __generatePerVuValue(generator) {`,
    `  switch (generator) {`,
    `    case 'uuid': {`,
    `      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {`,
    `        return crypto.randomUUID();`,
    `      }`,
    `      // RFC 4122 v4 fallback without WebCrypto. 32 hex chars + variant bits.`,
    `      const h = '0123456789abcdef';`,
    `      let s = '';`,
    `      for (let i = 0; i < 32; i++) {`,
    `        let v = Math.floor(Math.random() * 16);`,
    `        if (i === 12) v = 4;`,
    `        else if (i === 16) v = (v & 0x3) | 0x8;`,
    `        s += h[v];`,
    `      }`,
    `      return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);`,
    `    }`,
    `    case 'ipv4': {`,
    `      const o = () => Math.floor(Math.random() * 254) + 1;`,
    `      return o() + '.' + o() + '.' + o() + '.' + o();`,
    `    }`,
    `    case 'userAgent': {`,
    `      // A stable, small preset. The exact list is not security-sensitive;`,
    `      // any coverage of common UAs is enough for load testing.`,
    `      const pool = [`,
    `        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',`,
    `        'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',`,
    `        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',`,
    `        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',`,
    `        'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',`,
    `      ];`,
    `      return pool[Math.floor(Math.random() * pool.length)];`,
    `    }`,
    `    case 'randomInt':`,
    `      return String(Math.floor(Math.random() * 1000000));`,
    `    case 'timestamp':`,
    `      return String(Math.floor(Date.now() / 1000));`,
    `    default:`,
    `      return '';`,
    `  }`,
    `}`,
    ``,
    `function __getPerVuVar(name) {`,
    `  if (!__perVuDynamicCache) {`,
    `    __perVuDynamicCache = {};`,
    `    for (const key in __PER_VU_DYNAMIC_SPEC) {`,
    `      if (Object.prototype.hasOwnProperty.call(__PER_VU_DYNAMIC_SPEC, key)) {`,
    `        __perVuDynamicCache[key] = __generatePerVuValue(__PER_VU_DYNAMIC_SPEC[key]);`,
    `      }`,
    `    }`,
    `  }`,
    `  return Object.prototype.hasOwnProperty.call(__perVuDynamicCache, name)`,
    `    ? __perVuDynamicCache[name]`,
    `    : '';`,
    `}`,
    `// ---------------------------------------------------------------------------`,
  ].join('\n');
}

function publicDynamicVariables(config) {
  const normalized = normalizeDynamicVariables(config);
  return {
    mode: normalized.mode,
    variables: normalized.variables.map((v) => ({ ...v })),
  };
}

module.exports = {
  SUPPORTED_GENERATORS,
  GENERATOR_LABELS,
  DEFAULT_CONFIG,
  normalizeDynamicVariables,
  isEnabled,
  placeholderNames,
  buildPerVuDynamicRuntimeJs,
  publicDynamicVariables,
};
