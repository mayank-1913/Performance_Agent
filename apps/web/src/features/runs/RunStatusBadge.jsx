/**
 * Soft pastel status pill — light theme.
 * Colors mirror the reference image (Processing / Refund / Success chips).
 */
const STYLES = {
  queued:    'bg-slate-100 text-slate-600 border-slate-200',
  running:   'bg-sky-50 text-sky-700 border-sky-200 animate-pulse',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  failed:    'bg-rose-50 text-rose-700 border-rose-200',
  stopped:   'bg-amber-50 text-amber-700 border-amber-200',
};

export default function RunStatusBadge({ status }) {
  const cls = STYLES[status] || STYLES.queued;
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {status || 'unknown'}
    </span>
  );
}
