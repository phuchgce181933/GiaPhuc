'use strict';

const ApiError = require('../shared/ApiError');

/**
 * Build a validate(target)() middleware that runs a Zod schema against the request.
 *
 * Schemas may be either:
 *   - A flat Zod schema — validated directly against `target`.
 *   - A wrapper schema whose top-level shape is `{ body?, query?, params? }` —
 *     the middleware picks the inner schema that matches `target` (and is a
 *     no-op if no inner schema exists for that target).
 *
 * On success, `req[target]` is replaced with the parsed value (coerced strings,
 * trimmed, defaults filled in, unknown keys stripped).
 */
function validate(schema, target = 'body') {
  if (!schema || typeof schema.safeParse !== 'function') {
    throw new Error('validate() expects a Zod schema');
  }

  let actualSchema = schema;
  if (schema.shape && (schema.shape.body || schema.shape.query || schema.shape.params)) {
    const inner = schema.shape[target];
    if (!inner) {
      // No validator for this target — skip validation entirely.
      return function noop(_req, _res, next) { next(); };
    }
    actualSchema = inner;
  }

  return function validateMiddleware(req, _res, next) {
    const result = actualSchema.safeParse(req[target]);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
        code: i.code,
      }));
      return next(ApiError.unprocessable('Validation failed', { issues }));
    }
    req[target] = result.data;
    next();
  };
}

module.exports = validate;