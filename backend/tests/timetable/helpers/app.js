import express from 'express';
import { createSchedulesRouter } from '../../../src/modules/timetable/engine/api/routes.js';
import { createCatalogRouter } from '../../../src/modules/timetable/engine/catalog/catalog.route.js';
import { defaultCatalogStore } from '../../../src/modules/timetable/engine/catalog/catalog.store.js';
import { loadBenchmarkDataset } from '../../../src/modules/timetable/engine/loader/catalog-dataset.js';
import { PreviewStore } from '../../../src/modules/timetable/engine/api/generate.js';

function testScheduleStore() {
  const records = new Map();
  return { driver: 'memory', read: (id) => records.get(id) ?? null, list: () => [...records.values()],
    health: () => ({ driver: 'memory', versionAllocation: 'TEST_COUNTER', corruptRecordCount: 0 }),
    withLock: (_id, action) => action(), create: async (id, build) => {
      if (records.has(id)) return { created: false, record: records.get(id) };
      const record = build(records.size + 1); records.set(id, record); return { created: true, record };
    } };
}

export function createApp(options = {}) {
  const catalogStore = options.catalogStore ?? defaultCatalogStore();
  const dependencies = { previewStore: new PreviewStore(), scheduleStore: testScheduleStore(), ...options, catalogStore,
    loadDataset: options.loadDataset ?? (() => loadBenchmarkDataset({ catalogStore, preferenceStore: options.preferenceStore })) };
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Phase 14-17 surface. Unchanged.

  // Phase 32 surface: the user-facing generation flow.
  app.use('/api/schedules', createSchedulesRouter(dependencies));
  app.use('/api', createCatalogRouter(dependencies));

  // Phase 32 §28 — an unmatched /api path gets a JSON body with a
  // stable shape rather than Express's default HTML, so a client
  // never has to parse two different error formats depending on
  // whether the route existed.
  app.use('/api', (_req, res) => {
    res.status(404).json({
      ok: false,
      status: 'INVALID_INPUT',
      errors: [{ field: 'path', code: 'NOT_FOUND', message: 'Unknown API endpoint.' }],
    });
  });

  app.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ ok:false, errors:[{code:'INVALID_JSON',message:error.type === 'entity.parse.failed' ? 'JSON không hợp lệ' : 'Lỗi máy chủ'}] }));
  return app;
}
