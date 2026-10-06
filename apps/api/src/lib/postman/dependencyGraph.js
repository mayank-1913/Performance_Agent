'use strict';

/**
 * Plan-time dependency graph for Postman runtime-captured variables.
 *
 * When request A captures `campaign_id` via pm.environment.set and request B
 * references {{campaign_id}}, B depends on A. The generator uses this graph to
 * emit runtime skip guards so B is not executed with null/undefined/{{var}}.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '');
}

/**
 * Persisted writes only. pm.variables.set is request-local and must not
 * create a cross-request dependency.
 */
function persistedWrites(text) {
  const names = [];
  const stripped = stripComments(text);
  const re = /pm\.(environment|collectionVariables|globals)\.set\s*\(/g;
  let match;
  while ((match = re.exec(stripped)) !== null) {
    let i = re.lastIndex;
    while (i < stripped.length && /\s/.test(stripped[i])) i += 1;
    const q = stripped[i];
    if (q !== "'" && q !== '"') continue;
    const close = stripped.indexOf(q, i + 1);
    if (close < 0) continue;
    const name = stripped.slice(i + 1, close).trim();
    if (name) names.push(name);
  }
  return names;
}

function collectRuntimeCapturedVarNames(parsed) {
  const requests = parsed?.requests || [];
  const out = new Set();
  for (const req of requests) {
    const scripts = [...(req?.prerequests || []), ...(req?.tests || [])];
    for (const text of scripts) {
      if (typeof text !== 'string') continue;
      for (const name of persistedWrites(text)) out.add(name);
    }
  }
  return Array.from(out);
}

function collectWriters(requests) {
  const byVar = new Map();
  requests.forEach((req, index) => {
    const seen = new Set();
    const scripts = [...(req?.prerequests || []), ...(req?.tests || [])];
    for (const text of scripts) {
      if (typeof text !== 'string') continue;
      for (const name of persistedWrites(text)) seen.add(name);
    }
    for (const name of seen) {
      if (!byVar.has(name)) byVar.set(name, []);
      byVar.get(name).push({
        index,
        requestName: req?.name || `request_${index}`,
      });
    }
  });
  return byVar;
}

function extractReferencedVars(req) {
  const vars = new Set();
  const sniff = (s) => {
    if (typeof s !== 'string') return;
    let m;
    VAR_RE.lastIndex = 0;
    while ((m = VAR_RE.exec(s)) !== null) {
      const name = m[1].trim();
      if (name) vars.add(name);
    }
  };
  sniff(req.url);
  for (const h of req.headers || []) {
    sniff(h.key);
    sniff(h.value);
  }
  if (req.body) {
    if (req.body.mode === 'raw') sniff(req.body.raw);
    if (req.body.mode === 'urlencoded' || req.body.mode === 'formdata') {
      for (const p of req.body.params || []) {
        sniff(p.key);
        sniff(p.value);
      }
    }
    if (req.body.mode === 'graphql') {
      sniff(req.body.query);
      if (typeof req.body.variables === 'string') sniff(req.body.variables);
    }
  }
  return vars;
}

/**
 * @param {object} parsed - parser output
 * @param {object} authFlow - buildAuthFlow() output
 * @returns {{ perRequest: Array<Array<{varName, producerIndex, producerRequest}>>, runtimeCaptured: string[] }}
 */
function buildDependencyGraph(parsed, authFlow = {}) {
  const requests = parsed?.requests || [];
  const runtimeCaptured = new Set(collectRuntimeCapturedVarNames(parsed));
  const writers = collectWriters(requests);

  // Capture rules can name a variable even when the set() regex is obscured.
  for (const entry of authFlow.requestCaptureRules || []) {
    for (const rule of entry.rules || []) {
      if (!rule?.varName) continue;
      runtimeCaptured.add(rule.varName);
      if (!writers.has(rule.varName)) writers.set(rule.varName, []);
      const list = writers.get(rule.varName);
      if (!list.some((item) => item.index === entry.index)) {
        list.push({
          index: entry.index,
          requestName: requests[entry.index]?.name || `request_${entry.index}`,
        });
        list.sort((a, b) => a.index - b.index);
      }
    }
  }

  const producers = new Map();
  for (const [varName, list] of writers.entries()) {
    const last = list[list.length - 1];
    if (last) producers.set(varName, last);
  }

  const perRequest = requests.map((req, index) => {
    const refs = extractReferencedVars(req);
    const deps = [];
    for (const varName of refs) {
      if (!runtimeCaptured.has(varName)) continue;
      const history = writers.get(varName) || [];
      let producer = null;
      for (const writer of history) {
        if (writer.index < index) producer = writer;
        else break;
      }
      if (!producer) continue;
      deps.push({
        varName,
        producerIndex: producer.index,
        producerRequest: producer.requestName,
      });
    }
    return deps;
  });

  return {
    perRequest,
    runtimeCaptured: Array.from(runtimeCaptured),
    producers,
  };
}

module.exports = {
  buildDependencyGraph,
  extractReferencedVars,
};
