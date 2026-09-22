import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { config } from '../config.js';

const STORAGE_KEY = 'perf-agent-auth';
const AuthCtx = createContext(null);

function readStored() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(value) {
  if (!value) {
    localStorage.removeItem(STORAGE_KEY);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
}

export function AuthProvider({ children }) {
  const [auth, setAuth] = useState(() => readStored());
  const [bootstrapped, setBootstrapped] = useState(false);

  // Validate the stored token against /auth/me on mount.
  useEffect(() => {
    let mounted = true;
    (async () => {
      const stored = readStored();
      if (!stored?.token) {
        if (mounted) setBootstrapped(true);
        return;
      }
      try {
        const res = await fetch(`${config.apiBaseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${stored.token}` },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = await res.json().catch(() => null);
        if (mounted) {
          setAuth({ token: stored.token, user: json?.data?.user || stored.user });
        }
      } catch {
        // Bad/expired token; force logout.
        if (mounted) {
          writeStored(null);
          setAuth(null);
        }
      } finally {
        if (mounted) setBootstrapped(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(async (username, password) => {
    const res = await fetch(`${config.apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(json?.error?.message || `Login failed (${res.status})`);
    }
    const data = json?.data;
    if (!data?.token) throw new Error('Login response missing token');
    const next = { token: data.token, user: data.user };
    writeStored(next);
    setAuth(next);
    return next;
  }, []);

  const logout = useCallback(() => {
    writeStored(null);
    setAuth(null);
  }, []);

  const value = useMemo(
    () => ({
      token: auth?.token || null,
      user: auth?.user || null,
      isAuthenticated: !!auth?.token,
      bootstrapped,
      login,
      logout,
    }),
    [auth, bootstrapped, login, logout]
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/**
 * Helpers for code that lives outside the React tree (e.g. the api client).
 */
export function getStoredToken() {
  return readStored()?.token || null;
}
export function clearStoredAuth() {
  writeStored(null);
}
