const MODE_META = {
  AUTO_MANAGED: {
    label: 'Auto-managed',
    detail: 'Collection handles authentication automatically.',
    tone: 'emerald',
  },
  ENV_MANAGED: {
    label: 'Environment-managed',
    detail: 'Token resolved from environment variables.',
    tone: 'sky',
  },
  MANUAL_REQUIRED: {
    label: 'Manual token required',
    detail: 'No usable token found. Provide a Bearer token below.',
    tone: 'amber',
  },
  NONE: {
    label: 'No auth detected',
    detail: 'Collection appears to be unauthenticated.',
    tone: 'slate',
  },
};

// Tone-aware colour tokens, light-theme calibrated.
// - container: faint tint + stronger border + near-black primary text.
// - label:     tone-coloured but AA-contrast on the tint.
// - code:      slightly darker tone colour for the mode identifier.
const TONES = {
  emerald: {
    container: 'bg-emerald-50 border-emerald-300 text-emerald-900',
    label: 'text-emerald-700',
    code: 'text-emerald-800',
  },
  sky: {
    container: 'bg-sky-50 border-sky-300 text-sky-900',
    label: 'text-sky-700',
    code: 'text-sky-800',
  },
  amber: {
    container: 'bg-amber-50 border-amber-300 text-amber-900',
    label: 'text-amber-800',
    code: 'text-amber-900',
  },
  slate: {
    container: 'bg-gray-50 border-gray-300 text-ink-900',
    label: 'text-ink-600',
    code: 'text-ink-700',
  },
};

export default function AuthStatusBadge({ auth }) {
  if (!auth) return null;
  const meta = MODE_META[auth.mode] || MODE_META.NONE;
  const tone = TONES[meta.tone] || TONES.slate;

  return (
    <div className={`rounded-md border p-4 ${tone.container}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Auth: {meta.label}</div>
        <code className={`text-xs ${tone.code}`}>{auth.mode}</code>
      </div>
      <p className="mt-1 text-xs">{meta.detail}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className={tone.label}>Requests with Authorization header</dt>
        <dd>{auth.requestsWithAuthHeader} / {auth.totalRequests}</dd>
        {auth.loginRequest && (
          <>
            <dt className={tone.label}>Login request</dt>
            <dd className="truncate">{auth.loginRequest.method} {auth.loginRequest.url}</dd>
          </>
        )}
        {auth.referencedTokenVars?.length > 0 && (
          <>
            <dt className={tone.label}>Token variables referenced</dt>
            <dd className="font-mono">{auth.referencedTokenVars.join(', ')}</dd>
          </>
        )}
        {auth.unresolvedTokenVars?.length > 0 && (
          <>
            <dt className={tone.label}>Unresolved</dt>
            <dd className="font-mono text-amber-700">
              {auth.unresolvedTokenVars.join(', ')}
            </dd>
          </>
        )}
        {auth.environment?.provided && (
          <>
            <dt className={tone.label}>Environment file</dt>
            <dd>provided ({auth.environment.tokenVars.length} token vars)</dd>
          </>
        )}
      </dl>
    </div>
  );
}
