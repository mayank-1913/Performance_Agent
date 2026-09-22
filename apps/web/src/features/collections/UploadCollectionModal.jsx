import { useCallback, useRef, useState } from 'react';
import { collectionsApi } from '../../shared/api/collections.api.js';

const MAX_MB = 10;

/**
 * Modal upload dialog for Postman collections. Same logic as the legacy
 * `UploadPage`: drag/drop or click to pick a single .json file, validate, then
 * POST it to `/collections`. Calls `onUploaded(collection)` on success so the
 * parent can refresh its list.
 */
export default function UploadCollectionModal({ open, onClose, onUploaded }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const reset = () => {
    setFile(null);
    setError(null);
    setResult(null);
    setDragOver(false);
    setUploading(false);
  };

  const handleClose = () => {
    if (uploading) return;
    reset();
    onClose?.();
  };

  const validate = (f) => {
    if (!f) return 'No file selected.';
    if (!f.name.toLowerCase().endsWith('.json')) return 'Only .json files are accepted.';
    if (f.size > MAX_MB * 1024 * 1024) return `File exceeds ${MAX_MB}MB limit.`;
    return null;
  };

  const onPick = (f) => {
    const err = validate(f);
    if (err) {
      setError(err);
      setFile(null);
      return;
    }
    setError(null);
    setResult(null);
    setFile(f);
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    onPick(f);
  }, []);

  const onSubmit = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const data = await collectionsApi.upload(file);
      setResult(data);
      onUploaded?.(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-xl border border-slate-700 bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-100">Upload Postman collection</h3>
            <p className="mt-1 text-xs text-slate-500">
              Postman v2.1 collection JSON. Max {MAX_MB}MB.
            </p>
          </div>
          <button
            type="button"
            className="btn-ghost !px-2 !py-1 text-slate-400"
            onClick={handleClose}
            disabled={uploading}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {!result && (
          <>
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={[
                'mt-5 cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-all',
                dragOver
                  ? 'border-brand-500 bg-brand-500/10'
                  : 'border-slate-600 bg-slate-800 hover:border-slate-500 hover:bg-slate-900',
              ].join(' ')}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => onPick(e.target.files?.[0])}
              />
              <div className="text-sm text-slate-300">
                {file ? (
                  <>
                    <div className="font-medium text-slate-100">{file.name}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      {(file.size / 1024).toFixed(1)} KB
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-base font-medium text-slate-200">
                      Drag &amp; drop your{' '}
                      <code className="text-brand-300">.json</code> file here
                    </div>
                    <div className="mt-1 text-xs text-slate-500">or click to browse</div>
                  </>
                )}
              </div>
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              {file && !uploading && (
                <button type="button" className="btn-ghost" onClick={reset}>
                  Clear
                </button>
              )}
              <button type="button" className="btn-secondary" onClick={handleClose} disabled={uploading}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={onSubmit}
                disabled={!file || uploading}
              >
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>

            {error && (
              <div className="mt-4 rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
                {error}
              </div>
            )}
          </>
        )}

        {result && (
          <div className="mt-5 rounded-lg border border-emerald-700/40 bg-emerald-500/10 p-4">
            <div className="text-sm font-semibold text-emerald-200">Uploaded successfully</div>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-emerald-200/70">Name</dt>
              <dd className="text-slate-100">{result.summary?.name}</dd>
              <dt className="text-emerald-200/70">Requests</dt>
              <dd className="text-slate-100">{result.summary?.requestCount}</dd>
              <dt className="text-emerald-200/70">Folders</dt>
              <dd className="text-slate-100">{result.summary?.folderCount}</dd>
              <dt className="text-emerald-200/70">Size</dt>
              <dd className="text-slate-100">{(result.sizeBytes / 1024).toFixed(1)} KB</dd>
            </dl>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-secondary" onClick={handleClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
