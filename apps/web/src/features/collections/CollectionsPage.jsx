import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { collectionsApi } from '../../shared/api/collections.api.js';
import { reportsApi } from '../../shared/api/reports.api.js';
import UploadCollectionModal from './UploadCollectionModal.jsx';

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

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

const STATUS_DOT = {
  completed: 'bg-emerald-400',
  failed: 'bg-rose-400',
  stopped: 'bg-amber-400',
  running: 'bg-sky-400 animate-pulse',
  queued: 'bg-slate-400',
};

function ConfirmDeleteModal({ open, busy, name, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-white p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">Delete collection?</h3>
        <p className="mt-2 text-sm text-slate-300">
          This permanently removes <span className="font-medium text-slate-100">{name}</span>{' '}
          and its uploaded JSON. Existing reports stay intact.
        </p>
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

function CollectionCard({ collection, lastRun, onDelete, onRunAgain }) {
  const requests = collection.summary?.requestCount ?? 0;
  const folders = collection.summary?.folderCount ?? 0;
  const lastStatus = lastRun?.status;
  const dot = STATUS_DOT[lastStatus] || 'bg-slate-700';

  return (
    <div className="card card-hover flex flex-col gap-4 p-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 min-w-0">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-slate-100">
            {collection.summary?.name || collection.originalName}
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            Uploaded {relativeTime(collection.uploadedAt)} ·{' '}
            {(collection.sizeBytes / 1024).toFixed(1)} KB
          </p>
        </div>
        <span className="chip shrink-0">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {lastStatus || 'no runs'}
        </span>
      </div>

      {/* Counts */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Requests</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{requests}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Folders</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{folders}</div>
        </div>
        <div className="rounded-lg border border-slate-700 bg-slate-800 p-3">
          <div className="text-[10px] uppercase tracking-wide text-slate-500">Last run</div>
          <div className="mt-1 truncate text-sm font-semibold text-slate-100">
            {lastRun ? relativeTime(lastRun.startedAt) : '—'}
          </div>
          <div className="text-[10px] text-slate-500">
            {lastRun?.durationMs != null ? fmtDuration(lastRun.durationMs) : ''}
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Link
          to={`/collections/${collection.id}/generate`}
          className="btn-primary !py-1.5 !px-3 text-xs"
        >
          Generate K6
        </Link>
        <button
          type="button"
          className="btn-secondary !py-1.5 !px-3 text-xs"
          onClick={onRunAgain}
          disabled={!lastRun}
          title={
            lastRun
              ? 'Open the last run for this collection'
              : 'Generate a script first'
          }
        >
          Run
        </button>
        <Link
          to={`/reports?collection=${encodeURIComponent(collection.summary?.name || '')}`}
          className="btn-ghost !py-1.5 !px-3 text-xs"
        >
          Reports
        </Link>
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto rounded-md px-2 py-1.5 text-xs font-medium text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

export default function CollectionsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      const [cols, reps] = await Promise.all([
        collectionsApi.list(),
        reportsApi.list().catch(() => []),
      ]);
      setItems(cols || []);
      setReports(reps || []);
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

  // Map: collection name -> latest report (we don't persist collectionId on
  // every report yet, but reports carry `collectionName`, which we already
  // surface in the UI).
  const latestByCollection = useMemo(() => {
    const out = new Map();
    for (const r of reports) {
      const key = r.collectionName || '';
      if (!key) continue;
      const prev = out.get(key);
      if (!prev || String(r.startedAt || '') > String(prev.startedAt || '')) {
        out.set(key, r);
      }
    }
    return out;
  }, [reports]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter((c) => {
      const hay = `${c.summary?.name || ''} ${c.originalName || ''} ${c.id || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [items, search]);

  const onDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await collectionsApi.remove(pendingDelete.id);
      setPendingDelete(null);
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setDeleting(false);
    }
  };

  const onRunAgain = async (collection) => {
    const last = latestByCollection.get(collection.summary?.name || '');
    if (last?.runId) {
      navigate(`/runs/${last.runId}`);
      return;
    }
    navigate(`/collections/${collection.id}/generate`);
  };

  return (
    <div className="page-stack">
      <div className="page-hero">
        <div className="min-w-0">
          <h2 className="page-hero-title">Collections</h2>
          <p className="page-hero-subtitle">
            Your primary workspace. Upload Postman collections, generate K6 scripts, run load
            tests and inspect reports.
          </p>
        </div>
        <button
          type="button"
          className="btn-primary whitespace-nowrap"
          onClick={() => setShowUpload(true)}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          Upload Collection
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[16rem] max-w-lg">
          <input
            className="input pl-9"
            placeholder="Search by name or ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </div>
        <div className="text-xs text-slate-500">
          {filtered.length} / {items.length} collection{items.length === 1 ? '' : 's'}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      {loading && (
        <div className="card text-sm text-slate-400">Loading collections…</div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="card-loud text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800/60">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              className="h-5 w-5 text-slate-400"
            >
              <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
            </svg>
          </div>
          <h3 className="text-base font-semibold text-slate-100">
            {items.length === 0 ? 'No collections yet' : 'No matches'}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-400">
            {items.length === 0
              ? 'Upload a Postman v2.1 collection to start generating K6 scripts and running performance tests.'
              : 'Try a different search term, or clear the search to see everything.'}
          </p>
          {items.length === 0 && (
            <button
              type="button"
              className="btn-primary mt-4"
              onClick={() => setShowUpload(true)}
            >
              Upload your first collection
            </button>
          )}
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((c) => (
            <CollectionCard
              key={c.id}
              collection={c}
              lastRun={latestByCollection.get(c.summary?.name || '')}
              onDelete={() => setPendingDelete(c)}
              onRunAgain={() => onRunAgain(c)}
            />
          ))}
        </div>
      )}

      <UploadCollectionModal
        open={showUpload}
        onClose={() => {
          setShowUpload(false);
          // Refresh once the modal closes in case an upload completed.
          refresh();
        }}
        onUploaded={() => {
          // Soft refresh while the modal is still open so the user sees the
          // success state, then the close handler will refresh again.
          refresh();
        }}
      />

      <ConfirmDeleteModal
        open={!!pendingDelete}
        busy={deleting}
        name={pendingDelete?.summary?.name || pendingDelete?.originalName || ''}
        onCancel={() => (deleting ? null : setPendingDelete(null))}
        onConfirm={onDelete}
      />
    </div>
  );
}
