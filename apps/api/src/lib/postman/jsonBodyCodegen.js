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

/**
 * Escape chars that would be re-interpreted by the JavaScript template literal
 * that wraps the emitted body expression. Without this, source text like
 * `"Bid offers\r"` (two chars: backslash + 'r' as produced by JSON.stringify)
 * is evaluated as a raw U+000D control char, which produces invalid JSON on
 * the wire. We handle:
 *   - backslash   `\`  → `\\`
 *   - backtick    `` ` `` → `` \` ``
 *   - `${`        template-literal substitution start → `\${`
 * Control characters (CR, LF, TAB, etc.) in the raw input are already
 * JSON-escaped upstream by JSON.stringify, so they appear here as two-char
 * backslash sequences; doubling the backslash above is what preserves them
 * through the template-literal evaluation step.
 */
function escapeForTemplateLiteral(str) {
  if (str == null) return '';
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

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

/**
 * Build a fragment for a JSON string literal that is safe to embed inside a
 * JavaScript template literal. Literal segments are JSON.stringify'd (which
 * handles quote + control-char escaping) and then template-literal escaped
 * so backslashes survive the backtick-string evaluation step. Placeholder
 * expressions are left as `${...}`.
 */
function emitJsonStringLiteral(str, interp) {
  const input = String(str == null ? '' : str);
  let out = '"';
  let last = 0;
  VAR_RE.lastIndex = 0;
  let m;
  while ((m = VAR_RE.exec(input)) !== null) {
    const seg = input.slice(last, m.index);
    // JSON.stringify yields a quoted JSON string; strip the surrounding
    // quotes to get just the escaped inner bytes.
    const jsonInner = JSON.stringify(seg).slice(1, -1);
    out += escapeForTemplateLiteral(jsonInner);
    const original = m[1].trim();
    const wrapped = interp.exprForPlaceholder(original);
    const inner = wrapped.startsWith('${') && wrapped.endsWith('}')
      ? wrapped.slice(2, -1)
      : wrapped;
    out += '${' + inner + '}';
    last = m.index + m[0].length;
  }
  const tail = input.slice(last);
  const jsonInnerTail = JSON.stringify(tail).slice(1, -1);
  out += escapeForTemplateLiteral(jsonInnerTail);
  out += '"';
  return out;
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
    // Unified path for both placeholder-less and placeholder-containing
    // strings. Produces a template-literal fragment whose runtime value is
    // a valid JSON double-quoted string with the original byte content.
    // The single-placeholder shortcut (whole string is "{{var}}") is still
    // handled correctly: literal segments are empty, so the output is
    // just `"${expr}"`.
    return emitJsonStringLiteral(value, interp);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((item) => emitJsonTemplate(item, interp, markerMap)).join(',') + ']';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).map(
      ([k, v]) =>
        // Keys are JSON-stringified then template-literal escaped so a key
        // containing a backslash or backtick survives the backtick wrap.
        escapeForTemplateLiteral(JSON.stringify(k)) +
        ':' +
        emitJsonTemplate(v, interp, markerMap)
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
