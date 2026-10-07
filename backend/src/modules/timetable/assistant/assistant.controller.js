'use strict';

const service = require('./assistant.service.js');

async function preview(req, res, next, dependencies) {
  try {
    const plan = await service.preview({ body: req.body, dependencies, config: req.timetableConfig });
    return res.json({ ok: true, plan: { planId: plan.planId, scheduleId: plan.scheduleId, sourceVersion: plan.sourceVersion, intent: plan.intent, changes: plan.changes, repaired: plan.repaired, issues: plan.issues, audit: plan.audit, evaluation: plan.evaluation.summary, createdAt: plan.createdAt } });
  } catch (error) { return next(error); }
}

async function confirm(req, res, next, dependencies) {
  try {
    const result = await service.confirm({ planId: req.body?.planId, dependencies, actorId: req.timetableActorId ?? req.user?.id ?? null });
    return res.status(result.created ? 201 : 200).json({ ok: true, ...result });
  } catch (error) { return next(error); }
}

module.exports = { preview, confirm };
