'use strict';
const { randomUUID } = require('node:crypto');
const { interpretIntent } = require('./intent-parser.service.js');
const { createPlan, confirmPlan } = require('./repair-planner.service.js');
const plans = new Map();
const TTL_MS = 15 * 60 * 1000;
function prune() { const cutoff = Date.now() - TTL_MS; for (const [id, plan] of plans) if (Date.parse(plan.createdAt) < cutoff) plans.delete(id); }
async function preview({ body, dependencies, config }) {
  prune();
  const original = await dependencies.scheduleStore.read(body?.scheduleId);
  if (!original) { const error = new Error('Không tìm thấy phiên bản TKB đã chọn.'); error.status = 404; throw error; }
  const { input } = await dependencies.loadDataset();
  const intent = await interpretIntent(body?.text, { apiKey: config?.ASSISTANT?.API_KEY, model: config?.ASSISTANT?.MODEL });
  const plan = await createPlan({ original, intent, input });
  plan.planId = `assistant-${randomUUID()}`; plan.createdAt = new Date().toISOString(); plans.set(plan.planId, plan);
  return plan;
}
async function confirm({ planId, dependencies, actorId }) {
  prune(); const plan = plans.get(planId);
  if (!plan) { const error = new Error('Bản xem trước đã hết hạn hoặc không tồn tại.'); error.status = 404; throw error; }
  const result = await confirmPlan({ plan, dependencies, actorId }); plans.delete(planId); return result;
}
module.exports = { preview, confirm };
