'use strict';

/**
 * Unresolved variable classification and safety guards.
 */

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
const { isDynamicVariable, SUPPORTED_DYNAMIC } = require('./dynamicVariables');

const VariableStatus = Object.freeze({
  RESOLVED: 'RESOLVED',
  DYNAMIC_RESOLVED: 'DYNAMIC_RESOLVED',
  RUNTIME_CAPTURED: 'RUNTIME_CAPTURED',
  MANUAL_OVERRIDE: 'MANUAL_OVERRIDE',
  UNRESOLVED: 'UNRESOLVED',
  UNSUPPORTED_DYNAMIC_VARIABLE: 'UNSUPPORTED_DYNAMIC_VARIABLE',
  UNSUPPORTED_PRE_REQUEST_OPERATION: 'UNSUPPORTED_PRE_REQUEST_OPERATION',
});

function extractPlaceholderNames(text) {
  const names = new Set();
  if (typeof text !== 'string' || !text) return names;
  VAR_RE.lastIndex = 0;
  let m;
  while ((m = VAR_RE.exec(text)) !== null) {
    names.add(m[1].trim());
  }
  return names;
}

function classifyPlaceholder(name, ctx) {
  const original = String(name || '').trim();
  if (!original) return VariableStatus.UNRESOLVED;
  if (original.startsWith('$')) {
    return isDynamicVariable(original)
      ? VariableStatus.DYNAMIC_RESOLVED
      : VariableStatus.UNSUPPORTED_DYNAMIC_VARIABLE;
  }
  if (ctx.manualOverrides && ctx.manualOverrides.has(original)) return VariableStatus.MANUAL_OVERRIDE;
  if (ctx.prerequestSets && ctx.prerequestSets.has(original)) return VariableStatus.RESOLVED;
  if (ctx.requestLocals && ctx.requestLocals.has(original)) return VariableStatus.RESOLVED;
  if (ctx.capturedVars && ctx.capturedVars.has(original)) return VariableStatus.RUNTIME_CAPTURED;
  if (ctx.environmentVars && ctx.environmentVars.has(original)) return VariableStatus.RESOLVED;
  if (ctx.collectionVars && ctx.collectionVars.has(original)) return VariableStatus.RESOLVED;
  return VariableStatus.UNRESOLVED;
}

function collectRequestVariableRefs(req) {
  const refs = new Set();
  const add = (s) => extractPlaceholderNames(s).forEach((n) => refs.add(n));
  add(req.url);
  for (const h of req.headers || []) add(h.value);
  if (req.body) {
    if (req.body.mode === 'raw') add(req.body.raw);
    if (req.body.mode === 'urlencoded' || req.body.mode === 'formdata') {
      for (const p of req.body.params || []) {
        add(p.key);
        add(p.value);
      }
    }
    if (req.body.mode === 'graphql') {
      add(req.body.query);
      if (typeof req.body.variables === 'string') add(req.body.variables);
    }
  }
  return refs;
}

function analyzeRequestVariables(req, ctx) {
  const refs = collectRequestVariableRefs(req);
  const unresolved = [];
  const unsupportedDynamic = [];
  for (const name of refs) {
    const status = classifyPlaceholder(name, ctx);
    if (status === VariableStatus.UNRESOLVED) unresolved.push(name);
    if (status === VariableStatus.UNSUPPORTED_DYNAMIC_VARIABLE) unsupportedDynamic.push(name);
  }
  return { refs: Array.from(refs), unresolved, unsupportedDynamic };
}

const UNRESOLVED_SAFETY_RUNTIME_JS = `
function __hasInvalidRuntimeContent(content) {
  if (content == null) return true;
  const s = String(content);
  if (s.length === 0) return false;
  if (/\\{\\{[^}]+\\}\\}/.test(s)) return true;
  if (/__UNRESOLVED__/.test(s)) return true;
  if (/__UNSUPPORTED_DYNAMIC__/.test(s)) return true;
  if (/(?:^|["'\\s,:\\[{])(null|undefined)(?:["'\\s,}\\]}]|$)/i.test(s) && /__UNRESOLVED__|__UNSUPPORTED_DYNAMIC__/.test(s)) return true;
  return false;
}

function __markUnresolved(name) {
  return '__UNRESOLVED__' + String(name || '');
}
`.trim();

module.exports = {
  VariableStatus,
  extractPlaceholderNames,
  classifyPlaceholder,
  collectRequestVariableRefs,
  analyzeRequestVariables,
  UNRESOLVED_SAFETY_RUNTIME_JS,
};
