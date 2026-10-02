import express from 'express';
import scheduling from './routes/scheduling.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/scheduling', scheduling);
  return app;
}
