/**
 * Single source for all Vite env access. Mirrors backend permission strings and constants.
 * Outside this module, do NOT read import.meta.env directly.
 */

const REQUIRED = (name) => {
  const v = import.meta.env[name];
  if (v === undefined || v === '') {
    // During dev we surface a friendly default rather than a hard crash.
    console.warn(`[env] missing required env var: ${name}`);
    return null;
  }
  return v;
};

export const env = {
  API_BASE_URL: REQUIRED('VITE_API_BASE_URL') || 'http://localhost:5000/api',
  APP_NAME: REQUIRED('VITE_APP_NAME') || 'Gia Phuc',
  IS_DEV: import.meta.env.DEV,
};

// Mirror of backend/src/shared/permissions.js — keep in sync.
export const PERMISSIONS = Object.freeze({
  USER_VIEW: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_CHANGE_ROLE: 'user:change-role',
  USER_CHANGE_STATUS: 'user:change-status',
  SELF_PROFILE_VIEW: 'profile:read:self',
  SELF_PROFILE_UPDATE: 'profile:update:self',
  PROFILE_VIEW_ANY: 'profile:read:any',
  PROFILE_UPDATE_ANY: 'profile:update:any',
  ROLE_VIEW: 'role:read',
  ROLE_MANAGE: 'role:manage',
  AUTH_LOGIN: 'auth:login',
});

export const PERMISSION_GROUPS = Object.freeze([
  {
    key: 'user',
    label: 'User Management',
    permissions: [
      PERMISSIONS.USER_VIEW,
      PERMISSIONS.USER_CREATE,
      PERMISSIONS.USER_UPDATE,
      PERMISSIONS.USER_DELETE,
      PERMISSIONS.USER_CHANGE_ROLE,
      PERMISSIONS.USER_CHANGE_STATUS,
    ],
  },
  {
    key: 'profile',
    label: 'Profile',
    permissions: [
      PERMISSIONS.SELF_PROFILE_VIEW,
      PERMISSIONS.SELF_PROFILE_UPDATE,
      PERMISSIONS.PROFILE_VIEW_ANY,
      PERMISSIONS.PROFILE_UPDATE_ANY,
    ],
  },
  {
    key: 'role',
    label: 'Role & Permission',
    permissions: [PERMISSIONS.ROLE_VIEW, PERMISSIONS.ROLE_MANAGE],
    viewOnly: true,
  },
]);