import PresentationsPage from '../features/presentation/pages/PresentationsPage';
import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import AdminLayout from '../layouts/AdminLayout';
import AuthLayout from '../layouts/AuthLayout';
import RequireAuth from './RequireAuth';
import DashboardPage from '../pages/DashboardPage';
import LoginPage from '../features/auth/pages/LoginPage';
import ProfilePage from '../features/profile/pages/ProfilePage';
import UserListPage from '../features/user/pages/UserListPage';
import RoleListPage from '../features/user/pages/RoleListPage';
import LandingPage from '../LandingPage';
import { PERMISSIONS } from '../features/auth/permissions';
import TimetableRoutes from '../features/timetable/TimetableRoutes';
const ProgressTestRoutes = lazy(() => import('../features/progress-test/ProgressTestRoutes'));
const StudentPage = lazy(() => import('../features/progress-test/pages/StudentPage'));

const router = createBrowserRouter(createRoutesFromElements(<>
      <Route path="/tests" element={<StudentPage />} />
      <Route path="/tests/:slug" element={<StudentPage />} />
      <Route path="/" element={<LandingPage />} />
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>

      <Route element={<RequireAuth><AdminLayout /></RequireAuth>}>
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="users" element={
          <RequireAuth require={[PERMISSIONS.USER_VIEW]}>
            <UserListPage />
          </RequireAuth>
        } />
        <Route path="roles" element={
          <RequireAuth require={[PERMISSIONS.ROLE_VIEW]}>
            <RoleListPage />
          </RequireAuth>
        } />
        <Route path="timetable/*" element={<RequireAuth require={[PERMISSIONS.TKB_VIEW]}><TimetableRoutes /></RequireAuth>} />
        <Route path="progress-test/*" element={<RequireAuth require={[PERMISSIONS.PROGRESS_VIEW]}><ProgressTestRoutes /></RequireAuth>} />
        <Route path="presentations" element={<RequireAuth require={[PERMISSIONS.PRESENTATION_VIEW]}><PresentationsPage /></RequireAuth>} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </>));
export default function AppRouter() { return <Suspense fallback={<p role="status">Đang tải trang…</p>}><RouterProvider router={router} /></Suspense>; }
