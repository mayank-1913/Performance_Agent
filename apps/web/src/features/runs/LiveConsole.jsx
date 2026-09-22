import { useEffect, useRef, useState } from 'react';

/**
 * Live K6 log console. Internally scrolls; never expands the page.
 *  - Fixed height (~50vh, capped at 480px) for laptop screens.
 *  - Pauses auto-scroll when the user scrolls up so they can read history.
 *  - Word wraps long lines so wide URLs don't introduce horizontal scroll.
 */
export default function LiveConsole({ lines }) {
  const ref = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const lastLenRef = useRef(0);

  // Detect manual scroll-up to pause auto-scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
      setAutoScroll(nearBottom);
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll on new lines if user is at the bottom.
  useEffect(() => {
    if (!ref.current) return;
    if (autoScroll && lines.length !== lastLenRef.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
    lastLenRef.current = lines.length;
  }, [lines, autoScroll]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{lines.length} line{lines.length === 1 ? '' : 's'}</span>
        <div className="flex items-center gap-3">
          {!autoScroll && (
            <button
              type="button"
              className="text-brand-300 hover:underline"
              onClick={() => {
                if (ref.current) {
                  ref.current.scrollTop = ref.current.scrollHeight;
                  setAutoScroll(true);
                }
              }}
            >
              Jump to latest
            </button>
          )}
          <span>{autoScroll ? 'Auto-scroll on' : 'Auto-scroll paused'}</span>
        </div>
      </div>
      <div
        ref={ref}
        className="h-[min(50vh,480px)] overflow-y-auto overflow-x-hidden rounded-md border border-slate-800 bg-slate-950 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.length === 0 && (
          <div className="text-slate-600">Waiting for output…</div>
        )}
        {lines.map((l, i) => {
          const tone =
            l.stream === 'stderr'
              ? 'text-rose-300'
              : l.stream === 'system'
              ? 'text-slate-400'
              : 'text-slate-200';
          return (
            <div key={i} className={`${tone} whitespace-pre-wrap break-words`}>
              <span className="text-slate-600">[{l.ts?.slice(11, 19) || '--:--:--'}]</span>{' '}
              <span className="text-slate-500">{l.stream}</span>{' '}
              <span>{l.line}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
