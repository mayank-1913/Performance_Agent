import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
} from 'recharts';
import { runsApi } from '../../shared/api/runs.api.js';
import { reportsApi } from '../../shared/api/reports.api.js';

/* ---------- Formatters ---------- */
const fmtMs = (ms) => {
  if (ms == null) return '—';
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};
const fmtBytes = (b) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
};
const fmtPct = (r) => (r == null ? '—' : `${(r * 100).toFixed(2)}%`);

/* ---------- Stat card ---------- */
function Stat({ label, value, sub, tone = 'slate' }) {
  const toneCls = {
    slate: 'text-slate-100',
    ok: 'text-emerald-300',
    bad: 'text-rose-300',
    warn: 'text-amber-300',
    info: 'text-sky-300',
  }[tone];
  return (
    <div className="rounded-md border border-slate-700 bg-slate-800 p-3 min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-xl font-semibold ${toneCls} force-wrap`}>{value}</div>
      {sub != null && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/* ---------- Chart helper ---------- */
function ChartCard({ title, children, hint }) {
  return (
    <div className="rounded-md border border-slate-700 bg-white p-3 min-w-0">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span className="font-semibold text-slate-200">{title}</span>
        {hint && <span>{hint}</span>}
      </div>
      <div className="mt-2 h-[200px] w-full">
        <ResponsiveContainer>{children}</ResponsiveContainer>
      </div>
    </div>
  );
}

const TICK_STYLE = { fontSize: 10, fill: '#64748b' };
const GRID = { stroke: '#1f2937' };

function formatTick(t) {
  // ISO -> HH:MM:SS for chart axes
  if (typeof t !== 'string') return '';
  const m = t.match(/T(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : t;
}

/* ---------- Report container ---------- */
export default function RunReport({ runId, status, source = 'runs' }) {
  const api = source === 'reports' ? reportsApi : runsApi;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tick, setTick] = useState(0);

  const isRunning = status === 'running' || status === 'queued';

  useEffect(() => {
    if (!runId) return;
    if (isRunning) return; // wait until run finishes
    let mounted = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const m = await api.metrics(runId);
        if (mounted) setData(m);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [runId, isRunning, tick, api]);

  if (isRunning) {
    return (
      <div className="rounded-md border border-slate-700 bg-slate-800 p-6 text-center text-sm text-slate-400">
        The full report will appear here once the run finishes.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="rounded-md border border-slate-700 bg-slate-800 p-6 text-center text-sm text-slate-400">
        Building report…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-sm text-rose-300">
        {error}
        <button
          className="ml-3 underline text-rose-200 hover:text-rose-100"
          onClick={() => setTick((t) => t + 1)}
        >
          Retry
        </button>
      </div>
    );
  }
  if (!data) return null;

  const s = data.summary || {};
  const rt = s.responseTime || {};
  const reqs = s.requests || {};
  const checks = s.checks || {};
  const points = data.timeseries?.points || [];
  const requests = data.requests || [];
  const failures = data.failures || [];
  const thresholds = data.thresholds || [];

  return <ReportBody
    runId={runId}
    api={api}
    summary={s}
    authSession={data.normalized?.authSession || null}
    rt={rt}
    reqs={reqs}
    checks={checks}
    points={points}
    requests={requests}
    failures={failures}
    thresholds={thresholds}
  />;
}

function ReportBody({
  runId,
  api,
  summary,
  authSession,
  rt,
  reqs,
  checks,
  points,
  requests,
  failures,
  thresholds,
}) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('avg');

  const passedThresholds = thresholds.filter((t) => t.ok).length;
  const failedThresholds = thresholds.length - passedThresholds;

  const filteredRequests = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? requests.filter((r) => `${r.name} ${r.method}`.toLowerCase().includes(q))
      : requests.slice();
    list.sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0));
    return list;
  }, [requests, search, sortKey]);

  return (
    <div className="space-y-4">
      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-slate-500">
          Parsed {summary.pointsParsed?.toLocaleString?.() || 0} metric samples ·{' '}
          {points.length} time buckets
        </div>
        <div className="flex flex-wrap gap-2">
          <a
            className="btn-secondary"
            href={api.reportUrl(runId)}
            target="_blank"
            rel="noreferrer"
          >
            View report
          </a>
          <a className="btn-primary" href={api.reportDownloadUrl(runId)}>
            Download report
          </a>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        <Stat label="Total requests" value={reqs.total ?? '—'} />
        <Stat
          label="Failed"
          value={reqs.failed ?? '—'}
          sub={fmtPct(reqs.errorRate ?? 0)}
          tone={reqs.failed > 0 ? 'bad' : 'ok'}
        />
        <Stat label="RPS (avg)" value={reqs.rps ?? '—'} />
        <Stat label="Throughput" value={`${fmtBytes(reqs.throughputBytesPerSec)}/s`} />
        <Stat label="VUs (max)" value={summary.vusMax ?? '—'} />
        <Stat label="Iterations" value={summary.iterations ?? '—'} />
        {authSession?.authenticationMode && (
          <>
            <Stat
              label="Authentication mode"
              value={authSession.authenticationMode}
              tone="info"
            />
            <Stat
              label="Credential records"
              value={authSession.credentialRecords ?? '—'}
            />
            <Stat
              label="Credential reuse"
              value={authSession.credentialReuse ? 'YES' : 'NO'}
            />
          </>
        )}
        <Stat label="Avg duration" value={fmtMs(rt.avg)} tone="info" />
        <Stat label="p95 duration" value={fmtMs(rt.p95)} tone="info" />
        <Stat label="p99 duration" value={fmtMs(rt.p99)} tone="info" />
        <Stat label="Min / Max" value={`${fmtMs(rt.min)} / ${fmtMs(rt.max)}`} />
        <Stat label="Data sent" value={fmtBytes(summary.network?.dataSent)} />
        <Stat label="Data received" value={fmtBytes(summary.network?.dataReceived)} />
        <Stat
          label="Checks pass rate"
          value={fmtPct(checks.passRate)}
          sub={
            checks.passes != null && checks.fails != null
              ? `${checks.passes}/${checks.passes + checks.fails}`
              : null
          }
          tone={checks.passRate != null && checks.passRate < 1 ? 'warn' : 'ok'}
        />
        <Stat
          label="Thresholds"
          value={`${passedThresholds} ✓ / ${failedThresholds} ✗`}
          tone={failedThresholds > 0 ? 'bad' : 'ok'}
        />
      </div>

      {/* Threshold panel */}
      <div className="card">
        <h3 className="text-sm font-semibold text-slate-200">Thresholds</h3>
        {thresholds.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No thresholds defined.</p>
        ) : (
          <div className="table-wrap mt-3 max-h-56 overflow-y-auto">
            <table>
              <thead>
                <tr>
                  <th className="px-3 py-2">Metric</th>
                  <th className="px-3 py-2">Expression</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Last value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {thresholds.map((t, i) => (
                  <tr key={`${t.metric}-${t.expression}-${i}`} className="hover:bg-slate-900/40">
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-200">
                      {t.metric}
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-300">
                      {t.expression}
                    </td>
                    <td className="px-3 py-1.5">
                      <span
                        className={[
                          'rounded px-1.5 py-0.5 text-[11px] font-semibold',
                          t.ok
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-rose-500/15 text-rose-300',
                        ].join(' ')}
                      >
                        {t.ok ? 'pass' : 'fail'}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-300">
                      {t.lastValue == null ? '—' : t.lastValue}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <ChartCard title="p95 response time" hint="ms">
          <AreaChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
            />
            <Area type="monotone" dataKey="p95" stroke="#60a5fa" fill="#60a5fa33" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Requests per second" hint="rps">
          <LineChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
            />
            <Line type="monotone" dataKey="rps" stroke="#34d399" dot={false} strokeWidth={2} />
          </LineChart>
        </ChartCard>

        <ChartCard title="Errors per bucket" hint="">
          <BarChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
            />
            <Bar dataKey="errors" fill="#f87171" />
          </BarChart>
        </ChartCard>

        <ChartCard title="Virtual users" hint="vus">
          <AreaChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} allowDecimals={false} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
            />
            <Area type="step" dataKey="vus" stroke="#a78bfa" fill="#a78bfa33" />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Throughput (bytes/s)" hint="bps">
          <AreaChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
              formatter={(v) => fmtBytes(v) + '/s'}
            />
            <Area
              type="monotone"
              dataKey="throughput"
              stroke="#fbbf24"
              fill="#fbbf2433"
            />
          </AreaChart>
        </ChartCard>

        <ChartCard title="Execution timeline (combined)" hint="vus + rps + errors">
          <LineChart data={points} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
            <CartesianGrid {...GRID} strokeDasharray="3 3" />
            <XAxis dataKey="t" tickFormatter={formatTick} tick={TICK_STYLE} />
            <YAxis tick={TICK_STYLE} />
            <Tooltip
              contentStyle={{ background: '#0f172a', border: '1px solid #1f2937' }}
              labelFormatter={formatTick}
            />
            <Line type="monotone" dataKey="vus" stroke="#a78bfa" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="rps" stroke="#34d399" dot={false} strokeWidth={1.5} />
            <Line type="monotone" dataKey="errors" stroke="#f87171" dot={false} strokeWidth={1.5} />
          </LineChart>
        </ChartCard>
      </div>

      {/* Request table */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-200">Requests breakdown</h3>
          <div className="flex flex-wrap gap-2">
            <input
              className="input w-56"
              placeholder="Filter…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              className="input w-40"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              title="Sort by"
            >
              <option value="avg">Sort: avg</option>
              <option value="p95">Sort: p95</option>
              <option value="p99">Sort: p99</option>
              <option value="errorRate">Sort: error rate</option>
              <option value="count">Sort: count</option>
              <option value="max">Sort: max</option>
            </select>
          </div>
        </div>
        <div className="table-wrap mt-3 max-h-[60vh] overflow-y-auto">
          <table>
            <thead>
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Method</th>
                <th className="px-3 py-2">Count</th>
                <th className="px-3 py-2">Avg</th>
                <th className="px-3 py-2">Min</th>
                <th className="px-3 py-2">Max</th>
                <th className="px-3 py-2">p90</th>
                <th className="px-3 py-2">p95</th>
                <th className="px-3 py-2">p99</th>
                <th className="px-3 py-2">Errors</th>
                <th className="px-3 py-2">Error rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filteredRequests.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-4 text-center text-slate-500">
                    No matching requests.
                  </td>
                </tr>
              )}
              {filteredRequests.map((r) => (
                <tr key={r.name} className="hover:bg-slate-900/40">
                  <td className="px-3 py-1.5 max-w-[24rem] truncate text-slate-100">{r.name}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{r.method || '—'}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-200">{r.count}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-200">{fmtMs(r.avg)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{fmtMs(r.min)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{fmtMs(r.max)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{fmtMs(r.p90)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{fmtMs(r.p95)}</td>
                  <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{fmtMs(r.p99)}</td>
                  <td
                    className={`px-3 py-1.5 font-mono text-xs ${
                      r.errors > 0 ? 'text-rose-300' : 'text-slate-400'
                    }`}
                  >
                    {r.errors}
                  </td>
                  <td
                    className={`px-3 py-1.5 font-mono text-xs ${
                      r.errorRate > 0 ? 'text-rose-300' : 'text-slate-400'
                    }`}
                  >
                    {fmtPct(r.errorRate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Failures panel */}
      <div className="card">
        <h3 className="text-sm font-semibold text-slate-200">Failures</h3>
        {failures.length === 0 ? (
          <p className="mt-2 text-xs text-slate-500">No HTTP failures captured.</p>
        ) : (
          <div className="table-wrap mt-3 max-h-72 overflow-y-auto">
            <table>
              <thead>
                <tr>
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Method</th>
                  <th className="px-3 py-2">Count</th>
                  <th className="px-3 py-2">Last status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {failures.map((f) => (
                  <tr key={f.name} className="hover:bg-slate-900/40">
                    <td className="px-3 py-1.5 max-w-[24rem] truncate text-slate-100">{f.name}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-slate-300">{f.method || '—'}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-rose-300">{f.count}</td>
                    <td className="px-3 py-1.5 font-mono text-xs text-rose-300">
                      {f.lastStatus ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
