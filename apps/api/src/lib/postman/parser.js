'use strict';

/**
 * Postman v2.1 parser. Walks the collection tree and produces a normalized,
 * flattened list of requests with their folder path, plus an index of all
 * `{{variable}}` references used throughout the collection.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const { extractPostmanRequestTimeoutMs } = require('../k6/requestTimeout');

function isFolder(item) {
  return item && Array.isArray(item.item);
}

function isRequest(item) {
  return item && item.request && !Array.isArray(item.item);
}

/**
 * Percent-encode a query component without touching an existing %HH escape.
 * Characters Postman leaves literal in query values (`+`, `[]`, `/`, `:`, …)
 * stay literal so an already-encoded value is not encoded a second time.
 * `{{placeholders}}` must be removed before this runs; braces are encoded.
 */
function encodeQueryLiteral(value) {
  return encodeLiteral(value, /[A-Za-z0-9\-._~!*'()+,;:@/?[\]$]/);
}

/** Path-segment encoding. `:` is preserved so an unresolved `:name` stays intact. */
function encodePathLiteral(value) {
  return encodeLiteral(value, /[A-Za-z0-9\-._~:]/);
}

function encodeLiteral(value, safeRe) {
  const s = value == null ? '' : String(value);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && /^%[0-9A-Fa-f]{2}/.test(s.slice(i, i + 3))) {
      out += s.slice(i, i + 3);
      i += 2;
      continue;
    }
    const ch = s[i];
    if (safeRe.test(ch)) out += ch;
    else out += encodeURIComponent(ch);
  }
  return out;
}

/** Turn an already-encoded `{{name}}` back into a placeholder before resolution. */
function restorePlaceholders(value) {
  return String(value == null ? '' : value).replace(
    /%7[Bb]%7[Bb]\s*([^%]*?)\s*%7[Dd]%7[Dd]/g,
    (_, name) => `{{${String(name).trim()}}}`
  );
}

function containsPlaceholder(value) {
  VAR_RE.lastIndex = 0;
  const found = VAR_RE.test(String(value || ''));
  VAR_RE.lastIndex = 0;
  return found;
}

function pushComponent(state, text, kind) {
  const value = restorePlaceholders(text);
  if (containsPlaceholder(value)) {
    const start = state.url.length;
    state.url += value;
    state.spans.push({ start, end: state.url.length, kind });
    return;
  }
  state.url += kind === 'path' ? encodePathLiteral(value) : encodeQueryLiteral(value);
}

function resolvePathSegment(segment, pathVariables) {
  const text = restorePlaceholders(segment == null ? '' : String(segment));
  const match = text.match(/^:([A-Za-z_][A-Za-z0-9_-]*)$/);
  if (!match) return text;
  const name = match[1];
  const variable = (pathVariables || []).find((v) => v && String(v.key) === name);
  if (!variable || variable.disabled === true) return text;
  const value = restorePlaceholders(variable.value == null ? '' : String(variable.value));
  if (value.length === 0) return `{{${name}}}`;
  return value;
}

function buildOrigin(url) {
  const host = Array.isArray(url.host)
    ? url.host.map((part) => (part == null ? '' : String(part))).join('.')
    : url.host == null
      ? ''
      : String(url.host);
  let protocol = url.protocol
    ? String(url.protocol).replace(/:\/?\/?$/, '')
    : '';
  // Fallback: Postman exports occasionally include host-array + path-array
  // forms without an explicit `url.protocol`, even though the companion
  // `url.raw` string carries one (e.g. "https://api.example.com/users/:id").
  // Dropping the scheme produces a schema-less URL that k6 cannot route.
  // Honor the raw scheme ONLY for http/https to avoid injecting unknown
  // protocols from malformed exports.
  if (!protocol && typeof url.raw === 'string') {
    const schemeMatch = url.raw.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):\/\//);
    if (schemeMatch) {
      const candidate = schemeMatch[1].toLowerCase();
      if (candidate === 'http' || candidate === 'https') {
        protocol = candidate;
      }
    }
  }
  const port = url.port == null || url.port === '' ? '' : String(url.port);
  let origin = host;
  let schemeApplied = false;
  if (protocol && host && !host.includes('{{')) {
    origin = `${protocol}://${host}`;
    schemeApplied = true;
  } else if (protocol && host.includes('{{')) {
    const raw = typeof url.raw === 'string' ? url.raw : '';
    if (raw.startsWith(`${protocol}://`)) {
      origin = `${protocol}://${host}`;
      schemeApplied = true;
    }
  }
  if (port && (schemeApplied || !host.includes('{{'))) {
    origin += `:${port}`;
  }
  return origin;
}

/**
 * Structured Postman `url.query` / `url.path` / `url.variable` win over `url.raw`.
 * Placeholders stay as `{{name}}` so they resolve before encoding. Spans mark
 * the query values and path segments the generator must encode after substitution.
 * A raw-only URL is returned unchanged.
 */
function buildRequestUrl(url) {
  if (!url) return { url: '', urlEncodeSpans: null, structured: false };
  if (typeof url === 'string') return { url, urlEncodeSpans: null, structured: false };
  if (typeof url !== 'object') return { url: '', urlEncodeSpans: null, structured: false };

  const structuredQuery = Array.isArray(url.query) && url.query.length > 0;
  const structuredPath = Array.isArray(url.path) && url.path.length > 0;
  if (!structuredQuery && !structuredPath) {
    return { url: legacyUrlString(url), urlEncodeSpans: null, structured: false };
  }

  const state = { url: buildOrigin(url), spans: [] };
  if (!state.url && typeof url.raw === 'string') {
    const cut = url.raw.search(/[?#]/);
    state.url = cut >= 0 ? url.raw.slice(0, cut) : url.raw;
  }

  if (structuredPath) {
    const variables = Array.isArray(url.variable) ? url.variable : [];
    for (const segment of url.path) {
      state.url += '/';
      pushComponent(state, resolvePathSegment(segment, variables), 'path');
    }
  }

  if (structuredQuery) {
    const params = url.query.filter((q) => q && q.disabled !== true && q.key);
    if (params.length > 0) {
      state.url += '?';
      params.forEach((q, index) => {
        if (index > 0) state.url += '&';
        pushComponent(state, String(q.key), 'query');
        if (q.value != null) {
          state.url += '=';
          pushComponent(state, String(q.value), 'query');
        }
      });
    }
  } else if (typeof url.raw === 'string') {
    const q = url.raw.indexOf('?');
    if (q >= 0) state.url += url.raw.slice(q).split('#')[0];
  }

  if (url.hash != null && String(url.hash).length > 0) {
    const hash = String(url.hash);
    state.url += hash.startsWith('#') ? hash : `#${hash}`;
  }

  return {
    url: state.url,
    urlEncodeSpans: state.spans.length > 0 ? state.spans : null,
    structured: true,
  };
}

function legacyUrlString(url) {
  if (typeof url.raw === 'string' && url.raw.length > 0) return url.raw;
  const protocol = url.protocol ? `${url.protocol}://` : '';
  const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
  const path = Array.isArray(url.path) ? '/' + url.path.join('/') : url.path || '';
  const query =
    Array.isArray(url.query) && url.query.length > 0
      ? '?' +
        url.query
          .filter((q) => !q.disabled)
          .map((q) => `${encodeURIComponent(q.key || '')}=${encodeURIComponent(q.value || '')}`)
          .join('&')
      : '';
  return `${protocol}${host}${path}${query}`;
}

function getUrlString(url) {
  return buildRequestUrl(url).url;
}

function normalizeHeaders(rawHeaders) {
  if (!Array.isArray(rawHeaders)) return [];
  return rawHeaders
    .filter((h) => h && !h.disabled && h.key)
    .map((h) => ({ key: String(h.key), value: String(h.value ?? '') }));
}

function normalizeBody(body) {
  if (!body || typeof body !== 'object') return null;
  switch (body.mode) {
    case 'raw':
      return { mode: 'raw', raw: String(body.raw ?? ''), language: body.options?.raw?.language };
    case 'urlencoded':
      return {
        mode: 'urlencoded',
        params: (body.urlencoded || [])
          .filter((p) => !p.disabled)
          .map((p) => ({ key: String(p.key ?? ''), value: String(p.value ?? '') })),
      };
    case 'formdata':
      return {
        mode: 'formdata',
        params: (body.formdata || [])
          .filter((p) => !p.disabled)
          .map((p) => ({
            key: String(p.key ?? ''),
            value: String(p.value ?? ''),
            type: p.type === 'file' ? 'file' : 'text',
            src: p.src == null || p.src === '' ? '' : String(p.src),
          })),
      };
    case 'graphql':
      return {
        mode: 'graphql',
        query: String(body.graphql?.query ?? ''),
        variables: body.graphql?.variables ?? '',
      };
    case 'file':
      return {
        mode: 'file',
        src:
          body.file && body.file.src != null
            ? String(body.file.src)
            : body.src != null
              ? String(body.src)
              : '',
      };
    case 'binary':
      return {
        mode: 'binary',
        src: body.src != null ? String(body.src) : '',
      };
    default:
      return null;
  }
}

function findVarsIn(value, set) {
  if (typeof value !== 'string' || !value) return;
  let m;
  VAR_RE.lastIndex = 0;
  while ((m = VAR_RE.exec(value)) !== null) {
    set.add(m[1].trim());
  }
}

function indexRequestVars(req, set) {
  findVarsIn(req.url, set);
  for (const h of req.headers) {
    findVarsIn(h.value, set);
  }
  if (req.body) {
    if (req.body.mode === 'raw') findVarsIn(req.body.raw, set);
    if (req.body.mode === 'urlencoded' || req.body.mode === 'formdata') {
      for (const p of req.body.params) {
        findVarsIn(p.key, set);
        findVarsIn(p.value, set);
      }
    }
    if (req.body.mode === 'graphql') {
      findVarsIn(req.body.query, set);
      if (typeof req.body.variables === 'string') findVarsIn(req.body.variables, set);
    }
    if (req.body.mode === 'file' || req.body.mode === 'binary') {
      findVarsIn(req.body.src, set);
    }
  }
}

function extractEventScripts(item) {
  // Postman attaches `event[]` entries with `script.exec: string[]` for
  // listen='test' (post-response) and listen='prerequest'. We harvest both
  // so the auth-flow planner can read user-defined `pm.environment.set(...)`
  // capture statements without re-implementing JS evaluation.
  const events = Array.isArray(item?.event) ? item.event : [];
  const tests = [];
  const prerequests = [];
  for (const e of events) {
    if (!e || !e.script) continue;
    const exec = e.script.exec;
    const lines = Array.isArray(exec) ? exec : (typeof exec === 'string' ? [exec] : []);
    const text = lines.join('\n');
    if (e.listen === 'test') tests.push(text);
    else if (e.listen === 'prerequest') prerequests.push(text);
  }
  return { tests, prerequests };
}

/**
 * Substitute Postman path-variable references (":name") in a URL string
 * against the request's `url.variable[]` map. When a path variable has a
 * non-empty, non-disabled value we splice the value directly into the raw
 * URL; when it's missing we swap the `:name` for `{{name}}` so the
 * existing interpolator / variable resolver pipeline can pick it up (or
 * a runtime __ENV override can supply it).
 *
 * `:` inside ports (":8080") or protocol markers ("http://") is never
 * matched because the regex requires the first char after ":" to be a
 * letter or underscore.
 */
function applyPathVariables(rawUrl, pathVariables) {
  if (!Array.isArray(pathVariables) || pathVariables.length === 0) return rawUrl;
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) return rawUrl;
  const byName = new Map();
  for (const v of pathVariables) {
    if (!v || !v.key) continue;
    byName.set(String(v.key), v);
  }
  return rawUrl.replace(/:([A-Za-z_][A-Za-z0-9_-]*)/g, (m, name) => {
    const v = byName.get(name);
    if (!v) return m; // unknown :name — leave verbatim, the scanner will flag it
    if (v.disabled === true) return m;
    const value = v.value == null ? '' : String(v.value);
    if (value.length === 0) return `{{${name}}}`;
    return value;
  });
}

function walk(items, folderPath, acc) {
  for (const item of items || []) {
    if (isFolder(item)) {
      walk(item.item, [...folderPath, item.name || 'folder'], acc);
    } else if (isRequest(item)) {
      const r = item.request;
      const headers = normalizeHeaders(r.header);
      const body = r.body ? normalizeBody(r.body) : null;
      const built = buildRequestUrl(r.url);
      let url = built.url;
      const pathVariables =
        r.url && typeof r.url === 'object' && Array.isArray(r.url.variable)
          ? r.url.variable.map((v) => ({
              key: String(v?.key || ''),
              value: v?.value == null ? '' : String(v.value),
              disabled: v?.disabled === true,
            }))
          : [];
      if (!built.structured && pathVariables.length > 0) {
        url = applyPathVariables(url, pathVariables);
      }
      const auth = r.auth || null;
      const requestVariables = Array.isArray(item.variable)
        ? item.variable.map((v) => ({
            key: String(v?.key || ''),
            value: v?.value == null ? '' : String(v.value),
            disabled: v?.disabled === true,
          }))
        : [];
      const { tests, prerequests } = extractEventScripts(item);
      const timeoutMs = extractPostmanRequestTimeoutMs({
        timeout: r.timeout,
        requestTimeout: r.requestTimeout,
        protocolProfileBehavior: r.protocolProfileBehavior || item.protocolProfileBehavior,
        request: r,
      });
      acc.push({
        name: item.name || r.method || 'request',
        folderPath,
        method: (r.method || 'GET').toUpperCase(),
        url,
        headers,
        body,
        auth,
        requestVariables,
        tests,
        prerequests,
        pathVariables,
        urlEncodeSpans: built.urlEncodeSpans,
        timeoutMs,
        protocolProfileBehavior:
          (r.protocolProfileBehavior && typeof r.protocolProfileBehavior === 'object'
            ? r.protocolProfileBehavior
            : null) ||
          (item.protocolProfileBehavior && typeof item.protocolProfileBehavior === 'object'
            ? item.protocolProfileBehavior
            : null),
      });
    }
  }
}

/**
 * @param {object} collection - Raw Postman v2.1 collection
 * @returns {{ name: string, requests: Array, definedVars: Record<string,string>, referencedVars: string[], collectionAuth: object|null }}
 */
function parse(collection) {
  if (!collection || typeof collection !== 'object') {
    throw new Error('Invalid collection');
  }

  const requests = [];
  walk(collection.item, [], requests);

  const referenced = new Set();
  for (const req of requests) indexRequestVars(req, referenced);

  const definedVars = {};
  for (const v of collection.variable || []) {
    if (v && v.key) {
      definedVars[String(v.key)] = String(v.value ?? '');
    }
  }
  // Always index baseUrl placeholders even if not referenced
  if (definedVars.baseUrl) referenced.add('baseUrl');

  return {
    name: collection.info?.name || 'Untitled',
    requests,
    definedVars,
    referencedVars: Array.from(referenced),
    collectionAuth: collection.auth || null,
  };
}

module.exports = {
  parse,
  getUrlString,
  buildRequestUrl,
  encodeQueryLiteral,
  encodePathLiteral,
  normalizeHeaders,
  normalizeBody,
  applyPathVariables,
};
