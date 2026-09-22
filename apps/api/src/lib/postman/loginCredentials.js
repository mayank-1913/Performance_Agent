'use strict';

const VAR_RE = /\{\{\s*([^}]+?)\s*\}\}/;

function toEnvName(name) {
  return String(name || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

function credentialEnvName(key) {
  const normalized = toEnvName(key);
  if (/^(USERNAME|USER|LOGIN|LOGIN_NAME)$/.test(normalized)) return 'LOGIN_USERNAME';
  if (/^(EMAIL|EMAIL_ADDRESS)$/.test(normalized)) return 'LOGIN_EMAIL';
  if (/^(PASSWORD|PASS|PASSWD|PWD)$/.test(normalized)) return 'LOGIN_PASSWORD';
  if (/SECRET|CREDENTIAL/.test(normalized)) return `LOGIN_${normalized}`;
  return null;
}

function isPlaceholder(value) {
  return typeof value === 'string' && VAR_RE.test(value);
}

function rawCredentialEntries(body) {
  if (!body || typeof body !== 'object') return [];
  if (body.mode === 'raw') {
    try {
      const value = JSON.parse(String(body.raw || ''));
      const out = [];
      const walk = (node, path = []) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) return node.forEach((item, index) => walk(item, [...path, index]));
        for (const [key, value] of Object.entries(node)) {
          const envName = credentialEnvName(key);
          if (envName && (typeof value === 'string' || typeof value === 'number')) {
            out.push({ key, envName, value: String(value), path });
          }
          if (value && typeof value === 'object') walk(value, [...path, key]);
        }
      };
      walk(value);
      return out;
    } catch {
      return [];
    }
  }
  if (body.mode === 'urlencoded' || body.mode === 'formdata') {
    return (body.params || [])
      .map((param) => {
        const envName = credentialEnvName(param?.key);
        return envName && param?.value != null
          ? { key: String(param.key), envName, value: String(param.value), path: [] }
          : null;
      })
      .filter(Boolean);
  }
  return [];
}

function extractLoginCredentialBindings(request) {
  return rawCredentialEntries(request?.body);
}

function credentialSourceNames(request) {
  const names = new Set();
  for (const binding of rawCredentialEntries(request?.body)) {
    names.add(binding.key);
    const match = typeof binding.value === 'string' && binding.value.match(VAR_RE);
    if (match) names.add(match[1].trim());
  }
  return Array.from(names);
}

function redactLoginCredentials(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return raw;
  try {
    const value = JSON.parse(raw);
    const visit = (node) => {
      if (!node || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map(visit);
      const out = {};
      for (const [key, item] of Object.entries(node)) {
        const envName = credentialEnvName(key);
        out[key] = envName && (typeof item === 'string' || typeof item === 'number') && !isPlaceholder(item)
          ? `{{${envName}}}`
          : visit(item);
      }
      return out;
    };
    return JSON.stringify(visit(value));
  } catch {
    return raw;
  }
}

module.exports = {
  credentialEnvName,
  credentialSourceNames,
  extractLoginCredentialBindings,
  redactLoginCredentials,
  toEnvName,
};
