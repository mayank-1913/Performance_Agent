import { lazy, Suspense, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { runsApi } from '../../shared/api/runs.api.js';
import { useRunStream } from './useRunStream.js';
import RunStatusBadge from './RunStatusBadge.jsx';
import { PanelLoader } from '../../shared/components/Loading.jsx';

// RunReport (recharts) and LiveConsole are only needed once a tab opens —
// keeping them out of the initial chunk so the run-list → detail navigation
// doesn't pay for charts up front.
const RunReport = lazy(() => import('./RunReport.jsx'));
const LiveConsole = lazy(() => import('./LiveConsole.jsx'));
const AuthFlowDiagram = lazy(() => import('../scripts/AuthFlowDiagram.jsx'));

function CollapsibleCard({ title, subtitle, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-200">{title}</h3>
          {subtitle && (
            <p className="text-xs text-slate-500 mt-0.5 force-wrap">{subtitle}</p>
          )}
        </div>
        <span className="text-xs text-slate-400 shrink-0 ml-2">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

function MetaCell({ label, value }) {
  return (
    <div className="rounded-md border border-slate-700 bg-slate-800 p-3 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-sm text-slate-100 force-wrap font-mono">{value ?? '—'}</div>
    </div>
  );
}

const TABS = [
  { id: 'report', label: 'Report' },
  { id: 'console', label: 'Live console' },
  { id: 'metadata', label: 'Metadata' },
];

export default function RunDetailPage() {
  const { runId } = useParams();
  const navigate = useNavigate();
  const { status, lines, summary, error } = useRunStream(runId);

  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState(null);
  const [tab, setTab] = useState('report');

  const onStop = async () => {
    setStopping(true);
    setStopError(null);
    try {
      await runsApi.stop(runId);
    } catch (err) {
      setStopError(err.message);
    } finally {
      setStopping(false);
    }
  };

  const isRunning = status?.status === 'running' || status?.status === 'queued';

  return (
    <div className="page-stack">
      {/* Header */}
      <div className="min-w-0">
        <button
          className="text-xs text-slate-400 hover:text-slate-200"
          onClick={() => navigate('/runs')}
        >
          ← Back to runs
        </button>
        <h2 className="mt-1 text-lg font-semibold text-slate-100">Run detail</h2>
        <p className="font-mono text-xs text-slate-500 force-wrap">{runId}</p>
      </div>

      {/* Status bar */}
      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <RunStatusBadge status={status?.status} />
          <div className="flex flex-wrap gap-3 text-xs text-slate-400">
            {status?.startedAt && <span>Started {new Date(status.startedAt).toLocaleString()}</span>}
            {status?.endedAt && <span>Ended {new Date(status.endedAt).toLocaleString()}</span>}
            {status?.durationMs != null && (
              <span>Duration {(status.durationMs / 1000).toFixed(1)}s</span>
            )}
            {status?.exitCode != null && <span>Exit code {status.exitCode}</span>}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            {isRunning && (
              <button className="btn-secondary" onClick={onStop} disabled={stopping}>
                {stopping ? 'Stopping…' : 'Stop'}
              </button>
            )}
            {!isRunning && (
              <a
                className="btn-secondary"
                href={runsApi.reportUrl(runId)}
                target="_blank"
                rel="noreferrer"
              >
                View HTML report
              </a>
            )}
            {!isRunning && (
              <a className="btn-primary" href={runsApi.reportDownloadUrl(runId)}>
                Download report
              </a>
            )}
          </div>
        </div>

        {/* Compact metadata grid */}
        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
          <MetaCell label="Run ID" value={status?.runId || runId} />
          <MetaCell label="Script ID" value={status?.scriptId} />
          <MetaCell label="Selection" value={status?.selection ? status.selection.mode : '—'} />
          <MetaCell
            label="Requests"
            value={
              status?.requestCount != null
                ? `${status.requestCount}${
                    status.totalCollectionRequests != null
                      ? ` / ${status.totalCollectionRequests}`
                      : ''
                  }`
                : '—'
            }
          />
        </div>

        {status?.error && (
          <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300 force-wrap">
            {status.error}
          </div>
        )}
        {stopError && (
          <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300 force-wrap">
            {stopError}
          </div>
        )}
        {error && <div className="mt-3 text-xs text-amber-400">{error}</div>}
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-800">
        <div className="flex flex-wrap gap-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={[
                'px-3 py-2 text-sm font-medium transition-colors -mb-px border-b-2',
                tab === t.id
                  ? 'border-brand-500 text-brand-200'
                  : 'border-transparent text-slate-400 hover:text-slate-200',
              ].join(' ')}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'report' && (
        <Suspense fallback={<PanelLoader label="Loading report charts…" />}>
          <RunReport runId={runId} status={status?.status} />
        </Suspense>
      )}

      {tab === 'console' && (
        <CollapsibleCard
          title="Live console"
          subtitle="Tokens are redacted server-side before reaching this stream."
          defaultOpen
        >
          <Suspense fallback={<PanelLoader label="Loading console…" />}>
            <LiveConsole lines={lines} />
          </Suspense>
        </CollapsibleCard>
      )}

      {tab === 'metadata' && (
        <div className="space-y-4">
          {status?.selection && (
            <CollapsibleCard
              title="APIs in this run"
              subtitle={`${status.requestCount}${
                status.totalCollectionRequests != null
                  ? ` / ${status.totalCollectionRequests}`
                  : ''
              } requests · mode ${status.selection.mode}`}
              defaultOpen
            >
              {Array.isArray(status.selectedRequests) && status.selectedRequests.length > 0 ? (
                <ul className="max-h-56 overflow-y-auto overflow-x-hidden rounded-md border border-slate-700 bg-slate-800 p-2 text-xs">
                  {status.selectedRequests.map((r) => (
                    <li key={r.index} className="flex items-center gap-2 py-0.5 min-w-0">
                      <span className="rounded bg-slate-700/60 px-1.5 py-0.5 font-mono text-[10px] text-slate-200 shrink-0">
                        {r.method}
                      </span>
                      <span className="truncate text-slate-200">{r.name}</span>
                      <span className="ml-auto truncate font-mono text-slate-500 max-w-[50%]">
                        {r.url}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-xs text-slate-500">Entire collection.</div>
              )}
            </CollapsibleCard>
          )}

          {status?.authFlow && (
            <CollapsibleCard
              title="Runtime auth flow"
              subtitle={
                status.authFlow.enabled
                  ? `Login chained · token injected into ${
                      status.authFlow.injectionCount || 0
                    } request(s)`
                  : 'Manual fallback (env-driven)'
              }
              defaultOpen={!!status.authFlow.enabled}
            >
              <Suspense fallback={<PanelLoader label="Loading…" />}>
                <AuthFlowDiagram authFlow={status.authFlow} compact />
              </Suspense>
            </CollapsibleCard>
          )}

          {status?.env && Object.keys(status.env).length > 0 && (
            <CollapsibleCard
              title="Runtime env (masked)"
              subtitle="Secrets are masked. Long values wrap to keep the panel inside the page."
              defaultOpen={false}
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(status.env).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-md border border-slate-700 bg-slate-800 p-2 text-xs min-w-0"
                  >
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">{k}</div>
                    <div className="mt-0.5 font-mono text-slate-200 force-wrap">{String(v)}</div>
                  </div>
                ))}
              </div>
            </CollapsibleCard>
          )}

          {summary && (
            <CollapsibleCard title="Stdout-derived quick summary" defaultOpen={false}>
              <pre className="code-block-scroll-y max-h-[40vh]">
                {JSON.stringify(summary, null, 2)}
              </pre>
            </CollapsibleCard>
          )}
        </div>
      )}
    </div>
  );
}
