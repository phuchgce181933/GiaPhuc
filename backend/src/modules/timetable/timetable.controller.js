'use strict';
const { getRuntime } = require('./timetable.service');

// HTTP controller boundary for the feature. Domain/engine code never receives
// Express req/res directly; this controller injects the authenticated actor.
async function handle(req, res, next) {
  try {
    const runtime = await getRuntime();
    req.timetableActorId = req.user.id;
    req.timetableConfig = require('../../config').TIMETABLE;
    runtime.router(req, res, next);
  } catch (error) { next(error); }
}

module.exports = { handle };
