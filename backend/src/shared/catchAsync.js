'use strict';

/**
 * Wrap an async route handler so thrown errors propagate to the error middleware.
 * @param {(req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>Promise<any>} fn
 */
const catchAsync = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = catchAsync;