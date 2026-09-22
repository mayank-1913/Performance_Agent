import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collectionsApi } from '../../shared/api/collections.api.js';
import { reportsApi } from '../../shared/api/reports.api.js';
import { runsApi } from '../../shared/api/runs.api.js';
import StatCard from '../../shared/components/StatCard.jsx';
import RunStatusBadge from '../runs/RunStatusBadge.jsx';

function relativeTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const [collections, setCollections] = useState([]);
  const [reports, setReports] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const [cols, reps, rs] = await Promise.all([
          collectionsApi.list(),
          reportsApi.list().catch(() => []),
          runsApi.list().catch(() => []),
        ]);
        if (!mounted) return;
        setCollections(cols || []);
        setReports(reps || []);
        setRuns(rs || []);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const totalRequests = collections.reduce(
    (sum, c) => sum + (c.summary?.requestCount || 0),
    0
  );

  const activeRuns = useMemo(
    () => runs.filter((r) => r.status === 'running' || r.status === 'queued'),
    [runs]
  );

  const recentReports = useMemo(
    () =>
      [...reports]
        .sort((a, b) =>
          String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
        )
        .slice(0, 5),
    [reports]
  );

  return (
    <div className="page-stack">
      {error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Collections"
          value={loading ? '—' : collections.length}
          hint="Postman collections in workspace"
        />
        <StatCard
          label="Requests"
          value={loading ? '—' : totalRequests}
          hint="Across all collections"
        />
        <StatCard
          label="Reports"
          value={loading ? '—' : reports.length}
          hint="Saved performance runs"
        />
        <StatCard
          label="Active runs"
          value={loading ? '—' : activeRuns.length}
          hint={
            activeRuns.length === 0
              ? 'No tests running'
              : 'Running or queued right now'
          }
        />
      </section>

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="card xl:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Recent collections</h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Jump straight into generating a K6 script.
              </p>
            </div>
            <Link to="/collections" className="btn-secondary !py-1.5 !px-3 text-xs">
              View all
            </Link>
          </div>

          <div className="mt-4 table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="px-4 py-2.5">Name</th>
                  <th className="px-4 py-2.5">Requests</th>
                  <th className="px-4 py-2.5">Folders</th>
                  <th className="px-4 py-2.5">Uploaded</th>
                  <th className="px-4 py-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {loading && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      Loading…
                    </td>
                  </tr>
                )}
                {!loading && collections.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                      No collections yet.{' '}
                      <Link to="/collections" className="text-brand-300 hover:underline">
                        Upload one
                      </Link>{' '}
                      to get started.
                    </td>
                  </tr>
                )}
                {!loading &&
                  collections.slice(0, 5).map((c) => (
                    <tr
                      key={c.id}
                      className="cursor-pointer hover:bg-slate-900/40"
                      onClick={() => navigate(`/collections/${c.id}/generate`)}
                    >
                      <td className="px-4 py-2.5 font-medium text-slate-100">
                        {c.summary?.name || c.originalName}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">
                        {c.summary?.requestCount ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-300">
                        {c.summary?.folderCount ?? '—'}
                      </td>
                      <td className="px-4 py-2.5 text-slate-400 text-xs">
                        {relativeTime(c.uploadedAt)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          to={`/collections/${c.id}/generate`}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center rounded-md bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-200 hover:bg-brand-500/25"
                        >
                          Generate
                        </Link>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">Recent reports</h2>
              <p className="mt-0.5 text-xs text-slate-500">Last 5 runs.</p>
            </div>
            <Link to="/reports" className="btn-secondary !py-1.5 !px-3 text-xs">
              View all
            </Link>
          </div>

          <ul className="mt-4 divide-y divide-slate-800/60">
            {loading && <li className="py-4 text-center text-xs text-slate-500">Loading…</li>}
            {!loading && recentReports.length === 0 && (
              <li className="py-4 text-center text-xs text-slate-500">No reports yet.</li>
            )}
            {!loading &&
              recentReports.map((r) => (
                <li key={r.id}>
                  <Link
                    to={`/reports/${r.id}`}
                    className="flex items-center gap-3 py-3 -mx-2 px-2 rounded-md hover:bg-slate-900/60"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-100">
                        {r.displayApiName || r.collectionName || 'Run'}
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-slate-500">
                        {r.collectionName || '—'} · {relativeTime(r.startedAt)}
                      </div>
                    </div>
                    <RunStatusBadge status={r.status} />
                  </Link>
                </li>
              ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
