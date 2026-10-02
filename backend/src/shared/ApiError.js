'use strict';

/**
 * Application error class. Use so middleware can serialize a consistent shape.
 */
class ApiError extends Error {
  constructor(statusCode, message, { code, details, cause } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code || `HTTP_${statusCode}`;
    if (details !== undefined) this.details = details;
    if (cause !== undefined) this.cause = cause;
  }

  static badRequest(message, details) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', details });
  }
  static unauthorized(message = 'Unauthorized', details) {
    return new ApiError(401, message, { code: 'UNAUTHORIZED', details });
  }
  static forbidden(message = 'Forbidden', details) {
    return new ApiError(403, message, { code: 'FORBIDDEN', details });
  }
  static notFound(message = 'Not found', details) {
    return new ApiError(404, message, { code: 'NOT_FOUND', details });
  }
  static conflict(message, details) {
    return new ApiError(409, message, { code: 'CONFLICT', details });
  }
  static unprocessable(message, details) {
    return new ApiError(422, message, { code: 'UNPROCESSABLE_ENTITY', details });
  }
  static internal(message = 'Internal server error', cause) {
    return new ApiError(500, message, { code: 'INTERNAL_ERROR', cause });
  }
}

module.exports = ApiError;