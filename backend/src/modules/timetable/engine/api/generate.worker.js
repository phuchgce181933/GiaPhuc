import { parentPort, workerData } from 'node:worker_threads';
import { generateSchedules, PreviewStore } from './generate.js';

try {
  const previewStore = new PreviewStore();
  const result = await generateSchedules({ body: workerData.body, placementDetail: workerData.placementDetail,
    deps: { loadDataset: () => workerData.loaded, previewStore } });
  parentPort.postMessage({ ...result, entries: previewStore.get(result.payload.requestId) });
} catch { parentPort.postMessage({ error: 'SCHEDULER_FAILED' }); }
finally { parentPort.close(); }
