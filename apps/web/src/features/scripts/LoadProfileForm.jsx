// Phase 6: adds a workload profile selector on top of the historical
// vus / rampUp / hold / rampDown fields. The four fields remain
// authoritative for the 'custom' profile and act as overrides for the
// standardized ones. Selecting a preset overwrites the four fields with
// the profile's defaults so the user sees exactly what the backend will
// emit; edits after that stay as user overrides.

const PROFILE_PRESETS = {
  smoke:  { vus: 1,  rampUp: '0s',  hold: '30s', rampDown: '0s'  },
  load:   { vus: 10, rampUp: '30s', hold: '2m',  rampDown: '30s' },
  stress: { vus: 50, rampUp: '30s', hold: '1m',  rampDown: '30s' },
  spike:  { vus: 80, rampUp: '10s', hold: '30s', rampDown: '10s' },
  soak:   { vus: 15, rampUp: '2m',  hold: '1h',  rampDown: '2m'  },
  custom: { vus: 5,  rampUp: '30s', hold: '1m',  rampDown: '30s' },
};

const PROFILE_META = [
  { id: 'smoke',  label: 'Smoke',  hint: 'Very small load; sanity check' },
  { id: 'load',   label: 'Load',   hint: 'Sustained expected traffic' },
  { id: 'stress', label: 'Stress', hint: 'Progressive ramp beyond expected load' },
  { id: 'spike',  label: 'Spike',  hint: 'Rapid ramp, brief peak, rapid drop' },
  { id: 'soak',   label: 'Soak',   hint: 'Long-duration steady load' },
  { id: 'custom', label: 'Custom', hint: 'Fully user-driven ramp shape' },
];

export default function LoadProfileForm({ value, onChange }) {
  const profile = value.profile || 'custom';
  const set = (patch) => onChange({ ...value, ...patch });
  const setProfile = (nextProfile) => {
    const preset = PROFILE_PRESETS[nextProfile] || PROFILE_PRESETS.custom;
    onChange({ profile: nextProfile, ...preset });
  };

  return (
    <div className="card">
      <h3 className="text-sm font-semibold text-slate-900">Load profile</h3>
      <p className="text-xs text-slate-600 mt-1">
        Pick a workload profile or stick with Custom. The four fields below always represent
        exactly what the generated K6 script will run — presets fill them in for you.
      </p>

      <div className="mt-4">
        <label className="label">Workload profile</label>
        <div className="mt-1 flex flex-wrap gap-2">
          {PROFILE_META.map((p) => {
            const active = p.id === profile;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => setProfile(p.id)}
                className={[
                  'rounded px-2.5 py-1 text-xs font-medium border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2',
                  active
                    ? 'border-blue-600 bg-blue-50 text-blue-800 shadow-sm'
                    : 'border-slate-300 bg-white text-slate-700 hover:border-blue-400 hover:bg-blue-50/50',
                ].join(' ')}
                title={p.hint}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[11px] text-slate-600">
          {PROFILE_META.find((p) => p.id === profile)?.hint}
        </p>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 md:grid-cols-4">
        <div>
          <label className="label">Virtual users</label>
          <input
            type="number"
            min={1}
            max={1000}
            className="input"
            value={value.vus}
            onChange={(e) => set({ vus: Number(e.target.value) })}
          />
        </div>
        <div>
          <label className="label">Ramp-up</label>
          <input
            className="input"
            value={value.rampUp}
            onChange={(e) => set({ rampUp: e.target.value })}
            placeholder="30s"
          />
        </div>
        <div>
          <label className="label">Hold</label>
          <input
            className="input"
            value={value.hold}
            onChange={(e) => set({ hold: e.target.value })}
            placeholder="1m"
          />
        </div>
        <div>
          <label className="label">Ramp-down</label>
          <input
            className="input"
            value={value.rampDown}
            onChange={(e) => set({ rampDown: e.target.value })}
            placeholder="30s"
          />
        </div>
      </div>
    </div>
  );
}
