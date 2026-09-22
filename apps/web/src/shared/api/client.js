import { config } from '../config.js';
import { getStoredToken, clearStoredAuth } from '../auth/AuthContext.jsx';

/**
 * Thin fetch wrapper. Returns the parsed `data` field on success and throws
 * an Error with a descriptive message on failure. Auto-attaches the JWT bearer
 * token from local storage and force-logs the user out on 401 responses.
 */
async function request(path, { method = 'GET', body, headers, signal } = {}) {
  const url = `${config.apiBaseUrl}${path}`;
  const token = getStoredToken();

  const opts = {
    method,
    signal,
    headers: {
      Accept: 'application/json',
      ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  };

  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new Error(`Network error: ${err.message}`);
  }

  let payload = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    payload = await res.json().catch(() => null);
  }

  if (!res.ok) {
    if (res.status === 401) {
      // Token missing/expired/invalid -> force a fresh login.
      clearStoredAuth();
      // Avoid hard reload loops on the login page itself.
      if (typeof window !== 'undefined' && !/\/login$/.test(window.location.pathname)) {
        const dest = `/login?next=${encodeURIComponent(window.location.pathname)}`;
        window.location.replace(dest);
      }
    }
    const message = payload?.error?.message || `Request failed with status ${res.status}`;
    const error = new Error(message);
    error.status = res.status;
    error.code = payload?.error?.code;
    error.details = payload?.error?.details;
    throw error;
  }

  return payload?.data ?? payload;
}

/**
 * Append `?token=...` to URLs used by EventSource and <a href="..."> downloads,
 * which can't send custom headers from the browser.
 */
function withToken(url) {
  const token = getStoredToken();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}token=${encodeURIComponent(token)}`;
}

export const apiClient = {
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  delete: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  withToken,
};
