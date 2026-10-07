'use strict';
const { PERMISSIONS } = require('../shared/permissions');
const { requirePermission } = require('./rbac.middleware');

module.exports = function timetableAccess(req, res, next) {
  const path = req.path.replace(/\/+$/, '').toLowerCase();
  let permission = PERMISSIONS.TKB_VIEW;
  if (req.method === 'POST' && path === '/schedules/generate') permission = PERMISSIONS.TKB_GENERATE;
  else if (req.method === 'POST' && path === '/schedules/commit') permission = PERMISSIONS.TKB_COMMIT;
  else if (path.startsWith('/assistant/')) permission = PERMISSIONS.TKB_ADJUST;
  else if (req.method === 'DELETE' && /^\/schedules\/committed\/[^/]+$/.test(path)) permission = PERMISSIONS.TKB_DELETE;
  else if (req.method === 'PUT' && /^\/teachers\/[^/]+\/preferences$/.test(path)) permission = PERMISSIONS.TKB_PREFERENCE_UPDATE;
  else if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) permission = PERMISSIONS.TKB_CATALOG_MANAGE;
  return requirePermission(PERMISSIONS.TKB_VIEW, permission)(req, res, next);
};
