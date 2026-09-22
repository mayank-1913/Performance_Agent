import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { reportsApi } from '../../shared/api/reports.api.js';
import RunStatusBadge from '../runs/RunStatusBadge.jsx';
import { PanelLoader } from '../../shared/components/Loading.jsx';

// Defer heavy / rarely-used panels.
const RunReport = lazy(() => import('../runs/RunReport.jsx'));
const LiveConsole = lazy(() => import('../runs/LiveConsole.jsx'));
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
  { id: 'console', label: 'Run logs' },
  { id: 'metadata', label: 'Metadata' },
];

export default function ReportDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [report, setReport] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('report');
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const [r, l] = await Promise.all([
          reportsApi.get(id),
          reportsApi.logs(id).catch(() => ({ lines: [] })),
        ]);
        if (mounted) {
          setReport(r);
          setLogs(l?.lines || []);
        }
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [id]);

  const headline = useMemo(() => {
    const m = report?.metrics || {};
    return [
      { label: 'Total requests', value: m.totalRequests ?? '—' },
      { label: 'Failed', value: m.failedRequests ?? 0 },
      { label: 'p95', value: m.p95 != null ? `${m.p95.toFixed(0)}ms` : '—' },
      { label: 'RPS', value: m.rps ?? '—' },
      { label: 'Avg', value: m.avg != null ? `${m.avg.toFixed(0)}ms` : '—' },
      { label: 'VUs', value: m.vusMax ?? report?.loadProfile?.vus ?? '—' },
    ];
  }, [report]);

  const onDelete = async () => {
    setDeleting(true);
    try {
      await reportsApi.remove(id);
      navigate('/reports');
    } catch (err) {
      setError(err.message);
      setDeleting(false);
    }
  };

  if (loading) return <div className="card text-sm text-slate-400">Loading report…</div>;
  if (error) {
    return (
      <div className="card text-sm text-rose-300">
        {error}{' '}
        <Link to="/reports" className="ml-2 underline">
          Back to reports
        </Link>
      </div>
    );
  }
  if (!report) return null;

  return (
    <div className="page-stack">
      <div className="min-w-0">
        <button
          className="text-xs text-slate-400 hover:text-slate-200"
          onClick={() => navigate('/reports')}
        >
          ← Back to reports
        </button>
        <h2 className="mt-1 text-lg font-semibold text-slate-100 truncate">
          {report.displayApiName || 'Report'}
        </h2>
        <p className="text-xs text-slate-500 force-wrap">
          {report.collectionName || '—'} ·{' '}
          <span className="font-mono">{report.id}</span>
        </p>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-center gap-3">
          <RunStatusBadge status={report.status} />
          <div className="flex flex-wrap gap-3 text-xs text-slate-400">
            {report.startedAt && (
              <span>Started {new Date(report.startedAt).toLocaleString()}</span>
            )}
            {report.endedAt && (
              <span>Ended {new Date(report.endedAt).toLocaleString()}</span>
            )}
            {report.durationMs != null && (
              <span>Duration {(report.durationMs / 1000).toFixed(1)}s</span>
            )}
            {report.exitCode != null && <span>Exit code {report.exitCode}</span>}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <a
              className="btn-secondary"
              href={reportsApi.reportUrl(id)}
              target="_blank"
              rel="noreferrer"
            >
              View HTML report
            </a>
            <a className="btn-primary" href={reportsApi.reportDownloadUrl(id)}>
              Download
            </a>
            <button
              type="button"
              className="btn-secondary !bg-rose-600/20 !border-rose-700/60 !text-rose-200 hover:!bg-rose-600/30"
              onClick={() => setConfirming(true)}
            >
              Delete
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {headline.map((h) => (
            <MetaCell key={h.label} label={h.label} value={String(h.value)} />
          ))}
        </div>
      </div>

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
          <RunReport runId={id} status={report.status} source="reports" />
        </Suspense>
      )}

      {tab === 'console' && (
        <CollapsibleCard
          title="Run logs (persisted)"
          subtitle="Loaded from the saved log file. Tokens are redacted."
          defaultOpen
        >
          <Suspense fallback={<PanelLoader label="Loading console…" />}>
            <LiveConsole lines={logs} />
          </Suspense>
        </CollapsibleCard>
      )}

      {tab === 'metadata' && (
        <div className="space-y-4">
          {report.selection && (
            <CollapsibleCard
              title="APIs in this run"
              subtitle={`${report.requestCount}${
                report.totalCollectionRequests != null
                  ? ` / ${report.totalCollectionRequests}`
                  : ''
              } requests · mode ${report.selection.mode}`}
              defaultOpen
            >
              {Array.isArray(report.selectedRequests) && report.selectedRequests.length > 0 ? (
                <ul className="max-h-56 overflow-y-auto overflow-x-hidden rounded-md border border-slate-700 bg-slate-800 p-2 text-xs">
                  {report.selectedRequests.map((r) => (
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

          {report.authFlow && (
            <CollapsibleCard
              title="Runtime auth flow"
              subtitle={
                report.authFlow.enabled
                  ? `Login chained · token injected into ${
                      report.authFlow.injectionCount || 0
                    } request(s)`
                  : 'Manual fallback (env-driven)'
              }
              defaultOpen={!!report.authFlow.enabled}
            >
              <Suspense fallback={<PanelLoader label="Loading…" />}>
                <AuthFlowDiagram authFlow={report.authFlow} compact />
              </Suspense>
            </CollapsibleCard>
          )}

          {report.env && Object.keys(report.env).length > 0 && (
            <CollapsibleCard
              title="Runtime env (masked)"
              subtitle="Captured at run time. Secrets are masked."
              defaultOpen={false}
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {Object.entries(report.env).map(([k, v]) => (
                  <div
                    key={k}
                    className="rounded-md border border-slate-700 bg-slate-800 p-2 text-xs min-w-0"
                  >
                    <div className="text-[11px] uppercase tracking-wide text-slate-500">
                      {k}
                    </div>
                    <div className="mt-0.5 font-mono text-slate-200 force-wrap">
                      {String(v)}
                    </div>
                  </div>
                ))}
              </div>
            </CollapsibleCard>
          )}
        </div>
      )}

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-white p-5 shadow-2xl">
            <h3 className="text-base font-semibold text-slate-100">Delete report?</h3>
            <p className="mt-2 text-sm text-slate-300 force-wrap">
              This permanently removes the manifest, parsed metrics, HTML report, raw K6
              outputs, and run log file.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="btn-secondary"
                onClick={() => setConfirming(false)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="btn-primary !bg-rose-600 hover:!bg-rose-500"
                onClick={onDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
