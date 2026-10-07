import { createBrowserRouter, createRoutesFromElements, RouterProvider, Route, Navigate } from 'react-router-dom';
import AdminLayout from '../layouts/AdminLayout';
import AuthLayout from '../layouts/AuthLayout';
import RequireAuth from './RequireAuth';
import DashboardPage from '../pages/DashboardPage';
import LoginPage from '../features/auth/pages/LoginPage';
import ProfilePage from '../features/profile/pages/ProfilePage';
import UserListPage from '../features/user/pages/UserListPage';
import RoleListPage from '../features/user/pages/RoleListPage';
import { PERMISSIONS } from '../features/auth/permissions';
import TimetableRoutes from '../features/timetable/TimetableRoutes';

const router = createBrowserRouter(createRoutesFromElements(<>
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<LoginPage />} />
      </Route>

      <Route element={<RequireAuth><AdminLayout /></RequireAuth>}>
        <Route index element={<DashboardPage />} />
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
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </>));
export default function AppRouter() { return <RouterProvider router={router} />; }
