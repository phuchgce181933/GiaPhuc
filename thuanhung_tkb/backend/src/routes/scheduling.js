// Express routes for scheduling.

import { Router } from 'express';
import { load } from '../loader/index.js';
import { makeOrchestrator } from '../orchestrator/index.js';

const router = Router();
const orch = makeOrchestrator();

router.post('/preview', (req, res) => {
  const model = load();
  const options = req.body?.options ?? {};
  const out = orch.preview(model, options);
  // INVALID_INPUT is a 400; OK / MISSING_DATA / EMPTY are 200.
  const code = out.status === 'INVALID_INPUT' ? 400 : 200;
  res.status(code).json(out);
});

router.post('/commit', (req, res) => {
  const { solutionId } = req.body ?? {};
  if (!solutionId) return res.status(400).json({ ok: false, error: 'MISSING_SOLUTION_ID' });
  const result = orch.commit(solutionId);
  res.status(result.ok ? 200 : 409).json(result);
});

router.get('/health', (_req, res) => res.json({ ok: true }));

export default router;
