import { useState } from 'react';

/**
 * K6 script preview panel.
 *  - Vertical scroll only by default (overflow-x hidden) with optional
 *    word-wrap toggle so very long lines stay inside the panel.
 *  - Sticky toolbar with Copy / Download / Wrap.
 *  - Fixed max height so the page never expands beyond the viewport.
 */
export default function ScriptPreview({ code, downloadUrl }) {
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(true);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-200">Generated K6 script</h3>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-400 select-none">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => setWrap(e.target.checked)}
            />
            Wrap lines
          </label>
          <button className="btn-secondary" onClick={onCopy}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {downloadUrl && (
            <a className="btn-primary" href={downloadUrl}>
              Download
            </a>
          )}
        </div>
      </div>

      <div className="mt-3 max-h-[60vh] overflow-y-auto overflow-x-hidden rounded-md border border-slate-800 bg-slate-950">
        <pre
          className={[
            'p-4 text-xs leading-relaxed text-slate-200',
            wrap ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-pre',
          ].join(' ')}
        >
          <code>{code}</code>
        </pre>
      </div>
    </div>
  );
}
