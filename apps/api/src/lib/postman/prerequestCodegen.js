'use strict';

/**
 * Safe, allowlisted pre-request script translation.
 *
 * Postman pre-request scripts are NEVER eval'd in Node or emitted verbatim
 * into K6. Supported statements are pattern-matched and translated into
 * equivalent K6 runtime code operating on a pm sandbox (state.pm).
 *
 * Request-local pm.variables writes stay on the request scope. Environment
 * writes persist for the rest of the run.
 */

const FORBIDDEN_RE = /\b(eval|Function|require|import|globalThis|process|child_process|fetch|XMLHttpRequest|setTimeout|setInterval)\b/;
const PM_SET_RE =
  /pm\.(environment|collectionVariables|variables)\.set\s*\(\s*["']([^"']+)["']\s*,\s*([^;]+)\)\s*;?/;

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

function fail(reason) {
  const err = new Error(reason || 'unsupported');
  err.unsupported = true;
  throw err;
}

function translateExpression(expr, ctx) {
  const src = String(expr || '').trim();
  if (!src) fail('empty expression');
  let i = 0;

  function skip() {
    while (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r') i += 1;
  }

  function parseString() {
    const q = src[i];
    i += 1;
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        out += src[i] + (src[i + 1] || '');
        i += 2;
        continue;
      }
      out += src[i];
      i += 1;
    }
    if (src[i] !== q) fail('unterminated string');
    i += 1;
    return q + out + q;
  }

  function parseTemplate() {
    i += 1;
    let out = '`';
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') {
        out += src[i] + (src[i + 1] || '');
        i += 2;
        continue;
      }
      if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        const inner = parseAdd();
        skip();
        if (src[i] !== '}') fail('unterminated template expression');
        i += 1;
        out += '${' + inner + '}';
        continue;
      }
      out += src[i];
      i += 1;
    }
    if (src[i] !== '`') fail('unterminated template');
    i += 1;
    out += '`';
    return out;
  }

  function parseNumber() {
    const start = i;
    while (i < src.length && /[0-9]/.test(src[i])) i += 1;
    if (start === i) fail('number');
    return src.slice(start, i);
  }

  function readIdent() {
    const start = i;
    if (!/[A-Za-z_$]/.test(src[i] || '')) fail('identifier');
    i += 1;
    while (i < src.length && /[\w$]/.test(src[i])) i += 1;
    return src.slice(start, i);
  }

  function known(name) {
    return ctx.known.has(name) || ctx.dateVars.has(name) || ctx.fnVars.has(name) || ctx.valueVars.has(name);
  }

  function parseCallArgs() {
    skip();
    if (src[i] !== '(') fail('expected (');
    i += 1;
    skip();
    if (src[i] === ')') {
      i += 1;
      return [];
    }
    const args = [];
    args.push(parseAdd());
    skip();
    while (src[i] === ',') {
      i += 1;
      args.push(parseAdd());
      skip();
    }
    if (src[i] !== ')') fail('expected )');
    i += 1;
    return args;
  }

  function parseAtom() {
    skip();
    if (src.startsWith('new Date', i) && !/[\w$]/.test(src[i + 8] || '')) {
      i += 8;
      skip();
      if (src[i] !== '(') fail('new Date');
      i += 1;
      skip();
      let dateCode;
      if (src[i] === ')') {
        i += 1;
        dateCode = 'new Date()';
      } else {
        const inner = parseAdd();
        skip();
        if (src[i] !== ')') fail('new Date');
        i += 1;
        dateCode = 'new Date(' + inner + ')';
      }
      // Inline date expressions (new Date().toISOString()…) are translated
      // through the same date-postfix handler used by the intermediate-var
      // form (today.toISOString()…). Keeps grammar name-agnostic.
      return applyDatePostfix(dateCode);
    }
    if (src.startsWith('Math.random', i) && !/[\w$]/.test(src[i + 11] || '')) {
      i += 11;
      skip();
      if (src[i] !== '(') fail('Math.random');
      i += 1;
      skip();
      if (src[i] !== ')') fail('Math.random');
      i += 1;
      return 'Math.random()';
    }
    if (src.startsWith('Math.floor', i) && !/[\w$]/.test(src[i + 10] || '')) {
      i += 10;
      skip();
      const args = parseCallArgs();
      if (args.length !== 1) fail('Math.floor');
      return 'Math.floor(' + args[0] + ')';
    }
    if (src.startsWith('String', i) && !/[\w$]/.test(src[i + 6] || '')) {
      i += 6;
      skip();
      const args = parseCallArgs();
      if (args.length !== 1) fail('String');
      let code = 'String(' + args[0] + ')';
      skip();
      if (src.startsWith('.padStart', i)) {
        i += '.padStart'.length;
        skip();
        const padArgs = parseCallArgs();
        if (padArgs.length !== 2) fail('padStart');
        code += '.padStart(' + padArgs.join(', ') + ')';
      }
      return code;
    }
    if (src[i] === '"' || src[i] === "'") return parseString();
    if (src[i] === '`') return parseTemplate();
    if (src[i] === '(') {
      i += 1;
      const inner = parseAdd();
      skip();
      if (src[i] !== ')') fail('paren');
      i += 1;
      return '(' + inner + ')';
    }
    if (/[0-9]/.test(src[i] || '')) return parseNumber();
    if (/[A-Za-z_$]/.test(src[i] || '')) {
      const name = readIdent();
      skip();
      if (src[i] === '(') {
        const args = parseCallArgs();
        if (!ctx.fnVars.has(name) || args.length !== 1) fail('call ' + name);
        return name + '(' + args[0] + ')';
      }
      if (!known(name)) fail('unknown identifier ' + name);
      return applyDatePostfix(name);
    }
    fail('expression');
    return '';
  }

  // Shared postfix handler for date-shaped expressions. Accepts:
  //   .toISOString()                        (bare)
  //   .toISOString().split('T')[0]          (YMD extraction)
  //   .getFullYear() | .getMonth() | .getDate()
  // Anything else is returned verbatim; unknown postfix chains will fail
  // later via the trailing-expression check and remain classified as
  // unsupported.
  function applyDatePostfix(code) {
    if (src.startsWith('.toISOString()', i)) {
      i += '.toISOString()'.length;
      let out = code + ".toISOString()";
      skip();
      const split = src.slice(i).match(/^\.split\(\s*(['"])T\1\s*\)\s*\[\s*0\s*\]/);
      if (split) {
        i += split[0].length;
        out += ".split('T')[0]";
      }
      return out;
    }
    if (src.startsWith('.getFullYear()', i)) {
      i += '.getFullYear()'.length;
      return code + '.getFullYear()';
    }
    if (src.startsWith('.getMonth()', i)) {
      i += '.getMonth()'.length;
      return code + '.getMonth()';
    }
    if (src.startsWith('.getDate()', i)) {
      i += '.getDate()'.length;
      return code + '.getDate()';
    }
    return code;
  }

  function parseMul() {
    let left = parseAtom();
    skip();
    while (src[i] === '*' || src[i] === '/') {
      const op = src[i];
      i += 1;
      const right = parseAtom();
      left = '(' + left + ' ' + op + ' ' + right + ')';
      skip();
    }
    return left;
  }

  function parseAdd() {
    let left = parseMul();
    skip();
    while (src[i] === '+' || src[i] === '-') {
      const op = src[i];
      i += 1;
      const right = parseMul();
      left = '(' + left + ' ' + op + ' ' + right + ')';
      skip();
    }
    return left;
  }

  try {
    const code = parseAdd();
    skip();
    if (i !== src.length) fail('trailing expression');
    return { ok: true, code };
  } catch (err) {
    return { ok: false, reason: err.message || 'Unsupported expression' };
  }
}

function extractFlowBlocks(script) {
  const flow = [];
  let text = script;
  const re =
    /if\s*\(\s*pm\.(environment|variables|collectionVariables)\.get\(\s*(['"])([^'"]+)\2\s*\)\s*===?\s*(['"])([^'"]*)\4\s*\)\s*\{\s*postman\.setNextRequest\(\s*(null|(['"])[^'"]*\7)\s*\)\s*;?\s*\}/g;
  text = text.replace(re, (full, scope, _q1, varName, _q2, expected, target) => {
    let name = null;
    let stop = false;
    if (target === 'null') stop = true;
    else name = target.slice(1, -1);
    flow.push({ scope: SCOPE_MAP[scope], varName, expected, stop, name });
    return '';
  });
  const bare =
    /postman\.setNextRequest\(\s*(null|(['"])[^'"]*\2)\s*\)\s*;?/g;
  text = text.replace(bare, (full, target) => {
    if (target === 'null') flow.push({ scope: null, varName: null, expected: null, stop: true, name: null });
    else flow.push({ scope: null, varName: null, expected: null, stop: false, name: target.slice(1, -1) });
    return '';
  });
  return { text, flow };
}

function flowLines(flow) {
  return flow.map((step) => {
    const call = step.stop
      ? `__scheduleNextRequest(state, null)`
      : `__scheduleNextRequest(state, ${JSON.stringify(step.name)})`;
    if (!step.varName) return `  ${call};`;
    return [
      `  if (String(__pmGet(state, '${step.scope}', ${JSON.stringify(step.varName)})) === ${JSON.stringify(step.expected)}) {`,
      `    ${call};`,
      `  }`,
    ].join('\n');
  });
}

/**
 * Analyze and translate a pre-request script.
 * @returns {{
 *   translatable: boolean,
 *   k6Lines: string[],
 *   unsupported: string[],
 *   setsEnvironment: string[],
 *   setsVariables: string[],
 *   setsCollection: string[],
 *   schedulesNextRequest: boolean,
 *   reason?: string,
 * }}
 */
function analyzePrerequestScript(scriptText) {
  const empty = {
    translatable: true,
    k6Lines: [],
    unsupported: [],
    setsEnvironment: [],
    setsVariables: [],
    setsCollection: [],
    schedulesNextRequest: false,
  };
  const text = String(scriptText || '').trim();
  if (!text) return empty;

  if (FORBIDDEN_RE.test(text)) {
    return {
      translatable: false,
      k6Lines: [],
      unsupported: [text],
      setsEnvironment: [],
      setsVariables: [],
      setsCollection: [],
      schedulesNextRequest: false,
      reason: 'Forbidden JavaScript construct in pre-request script',
    };
  }

  const stripped = stripComments(text);
  let extracted;
  try {
    extracted = extractFlowBlocks(stripped);
  } catch (err) {
    return {
      translatable: false,
      k6Lines: [],
      unsupported: [text],
      setsEnvironment: [],
      setsVariables: [],
      setsCollection: [],
      schedulesNextRequest: false,
      reason: err.message,
    };
  }

  const ctx = {
    dateVars: new Set(),
    fnVars: new Set(),
    valueVars: new Set(),
    known: new Set(),
  };
  const k6Lines = [];
  const unsupported = [];
  const setsEnvironment = [];
  const setsVariables = [];
  const setsCollection = [];

  const statements = extracted.text
    .split(/[\n\r]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== '{' && l !== '}');

  for (const line of statements) {
    const bare = line.replace(/;+\s*$/, '');
    try {
      if (/^console\.(log|warn|error)\s*\(/.test(bare)) {
        continue;
      }

      const constDate = bare.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Date\s*\(\s*\)\s*$/);
      if (constDate) {
        ctx.dateVars.add(constDate[1]);
        ctx.known.add(constDate[1]);
        k6Lines.push(`  const ${constDate[1]} = new Date();`);
        continue;
      }

      const constDateClone = bare.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Date\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*$/);
      if (constDateClone) {
        if (!ctx.dateVars.has(constDateClone[2])) fail('date clone');
        ctx.dateVars.add(constDateClone[1]);
        ctx.known.add(constDateClone[1]);
        k6Lines.push(`  const ${constDateClone[1]} = new Date(${constDateClone[2]});`);
        continue;
      }

      const arrowYmd = bare.match(
        /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*\2\.toISOString\(\)\.split\((['"])T\3\)\[0\]\s*$/
      );
      if (arrowYmd) {
        ctx.fnVars.add(arrowYmd[1]);
        ctx.known.add(arrowYmd[1]);
        k6Lines.push(
          `  const ${arrowYmd[1]} = (${arrowYmd[2]}) => ${arrowYmd[2]}.toISOString().split('T')[0];`
        );
        continue;
      }

      const setDate = bare.match(
        /^([A-Za-z_$][\w$]*)\.setDate\s*\(\s*([A-Za-z_$][\w$]*)\.getDate\(\)\s*([+-])\s*(\d+)\s*\)\s*$/
      );
      if (setDate) {
        if (!ctx.dateVars.has(setDate[1]) || !ctx.dateVars.has(setDate[2])) fail('setDate');
        k6Lines.push(`  ${setDate[1]}.setDate(${setDate[2]}.getDate() ${setDate[3]} ${setDate[4]});`);
        continue;
      }

      const setMonth = bare.match(
        /^([A-Za-z_$][\w$]*)\.setMonth\s*\(\s*([A-Za-z_$][\w$]*)\.getMonth\(\)\s*([+-])\s*(\d+)\s*\)\s*$/
      );
      if (setMonth) {
        if (!ctx.dateVars.has(setMonth[1]) || !ctx.dateVars.has(setMonth[2])) fail('setMonth');
        k6Lines.push(`  ${setMonth[1]}.setMonth(${setMonth[2]}.getMonth() ${setMonth[3]} ${setMonth[4]});`);
        continue;
      }

      const assign = bare.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+)$/);
      if (assign) {
        const translated = translateExpression(assign[2], ctx);
        if (!translated.ok) fail(translated.reason || assign[2]);
        ctx.valueVars.add(assign[1]);
        ctx.known.add(assign[1]);
        if (/^new Date\(/.test(translated.code)) ctx.dateVars.add(assign[1]);
        k6Lines.push(`  const ${assign[1]} = ${translated.code};`);
        continue;
      }

      const pmSet = bare.match(
        /^pm\.(environment|collectionVariables|variables)\.set\(\s*(['"])([^'"]+)\2\s*,\s*([\s\S]*)\)$/
      );
      if (pmSet) {
        const scope = SCOPE_MAP[pmSet[1]];
        const varName = pmSet[3];
        const translated = translateExpression(pmSet[4], ctx);
        if (!translated.ok) fail(translated.reason || pmSet[4]);
        k6Lines.push(
          `  __pmSet(state, '${scope}', ${JSON.stringify(varName)}, ${translated.code});`
        );
        if (scope === 'environment') setsEnvironment.push(varName);
        else if (scope === 'variables') setsVariables.push(varName);
        else setsCollection.push(varName);
        ctx.valueVars.add(varName);
        ctx.known.add(varName);
        continue;
      }

      const pmUnset = bare.match(
        /^pm\.(environment|collectionVariables|variables)\.unset\(\s*(['"])([^'"]+)\2\s*\)$/
      );
      if (pmUnset) {
        const scope = SCOPE_MAP[pmUnset[1]];
        k6Lines.push(`  __pmUnset(state, '${scope}', ${JSON.stringify(pmUnset[3])});`);
        continue;
      }

      fail(bare);
    } catch (err) {
      unsupported.push(line);
    }
  }

  if (unsupported.length > 0) {
    return {
      translatable: false,
      k6Lines: [],
      unsupported,
      setsEnvironment: [],
      setsVariables: [],
      setsCollection: [],
      schedulesNextRequest: false,
      reason: 'Unsupported pre-request script statement(s)',
    };
  }

  k6Lines.push(...flowLines(extracted.flow));

  return {
    translatable: true,
    k6Lines,
    unsupported: [],
    setsEnvironment,
    setsVariables,
    setsCollection,
    schedulesNextRequest: extracted.flow.length > 0,
  };
}

function emitPrerequestBlock(emitIndex, analysis, requestLocalSeed) {
  if (!analysis || !analysis.translatable) return { block: '', required: false };
  const lines = [
    `    const __pmState_${emitIndex} = __getAuthState(data);`,
    `    __beginRequestScope(__pmState_${emitIndex}, ${emitIndex});`,
    `    __seedRequestLocals(__pmState_${emitIndex}, ${emitIndex}, ${JSON.stringify(requestLocalSeed || {})});`,
  ];
  if (analysis.k6Lines.length > 0) {
    lines.push(`    (function(state) {`);
    lines.push(`      if (!state.pm) state.pm = { environment: {}, collectionVariables: {}, variables: {} };`);
    lines.push(...analysis.k6Lines);
    lines.push(`    })(__pmState_${emitIndex});`);
  }
  return { block: lines.join('\n'), required: analysis.k6Lines.length > 0 || true };
}

const PREREQUEST_RUNTIME_JS = `
function __beginRequestScope(state, requestIndex) {
  if (!state.pm) state.pm = { environment: {}, collectionVariables: {}, variables: {} };
  state.pm.variables = {};
  state.__currentRequestIndex = requestIndex;
  if (!state.requestLocals) state.requestLocals = {};
  state.requestLocals[requestIndex] = {};
}

function __pmGet(state, scope, name) {
  if (!state || !state.pm || !scope || !name) return '';
  const bucket = state.pm[scope];
  if (!bucket || !Object.prototype.hasOwnProperty.call(bucket, name)) return '';
  const value = bucket[name];
  if (value == null) return '';
  return value;
}

function __pmSet(state, scope, name, value) {
  if (!state.pm) state.pm = { environment: {}, collectionVariables: {}, variables: {} };
  if (!state.pm[scope]) state.pm[scope] = {};
  state.pm[scope][name] = value;
  const stored = value == null ? '' : String(value);
  if (scope === 'environment' || scope === 'collectionVariables') {
    if (!state.vars) state.vars = {};
    state.vars[name] = stored;
  }
  if (scope === 'variables') {
    const requestIndex = state.__currentRequestIndex == null ? -1 : state.__currentRequestIndex;
    const bucket = __ensureRequestLocals(state, requestIndex);
    bucket[name] = stored;
  }
}

function __pmUnset(state, scope, name) {
  if (state.pm && state.pm[scope]) delete state.pm[scope][name];
  if (scope === 'variables') {
    const bucket = state.requestLocals && state.requestLocals[state.__currentRequestIndex];
    if (bucket) delete bucket[name];
    return;
  }
  if (state.vars) delete state.vars[name];
}

function __scheduleNextRequest(state, targetName) {
  if (targetName == null) state.__scheduledNext = { stop: true };
  else state.__scheduledNext = { name: String(targetName) };
}
`.trim();

module.exports = {
  analyzePrerequestScript,
  emitPrerequestBlock,
  PREREQUEST_RUNTIME_JS,
  PM_SET_RE,
  translateExpression,
};
