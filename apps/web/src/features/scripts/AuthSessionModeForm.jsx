const MODES = [
  {
    id: 'SHARED_SESSION',
    label: 'Shared session',
    hint: 'One login before the test; all VUs reuse the same token.',
  },
  {
    id: 'PER_VU_LOGIN',
    label: 'Per-VU login',
    hint: 'Each VU logs in independently with isolated tokens and captured variables.',
  },
  {
    id: 'MANUAL_TOKEN',
    label: 'Manual token',
    hint: 'Use the manually supplied token only — no automatic login.',
  },
];

/**
 * Authentication / session mode selector for multi-VU testing.
 *
 * @param {object} props
 * @param {string|null} props.authSessionMode
 * @param {boolean} props.credentialReuse
 * @param {string} props.credentialDataset  JSON text for multi-user credentials
 * @param {(patch: object) => void} props.onChange
 * @param {boolean} [props.loginDetected]
 */
export default function AuthSessionModeForm({
  authSessionMode,
  credentialReuse,
  credentialDataset,
  onChange,
  loginDetected = false,
}) {
  const mode = authSessionMode || (loginDetected ? 'SHARED_SESSION' : 'MANUAL_TOKEN');
  const set = (patch) => onChange({ authSessionMode: mode, credentialReuse, credentialDataset, ...patch });

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-slate-200">Authentication mode</h3>
      <p className="text-xs text-slate-500 mt-1">
        Choose how authentication is applied across virtual users. This is independent of the
        Postman collection structure.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {MODES.map((m) => {
          const active = m.id === mode;
          const disabled = m.id !== 'MANUAL_TOKEN' && !loginDetected;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => set({ authSessionMode: m.id })}
              className={[
                'rounded px-2.5 py-1 text-xs font-medium border transition',
                active
                  ? 'border-blue-600 bg-blue-50 text-blue-800 shadow-sm'
                  : 'border-slate-300 bg-white text-slate-700 hover:border-blue-400',
                disabled ? 'opacity-40 cursor-not-allowed' : '',
              ].join(' ')}
              title={disabled ? 'Requires a login request in the selected flow' : m.hint}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-slate-600">{MODES.find((m) => m.id === mode)?.hint}</p>

      {mode === 'PER_VU_LOGIN' && (
        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={!!credentialReuse}
              onChange={(e) => set({ credentialReuse: e.target.checked })}
            />
            Allow credential reuse when there are fewer users than VUs
          </label>
          <div>
            <label className="label">Credential dataset (JSON)</label>
            <textarea
              className="input min-h-[6rem] font-mono text-xs"
              placeholder={'[\n  { "id": "user-1", "username": "...", "password": "..." },\n  { "id": "user-2", "username": "...", "password": "..." }\n]'}
              value={credentialDataset || ''}
              onChange={(e) => set({ credentialDataset: e.target.value })}
            />
            <p className="mt-1 text-[11px] text-slate-500">
              Optional at generation time. Provide at run launch if not set here. Values are never
              shown in reports or logs.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
