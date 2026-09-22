'use strict';

/**
 * Phase 6 — Standardized workload profiles.
 *
 * The Performance Agent supports six workload profiles. Each maps to an
 * idiomatic K6 executor + scenario configuration and preserves the same
 * request execution loop (default export) — only the WORKLOAD SHAPE
 * changes across profiles, never the request generation code.
 *
 * Profile semantics (the "what" — the how lives in `buildScenarioConfig`):
 *
 *   smoke   Very low VU count, short hold, no ramping. Sanity check that
 *           the flow works at all. Executor: constant-vus.
 *   load    Sustained expected traffic. Controlled ramp-up, hold, and
 *           ramp-down using the four UI fields (vus/rampUp/hold/rampDown).
 *           Executor: ramping-vus. This is the historical default and
 *           preserves the pre-Phase-6 behaviour when the user picks it.
 *   stress  Progressive increase to peak. Multi-stage ramping-vus with
 *           four increasing plateaus (25 / 50 / 75 / 100 % of the target
 *           VU count) so degradation appears in the report as a shape,
 *           not a cliff. Executor: ramping-vus.
 *   spike   Rapid ramp to a high VU count, brief hold, rapid ramp-down.
 *           Executor: ramping-vus with aggressive short durations. The
 *           point is to test recovery, not sustained load.
 *   soak    Modest VU count held for a long duration to expose slow leaks
 *           / connection-pool exhaustion / GC pressure. Executor:
 *           ramping-vus with short ramp phases and a long hold.
 *   custom  Fully user-driven — the caller supplies vus/rampUp/hold/
 *           rampDown and gets exactly a 3-stage ramping-vus scenario.
 *           This is the legacy loadProfile shape and MUST stay
 *           backward compatible.
 *
 * The module is deliberately compact: it exposes defaults, a validator +
 * normalizer, and a scenario builder. Everything else (script emission,
 * report enrichment, UI wiring) reads from the normalized output only.
 */

const DURATION_RE = /^\d+(?:\.\d+)?(ms|s|m|h)$/;
const {
  AUTH_SESSION_MODE_LIST,
  normalizeAuthSessionConfig,
} = require('./authSessionMode');

const PROFILES = Object.freeze(['smoke', 'load', 'stress', 'spike', 'soak', 'custom']);
const DEFAULT_PROFILE = 'custom';

const PROFILE_LABELS = Object.freeze({
  smoke:  'Smoke',
  load:   'Load',
  stress: 'Stress',
  spike:  'Spike',
  soak:   'Soak',
  custom: 'Custom',
});

const PROFILE_DESCRIPTIONS = Object.freeze({
  smoke:  'Very small controlled load — quick sanity check that the flow works.',
  load:   'Sustained expected traffic with controlled ramp-up, hold, and ramp-down.',
  stress: 'Progressive ramp to peak load across multiple plateaus to expose degradation.',
  spike:  'Rapid ramp to a high VU count, brief hold, rapid ramp-down — recovery test.',
  soak:   'Modest steady load held for a long duration — endurance / leak detection.',
  custom: 'Fully user-driven ramp shape. Uses the supplied VUs / ramp / hold / ramp-down verbatim.',
});

/**
 * Default configuration per profile. `thresholds.errorRate` is applied to
 * `http_req_failed`; `thresholds.p95Ms` is applied to `http_req_duration`.
 * `load` and `custom` intentionally share the historical Phase 3 defaults
 * so the pre-Phase-6 behaviour is preserved for both.
 */
const PROFILE_DEFAULTS = Object.freeze({
  smoke:  { vus: 1,  rampUp: '0s',  hold: '30s', rampDown: '0s',  thresholds: { errorRate: 0.01, p95Ms: 2000 } },
  load:   { vus: 10, rampUp: '30s', hold: '2m',  rampDown: '30s', thresholds: { errorRate: 0.05, p95Ms: 2000 } },
  stress: { vus: 50, rampUp: '30s', hold: '1m',  rampDown: '30s', thresholds: { errorRate: 0.10, p95Ms: 4000 } },
  spike:  { vus: 80, rampUp: '10s', hold: '30s', rampDown: '10s', thresholds: { errorRate: 0.10, p95Ms: 5000 } },
  soak:   { vus: 15, rampUp: '2m',  hold: '1h',  rampDown: '2m',  thresholds: { errorRate: 0.02, p95Ms: 2500 } },
  custom: { vus: 5,  rampUp: '30s', hold: '1m',  rampDown: '30s', thresholds: { errorRate: 0.05, p95Ms: 2000 } },
});

/**
 * Executor selection.
 *
 *   constant-vus  is used ONLY for smoke: the whole point of a smoke is a
 *                 flat, minimal, constant load. Introducing ramp phases
 *                 would defeat the profile's intent.
 *   ramping-vus   is used for every other profile because they all care
 *                 about the SHAPE of load over time (either ramping up
 *                 progressively, spiking, or long-holding). Rate-based
 *                 executors (constant-arrival-rate / ramping-arrival-rate)
 *                 are intentionally NOT used here — they require the
 *                 iteration function to be idempotent and independent per
 *                 iteration, which we cannot guarantee for Postman
 *                 collections whose requests may depend on side effects
 *                 (login → protected request chaining). Sticking with
 *                 VU-based executors preserves the existing shared setup
 *                 + auth model without duplicating request logic.
 */
function executorFor(profile) {
  return profile === 'smoke' ? 'constant-vus' : 'ramping-vus';
}

/**
 * Build the K6 scenario config for the given profile + resolved values.
 * The `tags.workload_profile` entry is what K6 attaches to every metric
 * that originates inside this scenario — reports can filter by it.
 */
function buildScenarioConfig(profile, resolved) {
  const executor = executorFor(profile);
  if (executor === 'constant-vus') {
    return {
      executor,
      vus: resolved.vus,
      duration: resolved.hold,
      tags: { workload_profile: profile },
    };
  }
  return {
    executor,
    startVUs: 0,
    stages: buildStages(profile, resolved),
    tags: { workload_profile: profile },
  };
}

/**
 * Build the stages array for a ramping-vus profile. `stress` is the odd
 * one out — it steps through 25/50/75/100 % of the target VU count so
 * the response-time curve degrades gradually and the report shows the
 * knee. Every other ramping profile uses the classical 3-stage shape.
 */
function buildStages(profile, r) {
  if (profile === 'stress') {
    const q = (frac) => Math.max(1, Math.round(r.vus * frac));
    return [
      { duration: r.rampUp,   target: q(0.25) },
      { duration: r.hold,     target: q(0.25) },
      { duration: r.rampUp,   target: q(0.50) },
      { duration: r.hold,     target: q(0.50) },
      { duration: r.rampUp,   target: q(0.75) },
      { duration: r.hold,     target: q(0.75) },
      { duration: r.rampUp,   target: r.vus },
      { duration: r.hold,     target: r.vus },
      { duration: r.rampDown, target: 0 },
    ];
  }
  return [
    { duration: r.rampUp,   target: r.vus },
    { duration: r.hold,     target: r.vus },
    { duration: r.rampDown, target: 0 },
  ];
}

/**
 * Parse a K6 duration ("30s", "2m", "1h") to milliseconds. Returns 0 for
 * anything unparseable so callers can safely sum values.
 */
function durationToMs(raw) {
  if (typeof raw !== 'string') return 0;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  switch (m[2].toLowerCase()) {
    case 'ms': return n;
    case 's':  return n * 1000;
    case 'm':  return n * 60 * 1000;
    case 'h':  return n * 60 * 60 * 1000;
    default:   return 0;
  }
}

/**
 * Compute the total scenario duration in milliseconds from the stages
 * array (or the constant-vus `duration`).
 */
function computeTotalDurationMs(scenarioConfig) {
  if (!scenarioConfig) return 0;
  if (scenarioConfig.duration) return durationToMs(scenarioConfig.duration);
  if (Array.isArray(scenarioConfig.stages)) {
    return scenarioConfig.stages.reduce((sum, s) => sum + durationToMs(s.duration), 0);
  }
  return 0;
}

/**
 * Detect whether an input object looks like a legacy loadProfile payload
 * (i.e. it carries the four UI fields but no `profile` key). Used only by
 * `normalizeWorkload` to route legacy callers into the 'custom' profile.
 */
function isLegacyLoadProfile(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.profile != null) return false;
  return (
    input.vus != null ||
    input.rampUp != null ||
    input.hold != null ||
    input.rampDown != null
  );
}

/**
 * Normalize any workload input into the canonical internal shape. Accepts:
 *   1. `{ profile, overrides? }`                — Phase 6 input
 *   2. `{ vus, rampUp, hold, rampDown }`        — legacy loadProfile
 *   3. null / undefined                          — falls back to defaults
 *
 * Throws when supplied values are invalid so the caller can surface a
 * 400 with a stable code. Never mutates input.
 *
 * @returns {{
 *   profile: 'smoke'|'load'|'stress'|'spike'|'soak'|'custom',
 *   label: string,
 *   description: string,
 *   executor: 'constant-vus'|'ramping-vus',
 *   vus: number,
 *   rampUp: string,
 *   hold: string,
 *   rampDown: string,
 *   thresholds: { errorRate: number, p95Ms: number },
 *   scenarioName: string,
 *   scenarios: object,
 *   loadProfile: { vus, rampUp, hold, rampDown },  // legacy-shaped mirror
 *   totalDurationMs: number,
 *   isDefault: boolean,
 * }}
 */
function normalizeWorkload(input, context = {}) {
  // Phase 6.5 audit fix: normalizeWorkload must be idempotent.
  // Callers (notably the generator's own resilience path in
  // generateK6Script) may hand an already-normalized workload back
  // through this function. The pre-fix version silently reverted to
  // profile defaults because a normalized output has no `.overrides`
  // key. Detect the normalized shape and return it unchanged instead of
  // dropping the caller's resolved values.
  if (
    input &&
    typeof input === 'object' &&
    typeof input.profile === 'string' &&
    typeof input.executor === 'string' &&
    input.scenarios &&
    typeof input.scenarios === 'object' &&
    input.thresholds &&
    typeof input.thresholds === 'object'
  ) {
    return input;
  }
  if (isLegacyLoadProfile(input)) {
    return normalizeWorkload({ profile: 'custom', overrides: input });
  }
  const src = input && typeof input === 'object' ? input : {};

  const profile = PROFILES.includes(src.profile) ? src.profile : DEFAULT_PROFILE;
  const defaults = PROFILE_DEFAULTS[profile];
  const overrides = src.overrides && typeof src.overrides === 'object' ? src.overrides : {};

  const vus = overrides.vus != null ? Number(overrides.vus) : defaults.vus;
  const rampUp = overrides.rampUp != null ? String(overrides.rampUp) : defaults.rampUp;
  const hold = overrides.hold != null ? String(overrides.hold) : defaults.hold;
  const rampDown = overrides.rampDown != null ? String(overrides.rampDown) : defaults.rampDown;

  const errorRate =
    overrides.thresholds?.errorRate != null
      ? Number(overrides.thresholds.errorRate)
      : defaults.thresholds.errorRate;
  const p95Ms =
    overrides.thresholds?.p95Ms != null
      ? Number(overrides.thresholds.p95Ms)
      : defaults.thresholds.p95Ms;

  if (!Number.isFinite(vus) || vus < 1 || vus > 1000) {
    throw new Error('vus must be an integer between 1 and 1000');
  }
  for (const [k, v] of [
    ['rampUp', rampUp],
    ['hold', hold],
    ['rampDown', rampDown],
  ]) {
    if (typeof v !== 'string' || !DURATION_RE.test(v)) {
      throw new Error(`${k} must match a duration like "30s", "2m", "1h"`);
    }
  }
  if (!Number.isFinite(errorRate) || errorRate < 0 || errorRate > 1) {
    throw new Error('thresholds.errorRate must be a number between 0 and 1');
  }
  if (!Number.isFinite(p95Ms) || p95Ms <= 0) {
    throw new Error('thresholds.p95Ms must be a positive number');
  }

  const resolved = { vus: Math.round(vus), rampUp, hold, rampDown };
  const executor = executorFor(profile);
  const scenarioName = profile;
  const scenarioConfig = buildScenarioConfig(profile, resolved);
  const totalDurationMs = computeTotalDurationMs(scenarioConfig);
  const authSession = normalizeAuthSessionConfig(
    {
      authSessionMode: src.authSessionMode,
      credentialReuse: src.credentialReuse,
    },
    {
      authFlowEnabled: !!context.authFlowEnabled,
      injectAuthToken: !!context.injectAuthToken,
    }
  );

  return {
    profile,
    label: PROFILE_LABELS[profile],
    description: PROFILE_DESCRIPTIONS[profile],
    executor,
    vus: resolved.vus,
    rampUp: resolved.rampUp,
    hold: resolved.hold,
    rampDown: resolved.rampDown,
    thresholds: { errorRate, p95Ms },
    scenarioName,
    scenarios: { [scenarioName]: scenarioConfig },
    loadProfile: {
      vus: resolved.vus,
      rampUp: resolved.rampUp,
      hold: resolved.hold,
      rampDown: resolved.rampDown,
    },
    totalDurationMs,
    isDefault:
      profile === DEFAULT_PROFILE &&
      resolved.vus === PROFILE_DEFAULTS.custom.vus &&
      resolved.rampUp === PROFILE_DEFAULTS.custom.rampUp &&
      resolved.hold === PROFILE_DEFAULTS.custom.hold &&
      resolved.rampDown === PROFILE_DEFAULTS.custom.rampDown,
    authSessionMode: authSession.authSessionMode,
    credentialReuse: authSession.credentialReuse,
  };
}

/**
 * Public-safe view of a normalized workload for API responses / manifests.
 * Same shape minus the K6 scenarios blob (which is only useful to the
 * generator).
 */
function publicWorkload(workload) {
  if (!workload) return null;
  return {
    profile: workload.profile,
    label: workload.label,
    description: workload.description,
    executor: workload.executor,
    vus: workload.vus,
    rampUp: workload.rampUp,
    hold: workload.hold,
    rampDown: workload.rampDown,
    thresholds: workload.thresholds,
    totalDurationMs: workload.totalDurationMs,
    authSessionMode: workload.authSessionMode || null,
    credentialReuse: !!workload.credentialReuse,
  };
}

module.exports = {
  AUTH_SESSION_MODE_LIST,
  PROFILES,
  DEFAULT_PROFILE,
  PROFILE_LABELS,
  PROFILE_DESCRIPTIONS,
  PROFILE_DEFAULTS,
  executorFor,
  buildScenarioConfig,
  buildStages,
  durationToMs,
  computeTotalDurationMs,
  isLegacyLoadProfile,
  normalizeWorkload,
  publicWorkload,
};
