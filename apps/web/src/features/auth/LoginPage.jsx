import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../shared/auth/AuthContext.jsx';
import { config } from '../../shared/config.js';

export default function LoginPage() {
  const { login, isAuthenticated, bootstrapped } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // If already logged in, bounce to the saved path or root.
  if (bootstrapped && isAuthenticated) {
    const dest = location.state?.from?.pathname || '/';
    setTimeout(() => navigate(dest, { replace: true }), 0);
    return null;
  }

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
      const dest = location.state?.from?.pathname || '/';
      navigate(dest, { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden p-4">
      {/* Soft ambient glow blobs to add depth behind the login panel. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-24 -left-24 h-[420px] w-[420px] rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(230,117,66,0.45), transparent 60%)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-32 -right-24 h-[480px] w-[480px] rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(0,116,253,0.45), transparent 60%)' }}
      />

      <div className="relative w-full max-w-md">
        <div className="card !p-8">
          {/* Brand mark */}
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl text-white shadow-glow-soft accent-bg">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="font-display text-lg font-semibold tracking-tight text-slate-100">
                {config.appName}
              </h1>
              <p className="text-[11px] uppercase tracking-[0.16em] text-muted">
                Performance Suite
              </p>
            </div>
          </div>

          <h2 className="mt-7 font-display text-[22px] font-semibold tracking-tight text-slate-100">
            Welcome back
          </h2>
          <p className="mt-1 text-sm text-soft">
            Sign in to access performance runs and reports.
          </p>

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            <div>
              <label className="label" htmlFor="username">
                Username
              </label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="label" htmlFor="password">
                Password
              </label>
              <div className="flex gap-2">
                <input
                  id="password"
                  type={showPwd ? 'text' : 'password'}
                  className="input font-mono"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <button
                  type="button"
                  className="btn-secondary whitespace-nowrap"
                  onClick={() => setShowPwd((v) => !v)}
                >
                  {showPwd ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-200 force-wrap">
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary w-full !py-2.5"
              disabled={submitting || !username || !password}
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>

          <p className="mt-5 text-[11px] text-muted">
            Default admin credentials are configured via <code>ADMIN_USERNAME</code> and{' '}
            <code>ADMIN_PASSWORD</code> in the API <code>.env</code>. Change them and restart
            the API on first run.
          </p>
        </div>

        <div className="mt-4 text-center text-[11px] text-muted">
          Premium performance analytics for modern engineering teams.
        </div>
      </div>
    </div>
  );
}
