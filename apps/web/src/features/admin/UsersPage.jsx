import { useEffect, useState } from 'react';
import { usersApi } from '../../shared/api/users.api.js';
import { useAuth } from '../../shared/auth/AuthContext.jsx';

/**
 * Admin-only user management. Normal users should never reach this page —
 * the route is gated client-side AND the backend endpoints behind it are
 * all protected by `requireRole('admin')`.
 */
export default function UsersPage() {
  const { user: me } = useAuth();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [draft, setDraft] = useState({ username: '', password: '', role: 'user' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [pwDraftFor, setPwDraftFor] = useState(null);
  const [pwValue, setPwValue] = useState('');
  const [pwBusy, setPwBusy] = useState(false);

  const refresh = async () => {
    setLoading(true);
    try {
      setItems(await usersApi.list());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    if (!draft.username || !draft.password) return;
    setCreating(true);
    setCreateError(null);
    try {
      await usersApi.create(draft);
      setDraft({ username: '', password: '', role: 'user' });
      await refresh();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const onDelete = async (u) => {
    if (!window.confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      await usersApi.remove(u.id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  const onResetPassword = async (u) => {
    if (!pwValue) return;
    setPwBusy(true);
    try {
      await usersApi.update(u.id, { password: pwValue });
      setPwDraftFor(null);
      setPwValue('');
    } catch (err) {
      setError(err.message);
    } finally {
      setPwBusy(false);
    }
  };

  const onToggleRole = async (u) => {
    const nextRole = u.role === 'admin' ? 'user' : 'admin';
    if (!window.confirm(`Change ${u.username}'s role to ${nextRole}?`)) return;
    try {
      await usersApi.update(u.id, { role: nextRole });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="page-stack">
      <div className="page-hero">
        <div className="min-w-0">
          <h2 className="page-hero-title">Users</h2>
          <p className="page-hero-subtitle">
            Admin-only. Create normal users and manage access.
          </p>
        </div>
      </div>

      <form className="card" onSubmit={onCreate}>
        <h3 className="text-sm font-semibold text-slate-200">Create user</h3>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[12rem] flex-1">
            <label className="label">Username</label>
            <input
              className="input"
              value={draft.username}
              onChange={(e) => setDraft((d) => ({ ...d, username: e.target.value }))}
              required
              autoComplete="off"
            />
          </div>
          <div className="min-w-[12rem] flex-1">
            <label className="label">Password</label>
            <input
              type="password"
              className="input"
              value={draft.password}
              onChange={(e) => setDraft((d) => ({ ...d, password: e.target.value }))}
              required
              autoComplete="new-password"
            />
          </div>
          <div>
            <label className="label">Role</label>
            <select
              className="input w-32"
              value={draft.role}
              onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
            >
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <button className="btn-primary" type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create user'}
          </button>
        </div>
        {createError && <div className="mt-3 alert-error">{createError}</div>}
      </form>

      {error && <div className="alert-error">{error}</div>}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="px-3 py-2">Username</th>
              <th className="px-3 py-2">Role</th>
              <th className="px-3 py-2">Created</th>
              <th className="px-3 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {loading && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500">
                  Loading…
                </td>
              </tr>
            )}
            {!loading &&
              items.map((u) => {
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id} className="hover-row">
                    <td className="px-3 py-2 font-medium text-slate-100">{u.username}</td>
                    <td className="px-3 py-2">
                      <span className="chip uppercase tracking-[0.12em]">{u.role}</span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400">
                      {u.createdAt ? new Date(u.createdAt).toLocaleString() : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="inline-flex flex-wrap gap-1 justify-end">
                        {pwDraftFor === u.id ? (
                          <>
                            <input
                              type="password"
                              placeholder="new password"
                              className="input !py-1 !px-2 text-xs w-40"
                              value={pwValue}
                              onChange={(e) => setPwValue(e.target.value)}
                            />
                            <button
                              className="pill-primary"
                              onClick={() => onResetPassword(u)}
                              disabled={pwBusy || !pwValue}
                            >
                              Save
                            </button>
                            <button
                              className="pill-neutral"
                              onClick={() => {
                                setPwDraftFor(null);
                                setPwValue('');
                              }}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="pill-neutral"
                            onClick={() => {
                              setPwDraftFor(u.id);
                              setPwValue('');
                            }}
                          >
                            Reset password
                          </button>
                        )}
                        {!isSelf && (
                          <>
                            <button className="pill-neutral" onClick={() => onToggleRole(u)}>
                              Make {u.role === 'admin' ? 'user' : 'admin'}
                            </button>
                            <button className="pill-danger" onClick={() => onDelete(u)}>
                              Delete
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
