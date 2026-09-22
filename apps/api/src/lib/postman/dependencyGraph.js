'use strict';

/**
 * Plan-time dependency graph for Postman runtime-captured variables.
 *
 * When request A captures `campaign_id` via pm.environment.set and request B
 * references {{campaign_id}}, B depends on A. The generator uses this graph to
 * emit runtime skip guards so B is not executed with null/undefined/{{var}}.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

function collectRuntimeCapturedVarNames(parsed) {
  const requests = parsed?.requests || [];
  const out = new Set();
  for (const req of requests) {
    const scripts = [...(req?.tests || []), ...(req?.prerequests || [])];
    for (const text of scripts) {
      if (typeof text !== 'string') continue;
      const setRe = /pm\.(?:environment|collectionVariables|globals|variables)\.set\s*\(\s*["']([^"']+)["']\s*,/g;
      let match;
      while ((match = setRe.exec(text)) !== null) {
        const name = String(match[1] || '').trim();
        if (name) out.add(name);
      }
    }
  }
  return Array.from(out);
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

  const producers = new Map();
  for (const entry of authFlow.requestCaptureRules || []) {
    for (const rule of entry.rules || []) {
      if (!rule?.varName) continue;
      const req = requests[entry.index];
      producers.set(rule.varName, {
        index: entry.index,
        requestName: req?.name || `request_${entry.index}`,
      });
    }
  }

  const perRequest = requests.map((req, index) => {
    const refs = extractReferencedVars(req);
    const deps = [];
    for (const varName of refs) {
      if (!runtimeCaptured.has(varName)) continue;
      const producer = producers.get(varName);
      if (!producer || producer.index >= index) continue;
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
