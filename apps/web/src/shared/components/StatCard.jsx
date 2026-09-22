/**
 * Analytics-style metric card.
 * Glass surface + an accent gradient rail along the top edge so a row of
 * StatCards reads like a dashboard at a glance.
 */
export default function StatCard({ label, value, hint }) {
  return (
    <div className="card relative overflow-hidden">
      {/* Top accent rail */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px] accent-bg opacity-80"
      />
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted">
        {label}
      </div>
      <div className="mt-2.5 font-num text-3xl font-semibold tracking-tight text-slate-100">
        {value}
      </div>
      {hint && <div className="mt-1.5 text-xs text-soft">{hint}</div>}
    </div>
  );
}
