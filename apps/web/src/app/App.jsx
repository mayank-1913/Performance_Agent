import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '../shared/auth/AuthContext.jsx';
import ProtectedRoute from '../shared/auth/ProtectedRoute.jsx';
import DashboardLayout from '../shared/layouts/DashboardLayout.jsx';
import { PageLoader } from '../shared/components/Loading.jsx';

/* ----------------------------------------------------------------------------
   Code splitting strategy
   ----------------------------------------------------------------------------
   - The shell (auth context, protected route, dashboard layout, login form)
     stays in the initial bundle so the first paint is fast.
   - Every feature route is lazy-loaded so the dashboard never pulls in
     reports, run detail, generate, or charts on first paint.
   - Recharts (heavy) is only imported by RunReport which is itself lazy
     and only used inside the run/report detail pages.
   --------------------------------------------------------------------------*/

const LoginPage = lazy(() => import('../features/auth/LoginPage.jsx'));
const DashboardPage = lazy(() =>
  import('../features/dashboard/DashboardPage.jsx')
);
const CollectionsPage = lazy(() =>
  import('../features/collections/CollectionsPage.jsx')
);
const GenerateScriptPage = lazy(() =>
  import('../features/scripts/GenerateScriptPage.jsx')
);
const RunsPage = lazy(() => import('../features/runs/RunsPage.jsx'));
const RunDetailPage = lazy(() => import('../features/runs/RunDetailPage.jsx'));
const ReportsPage = lazy(() => import('../features/reports/ReportsPage.jsx'));
const ReportDetailPage = lazy(() =>
  import('../features/reports/ReportDetailPage.jsx')
);
const NotFoundPage = lazy(() => import('../shared/pages/NotFoundPage.jsx'));

export default function App() {
  return (
    <AuthProvider>
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardPage />} />
            <Route path="/dashboard" element={<Navigate to="/" replace />} />
            <Route path="/collections" element={<CollectionsPage />} />
            <Route
              path="/collections/:collectionId/generate"
              element={<GenerateScriptPage />}
            />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/runs/:runId" element={<RunDetailPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/reports/:id" element={<ReportDetailPage />} />

            {/* Legacy routes — Upload and Environments are no longer top-level
                destinations. Upload now lives inside the Collections page modal,
                and environments are uploaded contextually inside the Generate
                flow. We redirect so old links still work. */}
            <Route
              path="/upload"
              element={<Navigate to="/collections" replace />}
            />
            <Route
              path="/environments"
              element={<Navigate to="/collections" replace />}
            />

            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </AuthProvider>
  );
}
