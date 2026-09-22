/**
 * Lightweight loading placeholders used as Suspense fallbacks. Kept in a
 * separate file so the main entry never has to wait on these dependencies
 * being parsed before the splash renders.
 */

export function PageLoader({ label = 'Loading…' }) {
  return (
    <div className="card text-sm text-soft">
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-3 w-3 animate-pulse rounded-full"
          style={{
            background: 'linear-gradient(90deg, #e67542 0%, #0074fd 100%)',
          }}
        />
        <span>{label}</span>
      </div>
    </div>
  );
}

export function PanelLoader({ label = 'Loading…', className = '' }) {
  return (
    <div
      className={
        'rounded-2xl border border-soft bg-app-secondary/40 p-6 text-center text-sm text-soft ' +
        className
      }
      style={{ borderColor: 'rgba(255,255,255,0.08)' }}
    >
      {label}
    </div>
  );
}

export function FullscreenLoader({ label = 'Loading…' }) {
  return (
    <div className="flex h-screen items-center justify-center text-sm text-soft">
      {label}
    </div>
  );
}
