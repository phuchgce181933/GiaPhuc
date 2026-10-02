'use strict';

const env = require('../config');
const ApiError = require('../shared/ApiError');

// eslint-disable-next-line no-unused-vars
function errorMiddleware(err, req, res, _next) {
  // ApiError is intentional; everything else is wrapped as 500.
  let error = err;
  if (!(error instanceof ApiError)) {
    if (err && err.name === 'CastError') {
      error = ApiError.badRequest(`Invalid ${err.path}: ${err.value}`);
    } else if (err && err.code === 11000) {
      const fields = Object.keys(err.keyValue || {}).join(', ');
      error = ApiError.conflict(`Duplicate value for ${fields}`);
    } else if (err && err.name === 'ValidationError') {
      error = ApiError.unprocessable('Database validation failed', err.errors);
    } else {
      error = ApiError.internal(
        env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
        err
      );
    }
  }

  if (env.NODE_ENV !== 'production' && error.cause) {
    console.error('[error]', error.cause);
  }

  const body = {
    success: false,
    message: error.message,
    code: error.code,
  };
  if (error.details !== undefined) body.details = error.details;

  res.status(error.statusCode || 500).json(body);
}

module.exports = errorMiddleware;