import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { config } from '../config.js';
import HealthBadge from '../components/HealthBadge.jsx';
import { useAuth } from '../auth/AuthContext.jsx';

/* ---------- Inline SVG icons (no extra deps) ---------- */
function Icon({ name, className = 'h-[18px] w-[18px]' }) {
  const common = {
    xmlns: 'http://www.w3.org/2000/svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
  };
  switch (name) {
    case 'dashboard':
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </svg>
      );
    case 'collections':
      return (
        <svg {...common}>
          <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
        </svg>
      );
    case 'runs':
      return (
        <svg {...common}>
          <polygon points="6 4 20 12 6 20 6 4" />
        </svg>
      );
    case 'reports':
      return (
        <svg {...common}>
          <path d="M4 19V5" />
          <path d="M4 19h16" />
          <rect x="7" y="11" width="3" height="6" rx="0.5" />
          <rect x="12" y="7" width="3" height="10" rx="0.5" />
          <rect x="17" y="13" width="3" height="4" rx="0.5" />
        </svg>
      );
    case 'logout':
      return (
        <svg {...common}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
      );
    default:
      return null;
  }
}

const navItems = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', end: true },
  { to: '/collections', label: 'Collections', icon: 'collections' },
  { to: '/runs', label: 'Runs', icon: 'runs' },
  { to: '/reports', label: 'Reports', icon: 'reports' },
];

const PAGE_TITLES = {
  '/': { title: 'Dashboard', subtitle: 'Overview of collections, runs and recent activity.' },
  '/collections': {
    title: 'Collections',
    subtitle: 'Your primary workspace. Upload, generate, run and inspect.',
  },
  '/runs': { title: 'Runs', subtitle: 'Live and historical K6 executions.' },
  '/reports': {
    title: 'Reports',
    subtitle: 'Performance analytics across every executed run.',
  },
};

function findHeader(pathname) {
  if (pathname === '/' || pathname === '') return PAGE_TITLES['/'];
  // Best longest-prefix match.
  const keys = Object.keys(PAGE_TITLES)
    .filter((k) => k !== '/')
    .sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (pathname.startsWith(k)) return PAGE_TITLES[k];
  }
  return { title: 'Performance Agent', subtitle: '' };
}

/**
 * Premium dark enterprise layout (260px sidebar + flex main with min-w-0).
 * The body has overflow-x: hidden as a hard backstop.
 */
export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const header = findHeader(location.pathname);

  const onLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="flex min-h-screen w-full overflow-x-hidden">
      <aside className="sidebar-shell hidden md:flex md:w-[260px] md:shrink-0 md:flex-col px-5 py-6">
        {/* Brand */}
        <div className="mb-9 flex items-center gap-3">
          <div className="relative flex h-10 w-10 items-center justify-center rounded-xl text-white shadow-glow-soft accent-bg">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="h-[18px] w-[18px]"
            >
              <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="font-display truncate text-[15px] font-semibold tracking-tight text-slate-100">
              {config.appName}
            </div>
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted">
              Performance Suite
            </div>
          </div>
        </div>

        {/* Nav */}
        <div className="mb-2 px-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">
          Workspace
        </div>
        <nav className="flex flex-col gap-1.5">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                ['sidebar-link', isActive ? 'sidebar-link-active' : ''].join(' ')
              }
            >
              {({ isActive }) => (
                <>
                  <Icon
                    name={item.icon}
                    className={`h-[18px] w-[18px] ${isActive ? '' : 'opacity-80'}`}
                  />
                  <span>{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>

        {/* Bottom: user + health */}
        <div className="mt-auto pt-7 space-y-3">
          <div className="card p-3.5 !rounded-2xl">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold uppercase text-white accent-bg shadow-glow-soft">
                {(user?.username || '?').slice(0, 1)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-slate-100">
                  {user?.username || '—'}
                </div>
                <div className="text-[10px] uppercase tracking-[0.14em] text-muted">
                  {user?.role || ''}
                </div>
              </div>
              <button
                type="button"
                onClick={onLogout}
                className="rounded-lg p-1.5 text-soft transition-colors hover:bg-slate-800 hover:text-slate-100"
                title="Sign out"
              >
                <Icon name="logout" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between px-1 text-[11px] text-muted">
            <HealthBadge />
            <span>v0.1.0</span>
          </div>
        </div>
      </aside>

      <main className="flex min-h-screen flex-1 flex-col min-w-0 overflow-x-hidden">
        <header className="topbar px-5 py-4 md:px-10 md:py-6">
          {/* Mobile nav (visible only on small screens) */}
          <div className="md:hidden mb-3 flex flex-wrap items-center gap-1.5">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  [
                    'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'text-brand-600 border border-brand-500/40 bg-brand-50'
                      : 'text-soft hover:bg-slate-800 hover:text-slate-100',
                  ].join(' ')
                }
              >
                <Icon name={item.icon} className="h-3.5 w-3.5" />
                {item.label}
              </NavLink>
            ))}
            <button
              type="button"
              onClick={onLogout}
              className="ml-auto rounded-full px-3 py-1.5 text-xs text-soft hover:bg-slate-800 hover:text-slate-100"
            >
              Sign out
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-display text-[22px] font-semibold tracking-tight text-slate-100">
                {header.title}
              </h1>
              {header.subtitle && (
                <p className="mt-1 text-sm text-soft">{header.subtitle}</p>
              )}
            </div>
            <div className="hidden md:flex items-center gap-2 text-xs">
              <span className="chip">
                <span className="status-dot bg-emerald-500" />
                {user?.username}
              </span>
              <span className="chip uppercase tracking-[0.12em]">{user?.role}</span>
            </div>
          </div>
          <div className="accent-divider mt-5" />
        </header>

        <div className="page-container flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
