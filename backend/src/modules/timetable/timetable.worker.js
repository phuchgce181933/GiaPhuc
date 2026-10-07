'use strict';
const { Worker } = require('node:worker_threads');
const path = require('node:path');
let busy = false;

// CPU search must not block login, roles, or profile APIs on the main thread.
async function runGenerate({ body, placementDetail, deps }) {
  const api = await import('./engine/api/generate.js');
  const { validateGenerateRequest, API_VERSION } = await import('./engine/api/contract.js');
  if (!validateGenerateRequest(body).ok) return api.generateSchedules({ body, placementDetail, deps });
  if (busy) return { status: 429, payload: { apiVersion: API_VERSION, status: 'BUSY', ok: false, solutions: [], errors: [
    { field: 'scheduler', code: 'SCHEDULER_BUSY', message: 'Đang có lượt xếp lịch khác. Vui lòng thử lại sau.' },
  ] } };
  busy = true;
  try {
    const loaded = await deps.loadDataset();
    const result = await new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'engine/api/generate.worker.js'), { workerData: { body, placementDetail, loaded } });
      let settled = false;
      const finish = (action, value) => { if (!settled) { settled = true; clearTimeout(timeout); action(value); } };
      const timeout = setTimeout(() => { worker.terminate(); finish(reject, new Error('Scheduler time limit exceeded.')); }, 170_000);
      worker.once('message', (value) => value.error ? finish(reject, new Error(value.error)) : finish(resolve, value));
      worker.once('error', (error) => finish(reject, error));
      worker.once('exit', () => { if (!settled) finish(reject, new Error('Scheduler exited without a result.')); });
    });
    if (result.entries) {
      try {
        const stored = await deps.previewStore.put(result.payload.requestId, result.entries);
        result.payload.previewPersistence = { stored: stored?.stored !== false, duplicate: stored?.duplicate === true, driver: deps.previewStore.driver, reason: stored?.reason ?? null };
      } catch {
        result.payload.previewPersistence = { stored: false, duplicate: false, driver: deps.previewStore.driver, reason: 'Không thể lưu bản xem trước. Có thể xem nhưng cần tạo lại trước khi lưu lịch.' };
      }
    }
    return { status: result.status, payload: result.payload };
  } finally { busy = false; }
}
module.exports = { runGenerate };
