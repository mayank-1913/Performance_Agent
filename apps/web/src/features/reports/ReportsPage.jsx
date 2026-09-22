import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { reportsApi } from '../../shared/api/reports.api.js';

const STATUS_TONES = {
  completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-700/50',
  failed: 'bg-rose-500/15 text-rose-300 border-rose-700/50',
  stopped: 'bg-amber-500/15 text-amber-300 border-amber-700/50',
};
const METHOD_TONES = {
  GET: 'bg-emerald-500/15 text-emerald-300',
  POST: 'bg-sky-500/15 text-sky-300',
  PUT: 'bg-amber-500/15 text-amber-300',
  PATCH: 'bg-amber-500/15 text-amber-300',
  DELETE: 'bg-rose-500/15 text-rose-300',
  HEAD: 'bg-slate-500/15 text-slate-300',
  OPTIONS: 'bg-slate-500/15 text-slate-300',
  MIXED: 'bg-violet-500/15 text-violet-300',
};
const STATUS_OPTIONS = ['all', 'completed', 'failed', 'stopped'];
const METHOD_OPTIONS = ['all', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'MIXED'];

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function StatusBadge({ status }) {
  const cls = STATUS_TONES[status] || 'bg-slate-500/15 text-slate-300 border-slate-700/50';
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
      {status || '—'}
    </span>
  );
}

function MethodBadge({ method }) {
  const cls = METHOD_TONES[(method || '').toUpperCase()] || 'bg-slate-500/15 text-slate-300';
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${cls}`}>
      {method || '—'}
    </span>
  );
}

function ConfirmDeleteModal({ report, onCancel, onConfirm, busy }) {
  if (!report) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-white p-5 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">Delete report?</h3>
        <p className="mt-2 text-sm text-slate-300 force-wrap">
          This will permanently remove the report manifest and all on-disk artifacts (HTML
          report, parsed metrics JSON, raw K6 outputs, run log).
        </p>
        <dl className="mt-4 space-y-1 rounded-md border border-slate-700 bg-slate-800 p-3 text-xs text-slate-300">
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Report ID</dt>
            <dd className="font-mono truncate">{report.id}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Collection</dt>
            <dd className="truncate">{report.collectionName || '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">API name</dt>
            <dd className="truncate">{report.displayApiName || '—'}</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-slate-500">Started</dt>
            <dd>{report.startedAt ? new Date(report.startedAt).toLocaleString() : '—'}</dd>
          </div>
        </dl>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn-primary !bg-rose-600 hover:!bg-rose-500"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ReportsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [methodFilter, setMethodFilter] = useState('all');
  const [collectionFilter, setCollectionFilter] = useState(
    () => searchParams.get('collection') || 'all'
  );
  const [sort, setSort] = useState('latest');

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const data = await reportsApi.list();
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
  }, []);

  // Keep the URL ?collection= in sync with the dropdown so a deep-link from
  // the Collections page preselects, and the user can share the filtered view.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (collectionFilter && collectionFilter !== 'all') {
      next.set('collection', collectionFilter);
    } else {
      next.delete('collection');
    }
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectionFilter]);

  const collections = useMemo(() => {
    const set = new Set();
    for (const r of items) if (r.collectionName) set.add(r.collectionName);
    return ['all', ...Array.from(set).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = items.filter((r) => {
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (
        methodFilter !== 'all' &&
        String(r.displayMethod || '').toUpperCase() !== methodFilter
      ) {
        return false;
      }
      if (collectionFilter !== 'all' && (r.collectionName || '') !== collectionFilter) {
        return false;
      }
      if (q) {
        const hay = `${r.displayApiName || ''} ${r.collectionName || ''} ${
          r.id || ''
        } ${r.displayMethod || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    if (sort === 'latest') {
      out = out.sort((a, b) =>
        String(b.startedAt || '').localeCompare(String(a.startedAt || ''))
      );
    } else if (sort === 'oldest') {
      out = out.sort((a, b) =>
        String(a.startedAt || '').localeCompare(String(b.startedAt || ''))
      );
    } else if (sort === 'duration') {
      out = out.sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0));
    } else if (sort === 'errors') {
      out = out.sort(
        (a, b) => (b.metrics?.failedRequests || 0) - (a.metrics?.failedRequests || 0)
      );
    }
    return out;
  }, [items, search, statusFilter, methodFilter, collectionFilter, sort]);

  const onConfirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await reportsApi.remove(pendingDelete.id);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-stack">
      <div className="page-hero">
        <div className="min-w-0">
          <h2 className="page-hero-title">Performance reports</h2>
          <p className="page-hero-subtitle">
            Persistent run history with full analytics. Reports survive restarts and stay until
            you delete them.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={refresh}>
            Refresh
          </button>
          <Link to="/collections" className="btn-primary">
            New run
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[14rem]">
            <label className="label">Search</label>
            <input
              className="input"
              placeholder="API name, collection, run id, method…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Status</label>
            <select
              className="input w-36"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Method</label>
            <select
              className="input w-32"
              value={methodFilter}
              onChange={(e) => setMethodFilter(e.target.value)}
            >
              {METHOD_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-[12rem]">
            <label className="label">Collection</label>
            <select
              className="input"
              value={collectionFilter}
              onChange={(e) => setCollectionFilter(e.target.value)}
            >
              {collections.map((c) => (
                <option key={c} value={c}>
                  {c === 'all' ? 'all' : c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Sort</label>
            <select
              className="input w-40"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="latest">Latest first</option>
              <option value="oldest">Oldest first</option>
              <option value="duration">Longest duration</option>
              <option value="errors">Most errors</option>
            </select>
          </div>
        </div>
        <div className="mt-3 text-xs text-slate-500">
          {filtered.length} / {items.length} report{items.length === 1 ? '' : 's'}
        </div>
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
              <th className="px-3 py-2">Collection</th>
              <th className="px-3 py-2">Method</th>
              <th className="px-3 py-2">API name</th>
              <th className="px-3 py-2">VUs</th>
              <th className="px-3 py-2">Avg Response</th>
              <th className="px-3 py-2">Error %</th>
              <th className="px-3 py-2">p95</th>
              <th className="px-3 py-2">Run time</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">Thresholds</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                  No reports match these filters.
                </td>
              </tr>
            )}            {!loading &&
              filtered.map((r) => (
                <tr key={r.id} className="hover:bg-slate-900/40">
                  <td className="px-3 py-2 max-w-[16rem] truncate text-slate-100">
                    {r.collectionName || '—'}
                  </td>
                  <td className="px-3 py-2">
                    <MethodBadge method={r.displayMethod} />
                  </td>
                  <td className="px-3 py-2 max-w-[18rem] truncate text-slate-200">
                    {r.displayApiName || '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">
                    {r.metrics?.vusMax ?? r.loadProfile?.vus ?? '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-200">
                    {r.metrics?.avg != null ? `${r.metrics.avg.toFixed(0)}ms` : '—'}
                  </td>
                  <td
                    className={`px-3 py-2 font-mono text-xs ${
                      (r.metrics?.errorRate || 0) > 0 ? 'text-rose-300' : 'text-slate-400'
                    }`}
                  >
                    {r.metrics
                      ? `${((r.metrics.errorRate || 0) * 100).toFixed(2)}%`
                      : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">
                    {r.metrics?.p95 != null ? `${r.metrics.p95.toFixed(0)}ms` : '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-400">
                    {r.startedAt ? new Date(r.startedAt).toLocaleString() : '—'}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-300">
                    {fmtDuration(r.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {r.thresholds?.total ? (
                      <span
                        className={
                          (r.thresholds.failed || 0) > 0
                            ? 'text-rose-300'
                            : 'text-emerald-300'
                        }
                      >
                        {r.thresholds.passed}✓ / {r.thresholds.failed}✗
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex flex-wrap gap-1 justify-end">
                      <Link
                        to={`/reports/${r.id}`}
                        className="rounded-md bg-brand-500/15 px-2 py-1 text-[11px] font-medium text-brand-200 hover:bg-brand-500/25"
                      >
                        View
                      </Link>
                      <a
                        href={reportsApi.reportDownloadUrl(r.id)}
                        className="rounded-md bg-slate-700/60 px-2 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
                      >
                        Download
                      </a>
                      <button
                        type="button"
                        onClick={() => setPendingDelete(r)}
                        className="rounded-md bg-rose-500/15 px-2 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/25"
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <ConfirmDeleteModal
        report={pendingDelete}
        onCancel={() => (deleting ? null : setPendingDelete(null))}
        onConfirm={onConfirmDelete}
        busy={deleting}
      />
    </div>
  );
}
