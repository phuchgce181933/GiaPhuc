import { Navigate, useLocation } from 'react-router-dom';
import { useAuth, usePermission } from '../features/auth/hooks';

/**
 * Guard a route behind authentication and (optionally) required permissions.
 * usePermission() is consulted only when `require` is provided.
 */
export default function RequireAuth({ children, require }) {
  const { user, bootstrapped } = useAuth();
  const perm = usePermission();
  const location = useLocation();

  if (!bootstrapped) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }} className="gp-muted">
        Loading…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (require && !perm.hasAll(require)) {
    return (
      <div style={{ padding: 32 }}>
        <h2 style={{ marginTop: 0 }}>Forbidden</h2>
        <p className="gp-muted">You don't have permission to view this page.</p>
      </div>
    );
  }

  return children;
}