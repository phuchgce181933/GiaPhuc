'use strict';

const ApiError = require('../shared/ApiError');

/**
 * Require all listed permissions. Use `requireAny` for OR semantics.
 * The route handler can read req.user.role.permissions for current role.
 */
function requirePermission(...required) {
  if (required.length === 0) {
    throw new Error('requirePermission() needs at least one permission key');
  }
  return function rbacMiddleware(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    const granted = req.user.role?.permissions || [];
    const missing = required.filter((p) => !granted.includes(p));
    if (missing.length) {
      return next(
        ApiError.forbidden(`Missing permission(s): ${missing.join(', ')}`, { missing })
      );
    }
    next();
  };
}

function requireAnyPermission(...required) {
  if (required.length === 0) {
    throw new Error('requireAnyPermission() needs at least one permission key');
  }
  return function rbacMiddleware(req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized());
    const granted = req.user.role?.permissions || [];
    const has = required.some((p) => granted.includes(p));
    if (!has) {
      return next(ApiError.forbidden('None of the required permissions are granted'));
    }
    return next();
  };
}

module.exports = { requirePermission, requireAnyPermission };