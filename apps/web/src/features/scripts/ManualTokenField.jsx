import { useState } from 'react';

/**
 * Manual Bearer token input. Token stays in component state; never persisted
 * by the frontend either. Parent receives the value via onChange.
 */
export default function ManualTokenField({ value, onChange, recommended }) {
  const [show, setShow] = useState(false);

  return (
    <div className="card">
      <div className="flex items-center justify-between">
        <label className="label mb-0" htmlFor="manualToken">
          Manual Bearer token{' '}
          <span className="text-slate-500 font-normal">
            ({recommended ? 'recommended' : 'optional'})
          </span>
        </label>
        <button
          type="button"
          className="text-xs text-slate-400 hover:text-slate-200"
          onClick={() => setShow((s) => !s)}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>

      <p className="text-xs text-slate-500 mt-1">
        For SSO, Google, Azure, or MFA flows. Paste the access token only. It is sent securely
        to the runner and never stored.
      </p>

      <div className="mt-3 flex gap-2">
        <input
          id="manualToken"
          type={show ? 'text' : 'password'}
          autoComplete="off"
          spellCheck="false"
          className="input font-mono"
          placeholder="eyJhbGciOi..."
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => onChange('')}
            title="Clear"
          >
            Clear
          </button>
        )}
      </div>

      {value && (
        <div className="mt-2 text-xs text-slate-500">
          Token detected: {value.length} chars · will be passed as <code>__ENV.AUTH_TOKEN</code>.
        </div>
      )}
    </div>
  );
}
