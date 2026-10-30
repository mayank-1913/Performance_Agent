/**
 * Analytics-style metric card.
 *
 * - White card surface with a thin accent rail along the top.
 * - Accent color is semantic: indigo (default), emerald, amber, rose.
 * - Optional icon slot renders in a soft brand-tinted square.
 *
 * The DOM shape (label → value → hint) is intentionally preserved so that
 * any existing selectors / Playwright assertions keep working.
 */
const ACCENT_RAIL = {
  indigo:  'linear-gradient(90deg,#6366f1,#8b5cf6)',
  emerald: 'linear-gradient(90deg,#10b981,#14b8a6)',
  amber:   'linear-gradient(90deg,#f59e0b,#f97316)',
  rose:    'linear-gradient(90deg,#ef4444,#ec4899)',
};

const ICON_TINT = {
  indigo:  { bg: '#eef2ff', fg: '#4f46e5' },
  emerald: { bg: '#ecfdf5', fg: '#047857' },
  amber:   { bg: '#fffbeb', fg: '#b45309' },
  rose:    { bg: '#fef2f2', fg: '#b91c1c' },
};

export default function StatCard({ label, value, hint, accent = 'indigo', icon = null }) {
  const rail = ACCENT_RAIL[accent] || ACCENT_RAIL.indigo;
  const tint = ICON_TINT[accent] || ICON_TINT.indigo;

  return (
    <div className="card card-hover relative overflow-hidden">
      {/* Top accent rail */}
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: rail }}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-500">
            {label}
          </div>
          <div className="mt-2.5 font-num text-3xl font-semibold tracking-tight text-ink-900">
            {value}
          </div>
          {hint && (
            <div className="mt-1.5 text-xs text-ink-500">{hint}</div>
          )}
        </div>

        {icon && (
          <div
            aria-hidden
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ background: tint.bg, color: tint.fg }}
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}
