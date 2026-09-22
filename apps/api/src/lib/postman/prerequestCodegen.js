'use strict';

/**
 * Safe, allowlisted pre-request script translation.
 *
 * Postman pre-request scripts are NEVER eval'd in Node or emitted verbatim
 * into K6. Supported statements are pattern-matched and translated into
 * equivalent K6 runtime code operating on a pm sandbox (state.pm).
 */

const FORBIDDEN_RE = /\b(eval|Function|require|import|globalThis|process|child_process|fetch|XMLHttpRequest|setTimeout|setInterval)\b/;
const PM_SET_RE =
  /pm\.(environment|collectionVariables|variables)\.set\s*\(\s*["']([^"']+)["']\s*,\s*([^;]+)\)\s*;?/;
const PM_UNSET_RE =
  /pm\.(environment|collectionVariables|variables)\.unset\s*\(\s*["']([^"']+)["']\s*\)\s*;?/;
const CONST_DATE_RE = /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Date\s*\(\s*\)\s*;?\s*$/;
const CONST_ARROW_YMD_RE =
  /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\2\.toISOString\(\)\.split\(['"]T['"]\)\[0\]\s*;?\s*$/;
const SET_DATE_RE =
  /^\s*([A-Za-z_$][\w$]*)\.setDate\s*\(\s*([A-Za-z_$][\w$]*)\.getDate\(\)\s*\+\s*(\d+)\s*\)\s*;?\s*$/;
const PM_SET_LINE_RE =
  /^\s*pm\.(environment|collectionVariables|variables)\.set\s*\(\s*["']([^"']+)["']\s*,\s*([^;]+)\)\s*;?\s*$/;
const PM_SET_ISO_DATE_LINE_RE =
  /^\s*pm\.(environment|collectionVariables|variables)\.set\s*\(\s*["']([^"']+)["']\s*,\s*new\s+Date\s*\(\s*\)\.toISOString\(\)\.split\(['"]T['"]\)\[0\]\s*\)\s*;?\s*$/;

const SCOPE_MAP = {
  environment: 'environment',
  collectionVariables: 'collectionVariables',
  variables: 'variables',
};

function stripComments(text) {
  return String(text || '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n\r]*/g, '');
}

function splitStatements(script) {
  return stripComments(script)
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

function isSafeIdentifier(name, allowed) {
  return allowed.has(name);
}

function translateExpression(expr, ctx) {
  const e = String(expr || '').trim();
  if (/^["'].*["']$/.test(e)) {
    return { ok: true, code: e };
  }
  if (/^\d+$/.test(e)) {
    return { ok: true, code: e };
  }
  if (/^(true|false|null)$/.test(e)) {
    return { ok: true, code: e };
  }
  if (ctx.dateVars.has(e)) {
    return { ok: true, code: e };
  }
  if (ctx.fnVars.has(e)) {
    return { ok: true, code: e };
  }
  const callMatch = e.match(/^([A-Za-z_$][\w$]*)\(([^)]+)\)$/);
  if (callMatch) {
    const fn = callMatch[1];
    const arg = callMatch[2].trim();
    if (!ctx.fnVars.has(fn) || !ctx.dateVars.has(arg)) {
      return { ok: false, reason: `Unsupported call expression: ${e}` };
    }
    return { ok: true, code: `${fn}(${arg})` };
  }
  return { ok: false, reason: `Unsupported expression: ${e}` };
}

/**
 * Analyze and translate a pre-request script.
 * @returns {{
 *   translatable: boolean,
 *   k6Lines: string[],
 *   unsupported: string[],
 *   setsEnvironment: string[],
 *   reason?: string,
 * }}
 */
function analyzePrerequestScript(scriptText) {
  const unsupported = [];
  const k6Lines = [];
  const setsEnvironment = [];
  const text = String(scriptText || '').trim();

  if (!text) {
    return { translatable: true, k6Lines: [], unsupported: [], setsEnvironment: [] };
  }

  if (FORBIDDEN_RE.test(text)) {
    return {
      translatable: false,
      k6Lines: [],
      unsupported: [text],
      setsEnvironment: [],
      reason: 'Forbidden JavaScript construct in pre-request script',
    };
  }

  const ctx = { dateVars: new Set(), fnVars: new Set() };
  const statements = splitStatements(text);

  for (const line of statements) {
    let matched = false;

    const constDate = line.match(CONST_DATE_RE);
    if (constDate) {
      ctx.dateVars.add(constDate[1]);
      k6Lines.push(`  const ${constDate[1]} = new Date();`);
      matched = true;
    }

    const arrowYmd = line.match(CONST_ARROW_YMD_RE);
    if (!matched && arrowYmd) {
      ctx.fnVars.add(arrowYmd[1]);
      k6Lines.push(
        `  const ${arrowYmd[1]} = (${arrowYmd[2]}) => ${arrowYmd[2]}.toISOString().split('T')[0];`
      );
      matched = true;
    }

    const setDate = line.match(SET_DATE_RE);
    if (!matched && setDate) {
      if (!ctx.dateVars.has(setDate[1]) || !ctx.dateVars.has(setDate[2])) {
        unsupported.push(line);
        continue;
      }
      k6Lines.push(`  ${setDate[1]}.setDate(${setDate[2]}.getDate() + ${setDate[3]});`);
      matched = true;
    }

    const pmSetIso = line.match(PM_SET_ISO_DATE_LINE_RE);
    if (!matched && pmSetIso) {
      const scope = SCOPE_MAP[pmSetIso[1]];
      const varName = pmSetIso[2];
      k6Lines.push(
        `  __pmSet(state, '${scope}', ${JSON.stringify(varName)}, new Date().toISOString().split('T')[0]);`
      );
      if (scope === 'environment') setsEnvironment.push(varName);
      matched = true;
    }

    const pmSet = line.match(PM_SET_LINE_RE);
    if (!matched && pmSet) {
      const scope = SCOPE_MAP[pmSet[1]];
      const varName = pmSet[2];
      const expr = translateExpression(pmSet[3], ctx);
      if (!expr.ok) {
        unsupported.push(line);
        continue;
      }
      k6Lines.push(
        `  __pmSet(state, '${scope}', ${JSON.stringify(varName)}, ${expr.code});`
      );
      if (scope === 'environment') setsEnvironment.push(varName);
      matched = true;
    }

    const pmUnset = line.match(PM_UNSET_RE);
    if (!matched && pmUnset) {
      const scope = SCOPE_MAP[pmUnset[1]];
      k6Lines.push(`  __pmUnset(state, '${scope}', ${JSON.stringify(pmUnset[2])});`);
      matched = true;
    }

    if (!matched) {
      unsupported.push(line);
    }
  }

  if (unsupported.length > 0) {
    return {
      translatable: false,
      k6Lines: [],
      unsupported,
      setsEnvironment: [],
      reason: 'Unsupported pre-request script statement(s)',
    };
  }

  return { translatable: true, k6Lines, unsupported: [], setsEnvironment };
}

function emitPrerequestBlock(emitIndex, analysis, requestLocalSeed) {
  if (!analysis.translatable) return { block: '', required: false };
  const lines = [
    `    const __pmState_${emitIndex} = __getAuthState(data);`,
    `    __seedRequestLocals(__pmState_${emitIndex}, ${emitIndex}, ${JSON.stringify(requestLocalSeed || {})});`,
  ];
  if (analysis.k6Lines.length > 0) {
    lines.push(`    (function(state) {`);
    lines.push(`      if (!state.pm) state.pm = { environment: {}, collectionVariables: {}, variables: {} };`);
    lines.push(...analysis.k6Lines);
    lines.push(`    })(__pmState_${emitIndex});`);
  }
  return { block: lines.join('\n'), required: analysis.k6Lines.length > 0 };
}

const PREREQUEST_RUNTIME_JS = `
function __pmSet(state, scope, name, value) {
  if (!state.pm) state.pm = { environment: {}, collectionVariables: {}, variables: {} };
  if (!state.pm[scope]) state.pm[scope] = {};
  state.pm[scope][name] = value;
  if (!state.vars) state.vars = {};
  if (scope === 'environment' || scope === 'variables') state.vars[name] = value == null ? '' : String(value);
  const bucket = __ensureRequestLocals(state, state.__currentRequestIndex || -1);
  if (scope === 'variables') bucket[name] = value == null ? '' : String(value);
}

function __pmUnset(state, scope, name) {
  if (!state.pm || !state.pm[scope]) return;
  delete state.pm[scope][name];
  if (state.vars) delete state.vars[name];
}
`.trim();

module.exports = {
  analyzePrerequestScript,
  emitPrerequestBlock,
  PREREQUEST_RUNTIME_JS,
  PM_SET_RE,
};
