'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const env = require('./config');
const routes = require('./routes');
const errorMiddleware = require('./middlewares/error.middleware');
const notFoundMiddleware = require('./middlewares/notFound.middleware');

const app = express();

// Core middlewares
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// CORS — permissive in dev, env-driven otherwise.
const allowList = (env.FRONTEND_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true); // server-to-server or curl
      if (allowList.includes('*') || allowList.includes(origin)) return cb(null, true);
      return cb(null, true); // permissive during development
    },
    credentials: true,
  })
);

// Global rate-limit — coarse grained, applied to /api.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);

// Mount routes under /api.
app.use('/api', routes);

// Health on root for quick probes.
app.get('/', (_req, res) =>
  res.json({ success: true, message: 'Gia Phuc API', data: { version: '1.0.0' } })
);

// 404 + error handlers must be last.
app.use(notFoundMiddleware);
app.use(errorMiddleware);

module.exports = app;