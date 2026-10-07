'use strict';

/**
 * Central catalog of permission keys used across the system.
 * Every backend module that performs permission checks must import from here.
 * Frontend mirrors these strings exactly (see frontend/src/features/auth/permissions.js).
 */
const PERMISSIONS = Object.freeze({
  // User management
  USER_VIEW: 'user:read',
  USER_CREATE: 'user:create',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  USER_CHANGE_ROLE: 'user:change-role',
  USER_CHANGE_STATUS: 'user:change-status',

  // Profile
  SELF_PROFILE_VIEW: 'profile:read:self',
  SELF_PROFILE_UPDATE: 'profile:update:self',
  PROFILE_VIEW_ANY: 'profile:read:any',
  PROFILE_UPDATE_ANY: 'profile:update:any',

  // Role management
  ROLE_VIEW: 'role:read',
  ROLE_MANAGE: 'role:manage',

  // Auth (mostly self-service)
  AUTH_LOGIN: 'auth:login',
  TKB_VIEW: 'tkb:read',
  TKB_CATALOG_MANAGE: 'tkb:catalog:manage',
  TKB_PREFERENCE_UPDATE: 'tkb:preference:update',
  TKB_GENERATE: 'tkb:generate',
  TKB_COMMIT: 'tkb:commit',
  TKB_ADJUST: 'tkb:adjust',
  TKB_DELETE: 'tkb:delete',
  PROGRESS_VIEW: 'progress-test:read',
  PROGRESS_CATALOG: 'progress-test:catalog:manage',
  PROGRESS_QUESTION: 'progress-test:question:manage',
  PROGRESS_SCHEDULE: 'progress-test:schedule:manage',
  PROGRESS_RESULT: 'progress-test:result:read',
  PROGRESS_GRADE: 'progress-test:grade',
});

const PERMISSION_LIST = Object.freeze(Object.values(PERMISSIONS));

const PERMISSION_GROUPS = Object.freeze([
  { key: 'progress-test', label: 'Progress Test', permissions: [PERMISSIONS.PROGRESS_VIEW, PERMISSIONS.PROGRESS_CATALOG, PERMISSIONS.PROGRESS_QUESTION, PERMISSIONS.PROGRESS_SCHEDULE, PERMISSIONS.PROGRESS_RESULT, PERMISSIONS.PROGRESS_GRADE] },
  {
    key: 'tkb', label: 'Thời khóa biểu',
    permissions: [PERMISSIONS.TKB_VIEW, PERMISSIONS.TKB_CATALOG_MANAGE,
      PERMISSIONS.TKB_PREFERENCE_UPDATE, PERMISSIONS.TKB_GENERATE, PERMISSIONS.TKB_COMMIT,
      PERMISSIONS.TKB_ADJUST, PERMISSIONS.TKB_DELETE],
  },
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
  },
]);

module.exports = { PERMISSIONS, PERMISSION_LIST, PERMISSION_GROUPS };
