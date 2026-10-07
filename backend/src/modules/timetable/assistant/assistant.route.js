'use strict';

const { Router } = require('express');
const controller = require('./assistant.controller.js');

function createAssistantRouter({ dependencies }) {
  const router = Router();
  router.post('/preview', (req, res, next) => controller.preview(req, res, next, dependencies));
  router.post('/confirm', (req, res, next) => controller.confirm(req, res, next, dependencies));
  router.use((error, _req, res, _next) => res.status(error.status ?? 400).json({ ok: false, errors: [{ code: error.code ?? 'ASSISTANT_ERROR', message: error.message ?? 'Không thể xử lý yêu cầu điều chỉnh TKB.', ...(error.details ? { details: error.details } : {}) }] }));
  return router;
}

module.exports = { createAssistantRouter };
