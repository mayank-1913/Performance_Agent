import { useEffect, useMemo, useState } from 'react';
import { collectionsApi } from '../../shared/api/collections.api.js';

const METHOD_TONES = {
  GET: 'bg-emerald-500/15 text-emerald-300',
  POST: 'bg-sky-500/15 text-sky-300',
  PUT: 'bg-amber-500/15 text-amber-300',
  PATCH: 'bg-amber-500/15 text-amber-300',
  DELETE: 'bg-rose-500/15 text-rose-300',
  HEAD: 'bg-slate-500/15 text-slate-300',
  OPTIONS: 'bg-slate-500/15 text-slate-300',
};

const ALL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * Approximate "execution size" so the user has a feel for how long a run
 * will take. We use the configured load profile to multiply the per-iteration
 * cost. This is intentionally rough.
 */
function estimateExecutionSize({ requestCount, loadProfile }) {
  if (!requestCount || !loadProfile) return null;
  const parseDur = (s) => {
    const m = String(s || '').match(/^(\d+)(ms|s|m|h)$/);
    if (!m) return 0;
    const n = Number(m[1]);
    const unit = m[2];
    const mult = { ms: 1 / 1000, s: 1, m: 60, h: 3600 }[unit];
    return n * mult;
  };
  const seconds =
    parseDur(loadProfile.rampUp) + parseDur(loadProfile.hold) + parseDur(loadProfile.rampDown);
  // Assumes ~1s sleep per request (matches the generator).
  const itersPerVu = Math.max(1, Math.floor(seconds / Math.max(1, requestCount)));
  const totalRequests = itersPerVu * (loadProfile.vus || 1) * requestCount;
  return {
    durationSeconds: seconds,
    estimatedRequests: totalRequests,
    iterationsPerVu: itersPerVu,
  };
}

/**
 * Flatten the tree into a list of request nodes for filtering and counting.
 */
function flatten(nodes, acc = []) {
  for (const n of nodes || []) {
    if (n.type === 'request') acc.push(n);
    else flatten(n.children, acc);
  }
  return acc;
}

function getDescendantRequestIndices(node) {
  const out = [];
  if (node.type === 'request') {
    out.push(node.requestIndex);
  } else {
    for (const child of node.children || []) {
      out.push(...getDescendantRequestIndices(child));
    }
  }
  return out;
}

/**
 * Selection model used by this component:
 *   selected: Set<number>   request indices that are checked
 *   expanded: Set<string>   folder ids that are open
 *
 * The parent receives `{ mode, requestIndex|requestIndices|folderPath }` via
 * `onSelectionChange` whenever the selection changes meaningfully.
 *
 * @param {object} props
 * @param {string} props.collectionId
 * @param {object} [props.loadProfile]   Used for execution size estimation
 * @param {(sel: object|null, meta: object) => void} props.onSelectionChange
 */
export default function RequestPicker({ collectionId, loadProfile, onSelectionChange }) {
  const [tree, setTree] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [search, setSearch] = useState('');
  const [methodFilters, setMethodFilters] = useState(() => new Set(ALL_METHODS));
  const [authOnly, setAuthOnly] = useState(false);
  const [foldersOnlyView, setFoldersOnlyView] = useState(false);

  // Load tree
  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const data = await collectionsApi.tree(collectionId);
        if (!mounted) return;
        setTree(data);
        // Default selection: everything.
        const allIdx = flatten(data.tree).map((r) => r.requestIndex);
        setSelected(new Set(allIdx));
        // Default expanded: top-level folders only.
        const topFolders = (data.tree || [])
          .filter((n) => n.type === 'folder')
          .map((n) => n.id);
        setExpanded(new Set(topFolders));
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [collectionId]);

  const allRequests = useMemo(() => (tree ? flatten(tree.tree) : []), [tree]);

  // Apply filters: search/method/authOnly
  const filteredIndices = useMemo(() => {
    const set = new Set();
    const q = search.trim().toLowerCase();
    for (const r of allRequests) {
      if (!methodFilters.has(r.method)) continue;
      if (authOnly && !r.hasAuth) continue;
      if (q) {
        const hay =
          `${r.name} ${r.url} ${(r.folderPath || []).join(' / ')}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      set.add(r.requestIndex);
    }
    return set;
  }, [allRequests, search, methodFilters, authOnly]);

  // Selection effective intersection with filter (so counts reflect what will run)
  const effectiveSelected = useMemo(() => {
    const out = new Set();
    for (const i of selected) if (filteredIndices.has(i)) out.add(i);
    return out;
  }, [selected, filteredIndices]);

  // Notify parent whenever selection (or filtering) changes.
  useEffect(() => {
    if (!tree) return;
    const total = allRequests.length;
    const indices = Array.from(effectiveSelected).sort((a, b) => a - b);
    let payload = null;
    if (indices.length === 0) {
      payload = null;
    } else if (indices.length === total) {
      payload = { mode: 'all' };
    } else if (indices.length === 1) {
      payload = { mode: 'single', requestIndex: indices[0] };
    } else {
      payload = { mode: 'requests', requestIndices: indices };
    }
    onSelectionChange?.(payload, {
      selectedCount: indices.length,
      totalCount: total,
      indices,
    });
  }, [effectiveSelected, allRequests.length, tree, onSelectionChange]);

  if (loading) {
    return <div className="card text-sm text-slate-400">Loading collection tree…</div>;
  }
  if (error) {
    return <div className="card text-sm text-rose-300">Error: {error}</div>;
  }
  if (!tree) return null;

  const total = allRequests.length;
  const selectedCount = effectiveSelected.size;
  const estimate = estimateExecutionSize({ requestCount: selectedCount, loadProfile });

  // Helpers used by the recursive renderer.
  const toggleFolder = (id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleRequest = (idx) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };
  const setFolderSelection = (node, on) => {
    const idxs = getDescendantRequestIndices(node);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const i of idxs) {
        if (on) next.add(i);
        else next.delete(i);
      }
      return next;
    });
  };
  const folderState = (node) => {
    const idxs = getDescendantRequestIndices(node);
    const visible = idxs.filter((i) => filteredIndices.has(i));
    if (visible.length === 0) return 'empty';
    const sel = visible.filter((i) => selected.has(i)).length;
    if (sel === 0) return 'none';
    if (sel === visible.length) return 'all';
    return 'some';
  };

  const selectAll = () => setSelected(new Set(filteredIndices));
  const selectNone = () => setSelected(new Set());
  const invert = () => {
    setSelected((prev) => {
      const next = new Set();
      for (const i of filteredIndices) if (!prev.has(i)) next.add(i);
      return next;
    });
  };

  return (
    <div className="card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-200">Select APIs to run</h3>
          <p className="text-xs text-slate-500 mt-1">
            Pick a single request, a folder, multiple requests, or the entire collection.
            Order is preserved exactly as in the collection.
          </p>
        </div>
        <div className="text-xs text-slate-400">
          <span className="font-semibold text-slate-100">{selectedCount}</span> /{' '}
          {total} selected
        </div>
      </div>

      {/* Filter bar */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <input
          type="text"
          placeholder="Filter by name, URL, or folder…"
          className="input flex-1 min-w-[12rem]"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex flex-wrap gap-1">
          {ALL_METHODS.map((m) => {
            const on = methodFilters.has(m);
            return (
              <button
                type="button"
                key={m}
                onClick={() =>
                  setMethodFilters((prev) => {
                    const next = new Set(prev);
                    if (next.has(m)) next.delete(m);
                    else next.add(m);
                    return next;
                  })
                }
                className={[
                  'rounded px-2 py-1 text-xs font-mono transition-colors',
                  on
                    ? METHOD_TONES[m] || 'bg-slate-500/15 text-slate-300'
                    : 'bg-slate-800/60 text-slate-500 hover:text-slate-300',
                ].join(' ')}
                title={`Toggle ${m}`}
              >
                {m}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={authOnly}
            onChange={(e) => setAuthOnly(e.target.checked)}
          />
          Auth only
        </label>
        <label className="flex items-center gap-1 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={foldersOnlyView}
            onChange={(e) => setFoldersOnlyView(e.target.checked)}
          />
          Folders view
        </label>
      </div>

      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button type="button" className="btn-secondary" onClick={selectAll}>
          Select all (filtered)
        </button>
        <button type="button" className="btn-secondary" onClick={selectNone}>
          Select none
        </button>
        <button type="button" className="btn-secondary" onClick={invert}>
          Invert
        </button>
      </div>

      {/* Tree */}
      <div className="mt-3 max-h-[55vh] overflow-y-auto overflow-x-hidden rounded-md border border-slate-700 bg-slate-800 p-2">
        {(tree.tree || []).length === 0 && (
          <div className="p-4 text-center text-xs text-slate-500">No requests in collection.</div>
        )}
        <TreeNodes
          nodes={tree.tree}
          depth={0}
          expanded={expanded}
          selected={selected}
          filteredIndices={filteredIndices}
          foldersOnlyView={foldersOnlyView}
          onToggleFolder={toggleFolder}
          onToggleRequest={toggleRequest}
          onFolderCheckbox={setFolderSelection}
          folderState={folderState}
        />
      </div>

      {/* Estimate */}
      {estimate && selectedCount > 0 && (
        <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/40 p-3 text-xs text-slate-300">
          <div className="font-semibold text-slate-200">Estimated execution size</div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-4">
            <div>
              <div className="text-slate-500">Selected</div>
              <div className="font-mono text-slate-100">{selectedCount} req</div>
            </div>
            <div>
              <div className="text-slate-500">Duration</div>
              <div className="font-mono text-slate-100">{estimate.durationSeconds}s</div>
            </div>
            <div>
              <div className="text-slate-500">VUs</div>
              <div className="font-mono text-slate-100">{loadProfile?.vus ?? '—'}</div>
            </div>
            <div>
              <div className="text-slate-500">Total HTTP calls (≈)</div>
              <div className="font-mono text-slate-100">
                {estimate.estimatedRequests.toLocaleString()}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeNodes({
  nodes,
  depth,
  expanded,
  selected,
  filteredIndices,
  foldersOnlyView,
  onToggleFolder,
  onToggleRequest,
  onFolderCheckbox,
  folderState,
}) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((node) => {
        if (node.type === 'folder') {
          const open = expanded.has(node.id);
          const state = folderState(node);
          return (
            <li key={node.id}>
              <div
                className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-slate-800/60"
                style={{ paddingLeft: `${depth * 16}px` }}
              >
                <button
                  type="button"
                  className="text-slate-500 hover:text-slate-200 w-4 text-center"
                  onClick={() => onToggleFolder(node.id)}
                  aria-label={open ? 'Collapse' : 'Expand'}
                >
                  {open ? '▾' : '▸'}
                </button>
                <input
                  type="checkbox"
                  ref={(el) => {
                    if (el) el.indeterminate = state === 'some';
                  }}
                  checked={state === 'all'}
                  onChange={(e) => onFolderCheckbox(node, e.target.checked)}
                  disabled={state === 'empty'}
                />
                <span className="text-sm text-slate-200">{node.name}</span>
                <span className="ml-auto text-xs text-slate-500">
                  {node.requestCount} req
                </span>
              </div>
              {open && (
                <TreeNodes
                  nodes={node.children}
                  depth={depth + 1}
                  expanded={expanded}
                  selected={selected}
                  filteredIndices={filteredIndices}
                  foldersOnlyView={foldersOnlyView}
                  onToggleFolder={onToggleFolder}
                  onToggleRequest={onToggleRequest}
                  onFolderCheckbox={onFolderCheckbox}
                  folderState={folderState}
                />
              )}
            </li>
          );
        }
        // request
        if (foldersOnlyView) return null;
        const isVisible = filteredIndices.has(node.requestIndex);
        if (!isVisible) return null;
        const isSel = selected.has(node.requestIndex);
        const tone = METHOD_TONES[node.method] || 'bg-slate-500/15 text-slate-300';
        return (
          <li key={node.id}>
            <label
              className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-slate-800/60 cursor-pointer min-w-0"
              style={{ paddingLeft: `${depth * 16 + 20}px` }}
            >
              <input
                type="checkbox"
                checked={isSel}
                onChange={() => onToggleRequest(node.requestIndex)}
                className="shrink-0"
              />
              <span
                className={[
                  'rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold shrink-0',
                  tone,
                ].join(' ')}
              >
                {node.method}
              </span>
              <span className="text-sm text-slate-200 truncate min-w-0 flex-1">
                {node.name}
              </span>
              {node.hasAuth && (
                <span className="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300 shrink-0">
                  auth
                </span>
              )}
              <span className="ml-2 truncate font-mono text-[11px] text-slate-500 min-w-0 max-w-[45%]">
                {node.url}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
