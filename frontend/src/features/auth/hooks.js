import { useAuthStore, selectPermissions } from './store';
import { hasAll, hasAny } from './permissions';

export function useAuth() {
  const user = useAuthStore((s) => s.user);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const bootstrapped = useAuthStore((s) => s.bootstrapped);
  return { user, login, logout, bootstrap, bootstrapped };
}

export function usePermission() {
  const granted = useAuthStore(selectPermissions);
  return {
    granted,
    hasAll: (req) => hasAll(granted, req),
    hasAny: (req) => hasAny(granted, req),
  };
}