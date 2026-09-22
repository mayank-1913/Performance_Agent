'use strict';

/**
 * Semantic HTTP response classifier for generated K6 scripts.
 * Distinguishes transport failures (DNS/TCP/TLS/timeout) from HTTP status failures.
 *
 * k6 sets error_code on failed requests:
 *   - 1100-range: timeouts / network
 *   - 1200-range: TCP / connection
 *   - 1300-range: TLS
 *   - 1400-range: HTTP status errors (4xx/5xx) — NOT transport failures
 */

function normalizeErrorCode(code) {
  if (code == null || code === '' || code === 0 || code === '0') return 0;
  const n = typeof code === 'string' ? parseInt(code, 10) : code;
  return Number.isFinite(n) ? n : 0;
}

function isTransportErrorCode(code) {
  const n = normalizeErrorCode(code);
  if (n === 0) return false;
  // k6 HTTP status error codes (1400+) mean a response was received.
  if (n >= 1400 && n < 1600) return false;
  return true;
}

function classifyResponse(res, expected) {
  if (!res) return 'transport_failure';
  if (res.status === 0) return 'transport_failure';
  if (isTransportErrorCode(res.error_code)) return 'transport_failure';

  if (Array.isArray(expected) && expected.length > 0) {
    return expected.indexOf(res.status) === -1 ? 'unexpected_status' : 'ok';
  }
  return res.status >= 200 && res.status < 300 ? 'ok' : 'unexpected_status';
}

/** JS source embedded verbatim in generated K6 scripts. */
const RESPONSE_CLASSIFIER_JS = `
function __normalizeErrorCode(code) {
  if (code == null || code === '' || code === 0 || code === '0') return 0;
  const n = typeof code === 'string' ? parseInt(code, 10) : code;
  return Number.isFinite(n) ? n : 0;
}
function __isTransportErrorCode(code) {
  const n = __normalizeErrorCode(code);
  if (n === 0) return false;
  if (n >= 1400 && n < 1600) return false;
  return true;
}
function __classifyResponse(res, expected) {
  if (!res) return 'transport_failure';
  if (res.status === 0) return 'transport_failure';
  if (__isTransportErrorCode(res.error_code)) return 'transport_failure';
  if (Array.isArray(expected) && expected.length > 0) {
    return expected.indexOf(res.status) === -1 ? 'unexpected_status' : 'ok';
  }
  return res.status >= 200 && res.status < 300 ? 'ok' : 'unexpected_status';
}
`;

module.exports = {
  normalizeErrorCode,
  isTransportErrorCode,
  classifyResponse,
  RESPONSE_CLASSIFIER_JS,
};
