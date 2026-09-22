'use strict';

/**
 * Centralized auth sanitizer.
 *
 * Purpose:
 *   Postman collections frequently bake raw Bearer JWTs (or other long opaque
 *   tokens) directly into Authorization headers. Those literals must NEVER
 *   reach the generated K6 script, the request preview, the run logs, or any
 *   API response body. This module is the single chokepoint that strips them
 *   out and replaces them with a Postman-style placeholder so the existing
 *   downstream interpolator turns them into `${__ENV.AUTH_TOKEN}`.
 *
 * Detection:
 *   - "Bearer eyJ..."          -> three-segment JWT
 *   - "Bearer <opaque>"        -> any Bearer with a long opaque token
 *   - "Authorization: Bearer ..." raw lines
 *   - X-API-Key / api-key style headers with long opaque values
 *
 * Replacement:
 *   - Authorization values become "Bearer {{AUTH_TOKEN}}"
 *   - X-API-Key style values become "{{API_KEY}}"
 *   - The corresponding env vars are recorded in `injectedTokens`.
 */

const JWT_RE = /eyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}/g;
const BEARER_RE = /^\s*Bearer\s+(\S.*)$/i;
const PLACEHOLDER_RE = /^\s*\{\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}\}\s*$/;
const API_KEY_HEADER_RE = /^(x-api-key|api-key|apikey|x-auth-token)$/i;

/**
 * Decide whether a Bearer header value still contains a literal secret.
 * `Bearer {{token}}` -> safe, leave alone.
 * `Bearer eyJ...`    -> NOT safe, must be sanitized.
 */
function bearerContainsLiteral(value) {
  if (typeof value !== 'string') return false;
  const m = value.match(BEARER_RE);
  if (!m) return false;
  const inner = m[1].trim();
  if (PLACEHOLDER_RE.test(inner)) return false;
  // Anything that looks like a JWT or just a long opaque chunk is a literal.
  if (JWT_RE.test(inner)) return true;
  // strip placeholders out of mixed values to test the remainder
  const stripped = inner.replace(/\{\{[^}]+\}\}/g, '').trim();
  return stripped.length >= 8;
}

function apiKeyContainsLiteral(value) {
  if (typeof value !== 'string') return false;
  const stripped = value.replace(/\{\{[^}]+\}\}/g, '').trim();
  return stripped.length >= 8;
}

/**
 * Sanitize one normalized header. Returns { header, replacedWith } where
 * `replacedWith` is the env var name that now needs to be supplied at runtime
 * (or null if no replacement happened).
 */
function sanitizeHeader(header) {
  if (!header || typeof header.key !== 'string') {
    return { header, replacedWith: null };
  }
  const k = header.key.toLowerCase();
  const value = header.value == null ? '' : String(header.value);

  if (k === 'authorization') {
    if (bearerContainsLiteral(value)) {
      return {
        header: { ...header, value: 'Bearer {{AUTH_TOKEN}}' },
        replacedWith: 'AUTH_TOKEN',
      };
    }
    // Non-bearer Authorization with a long literal (Basic, Digest, ...) -> still strip.
    if (!PLACEHOLDER_RE.test(value) && !/^\s*Bearer\s+\{\{/i.test(value)) {
      const stripped = value.replace(/\{\{[^}]+\}\}/g, '').trim();
      if (stripped.length >= 16) {
        return {
          header: { ...header, value: '{{AUTH_TOKEN}}' },
          replacedWith: 'AUTH_TOKEN',
        };
      }
    }
    return { header, replacedWith: null };
  }

  if (API_KEY_HEADER_RE.test(header.key)) {
    if (apiKeyContainsLiteral(value)) {
      return {
        header: { ...header, value: '{{API_KEY}}' },
        replacedWith: 'API_KEY',
      };
    }
  }

  return { header, replacedWith: null };
}

function sanitizeAuthBlock(auth) {
  if (!auth || typeof auth !== 'object') return { auth, replacedWith: null };
  const type = auth.type;
  // bearer { token: '...' }
  if (type === 'bearer') {
    const node = Array.isArray(auth.bearer)
      ? auth.bearer.find((x) => x && (x.key === 'token' || x.key === 'Token'))
      : auth.bearer;
    const token = node?.value ?? auth.bearer?.token ?? '';
    if (typeof token === 'string' && token.length > 0 && !PLACEHOLDER_RE.test(token)) {
      return {
        auth: { ...auth, bearer: [{ key: 'token', value: '{{AUTH_TOKEN}}', type: 'string' }] },
        replacedWith: 'AUTH_TOKEN',
      };
    }
  }
  // apikey { key, value, in }
  if (type === 'apikey') {
    const node = Array.isArray(auth.apikey)
      ? auth.apikey.find((x) => x && (x.key === 'value' || x.key === 'Value'))
      : null;
    const value = node?.value ?? auth.apikey?.value ?? '';
    if (typeof value === 'string' && value.length > 0 && !PLACEHOLDER_RE.test(value)) {
      return {
        auth: {
          ...auth,
          apikey: [
            ...(Array.isArray(auth.apikey) ? auth.apikey.filter((x) => x.key !== 'value') : []),
            { key: 'value', value: '{{API_KEY}}', type: 'string' },
          ],
        },
        replacedWith: 'API_KEY',
      };
    }
  }
  return { auth, replacedWith: null };
}

/**
 * Sanitize a parsed Postman collection (post-`parse()` shape).
 *
 * @param {{ requests: Array, collectionAuth?: object|null, referencedVars?: string[] }} parsed
 * @returns {{
 *   parsed: object,
 *   sanitized: boolean,
 *   injectedTokens: string[],
 *   findings: Array<{ requestName: string, header: string, action: string }>,
 * }}
 */
function sanitizeParsedCollection(parsed) {
  if (!parsed || !Array.isArray(parsed.requests)) {
    return { parsed, sanitized: false, injectedTokens: [], findings: [] };
  }

  const injected = new Set();
  const findings = [];
  const newRequests = parsed.requests.map((req) => {
    const newHeaders = (req.headers || []).map((h) => {
      const { header, replacedWith } = sanitizeHeader(h);
      if (replacedWith) {
        injected.add(replacedWith);
        findings.push({
          requestName: req.name || '',
          header: h.key,
          action: `replaced literal with {{${replacedWith}}}`,
        });
      }
      return header;
    });
    let newAuth = req.auth || null;
    if (newAuth) {
      const { auth, replacedWith } = sanitizeAuthBlock(newAuth);
      newAuth = auth;
      if (replacedWith) {
        injected.add(replacedWith);
        findings.push({
          requestName: req.name || '',
          header: `auth.${newAuth?.type || 'block'}`,
          action: `replaced literal with {{${replacedWith}}}`,
        });
      }
    }
    return { ...req, headers: newHeaders, auth: newAuth };
  });

  let newCollectionAuth = parsed.collectionAuth || null;
  if (newCollectionAuth) {
    const { auth, replacedWith } = sanitizeAuthBlock(newCollectionAuth);
    newCollectionAuth = auth;
    if (replacedWith) {
      injected.add(replacedWith);
      findings.push({
        requestName: '<collection>',
        header: `auth.${newCollectionAuth?.type || 'block'}`,
        action: `replaced literal with {{${replacedWith}}}`,
      });
    }
  }

  // Make sure newly injected vars show up in referencedVars so the generator
  // emits ${__ENV.AUTH_TOKEN} / ${__ENV.API_KEY} references and the runner
  // expects them.
  const referencedVars = new Set(parsed.referencedVars || []);
  for (const k of injected) referencedVars.add(k);

  return {
    parsed: {
      ...parsed,
      requests: newRequests,
      collectionAuth: newCollectionAuth,
      referencedVars: Array.from(referencedVars),
    },
    sanitized: injected.size > 0,
    injectedTokens: Array.from(injected),
    findings,
  };
}

/**
 * Hard assertion used right before persisting a generated script. Throws if a
 * raw JWT or a long opaque Bearer literal somehow survived sanitization.
 */
function assertNoSecretsInScript(code) {
  if (typeof code !== 'string') return;
  if (JWT_RE.test(code)) {
    throw new Error('Generated script contains a literal JWT. Sanitization failed.');
  }
  // Bearer literal that is NOT a template placeholder.
  const literalBearer = /Bearer\s+(?!\$\{__ENV\.)[A-Za-z0-9._\-+/=]{8,}/g;
  const m = code.match(literalBearer);
  if (m && m.length > 0) {
    throw new Error(
      `Generated script contains a literal Bearer token (${m.length} occurrence${
        m.length === 1 ? '' : 's'
      }). Sanitization failed.`
    );
  }
}

/**
 * Mask a secret value for logs / preview.
 */
function maskSecretValue(value) {
  if (!value) return '';
  const s = String(value);
  if (s.length <= 8) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

module.exports = {
  sanitizeParsedCollection,
  sanitizeHeader,
  sanitizeAuthBlock,
  assertNoSecretsInScript,
  bearerContainsLiteral,
  maskSecretValue,
  JWT_RE,
};
