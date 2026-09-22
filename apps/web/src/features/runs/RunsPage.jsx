import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { runsApi } from '../../shared/api/runs.api.js';
import RunStatusBadge from './RunStatusBadge.jsx';

export default function RunsPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = async () => {
    try {
      const data = await runsApi.list();
      setItems(data || []);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="page-stack">
      <div className="page-hero">
        <div className="min-w-0">
          <h2 className="page-hero-title">Run history</h2>
          <p className="page-hero-subtitle">
            Local K6 executions performed by this server. Metadata only — secrets are never
            persisted to disk.
          </p>
        </div>
        <Link to="/collections" className="btn-primary whitespace-nowrap">
          Start a new run
        </Link>
      </div>

      {error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="table-wrap max-h-[70vh] overflow-y-auto">
        <table>
          <thead>
            <tr>
              <th className="px-4 py-2">Run</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Started</th>
              <th className="px-4 py-2">Duration</th>
              <th className="px-4 py-2">Exit</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                  No runs yet.
                </td>
              </tr>
            )}
            {!loading &&
              items.map((r) => (
                <tr key={r.runId} className="hover:bg-slate-900/40">
                  <td className="px-4 py-2 font-mono text-xs text-slate-300">
                    {r.runId.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-2">
                    <RunStatusBadge status={r.status} />
                  </td>
                  <td className="px-4 py-2 text-slate-400">
                    {new Date(r.startedAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-2 text-slate-300">
                    {r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-300">{r.exitCode ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <Link
                      to={`/runs/${r.runId}`}
                      className="inline-flex items-center rounded-md bg-brand-500/15 px-2.5 py-1 text-xs font-medium text-brand-200 hover:bg-brand-500/25"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
