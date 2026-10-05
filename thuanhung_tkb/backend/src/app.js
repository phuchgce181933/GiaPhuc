import express from 'express';
import scheduling from './routes/scheduling.js';
import { createSchedulesRouter } from './api/routes.js';
import { createCatalogRouter } from './api/catalog.js';

export function createApp(options = {}) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Phase 14-17 surface. Unchanged.
  app.use('/api/scheduling', scheduling);

  // Phase 32 surface: the user-facing generation flow.
  app.use('/api/schedules', createSchedulesRouter(options));
  // Read-only legacy catalogue plus the small, operator-owned preference overlay.
  app.use('/api', createCatalogRouter(options));

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
