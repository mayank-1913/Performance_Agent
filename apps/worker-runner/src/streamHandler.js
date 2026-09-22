'use strict';

const { SECRET_KEY_RE } = require('./envInjector');

/**
 * Redacts known token shapes from K6 stdout/stderr so secrets never leak
 * into log files, the UI, or the in-memory ring buffer.
 */
const SECRET_ENV_ASSIGN_RE =
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|JWT|KEY|SESSION|AUTH|BEARER|PASSWORD|PASS|PASSWD|USERNAME|EMAIL|CREDENTIAL|COOKIE)[A-Z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+)/gi;

const REDACTIONS = [
  // Bearer eyJ... or Bearer abcdef
  { re: /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g, repl: 'Bearer ***' },
  // JWT-looking strings: three base64url segments separated by dots
  { re: /\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\b/g, repl: '***JWT***' },
  // Authorization header lines printed by k6 -v / debug
  { re: /(authorization\s*[:=]\s*)["']?[^"'\r\n]+["']?/gi, repl: '$1***' },
  // X-API-Key style
  { re: /(x-api-key\s*[:=]\s*)["']?[^"'\r\n]+["']?/gi, repl: '$1***' },
  // Shell-style secret env assignments (LOGIN_PASSWORD=..., AUTH_TOKEN=...)
  {
    re: SECRET_ENV_ASSIGN_RE,
    repl: (match, key) => `${key}=[REDACTED]`,
  },
];

function redactLine(line) {
  let out = line;
  for (const { re, repl } of REDACTIONS) {
    out = typeof repl === 'function' ? out.replace(re, repl) : out.replace(re, repl);
  }
  return out;
}

/** Parse the final k6 status line for completed/interrupted iteration counts. */
function parseIterationLifecycle(lines) {
  const re = /(\d+) complete and (\d+) interrupted iterations/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = String(lines[i] || '').match(re);
    if (m) {
      return {
        completedIterations: parseInt(m[1], 10),
        interruptedIterations: parseInt(m[2], 10),
      };
    }
  }
  return { completedIterations: null, interruptedIterations: null };
}

/**
 * Wrap a node Readable to emit redacted line events.
 *
 * @param {NodeJS.ReadableStream} stream
 * @param {(line: string) => void} onLine
 */
function attachLineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf-8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      onLine(redactLine(raw));
    }
  });
  stream.on('end', () => {
    if (buffer.length > 0) onLine(redactLine(buffer));
  });
}

/**
 * Bounded ring buffer for storing recent log lines per run.
 */
class RingBuffer {
  constructor(capacity = 2000) {
    this.capacity = capacity;
    this.items = [];
  }
  push(item) {
    if (this.items.length >= this.capacity) this.items.shift();
    this.items.push(item);
  }
  toArray() {
    return this.items.slice();
  }
}

module.exports = {
  redactLine,
  attachLineReader,
  RingBuffer,
  parseIterationLifecycle,
  SECRET_KEY_RE,
};
