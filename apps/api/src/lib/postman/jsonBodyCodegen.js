'use strict';

/**
 * JSON-aware raw body codegen.
 *
 * Walks parsed JSON to preserve boolean / number / null types while
 * substituting {{variable}} placeholders. Falls back to string templating
 * when the raw body is not valid JSON (e.g. unquoted {{placeholders}}).
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const UNQUOTED_PLACEHOLDER_RE = /:\s*(\{\{[^}]+\}\})(\s*[,}\]])/g;

function containsVariableReference(str) {
  if (str == null) return false;
  VAR_RE.lastIndex = 0;
  return VAR_RE.test(String(str));
}

function isJsonRawBody(body) {
  if (!body || body.mode !== 'raw') return false;
  const lang = body.language || body.options?.raw?.language;
  if (lang === 'json') return true;
  const raw = String(body.raw || '').trim();
  return raw.startsWith('{') || raw.startsWith('[');
}

/**
 * Attempt tolerant parse for bodies with unquoted {{var}} placeholders.
 */
function tryParseJsonBody(raw) {
  const text = String(raw ?? '');
  try {
    return { ok: true, value: JSON.parse(text), mode: 'strict' };
  } catch {
    // Normalize unquoted placeholders to quoted strings for parse, tracking positions.
    const markers = [];
    let idx = 0;
    const normalized = text.replace(UNQUOTED_PLACEHOLDER_RE, (match, placeholder, suffix) => {
      const marker = `__PA_UNQUOTED_${idx++}__`;
      markers.push({ marker, placeholder, unquoted: true });
      return `: "${marker}"${suffix}`;
    });
    try {
      const value = JSON.parse(normalized);
      return { ok: true, value, mode: 'normalized', markers };
    } catch {
      return { ok: false, value: null, mode: 'string' };
    }
  }
}

function emitJsonTemplate(value, interp, markerMap) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') {
    const markerEntry = markerMap && markerMap.get(value);
    if (markerEntry && markerEntry.unquoted) {
      const inner = markerEntry.placeholder.replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
      return interp.exprForPlaceholder(inner, { unquotedJson: true });
    }
    if (!containsVariableReference(value)) return JSON.stringify(value);
    const single = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (single) {
      const inner = interp.exprForPlaceholder(single[1].trim()).slice(2, -1);
      // Expression is embedded inside a template literal; do not escape quotes
      // inside ${...} — \" is invalid there and breaks k6 script parsing.
      return '"${' + inner + '}"';
    }
    return '"' + interp.asTemplate(value) + '"';
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => emitJsonTemplate(item, interp, markerMap)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([k, v]) => JSON.stringify(k) + ':' + emitJsonTemplate(v, interp, markerMap)
    );
    return '{' + entries.join(',') + '}';
  }
  return 'null';
}

function buildMarkerMap(markers) {
  const map = new Map();
  for (const m of markers || []) map.set(m.marker, m);
  return map;
}

/**
 * @param {object} body normalized body { mode, raw, language }
 * @param {object} interp from makeInterpolator (must expose asTemplate + exprForPlaceholder)
 */
function buildJsonAwareRawBody(body, interp) {
  const raw = body.raw || '';
  const parsed = tryParseJsonBody(raw);
  if (!parsed.ok) {
    return { expr: '`' + interp.asTemplate(raw) + '`', mode: 'string-fallback' };
  }
  const markerMap = buildMarkerMap(parsed.markers);
  const templateBody = emitJsonTemplate(parsed.value, interp, markerMap);
  return { expr: '`' + templateBody + '`', mode: parsed.mode };
}

module.exports = {
  containsVariableReference,
  isJsonRawBody,
  tryParseJsonBody,
  buildJsonAwareRawBody,
  UNQUOTED_PLACEHOLDER_RE,
};
