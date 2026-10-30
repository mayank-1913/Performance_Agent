import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext.jsx';

export default function ProtectedRoute({ children, requireRole }) {
  const { isAuthenticated, bootstrapped, user } = useAuth();
  const location = useLocation();
  if (!bootstrapped) {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-slate-500">
        Loading…
      </div>
    );
  }
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  // Role gate: admin passes any requirement; everyone else must match exactly.
  if (requireRole && user?.role !== requireRole && user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }
  return children;
}
