'use strict';

/**
 * Generic Postman-vs-Agent wire-level comparison (secrets redacted).
 */

const SECRET_KEY_RE = /(token|secret|jwt|key|session|auth|bearer|password|cookie)/i;
const { resolveDynamicVariable } = require('./dynamicVariables');
const { resolveVariables, toEnvName } = require('./variableResolver');

function redactValue(key, value) {
  if (value == null) return { present: false, type: typeof value, length: 0, redacted: null };
  const str = String(value);
  const secret = SECRET_KEY_RE.test(String(key || ''));
  return {
    present: str.length > 0,
    type: typeof value === 'number' || typeof value === 'boolean' ? typeof value : 'string',
    length: str.length,
    redacted: secret ? '<redacted>' : str.length > 120 ? str.slice(0, 120) + '…' : str,
  };
}

function resolveTemplateString(template, ctx) {
  const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const dynCache = new Map();
  return String(template || '').replace(VAR_RE, (full, name) => {
    const original = String(name).trim();
    if (original.startsWith('$')) {
      const dyn = resolveDynamicVariable(original, ctx.provider || {}, dynCache);
      if (!dyn.ok) return full;
      if (typeof dyn.value === 'boolean' || typeof dyn.value === 'number' || dyn.value === null) {
        return String(dyn.value);
      }
      return String(dyn.value);
    }
    const envName = toEnvName(original);
    if (ctx.manual && ctx.manual[envName] != null) return String(ctx.manual[envName]);
    if (ctx.pm && ctx.pm[original] != null) return String(ctx.pm[original]);
    if (ctx.requestLocals && ctx.requestLocals[original] != null) return String(ctx.requestLocals[original]);
    if (ctx.captured && ctx.captured[original] != null) return String(ctx.captured[original]);
    if (ctx.environment && ctx.environment[original] != null) return String(ctx.environment[original]);
    if (ctx.collection && ctx.collection[original] != null) return String(ctx.collection[original]);
    return '';
  });
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compareField(path, postmanVal, agentVal) {
  const postmanType = postmanVal === null ? 'null' : Array.isArray(postmanVal) ? 'array' : typeof postmanVal;
  const agentType = agentVal === null ? 'null' : Array.isArray(agentVal) ? 'array' : typeof agentVal;
  const match =
    postmanType === agentType &&
    JSON.stringify(postmanVal) === JSON.stringify(agentVal);
  return {
    path,
    postman: redactValue(path, postmanVal),
    agent: redactValue(path, agentVal),
    postmanType,
    agentType,
    result: match ? 'MATCH' : 'DIFFERENCE',
  };
}

/**
 * Compare a Postman request template against an Agent-resolved request snapshot.
 */
function compareWireRequest(postmanReq, agentResolved, ctx = {}) {
  const differences = [];
  const matches = [];

  const pmMethod = String(postmanReq.method || 'GET').toUpperCase();
  const agMethod = String(agentResolved.method || 'GET').toUpperCase();
  const methodCmp = compareField('method', pmMethod, agMethod);
  (methodCmp.result === 'MATCH' ? matches : differences).push(methodCmp);

  const pmUrl = resolveTemplateString(postmanReq.url, ctx);
  const agUrl = String(agentResolved.url || '');
  const urlCmp = compareField('url', pmUrl, agUrl);
  (urlCmp.result === 'MATCH' ? matches : differences).push(urlCmp);

  const pmBodyRaw =
    postmanReq.body && postmanReq.body.mode === 'raw' ? resolveTemplateString(postmanReq.body.raw, ctx) : '';
  const agBodyRaw = agentResolved.body == null ? '' : String(agentResolved.body);
  const pmBody = tryParseJson(pmBodyRaw) ?? pmBodyRaw;
  const agBody = tryParseJson(agBodyRaw) ?? agBodyRaw;
  const bodyCmp = compareField('body', pmBody, agBody);
  (bodyCmp.result === 'MATCH' ? matches : differences).push(bodyCmp);

  return {
    result: differences.length === 0 ? 'MATCH' : 'DIFFERENCE',
    matches,
    differences,
  };
}

module.exports = {
  compareWireRequest,
  resolveTemplateString,
  redactValue,
};
