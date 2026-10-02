'use strict';

const ApiError = require('../shared/ApiError');

/**
 * Reject requests that hit an unknown route.
 */
function notFoundMiddleware(req, _res, next) {
  next(ApiError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
}

module.exports = notFoundMiddleware;