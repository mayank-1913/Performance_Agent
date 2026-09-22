'use strict';

const { spawn, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const {
  buildK6CommandArgs,
  validateSpawnInputs,
  buildCommandPreview,
} = require('./commandBuilder');

/**
 * Resolves a bare bin name (e.g. "k6") to an absolute path using `where` on
 * Windows and `which` on POSIX. We DO NOT use shell mode on Windows, because
 * cmd.exe splits unquoted paths with spaces (the workspace path contains
 * "Mayank Harsora" / "Performance Agent"), which previously caused
 * "k6 accepts 1 arg(s), received 3".
 */
const _resolvedBinCache = new Map();

function resolveK6Bin(binPath) {
  if (!binPath || typeof binPath !== 'string') {
    throw new Error('resolveK6Bin: binPath is required');
  }
  // Already a path-like value -> trust it.
  if (path.isAbsolute(binPath) || binPath.includes('/') || binPath.includes('\\')) {
    return binPath;
  }
  if (_resolvedBinCache.has(binPath)) return _resolvedBinCache.get(binPath);

  const isWin = os.platform() === 'win32';
  const lookup = isWin ? 'where' : 'which';

  try {
    const res = spawnSync(lookup, [binPath], {
      encoding: 'utf-8',
      windowsHide: true,
    });
    if (res.status === 0 && res.stdout) {
      const lines = res.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      let chosen = lines[0];
      if (isWin) {
        const exe = lines.find((l) => /\.exe$/i.test(l));
        if (exe) chosen = exe;
      }
      if (chosen) {
        _resolvedBinCache.set(binPath, chosen);
        return chosen;
      }
    }
  } catch {
    /* fall through */
  }

  // Couldn't resolve; let spawn surface the original ENOENT later.
  _resolvedBinCache.set(binPath, binPath);
  return binPath;
}

/**
 * Spawn the K6 binary in a way that is safe across platforms with paths
 * containing spaces. Returns the child process with two extra fields:
 *   - child.commandPreview : sanitized log line (secrets masked)
 *   - child.resolvedBinPath: the absolute path actually used
 */
function spawnK6({ binPath = 'k6', scriptPath, env, cwd, summaryExportPath, metricsJsonPath } = {}) {
  validateSpawnInputs({ binPath, scriptPath, env, cwd });
  const resolvedBin = resolveK6Bin(binPath);
  const args = buildK6CommandArgs({ scriptPath, summaryExportPath, metricsJsonPath });

  const child = spawn(resolvedBin, args, {
    cwd,
    env,
    shell: false, // critical: do NOT let cmd.exe re-tokenize args
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.commandPreview = buildCommandPreview({
    binPath: resolvedBin,
    args,
    env,
  });
  child.resolvedBinPath = resolvedBin;

  return child;
}

/**
 * Try to terminate a child gracefully, then force-kill after `forceAfterMs`.
 */
function killTree(child, forceAfterMs = 5000) {
  if (!child || child.killed) return;

  try {
    if (os.platform() === 'win32') {
      // taskkill is the only reliable way to stop a tree on Windows
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* ignore */
  }

  setTimeout(() => {
    try {
      if (!child.killed) child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, forceAfterMs).unref();
}

module.exports = { spawnK6, killTree, resolveK6Bin };
