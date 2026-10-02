import { PERMISSIONS } from '../../lib/env';

/**
 * Frontend mirror of backend permission strings. Keep these in sync with backend/src/shared/permissions.js.
 * Permissions are checked next to where they are consumed (e.g. admin menus, route guards).
 */
export { PERMISSIONS };

export function hasAll(granted = [], required = []) {
  if (!required?.length) return true;
  return required.every((p) => granted.includes(p));
}

export function hasAny(granted = [], required = []) {
  if (!required?.length) return false;
  return required.some((p) => granted.includes(p));
}