'use strict';

const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { spawnK6, killTree } = require('./processManager');
const { buildK6Env, maskEnv } = require('./envInjector');
const { attachLineReader, RingBuffer, parseIterationLifecycle } = require('./streamHandler');

const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
});

/**
 * Manages the lifecycle of all local K6 runs.
 * Emits events:
 *   'status'      ({ runId, status, ... })
 *   'log'         ({ runId, stream, line, ts })
 *   'summary'     ({ runId, summary })
 *   'report-ready'({ runId, paths })       // emitted when artifacts have been written
 */
class LifecycleManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.binPath        K6 binary path (default: 'k6')
   * @param {string} opts.logsDir        Per-run log files
   * @param {string} opts.artifactsDir   Per-run summary/metrics/report artifacts
   * @param {number} [opts.maxLogLines=2000]
   * @param {number} [opts.maxRuntimeMs=30*60*1000]
   */
  constructor({
    binPath = 'k6',
    logsDir,
    artifactsDir,
    maxLogLines = 2000,
    maxRuntimeMs = 30 * 60 * 1000,
  }) {
    super();
    this.binPath = binPath;
    this.logsDir = logsDir;
    this.artifactsDir = artifactsDir || logsDir;
    this.maxLogLines = maxLogLines;
    this.maxRuntimeMs = maxRuntimeMs;
    /** @type {Map<string, RunContext>} */
    this.runs = new Map();
  }

  async ensureDirs() {
    await fs.mkdir(this.logsDir, { recursive: true });
    await fs.mkdir(this.artifactsDir, { recursive: true });
  }

  /**
   * Start a new run.
   */
  async start({ script, env = {}, secrets = {} }) {
    if (!script || !script.filePath) {
      throw new Error('script.filePath is required');
    }
    await this.ensureDirs();

    const runId = uuidv4();
    const startedAt = new Date().toISOString();
    const logFilePath = path.join(this.logsDir, `${runId}.log`);
    const logStream = await fs.open(logFilePath, 'w');

    // Per-run artifact directory.
    const runArtifactsDir = path.join(this.artifactsDir, runId);
    await fs.mkdir(runArtifactsDir, { recursive: true });
    const summaryExportPath = path.join(runArtifactsDir, 'summary.json');
    const metricsJsonPath = path.join(runArtifactsDir, 'metrics.json');
    // Phase 6.6: the generated script's handleSummary writes a scrubbed
    // (setup_data-stripped) copy of the K6 summary to this sibling path.
    // runs.manager atomically replaces the raw --summary-export write
    // with this clean copy before any parser touches it.
    const cleanSummaryPath = summaryExportPath + '.clean';

    const k6EnvResult = buildK6Env({
      expectedEnvVars: script.expectedEnvVars || [],
      env,
      secrets,
    });
    const k6Env = k6EnvResult.envMap;
    // Inject the path AFTER envInjector runs so it can't be clobbered by
    // an incidentally-named user-provided env var, and mark it as an
    // internal key by prefixing PA_.
    k6Env.PA_CLEAN_SUMMARY_PATH = cleanSummaryPath;
    const manualOverrides = k6EnvResult.manualOverrides || [];
    const bearerNormalized = k6EnvResult.bearerNormalized || [];
    const tokenMirroredKeys = k6EnvResult.tokenMirroredKeys || [];

    const ctx = {
      runId,
      scriptId: script.id,
      status: STATUS.QUEUED,
      startedAt,
      endedAt: null,
      durationMs: null,
      exitCode: null,
      child: null,
      logFilePath,
      ringBuffer: new RingBuffer(this.maxLogLines),
      env: maskEnv(k6Env),
      manualOverrides,
      bearerNormalized,
      tokenMirroredKeys,
      summary: null,
      error: null,
      timeoutHandle: null,
      artifacts: {
        dir: runArtifactsDir,
        summaryExportPath,
        cleanSummaryPath,
        metricsJsonPath,
        reportHtmlPath: path.join(runArtifactsDir, 'report.html'),
        parsedSummaryPath: path.join(runArtifactsDir, 'parsed-summary.json'),
      },
    };
    this.runs.set(runId, ctx);

    this._emitStatus(ctx, STATUS.QUEUED);

    // Resolver-trace: never include actual values, only key names. These
    // lines are written to the run log so users can see exactly which env
    // vars were locked by manual entries vs left for runtime extraction.
    const traceTs = new Date().toISOString();
    for (const k of manualOverrides) {
      const line = `[resolver] ${k} -> manual override`;
      ctx.ringBuffer.push({ ts: traceTs, stream: 'system', line });
      logStream.write(`[${traceTs}] [system] ${line}\n`).catch(() => {});
      this.emit('log', { runId, stream: 'system', line, ts: traceTs });
    }
    for (const k of bearerNormalized) {
      const line = `[auth] Authorization header normalized for ${k} (Bearer prefix handled)`;
      ctx.ringBuffer.push({ ts: traceTs, stream: 'system', line });
      logStream.write(`[${traceTs}] [system] ${line}\n`).catch(() => {});
      this.emit('log', { runId, stream: 'system', line, ts: traceTs });
    }
    for (const k of tokenMirroredKeys) {
      const line = `[auth] mirrored AUTH_TOKEN -> ${k} (placeholder fallback)`;
      ctx.ringBuffer.push({ ts: traceTs, stream: 'system', line });
      logStream.write(`[${traceTs}] [system] ${line}\n`).catch(() => {});
      this.emit('log', { runId, stream: 'system', line, ts: traceTs });
    }

    setImmediate(() =>
      this._spawn(ctx, script, k6Env, logStream).catch((err) => {
        ctx.error = err.message;
        this._finish(ctx, STATUS.FAILED, null);
        logStream.close().catch(() => {});
      })
    );

    return ctx;
  }

  async _spawn(ctx, script, k6Env, logStream) {
    let child;
    try {
      child = spawnK6({
        binPath: this.binPath,
        scriptPath: script.filePath,
        env: k6Env,
        cwd: path.dirname(script.filePath),
        summaryExportPath: ctx.artifacts.summaryExportPath,
        metricsJsonPath: ctx.artifacts.metricsJsonPath,
      });
    } catch (err) {
      ctx.error = `Failed to spawn k6: ${err.message}`;
      this._finish(ctx, STATUS.FAILED, null);
      return;
    }

    ctx.child = child;
    ctx.commandPreview = child.commandPreview || null;
    ctx.resolvedBinPath = child.resolvedBinPath || null;
    ctx.status = STATUS.RUNNING;

    const ts0 = new Date().toISOString();
    const previewLine = `[${ts0}] [system] $ ${child.commandPreview}`;
    logStream.write(`${previewLine}\n`).catch(() => {});
    ctx.ringBuffer.push({ ts: ts0, stream: 'system', line: `$ ${child.commandPreview}` });
    this.emit('log', {
      runId: ctx.runId,
      stream: 'system',
      line: `$ ${child.commandPreview}`,
      ts: ts0,
    });

    this._emitStatus(ctx, STATUS.RUNNING);

    const onLine = (stream) => (line) => {
      const ts = new Date().toISOString();
      ctx.ringBuffer.push({ ts, stream, line });
      logStream.write(`[${ts}] [${stream}] ${line}\n`).catch(() => {});
      this.emit('log', { runId: ctx.runId, stream, line, ts });
    };

    attachLineReader(child.stdout, onLine('stdout'));
    attachLineReader(child.stderr, onLine('stderr'));

    ctx.timeoutHandle = setTimeout(() => {
      if (ctx.status === STATUS.RUNNING) {
        ctx.error = `Run exceeded max runtime ${this.maxRuntimeMs}ms`;
        this.stop(ctx.runId, { reason: 'timeout' });
      }
    }, this.maxRuntimeMs);
    ctx.timeoutHandle.unref?.();

    child.on('error', (err) => {
      ctx.error = `Process error: ${err.message}`;
      this._finish(ctx, STATUS.FAILED, null);
      logStream.close().catch(() => {});
    });

    child.on('close', (code, signal) => {
      clearTimeout(ctx.timeoutHandle);
      // k6 exit code 99 = threshold failure (script ran to completion).
      const finalStatus =
        ctx.status === STATUS.STOPPED
          ? STATUS.STOPPED
          : code === 0 || code === 99
          ? STATUS.COMPLETED
          : STATUS.FAILED;
      this._finish(ctx, finalStatus, code, signal);
      logStream.close().catch(() => {});
    });
  }

  stop(runId, { reason = 'user' } = {}) {
    const ctx = this.runs.get(runId);
    if (!ctx) return false;
    if (ctx.status !== STATUS.RUNNING && ctx.status !== STATUS.QUEUED) return false;
    ctx.status = STATUS.STOPPED;
    ctx.error = ctx.error || `Stopped (${reason})`;
    if (ctx.child) killTree(ctx.child);
    this._emitStatus(ctx, STATUS.STOPPED);
    return true;
  }

  get(runId) {
    return this.runs.get(runId) || null;
  }

  list() {
    return Array.from(this.runs.values()).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    );
  }

  getLogs(runId) {
    const ctx = this.runs.get(runId);
    if (!ctx) return null;
    return ctx.ringBuffer.toArray();
  }

  _finish(ctx, status, exitCode, signal) {
    ctx.status = status;
    ctx.endedAt = new Date().toISOString();
    ctx.durationMs = new Date(ctx.endedAt) - new Date(ctx.startedAt);
    ctx.exitCode = exitCode;
    ctx.signal = signal || null;
    const logLines = ctx.ringBuffer.toArray().map((l) => l.line);
    ctx.iterationLifecycle = parseIterationLifecycle(logLines);
    ctx.summary = this._buildSummary(ctx);
    this._emitStatus(ctx, status);
    this.emit('summary', { runId: ctx.runId, summary: ctx.summary });
    // Tell listeners that the K6 artifact files (if any) are available now.
    this.emit('report-ready', { runId: ctx.runId, paths: ctx.artifacts });
  }

  _buildSummary(ctx) {
    const lines = ctx.ringBuffer.toArray().map((l) => l.line);
    const findMetric = (label) => {
      const re = new RegExp(
        `${label}[^\\n]*?(?:avg=([\\d.]+\\w+))?[^\\n]*?(?:min=([\\d.]+\\w+))?[^\\n]*?(?:med=([\\d.]+\\w+))?[^\\n]*?(?:max=([\\d.]+\\w+))?[^\\n]*?(?:p\\(95\\)=([\\d.]+\\w+))?`
      );
      for (const ln of lines) {
        const m = ln.match(re);
        if (m && (m[1] || m[2] || m[3] || m[4] || m[5])) {
          return { avg: m[1], min: m[2], med: m[3], max: m[4], p95: m[5] };
        }
      }
      return null;
    };
    const findCount = (label) => {
      for (const ln of lines) {
        const m = ln.match(new RegExp(`${label}[^\\d]*([\\d.]+)`));
        if (m) return Number(m[1]);
      }
      return null;
    };
    return {
      httpReqDuration: findMetric('http_req_duration'),
      httpReqFailed: findMetric('http_req_failed'),
      iterations: findCount('iterations'),
      vusMax: findCount('vus_max'),
      checks: findMetric('checks'),
    };
  }

  _emitStatus(ctx, status) {
    this.emit('status', {
      runId: ctx.runId,
      scriptId: ctx.scriptId,
      status,
      startedAt: ctx.startedAt,
      endedAt: ctx.endedAt,
      durationMs: ctx.durationMs,
      exitCode: ctx.exitCode,
      error: ctx.error,
      summary: ctx.summary,
      manualOverrides: ctx.manualOverrides || [],
      bearerNormalized: ctx.bearerNormalized || [],
      artifacts: ctx.artifacts || null,
    });
  }
}

module.exports = { LifecycleManager, STATUS };
