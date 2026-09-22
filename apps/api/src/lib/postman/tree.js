'use strict';

/**
 * Builds a hierarchical tree view of a parsed Postman collection.
 *
 * Each request is also tagged with a `requestIndex` matching its position in
 * `parsed.requests`. That index is the stable selection ID used by the
 * frontend tree picker and by the script generator's filter.
 *
 * Folder ids are derived from a slash-joined path of folder indices (e.g.
 * `0`, `0/2`) so they uniquely identify a folder regardless of duplicate
 * names. The frontend uses them only for expand/collapse state.
 */

function isFolder(item) {
  return item && Array.isArray(item.item);
}
function isRequest(item) {
  return item && item.request && !Array.isArray(item.item);
}

function hasAuthHeader(headers) {
  if (!Array.isArray(headers)) return false;
  return headers.some(
    (h) => h && typeof h.key === 'string' && h.key.toLowerCase() === 'authorization'
  );
}

/**
 * @param {object} collection - Raw Postman v2.1 collection
 * @param {{ requests: Array }} parsed - Output of parser.parse() (post-sanitize)
 * @returns {{
 *   name: string,
 *   totalRequests: number,
 *   tree: Array<TreeNode>
 * }}
 *
 * TreeNode (folder): { type:'folder', id, name, path, requestCount, children:[] }
 * TreeNode (request): { type:'request', id, requestIndex, name, method, url, folderPath, hasAuth }
 */
function buildTree(collection, parsed) {
  const requests = parsed?.requests || [];
  // Index parsed requests by their (folderPath, name, method, url) signature
  // so we can pair them up with the raw collection tree we walk in the same
  // order. `parser.parse` walks folders -> requests in the same depth-first
  // order, so a simple counter works.
  let cursor = 0;

  function walk(items, folderPath, parentId) {
    const children = [];
    for (let i = 0; i < (items || []).length; i++) {
      const item = items[i];
      const localId = parentId == null ? String(i) : `${parentId}/${i}`;

      if (isFolder(item)) {
        const folderName = item.name || 'folder';
        const node = {
          type: 'folder',
          id: `f:${localId}`,
          name: folderName,
          path: [...folderPath, folderName],
          requestCount: 0,
          children: walk(item.item, [...folderPath, folderName], localId),
        };
        node.requestCount = countRequests(node.children);
        children.push(node);
      } else if (isRequest(item)) {
        const r = requests[cursor];
        const requestIndex = cursor;
        cursor += 1;
        if (!r) continue;
        children.push({
          type: 'request',
          id: `r:${localId}`,
          requestIndex,
          name: r.name,
          method: r.method,
          url: r.url,
          folderPath: r.folderPath,
          hasAuth: hasAuthHeader(r.headers) || !!r.auth,
        });
      }
    }
    return children;
  }

  function countRequests(nodes) {
    let n = 0;
    for (const node of nodes) {
      if (node.type === 'request') n += 1;
      else n += node.requestCount;
    }
    return n;
  }

  const tree = walk(collection?.item, [], null);
  return {
    name: collection?.info?.name || parsed?.name || 'Untitled',
    totalRequests: requests.length,
    tree,
  };
}

/**
 * Resolve a selection descriptor into a Set of requestIndices.
 *
 * @param {object} selection
 * @param {'all'|'requests'|'folder'|'single'} selection.mode
 * @param {number[]} [selection.requestIndices]
 * @param {number} [selection.requestIndex]
 * @param {string[]} [selection.folderPath]   Folder names from root; matches r.folderPath exactly.
 * @param {Array} requests - parsed.requests
 * @returns {Set<number>}
 */
function resolveSelection(selection, requests) {
  const all = new Set(requests.map((_, i) => i));
  if (!selection || selection.mode === 'all') return all;

  if (selection.mode === 'single') {
    const idx = Number(selection.requestIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < requests.length) {
      return new Set([idx]);
    }
    return new Set();
  }

  if (selection.mode === 'requests') {
    const set = new Set();
    for (const v of selection.requestIndices || []) {
      const idx = Number(v);
      if (Number.isInteger(idx) && idx >= 0 && idx < requests.length) {
        set.add(idx);
      }
    }
    return set;
  }

  if (selection.mode === 'folder') {
    const fp = Array.isArray(selection.folderPath) ? selection.folderPath : [];
    const set = new Set();
    requests.forEach((r, i) => {
      if (!Array.isArray(r.folderPath)) return;
      // Match if request's folderPath starts with the selected folder path.
      let match = fp.length <= r.folderPath.length;
      for (let k = 0; k < fp.length && match; k++) {
        if (r.folderPath[k] !== fp[k]) match = false;
      }
      if (match) set.add(i);
    });
    return set;
  }

  return all;
}

/**
 * Apply a selection to a parsed collection by filtering parsed.requests
 * while preserving order. Re-emits referencedVars based on the filtered set.
 */
function applySelection(parsed, selection) {
  const indices = resolveSelection(selection, parsed.requests || []);
  const filtered = (parsed.requests || []).filter((_, i) => indices.has(i));

  // Recompute referencedVars from the filtered requests so the runner only
  // expects env vars actually used by the selected APIs.
  const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const referenced = new Set();
  const sniff = (s) => {
    if (typeof s !== 'string') return;
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(s)) !== null) referenced.add(m[1].trim());
  };
  for (const r of filtered) {
    sniff(r.url);
    for (const h of r.headers || []) sniff(h.value);
    if (r.body) {
      if (r.body.mode === 'raw') sniff(r.body.raw);
      if (r.body.mode === 'urlencoded' || r.body.mode === 'formdata') {
        for (const p of r.body.params || []) {
          sniff(p.key);
          sniff(p.value);
        }
      }
      if (r.body.mode === 'graphql') {
        sniff(r.body.query);
        if (typeof r.body.variables === 'string') sniff(r.body.variables);
      }
    }
  }
  return {
    parsed: { ...parsed, requests: filtered, referencedVars: Array.from(referenced) },
    selectedIndices: Array.from(indices).sort((a, b) => a - b),
  };
}

module.exports = { buildTree, resolveSelection, applySelection };
