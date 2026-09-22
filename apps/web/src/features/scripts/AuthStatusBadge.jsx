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

const TONES = {
  emerald: 'bg-emerald-500/10 text-emerald-300 border-emerald-700/50',
  sky: 'bg-sky-500/10 text-sky-300 border-sky-700/50',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-700/50',
  slate: 'bg-slate-500/10 text-slate-300 border-slate-700/50',
};

export default function AuthStatusBadge({ auth }) {
  if (!auth) return null;
  const meta = MODE_META[auth.mode] || MODE_META.NONE;
  const tone = TONES[meta.tone];

  return (
    <div className={`rounded-md border p-4 ${tone}`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold">Auth: {meta.label}</div>
        <code className="text-xs opacity-70">{auth.mode}</code>
      </div>
      <p className="mt-1 text-xs opacity-90">{meta.detail}</p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <dt className="opacity-70">Requests with Authorization header</dt>
        <dd>{auth.requestsWithAuthHeader} / {auth.totalRequests}</dd>
        {auth.loginRequest && (
          <>
            <dt className="opacity-70">Login request</dt>
            <dd className="truncate">{auth.loginRequest.method} {auth.loginRequest.url}</dd>
          </>
        )}
        {auth.referencedTokenVars?.length > 0 && (
          <>
            <dt className="opacity-70">Token variables referenced</dt>
            <dd className="font-mono">{auth.referencedTokenVars.join(', ')}</dd>
          </>
        )}
        {auth.unresolvedTokenVars?.length > 0 && (
          <>
            <dt className="opacity-70">Unresolved</dt>
            <dd className="font-mono text-amber-300">
              {auth.unresolvedTokenVars.join(', ')}
            </dd>
          </>
        )}
        {auth.environment?.provided && (
          <>
            <dt className="opacity-70">Environment file</dt>
            <dd>provided ({auth.environment.tokenVars.length} token vars)</dd>
          </>
        )}
      </dl>
    </div>
  );
}
