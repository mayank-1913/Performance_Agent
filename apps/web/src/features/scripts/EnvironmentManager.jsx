import { useCallback, useEffect, useRef, useState } from 'react';
import { environmentsApi } from '../../shared/api/environments.api.js';

const MAX_MB = 10;

/**
 * Inline environment manager for the Generate K6 page.
 *
 * Layout: a single row with the dropdown + "+ Upload" button.
 * Picking a file uploads it immediately (auto-refresh + auto-select),
 * so the user never has to leave the page or switch tabs.
 *
 * @param {object} props
 * @param {string|null} props.value           Selected environment id
 * @param {(id: string|null) => void} props.onChange
 */
function ConfirmDeleteModal({ open, busy, name, onCancel, onConfirm }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h3 className="text-base font-semibold text-slate-100">Remove environment?</h3>
        <p className="mt-2 text-sm text-slate-300">
          This permanently removes <span className="font-medium text-slate-100">{name}</span> from
          storage. The collection is not affected. Active runs keep their runtime values; future runs
          will no longer use this environment.
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
            {busy ? 'Removing…' : 'Remove permanently'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function EnvironmentManager({ value, onChange }) {
  const inputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [lastUploadedName, setLastUploadedName] = useState(null);

  const [details, setDetails] = useState(null);
  const [detailsError, setDetailsError] = useState(null);

  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(null);

  const refreshList = useCallback(async () => {
    setLoading(true);
    try {
      const data = await environmentsApi.list();
      setItems(data || []);
      setListError(null);
    } catch (err) {
      setListError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  // Load full details (variables + issues) for the currently selected env.
  useEffect(() => {
    let mounted = true;
    setDetails(null);
    setDetailsError(null);
    if (!value) return;
    (async () => {
      try {
        const data = await environmentsApi.get(value);
        if (mounted) setDetails(data);
      } catch (err) {
        if (mounted) setDetailsError(err.message);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [value]);

  const validateFile = (f) => {
    if (!f) return 'No file selected.';
    if (!f.name.toLowerCase().endsWith('.json')) return 'Only .json files are accepted.';
    if (f.size > MAX_MB * 1024 * 1024) return `File exceeds ${MAX_MB}MB limit.`;
    return null;
  };

  const handleUpload = useCallback(
    async (file) => {
      if (!file) return;
      const err = validateFile(file);
      if (err) {
        setUploadError(err);
        return;
      }
      setUploadError(null);
      setUploading(true);
      try {
        const data = await environmentsApi.upload(file);
        await refreshList();
        onChange(data.id); // auto-select the freshly uploaded env
        setLastUploadedName(data?.summary?.name || file.name);
      } catch (e) {
        let msg = e.message;
        if (e.details?.issues?.length) {
          msg = `${e.message} — ${e.details.issues.map((i) => i.message).join(' · ')}`;
        }
        setUploadError(msg);
      } finally {
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [onChange, refreshList]
  );

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await environmentsApi.remove(pendingDelete.id);
      if (value === pendingDelete.id) onChange(null);
      await refreshList();
      setPendingDelete(null);
      setDetails(null);
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, value, onChange, refreshList]);

  const selectedItem = items.find((e) => e.id === value);

  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-200">Environment</h3>
        <span className="chip">optional</span>
      </div>
      <p className="text-xs text-slate-500 mt-1">
        Attach a Postman environment so the generator can auto-resolve token variables.
        You can upload one right here — environments are contextual to this run.
      </p>

      {/* Single-row picker + upload */}
      <div className="mt-3 flex items-center gap-2">
        <select
          className="input flex-1"
          value={value || ''}
          onChange={(e) => onChange(e.target.value || null)}
          disabled={loading || uploading}
        >
          <option value="">— None —</option>
          {items.map((e) => (
            <option key={e.id} value={e.id}>
              {e.summary?.name} ·{' '}
              {e.summary?.tokenVarCount > 0
                ? `${e.summary.tokenVarCount} token vars`
                : 'no token vars'}
            </option>
          ))}
        </select>

        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => handleUpload(e.target.files?.[0])}
        />
        <button
          type="button"
          className="btn-secondary whitespace-nowrap"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          title="Upload a Postman environment JSON"
        >
          {uploading ? 'Uploading…' : '+ Upload Environment'}
        </button>
        {value && (
          <button
            type="button"
            className="btn-secondary whitespace-nowrap !text-rose-300 !border-rose-800 hover:!bg-rose-950/40"
            onClick={() =>
              setPendingDelete({
                id: value,
                name: selectedItem?.summary?.name || 'selected environment',
              })
            }
            disabled={uploading || deleting}
            title="Remove the selected environment"
          >
            Remove
          </button>
        )}
      </div>

      {listError && (
        <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-300">
          {listError}
        </div>
      )}
      {uploadError && (
        <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-300">
          {uploadError}
        </div>
      )}
      {!uploadError && lastUploadedName && (
        <div className="mt-3 rounded-md border border-emerald-700/50 bg-emerald-500/10 p-2 text-xs text-emerald-300">
          Uploaded and selected: <span className="font-medium">{lastUploadedName}</span>
        </div>
      )}

      {deleteError && (
        <div className="mt-3 rounded-md border border-rose-800 bg-rose-950/40 p-2 text-xs text-rose-300">
          {deleteError}
        </div>
      )}

      {value && <EnvironmentDetailsPanel details={details} error={detailsError} />}

      <ConfirmDeleteModal
        open={!!pendingDelete}
        busy={deleting}
        name={pendingDelete?.name}
        onCancel={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function ValidationIssues({ issues }) {
  if (!issues || issues.length === 0) return null;
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  if (errors.length === 0 && warnings.length === 0) return null;

  return (
    <div className="space-y-2">
      {errors.length > 0 && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-300">
          <div className="font-semibold">Errors</div>
          <ul className="mt-1 list-disc pl-4">
            {errors.map((i, idx) => (
              <li key={idx}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-3 text-xs text-amber-300">
          <div className="font-semibold">Warnings</div>
          <ul className="mt-1 list-disc pl-4">
            {warnings.map((i, idx) => (
              <li key={idx}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EnvironmentDetailsPanel({ details, error }) {
  if (error) {
    return (
      <div className="mt-4 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
        {error}
      </div>
    );
  }
  if (!details) {
    return <div className="mt-4 text-xs text-slate-500">Loading environment details…</div>;
  }

  const values = details.values || [];
  const issues = details.validation?.issues || [];

  return (
    <div className="mt-4 space-y-3">
      <div className="rounded-md border border-slate-800 bg-slate-900/40 p-3 text-sm">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-semibold text-slate-100">{details.summary?.name}</div>
            <div className="text-xs text-slate-500">
              {details.summary?.variableCount} variables ·{' '}
              {details.summary?.tokenVarCount} sensitive
            </div>
          </div>
          <div className="text-xs text-slate-500">
            Uploaded {new Date(details.uploadedAt).toLocaleString()}
          </div>
        </div>
      </div>

      <ValidationIssues issues={issues} />

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="px-3 py-2">Variable</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {values.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-center text-slate-500">
                  No enabled variables.
                </td>
              </tr>
            )}
            {values.map((v) => (
              <tr key={v.key} className="hover:bg-slate-900/40">
                <td className="px-3 py-1.5 font-mono text-slate-200">{v.key}</td>
                <td className="px-3 py-1.5 font-mono text-slate-300 force-wrap max-w-[24rem]">
                  {v.hasValue ? (
                    v.value || (v.secret ? <span className="text-slate-500">****</span> : '')
                  ) : (
                    <span className="text-slate-600">— empty —</span>
                  )}
                </td>
                <td className="px-3 py-1.5">
                  {v.secret ? (
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
                      sensitive
                    </span>
                  ) : (
                    <span className="text-slate-500">default</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
