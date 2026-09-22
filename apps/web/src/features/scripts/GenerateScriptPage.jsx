import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { collectionsApi } from '../../shared/api/collections.api.js';
import { scriptsApi } from '../../shared/api/scripts.api.js';
import { runsApi } from '../../shared/api/runs.api.js';
import AuthStatusBadge from './AuthStatusBadge.jsx';
import ManualTokenField from './ManualTokenField.jsx';
import LoadProfileForm from './LoadProfileForm.jsx';
import AuthSessionModeForm from './AuthSessionModeForm.jsx';
import EnvironmentManager from './EnvironmentManager.jsx';
import RequestPicker from './RequestPicker.jsx';
import { PanelLoader } from '../../shared/components/Loading.jsx';

// These three only render after a script is generated, so they don't need to
// ship in the same chunk as the form.
const ScriptPreview = lazy(() => import('./ScriptPreview.jsx'));
const AuthFlowDiagram = lazy(() => import('./AuthFlowDiagram.jsx'));
const RunLauncher = lazy(() => import('../runs/RunLauncher.jsx'));

const DEFAULT_PROFILE = { profile: 'custom', vus: 5, rampUp: '30s', hold: '1m', rampDown: '30s' };

export default function GenerateScriptPage() {
  const { collectionId } = useParams();
  const navigate = useNavigate();

  const [collection, setCollection] = useState(null);
  const [loadingCol, setLoadingCol] = useState(true);
  const [error, setError] = useState(null);

  const [environmentId, setEnvironmentId] = useState(null);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [authSession, setAuthSession] = useState({
    authSessionMode: null,
    credentialReuse: false,
    credentialDataset: '',
  });
  const [manualToken, setManualToken] = useState('');

  const [liveAuth, setLiveAuth] = useState(null);
  const [authChecking, setAuthChecking] = useState(false);

  const [generating, setGenerating] = useState(false);
  const [script, setScript] = useState(null);

  const [preparing, setPreparing] = useState(false);
  const [prepResult, setPrepResult] = useState(null);

  // Selection state, owned here so the run-mode buttons can override it.
  const [selection, setSelection] = useState(null); // null = "all"
  const [selectionMeta, setSelectionMeta] = useState({
    selectedCount: 0,
    totalCount: 0,
    indices: [],
  });

  const onSelectionChange = useCallback((sel, meta) => {
    setSelection(sel);
    setSelectionMeta(meta);
  }, []);

  // Load collection on mount
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const data = await collectionsApi.get(collectionId);
        if (mounted) setCollection(data);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoadingCol(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [collectionId]);

  // Re-run auth detection whenever the env selection changes
  useEffect(() => {
    let mounted = true;
    if (!collectionId) return;
    setAuthChecking(true);
    (async () => {
      try {
        const data = await collectionsApi.authCheck(collectionId, environmentId);
        if (mounted) setLiveAuth(data.auth);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setAuthChecking(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [collectionId, environmentId]);

  const auth = liveAuth || script?.auth || collection?.auth || null;
  const hasUnresolved = (auth?.unresolvedTokenVars?.length || 0) > 0;
  const noEnvWarning =
    !environmentId && hasUnresolved && auth?.mode !== 'AUTO_MANAGED';

  const tokenWarning = useMemo(() => {
    if (!auth) return null;
    if (auth.mode === 'MANUAL_REQUIRED' && manualToken.trim().length === 0) {
      return 'Auth could not be auto-resolved. Provide a Bearer token, otherwise authenticated requests will fail.';
    }
    return null;
  }, [auth, manualToken]);

  /**
   * Generate a K6 script. `selectionOverride` lets the run-mode buttons force
   * a different selection without touching the picker state.
   */
  const generateScript = useCallback(
    async (selectionOverride = undefined) => {
      setGenerating(true);
      setError(null);
      setScript(null);
      setPrepResult(null);
      try {
        const sel = selectionOverride !== undefined ? selectionOverride : selection;
        const data = await scriptsApi.generate({
          collectionId,
          environmentId: environmentId || undefined,
          selection: sel ?? undefined,
          options: {
            // Legacy shape (still consumed by callers that predate Phase 6).
            loadProfile: {
              vus: profile.vus,
              rampUp: profile.rampUp,
              hold: profile.hold,
              rampDown: profile.rampDown,
            },
            // Phase 6 shape. When both are present the API prefers this one.
            workload: {
              profile: profile.profile || 'custom',
              authSessionMode: authSession.authSessionMode || undefined,
              credentialReuse: authSession.credentialReuse || undefined,
              overrides: {
                vus: profile.vus,
                rampUp: profile.rampUp,
                hold: profile.hold,
                rampDown: profile.rampDown,
              },
            },
            injectAuthToken:
              authSession.authSessionMode === 'MANUAL_TOKEN' ||
              auth?.mode === 'MANUAL_REQUIRED' ||
              manualToken.trim().length > 0,
          },
        });
        setScript(data);
        return data;
      } catch (err) {
        setError(err.message);
        return null;
      } finally {
        setGenerating(false);
      }
    },
    [collectionId, environmentId, profile, authSession, auth, manualToken, selection]
  );

  const onPrepareRun = async () => {
    if (!script) return;
    setPreparing(true);
    setError(null);
    try {
      const data = await runsApi.prepare({
        scriptId: script.id,
        env: {},
        authToken: manualToken || undefined,
        credentialDataset: authSession.credentialDataset || undefined,
        credentialReuse: authSession.credentialReuse || undefined,
      });
      setPrepResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setPreparing(false);
    }
  };

  if (loadingCol) {
    return <div className="card">Loading collection…</div>;
  }
  if (error && !collection) {
    return <div className="card text-rose-300">Error: {error}</div>;
  }
  if (!collection) {
    return <div className="card">Collection not found.</div>;
  }

  const tokenRecommended = auth?.mode === 'MANUAL_REQUIRED';
  const totalRequests = selectionMeta.totalCount || collection.summary?.requestCount || 0;
  const canRunSingle = selectionMeta.selectedCount === 1;

  return (
    <div className="page-stack">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button
            className="text-xs text-slate-400 hover:text-slate-200"
            onClick={() => navigate('/collections')}
          >
            ← Back to collections
          </button>
          <h2 className="mt-1 text-lg font-semibold text-slate-100">Generate K6 script</h2>
          <p className="text-sm text-slate-400 force-wrap">
            {collection.summary?.name} · {totalRequests} requests
          </p>
        </div>
        {authChecking && <div className="text-xs text-slate-500">Re-checking auth…</div>}
      </div>

      {/* Sequential workflow ribbon — gives the page a guided feel without
          forcing users into a strict wizard. */}
      <div className="step-ribbon">
        <span className={`step ${!script ? 'step-active' : ''}`}>
          <span className="step-num">1</span> Auth &amp; environment
        </span>
        <span className="step-sep">›</span>
        <span className={`step ${!script ? 'step-active' : ''}`}>
          <span className="step-num">2</span> Load profile &amp; selection
        </span>
        <span className="step-sep">›</span>
        <span className={`step ${script && !prepResult ? 'step-active' : ''}`}>
          <span className="step-num">3</span> Generate script
        </span>
        <span className="step-sep">›</span>
        <span className={`step ${script ? 'step-active' : ''}`}>
          <span className="step-num">4</span> Run test
        </span>
      </div>

      <AuthStatusBadge auth={auth} />

      <EnvironmentManager value={environmentId} onChange={setEnvironmentId} />

      {noEnvWarning && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-3 text-sm text-amber-300">
          <div className="font-semibold">No environment selected</div>
          <div className="mt-1 text-xs">
            The collection references {auth.unresolvedTokenVars.length} unresolved auth variable
            {auth.unresolvedTokenVars.length === 1 ? '' : 's'} ({auth.unresolvedTokenVars.join(', ')}
            ). Select or upload an environment that defines them, or provide a manual Bearer token below.
          </div>
        </div>
      )}

      <ManualTokenField
        value={manualToken}
        onChange={setManualToken}
        recommended={tokenRecommended}
      />

      {tokenWarning && (
        <div className="rounded-md border border-amber-700/50 bg-amber-500/10 p-3 text-sm text-amber-300">
          {tokenWarning}
        </div>
      )}

      <LoadProfileForm value={profile} onChange={setProfile} />

      <AuthSessionModeForm
        authSessionMode={authSession.authSessionMode}
        credentialReuse={authSession.credentialReuse}
        credentialDataset={authSession.credentialDataset}
        onChange={setAuthSession}
        loginDetected={auth?.mode === 'AUTO_MANAGED' || !!script?.authFlow?.enabled}
      />

      <RequestPicker
        collectionId={collectionId}
        loadProfile={profile}
        onSelectionChange={onSelectionChange}
      />

      {error && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
          {error}
        </div>
      )}

      <div className="card">
        <h3 className="text-sm font-semibold text-slate-200">Generate</h3>
        <p className="text-xs text-slate-500 mt-1">
          Pick how much of the collection to include. The button label updates with your
          current selection.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            className="btn-primary"
            onClick={() => generateScript()}
            disabled={generating || selectionMeta.selectedCount === 0}
            title={
              selectionMeta.selectedCount === 0
                ? 'Pick at least one request from the tree'
                : undefined
            }
          >
            {generating
              ? 'Generating…'
              : selectionMeta.selectedCount === selectionMeta.totalCount
              ? `Run entire collection (${selectionMeta.totalCount})`
              : `Run selected (${selectionMeta.selectedCount})`}
          </button>
          <button
            className="btn-secondary"
            onClick={() =>
              generateScript(
                selectionMeta.indices.length === 1
                  ? { mode: 'single', requestIndex: selectionMeta.indices[0] }
                  : undefined
              )
            }
            disabled={generating || !canRunSingle}
            title={
              canRunSingle ? 'Generate a script with just the one selected request' : 'Select exactly one request'
            }
          >
            Run single API
          </button>
          <button
            className="btn-secondary"
            onClick={() => generateScript({ mode: 'all' })}
            disabled={generating}
          >
            Run entire collection
          </button>
          {script && (
            <button className="btn-secondary" onClick={onPrepareRun} disabled={preparing}>
              {preparing ? 'Preparing…' : 'Prepare run (preview env)'}
            </button>
          )}
        </div>
      </div>

      {script && (
        <Suspense fallback={<PanelLoader label="Loading script preview…" />}>
          <AuthFlowDiagram authFlow={script.authFlow} />

          <div className="card">
            <h3 className="text-sm font-semibold text-slate-200">Script metadata</h3>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <dt className="text-slate-500">Script ID</dt>
              <dd className="break-all font-mono text-xs text-slate-300">{script.id}</dd>
              <dt className="text-slate-500">Selection mode</dt>
              <dd className="font-mono text-xs text-slate-100">
                {script.selection?.mode || 'all'}
              </dd>
              <dt className="text-slate-500">Selected requests</dt>
              <dd className="text-slate-100">
                {script.requestCount} / {script.totalCollectionRequests ?? script.requestCount}
              </dd>
              <dt className="text-slate-500">Inject AUTH_TOKEN</dt>
              <dd className="text-slate-100">
                {script.injectAuthToken ? 'Yes' : 'No (collection/env handles it)'}
              </dd>
              <dt className="text-slate-500">Expected env vars</dt>
              <dd className="font-mono text-xs text-slate-300">
                {script.expectedEnvVars.join(', ') || '—'}
              </dd>
            </dl>
            {Array.isArray(script.selectedRequests) && script.selectedRequests.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-slate-400">
                  View selected requests ({script.selectedRequests.length})
                </summary>
                <ul className="mt-2 max-h-48 overflow-y-auto overflow-x-hidden rounded-md border border-slate-700 bg-slate-800 p-2 text-xs">
                  {script.selectedRequests.map((r) => (
                    <li
                      key={r.index}
                      className="flex items-center gap-2 py-0.5 min-w-0"
                    >
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
              </details>
            )}
          </div>

          <ScriptPreview code={script.code} downloadUrl={scriptsApi.downloadUrl(script.id)} />

          <RunLauncher
            script={script}
            manualToken={manualToken}
            credentialDataset={authSession.credentialDataset}
            credentialReuse={authSession.credentialReuse}
          />
        </Suspense>
      )}

      {prepResult && (
        <div className="card">
          <h3 className="text-sm font-semibold text-slate-200">Run preparation</h3>
          <p className="text-xs text-slate-500 mt-1">{prepResult.note}</p>
          <div className="mt-3 text-sm">
            Status:{' '}
            {prepResult.ready ? (
              <span className="text-emerald-300">Ready ✓</span>
            ) : (
              <span className="text-amber-300">
                Missing: {prepResult.missingEnvVars.join(', ')}
              </span>
            )}
          </div>
          <pre className="mt-3 code-block-scroll-y max-h-[40vh]">
            {JSON.stringify(prepResult.env, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
