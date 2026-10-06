import express from 'express';
import scheduling from './routes/scheduling.js';
import { createSchedulesRouter } from './api/routes.js';
import { createCatalogRouter } from './modules/catalog/catalog.route.js';
import { defaultCatalogStore } from './modules/catalog/catalog.store.js';
import { loadBenchmarkDataset } from './benchmark/dataset.js';

export function createApp(options = {}) {
  const catalogStore = options.catalogStore ?? defaultCatalogStore();
  const dependencies = { ...options, catalogStore,
    ...(!options.loadDataset && (options.catalogStore || options.preferenceStore)
      ? { loadDataset: () => loadBenchmarkDataset({ catalogStore, preferenceStore: options.preferenceStore }) } : {}) };
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Phase 14-17 surface. Unchanged.
  app.use('/api/scheduling', scheduling);

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

  return app;
}
