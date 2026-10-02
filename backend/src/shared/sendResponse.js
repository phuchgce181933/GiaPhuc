'use strict';

/**
 * Standard JSON success response. Always use this so clients see a consistent shape.
 */
function sendResponse(res, { statusCode = 200, message = 'OK', data = null, meta } = {}) {
  const body = { success: true, message, data };
  if (meta) body.meta = meta;
  return res.status(statusCode).json(body);
}

module.exports = sendResponse;