/**
 * Renders the runtime auth chain produced by the generator:
 *
 *   Login API
 *      ↓
 *   Token extracted (token / access_token / jwt / id_token / bearerToken …)
 *      ↓
 *   APIs using token (N)
 *
 * Reads the `authFlow` field that the API attaches to a script or a run.
 *
 * NOTE on colours
 * --------------------------------------------------------------------
 * This component intentionally uses the `gray-*` scale (NOT `slate-*`).
 *
 * `tailwind.config.js` inverts the `slate` palette for this light theme
 * (slate-100 is near-black, slate-900 is near-white). The inversion is
 * easy to misread, so every text/background/border below is specified
 * with the unambiguous standard-Tailwind `gray-*` scale instead, which
 * is NOT remapped. That removes any risk of accidentally picking the
 * wrong direction in the inverted scale.
 */
export default function AuthFlowDiagram({ authFlow, compact = false }) {
  if (!authFlow) return null;

  if (!authFlow.enabled) {
    return (
      <div className="card">
        <h3 className="text-sm font-semibold text-gray-900">Runtime auth flow</h3>
        <p className="mt-1 text-xs text-gray-700">
          No login API was detected in the current selection. The script will rely on
          <code className="mx-1 font-semibold text-gray-900">__ENV.AUTH_TOKEN</code>
          (manual fallback) or no auth at all.
        </p>
        {Array.isArray(authFlow.reasons) && authFlow.reasons.length > 0 && (
          <ul className="mt-2 list-disc pl-5 text-xs text-gray-700">
            {authFlow.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const targets = authFlow.injectionTargets || [];
  const tokenKeys = authFlow.tokenKeys || [];
  const visibleTargets = compact ? targets.slice(0, 5) : targets;

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-900">Runtime auth flow</h3>
        <span className="rounded border border-emerald-600 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-800">
          chained
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-700">
        Login runs once before iterations; the extracted token is injected into every dependent
        request. The token lives in K6 memory only — it is never persisted to disk or logs.
      </p>

      <div className="mt-4 space-y-2">
        <FlowStep
          tone="sky"
          title="Login API"
          subtitle={`${authFlow.login?.method || ''} ${authFlow.login?.url || ''}`}
        />
        <Arrow />
        <FlowStep
          tone="emerald"
          title="Token extracted"
          subtitle={
            <span className="font-mono text-[11px] text-gray-900">
              {tokenKeys.length > 0
                ? `looks for: ${tokenKeys.join(' · ')}`
                : 'detected via response body'}
            </span>
          }
        />
        <Arrow />
        <FlowStep
          tone="amber"
          title={`APIs using token (${targets.length})`}
          subtitle={
            <ul className="mt-1 space-y-0.5">
              {visibleTargets.length === 0 ? (
                <li className="text-gray-700 text-xs">No dependents — chaining is disabled.</li>
              ) : (
                visibleTargets.map((r, i) => (
                  <li key={i} className="flex items-center gap-2 min-w-0">
                    <span className="rounded border border-gray-700 bg-gray-900 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white shrink-0">
                      {r.method}
                    </span>
                    <span className="truncate font-medium text-gray-900">{r.name}</span>
                    <span className="ml-auto truncate font-mono text-[11px] text-gray-700 max-w-[55%]">
                      {r.url}
                    </span>
                  </li>
                ))
              )}
              {compact && targets.length > visibleTargets.length && (
                <li className="text-xs text-gray-600">
                  …and {targets.length - visibleTargets.length} more
                </li>
              )}
            </ul>
          }
        />
      </div>
    </div>
  );
}

// Tone backgrounds + default heading colour. The FlowStep `title` inherits
// this colour; the `subtitle` is given its own colour at the usage site so
// that nested elements (list items, URLs) read correctly on the tinted
// background without inheriting a tone-coloured text that lowers contrast.
const TONES = {
  sky: 'border-sky-600 bg-sky-50 text-sky-900',
  emerald: 'border-emerald-600 bg-emerald-50 text-emerald-900',
  amber: 'border-amber-600 bg-amber-50 text-amber-900',
  slate: 'border-gray-400 bg-white text-gray-900',
};

function FlowStep({ tone = 'slate', title, subtitle }) {
  return (
    <div className={`rounded-md border p-3 ${TONES[tone] || TONES.slate} min-w-0`}>
      <div className="text-sm font-semibold">{title}</div>
      {subtitle && (
        <div className="mt-0.5 text-xs force-wrap text-gray-900">
          {typeof subtitle === 'string' ? subtitle : subtitle}
        </div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center text-gray-500" aria-hidden>
      <span className="text-lg leading-none">↓</span>
    </div>
  );
}
