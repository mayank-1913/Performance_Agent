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

function getUrlString(url) {
  if (!url) return '';
  if (typeof url === 'string') return url;
  if (typeof url === 'object') {
    if (typeof url.raw === 'string' && url.raw.length > 0) return url.raw;
    const protocol = url.protocol ? `${url.protocol}://` : '';
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const path = Array.isArray(url.path) ? '/' + url.path.join('/') : url.path || '';
    const query =
      Array.isArray(url.query) && url.query.length > 0
        ? '?' +
          url.query
            .filter((q) => !q.disabled)
            .map(
              (q) => `${encodeURIComponent(q.key || '')}=${encodeURIComponent(q.value || '')}`
            )
            .join('&')
        : '';
    return `${protocol}${host}${path}${query}`;
  }
  return '';
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
          .filter((p) => !p.disabled && p.type !== 'file')
          .map((p) => ({ key: String(p.key ?? ''), value: String(p.value ?? '') })),
      };
    case 'graphql':
      return {
        mode: 'graphql',
        query: String(body.graphql?.query ?? ''),
        variables: body.graphql?.variables ?? '',
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
      let url = getUrlString(r.url);
      const pathVariables =
        r.url && typeof r.url === 'object' && Array.isArray(r.url.variable)
          ? r.url.variable.map((v) => ({
              key: String(v?.key || ''),
              value: v?.value == null ? '' : String(v.value),
              disabled: v?.disabled === true,
            }))
          : [];
      if (pathVariables.length > 0) {
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
        timeoutMs,
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
  normalizeHeaders,
  normalizeBody,
  applyPathVariables,
};
