import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { runsApi } from '../../shared/api/runs.api.js';

/**
 * Runtime resolution priority enforced end-to-end:
 *   1. Manual UI-entered runtime values (this component) — locked override
 *   2. Runtime-extracted auth tokens (from setup() in the K6 script)
 *   3. Environment variables baked into the script via __ENV
 *   4. Collection variables baked into the script
 *   5. Empty fallback
 *
 * Anything the user types here is sent to the API and forwarded to K6 as a
 * top-priority __ENV value. The script reads __ENV first before consulting
 * any captured runtime data, so a manual override always wins.
 */

// First-class secrets we surface up front. The user can also add arbitrary
// custom keys via the "Custom overrides" editor below.
const SECRET_KEYS = ['AUTH_TOKEN', 'JWT_TOKEN', 'SESSION_ID', 'HOST_PATH', 'API_KEY'];
const SECRET_FIELD = (k) =>
  /token|jwt|session|key|secret|auth|bearer|password/i.test(k);
const RESERVED_KEYS = new Set(['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP']);
const VALID_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function hasValue(v) {
  return v != null && String(v).trim().length > 0;
}

/**
 * Visual override badge. Shown next to any field the user has typed into so
 * it's obvious which variables are locked at the highest priority.
 */
function OverrideBadge() {
  return (
    <span
      className="ml-2 inline-flex items-center gap-1 rounded-full border border-amber-600 bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
      title="Manual override — wins over collection / environment / runtime values"
    >
      <span className="status-dot bg-amber-400" />
      manual override
    </span>
  );
}

export default function RunLauncher({
  script,
  manualToken,
  credentialDataset = '',
  credentialReuse = false,
}) {
  const navigate = useNavigate();
  const [env, setEnv] = useState({});
  const [secrets, setSecrets] = useState({
    AUTH_TOKEN: manualToken || '',
    JWT_TOKEN: '',
    SESSION_ID: '',
    HOST_PATH: '',
    API_KEY: '',
  });
  // User-defined extra overrides. Each row is { key, value } and ships under
  // the same `env` payload. The API accepts any valid identifier — the user
  // typing it counts as consent for that key.
  const [customRows, setCustomRows] = useState([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  // If the parent passes an updated manualToken later, reflect it.
  useEffect(() => {
    if (manualToken !== undefined) {
      setSecrets((prev) => ({ ...prev, AUTH_TOKEN: manualToken || prev.AUTH_TOKEN }));
    }
  }, [manualToken]);

  const expected = script?.expectedEnvVars || [];
  const chainEnabled = script?.authFlow?.enabled === true;

  const publicVars = useMemo(
    () => expected.filter((k) => !SECRET_KEYS.includes(k) && !SECRET_FIELD(k)),
    [expected]
  );
  const expectedSecretKeys = useMemo(
    () =>
      Array.from(
        new Set([
          ...expected.filter((k) => SECRET_KEYS.includes(k) || SECRET_FIELD(k)),
          ...(script?.injectAuthToken && !chainEnabled ? ['AUTH_TOKEN'] : []),
        ])
      ).filter((k) => !(chainEnabled && k === 'AUTH_TOKEN')),
    [expected, script, chainEnabled]
  );

  // Compute missing variables in real time. A manual override (non-empty
  // value in either env or secrets) satisfies the requirement regardless of
  // where else it could come from.
  const missingPublic = useMemo(
    () =>
      publicVars.filter((k) => {
        const v = env[k];
        const fromCustom = customRows.find((r) => r.key === k);
        return !hasValue(v) && !hasValue(fromCustom?.value);
      }),
    [publicVars, env, customRows]
  );

  const missingSecrets = useMemo(
    () =>
      expectedSecretKeys.filter((k) => {
        const v = secrets[k];
        const fromCustom = customRows.find((r) => r.key === k);
        return !hasValue(v) && !hasValue(fromCustom?.value);
      }),
    [expectedSecretKeys, secrets, customRows]
  );

  const missingAll = useMemo(
    () => [...missingPublic, ...missingSecrets],
    [missingPublic, missingSecrets]
  );
  const blocked = missingAll.length > 0;

  // The set of keys the user has explicitly overridden right now (only
  // counted when the value is non-empty so half-typed entries don't trigger
  // the badge prematurely).
  const activeOverrides = useMemo(() => {
    const out = new Set();
    for (const [k, v] of Object.entries(env)) {
      if (hasValue(v) && VALID_KEY_RE.test(k) && !RESERVED_KEYS.has(k)) out.add(k);
    }
    for (const [k, v] of Object.entries(secrets)) {
      if (hasValue(v) && VALID_KEY_RE.test(k) && !RESERVED_KEYS.has(k)) out.add(k);
    }
    for (const r of customRows) {
      if (hasValue(r.value) && VALID_KEY_RE.test(r.key) && !RESERVED_KEYS.has(r.key)) {
        out.add(r.key);
      }
    }
    return out;
  }, [env, secrets, customRows]);

  // Detect tokens the user pasted with a "Bearer " prefix so we can show a
  // helpful hint that the system will normalize the Authorization header.
  const bearerPrefixed = useMemo(() => {
    const out = [];
    for (const k of ['AUTH_TOKEN', 'JWT_TOKEN']) {
      const v = secrets[k];
      if (typeof v === 'string' && /^\s*Bearer\s+/i.test(v)) out.push(k);
    }
    return out;
  }, [secrets]);

  const onStart = async (force = false) => {
    setStarting(true);
    setError(null);
    try {
      // Build payload. We split the user's overrides into env (public) vs
      // secrets (token-ish) for readable server logs, but the backend treats
      // every non-empty manual value as a locked override either way.
      const customEnv = {};
      const customSecrets = {};
      for (const r of customRows) {
        if (!hasValue(r.value)) continue;
        if (!VALID_KEY_RE.test(r.key) || RESERVED_KEYS.has(r.key)) continue;
        if (SECRET_FIELD(r.key)) customSecrets[r.key] = r.value;
        else customEnv[r.key] = r.value;
      }
      const cleanedSecrets = {
        ...Object.fromEntries(
          Object.entries(secrets).filter(([, v]) => hasValue(v))
        ),
        ...customSecrets,
      };
      const cleanedEnv = { ...env, ...customEnv };

      const data = await runsApi.start({
        scriptId: script.id,
        env: cleanedEnv,
        secrets: cleanedSecrets,
        force,
        credentialDataset: credentialDataset || undefined,
        credentialReuse: credentialReuse || undefined,
      });
      navigate(`/runs/${data.runId}`);
    } catch (err) {
      if (err.code === 'MISSING_ENV_VARS' && err.details?.missing?.length) {
        setError(`Missing required env vars: ${err.details.missing.join(', ')}`);
      } else {
        setError(err.message);
      }
    } finally {
      setStarting(false);
    }
  };

  const updateCustom = (idx, patch) => {
    setCustomRows((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const addCustom = () => setCustomRows((prev) => [...prev, { key: '', value: '' }]);
  const removeCustom = (idx) =>
    setCustomRows((prev) => prev.filter((_, i) => i !== idx));

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Run test</h3>
          <p className="mt-1 text-xs text-soft">
            Provide runtime env vars. Manual values you type here are{' '}
            <span className="font-semibold text-amber-700">locked overrides</span> and always
            win over collection / environment / runtime-extracted values.
            Secrets are passed to K6 in-memory only and never stored.
          </p>
        </div>
        {activeOverrides.size > 0 && (
          <div className="text-[11px] font-semibold text-amber-700">
            {activeOverrides.size} manual override{activeOverrides.size === 1 ? '' : 's'} active
          </div>
        )}
      </div>

      {chainEnabled && (
        <div className="mt-3 rounded-md border border-emerald-600 bg-emerald-50 p-3 text-xs text-emerald-800">
          <div className="font-semibold text-emerald-900">Auto auth chain enabled</div>
          <div className="mt-1">
            The login API will run before iterations and the extracted token
            will be injected into dependent requests automatically.{' '}
            {activeOverrides.has('AUTH_TOKEN') ? (
              <>
                You provided a manual{' '}
                <code className="font-semibold text-emerald-900">AUTH_TOKEN</code> — it will
                shadow the runtime-extracted token for every request that
                needs auth.
              </>
            ) : (
              <>
                <code className="font-semibold text-emerald-900">AUTH_TOKEN</code> below is
                optional — only fill it as a manual fallback if the chain
                might fail.
              </>
            )}
          </div>
        </div>
      )}

      {publicVars.length > 0 && (
        <div className="mt-4">
          <div className="label">Public env vars</div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {publicVars.map((k) => {
              const isMissing = missingPublic.includes(k);
              const overridden = activeOverrides.has(k);
              return (
                <div key={k}>
                  <label className="flex items-center text-xs text-soft">
                    <span>{k}</span>
                    {overridden && <OverrideBadge />}
                    {isMissing && (
                      <span className="ml-2 font-semibold text-amber-700">required</span>
                    )}
                  </label>
                  <input
                    className={[
                      'input mt-1',
                      isMissing ? 'border-amber-600 focus:border-amber-500' : '',
                      overridden ? 'border-amber-500/50' : '',
                    ].join(' ')}
                    value={env[k] || ''}
                    onChange={(e) => setEnv({ ...env, [k]: e.target.value })}
                    placeholder={k === 'BASE_URL' ? 'https://api.example.com' : ''}
                    aria-label={k}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-4">
        <div className="label">Secrets (optional unless required by script)</div>
        <p className="text-[11px] text-soft mt-0 mb-2">
          Tokens may be pasted with or without the <code>Bearer </code>{' '}
          prefix; the system normalizes Authorization headers automatically so
          you'll never end up with <code>Bearer Bearer ey…</code>.
        </p>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {SECRET_KEYS.map((k) => {
            const required = expectedSecretKeys.includes(k);
            const isMissing = required && missingSecrets.includes(k);
            const overridden = activeOverrides.has(k);
            return (
              <div key={k}>
                <label className="flex items-center text-xs text-soft">
                  <span>{k}</span>
                  {overridden && <OverrideBadge />}
                  {required && (
                    <span className="ml-2 font-semibold text-amber-700">required</span>
                  )}
                </label>
                <input
                  type="password"
                  autoComplete="off"
                  spellCheck="false"
                  className={[
                    'input mt-1 font-mono',
                    isMissing ? 'border-amber-600 focus:border-amber-500' : '',
                    overridden ? 'border-amber-500/50' : '',
                  ].join(' ')}
                  value={secrets[k]}
                  onChange={(e) => setSecrets({ ...secrets, [k]: e.target.value })}
                  placeholder={k === 'AUTH_TOKEN' ? 'eyJhbGciOi...' : ''}
                  aria-label={k}
                />
              </div>
            );
          })}
        </div>
      </div>

      {bearerPrefixed.length > 0 && (
        <div className="mt-3 rounded-md border border-sky-600 bg-sky-50 p-2.5 text-[11px] text-sky-800">
          {bearerPrefixed.join(', ')} starts with{' '}
          <code className="font-semibold text-sky-900">Bearer </code> — the prefix will be
          stripped before storage and re-added exactly once on the
          Authorization header.
        </div>
      )}

      {/* Custom overrides — any key the user wants to lock for this run. */}
      <div className="mt-5">
        <div className="flex items-center justify-between">
          <div className="label !mb-0">Custom overrides (advanced)</div>
          <button
            type="button"
            className="btn-ghost !px-2 !py-1 text-xs"
            onClick={addCustom}
          >
            + Add override
          </button>
        </div>
        <p className="text-[11px] text-soft mt-1">
          Add any variable referenced by your collection (for example{' '}
          <code>OPTICKS_BASE_URL</code>). Manual entries here are locked
          overrides and bypass auto-resolution entirely.
        </p>
        {customRows.length > 0 && (
          <div className="mt-2 space-y-2">
            {customRows.map((row, i) => {
              const validKey = !row.key || VALID_KEY_RE.test(row.key);
              const isReserved = RESERVED_KEYS.has(row.key);
              const overridden = hasValue(row.value) && validKey && !isReserved;
              return (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <div className="flex-1 min-w-[10rem]">
                    <input
                      className={[
                        'input',
                        !validKey || isReserved
                          ? 'border-rose-600 focus:border-rose-500'
                          : overridden
                          ? 'border-amber-500/50'
                          : '',
                      ].join(' ')}
                      placeholder="KEY (e.g. OPTICKS_BASE_URL)"
                      value={row.key}
                      onChange={(e) =>
                        updateCustom(i, { key: e.target.value.trim() })
                      }
                      aria-label={`Custom override key ${i + 1}`}
                    />
                  </div>
                  <div className="flex-[2] min-w-[12rem]">
                    <input
                      className={[
                        'input',
                        SECRET_FIELD(row.key) ? 'font-mono' : '',
                        overridden ? 'border-amber-500/50' : '',
                      ].join(' ')}
                      type={SECRET_FIELD(row.key) ? 'password' : 'text'}
                      autoComplete="off"
                      spellCheck="false"
                      placeholder="value"
                      value={row.value}
                      onChange={(e) => updateCustom(i, { value: e.target.value })}
                      aria-label={`Custom override value ${i + 1}`}
                    />
                  </div>
                  <button
                    type="button"
                    className="btn-ghost !px-2 !py-2"
                    onClick={() => removeCustom(i)}
                    title="Remove"
                    aria-label="Remove override"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            <div className="text-[11px] text-soft">
              {customRows.some((r) => RESERVED_KEYS.has(r.key)) && (
                <span className="text-rose-700">
                  Reserved keys (PATH, etc.) are ignored.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {blocked && (
        <div className="mt-4 rounded-md border border-amber-600 bg-amber-50 p-3 text-sm text-amber-800">
          <div className="font-semibold">Cannot start: unresolved variables</div>
          <div className="mt-1 text-xs">
            The generated K6 script references the following env vars but no
            value was provided. Fill them in (or upload an environment that
            defines them):
          </div>
          <ul className="mt-2 list-disc pl-5 font-mono text-xs">
            {missingAll.map((k) => (
              <li key={k}>{k}</li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn-primary"
          onClick={() => onStart(false)}
          disabled={starting || blocked}
          title={blocked ? 'Resolve the missing variables first' : undefined}
        >
          {starting ? 'Starting…' : 'Run test'}
        </button>
        {blocked && (
          <button
            className="btn-secondary"
            onClick={() => onStart(true)}
            disabled={starting}
            title="Bypass the env-var check and start anyway"
          >
            Run anyway
          </button>
        )}
      </div>
    </div>
  );
}
