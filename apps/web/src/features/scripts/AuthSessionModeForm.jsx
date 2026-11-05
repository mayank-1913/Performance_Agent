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
  {
    id: 'NONE',
    label: 'No authentication',
    hint:
      'The collection does not require authentication. No login request, no Authorization header injection. Existing collection headers are left untouched.',
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
      <h3 className="text-sm font-semibold text-ink-900">Authentication mode</h3>
      <p className="text-xs text-ink-600 mt-1">
        Choose how authentication is applied across virtual users. This is independent of the
        Postman collection structure.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {MODES.map((m) => {
          const active = m.id === mode;
          // MANUAL_TOKEN and NONE are always available — they do not
          // depend on a detected login request in the collection.
          const disabled =
            m.id !== 'MANUAL_TOKEN' && m.id !== 'NONE' && !loginDetected;
          return (
            <button
              key={m.id}
              type="button"
              disabled={disabled}
              onClick={() => set({ authSessionMode: m.id })}
              className={[
                'rounded-md px-3 py-1.5 text-xs font-semibold border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2',
                active
                  ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm'
                  : 'border-gray-300 bg-white text-ink-700 hover:border-brand-400 hover:bg-brand-50/60',
                disabled ? 'opacity-60 cursor-not-allowed hover:border-gray-300' : '',
              ].join(' ')}
              title={disabled ? 'Requires a login request in the selected flow' : m.hint}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-ink-600">{MODES.find((m) => m.id === mode)?.hint}</p>

      {mode === 'PER_VU_LOGIN' && (
        <div className="mt-4 space-y-3">
          <label className="flex items-center gap-2 text-xs text-ink-700">
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
            <p className="mt-1 text-[11px] text-ink-500">
              Optional at generation time. Provide at run launch if not set here. Values are never
              shown in reports or logs.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
