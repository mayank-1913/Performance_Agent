import { useMemo } from 'react';

/**
 * Independent Dynamic Test Data configuration.
 *
 * Separate from authentication. Lets the user opt in to generating per-VU
 * dynamic values (DID, Device ID, IP, User-Agent, etc.) at K6 runtime.
 *
 * The value for each configured variable is produced ONCE per virtual user
 * and reused across every request executed by that VU. Different VUs
 * receive different values. The backend wires this into the K6 generator
 * so a static environment value with the same name is shadowed — the
 * placeholder resolves to the generated per-VU value.
 */

const GENERATORS = [
  { id: 'uuid', label: 'UUID v4 (recommended for DID / device ID)' },
  { id: 'ipv4', label: 'Random IPv4 address' },
  { id: 'userAgent', label: 'Random User-Agent' },
  { id: 'randomInt', label: 'Random integer' },
  { id: 'timestamp', label: 'Unix timestamp (seconds)' },
];

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function isValidName(name) {
  return typeof name === 'string' && VAR_NAME_RE.test(name);
}

/**
 * @param {object} props
 * @param {{mode: 'DISABLED'|'PER_VU', variables: Array<{name:string, generator:string}>}} props.value
 * @param {(next:any)=>void} props.onChange
 * @param {string[]} [props.suggestedNames]  placeholder names the collection references
 */
export default function DynamicTestDataForm({ value, onChange, suggestedNames = [] }) {
  const config = value && typeof value === 'object'
    ? value
    : { mode: 'DISABLED', variables: [] };
  const mode = config.mode === 'PER_VU' ? 'PER_VU' : 'DISABLED';
  const variables = Array.isArray(config.variables) ? config.variables : [];

  const suggestions = useMemo(() => {
    const set = new Set();
    for (const n of suggestedNames || []) {
      if (typeof n === 'string' && n && /did|device|ip|agent|uuid|guid|session/i.test(n)) {
        set.add(n);
      }
    }
    // Ensure the exact example names from the spec are always proposed.
    for (const n of ['Test_did', 'Test_ip', 'Test_useragent']) set.add(n);
    for (const v of variables) set.delete(v.name);
    return Array.from(set).slice(0, 8);
  }, [suggestedNames, variables]);

  const emit = (next) => onChange({ mode: next.mode, variables: next.variables });

  const setMode = (newMode) => {
    if (newMode === 'DISABLED') return emit({ mode: 'DISABLED', variables: [] });
    emit({ mode: 'PER_VU', variables });
  };

  const addRow = (name = '', generator = 'uuid') => {
    emit({
      mode: 'PER_VU',
      variables: [...variables, { name, generator }],
    });
  };
  const updateRow = (idx, patch) => {
    emit({
      mode: 'PER_VU',
      variables: variables.map((row, i) => (i === idx ? { ...row, ...patch } : row)),
    });
  };
  const removeRow = (idx) => {
    const next = variables.filter((_, i) => i !== idx);
    emit({ mode: next.length > 0 ? 'PER_VU' : 'DISABLED', variables: next });
  };

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-ink-900">Dynamic test data</h3>
      <p className="mt-1 text-xs text-ink-600">
        Generate test values at K6 runtime. Independent of authentication —
        collections that do not require login can still benefit from unique
        per-VU identifiers. One value is produced per VU on first use and
        reused for every request executed by that VU.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {[
          { id: 'DISABLED', label: 'Disabled', hint: 'No dynamic generation — existing behavior.' },
          { id: 'PER_VU', label: 'Per VU', hint: 'Generate once per VU; reuse across every request by that VU.' },
        ].map((m) => {
          const active = m.id === mode;
          return (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={[
                'rounded-md px-3 py-1.5 text-xs font-semibold border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40 focus-visible:ring-offset-2',
                active
                  ? 'border-brand-500 bg-brand-50 text-brand-700 shadow-sm'
                  : 'border-gray-300 bg-white text-ink-700 hover:border-brand-400 hover:bg-brand-50/60',
              ].join(' ')}
              title={m.hint}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-ink-600">
        {mode === 'PER_VU'
          ? 'Per-VU: each virtual user generates its own value once and reuses it across all requests in that VU.'
          : 'Disabled: pre-existing behavior is preserved exactly.'}
      </p>

      {mode === 'PER_VU' && (
        <div className="mt-4 space-y-2">
          {variables.length === 0 && (
            <p className="text-[11px] text-ink-500">
              Add at least one variable to generate. Example: <code>Test_did</code> →{' '}
              <code>UUID v4</code>.
            </p>
          )}
          {variables.map((row, i) => {
            const nameOk = isValidName(row.name);
            return (
              <div key={i} className="flex flex-wrap items-start gap-2">
                <div className="flex-1 min-w-[12rem]">
                  <input
                    className={[
                      'input',
                      row.name && !nameOk ? 'border-rose-600 focus:border-rose-500' : '',
                    ].join(' ')}
                    placeholder="Variable name (e.g. Test_did)"
                    value={row.name}
                    onChange={(e) => updateRow(i, { name: e.target.value.trim() })}
                    aria-label={`Dynamic variable name ${i + 1}`}
                  />
                </div>
                <div className="flex-1 min-w-[12rem]">
                  <select
                    className="input"
                    value={row.generator}
                    onChange={(e) => updateRow(i, { generator: e.target.value })}
                    aria-label={`Dynamic variable generator ${i + 1}`}
                  >
                    {GENERATORS.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="btn-ghost !px-2 !py-2"
                  onClick={() => removeRow(i)}
                  title="Remove"
                  aria-label="Remove variable"
                >
                  ✕
                </button>
              </div>
            );
          })}
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-ghost !px-2 !py-1 text-xs" onClick={() => addRow()}>
              + Add variable
            </button>
            {suggestions.map((name) => (
              <button
                key={name}
                type="button"
                className="btn-ghost !px-2 !py-1 text-xs"
                title={`Add ${name}`}
                onClick={() => addRow(name, /ip/i.test(name) ? 'ipv4' : /agent/i.test(name) ? 'userAgent' : 'uuid')}
              >
                + {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
