import { Router } from 'express';
import { generateSchedules, SCHEDULER_STATUS } from './generate.js';
import { commit, describeCommitted, readCommitted, COMMIT_STATUS } from './commit.js';
import { PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../persistence/preview-record.js';
import { API_VERSION, ALLOWED_REQUEST_KEYS, ALLOWED_COMMIT_KEYS } from './contract.js';
import { isPlacementDetail, PLACEMENT_DETAIL } from './mappers.js';
import { OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../domain/strategies.js';
import { mapTransferStatus, mapTravelStatus } from './status.js';
export function createSchedulesRouter(options = {}) {
  const router = Router();
  const store = options.previewStore;
  const schedules = options.scheduleStore;
  if (!store || !schedules || typeof options.loadDataset !== 'function') throw new TypeError('Scheduling requires explicit dataset, preview and schedule stores.');
  const deps = {
    loadDataset: options.loadDataset,
    previewStore: store,
    scheduleStore: schedules,
    actorId: options.actorId ?? null
  };
  const runGenerate = options.runGenerate ?? generateSchedules;
  router.post('/generate', async (req, res, next) => {
    try {
      const requested = req.query?.placements ?? PLACEMENT_DETAIL.ALL;
      if (!isPlacementDetail(requested)) {
        return res.status(400).json({
          apiVersion: API_VERSION,
          status: SCHEDULER_STATUS.INVALID_INPUT,
          ok: false,
          errors: [{
            field: 'placements',
            code: 'INVALID_PLACEMENT_DETAIL',
            message: `placements must be one of: ${Object.values(PLACEMENT_DETAIL).join(', ')}.`
          }]
        });
      }
      const {
        status,
        payload
      } = await runGenerate({
        body: req.body,
        deps,
        placementDetail: requested || PLACEMENT_DETAIL.ALL
      });
      res.status(status).json(payload);
    } catch (e) {
      next(e);
    }
  });
  router.post('/commit', async (req, res, next) => {
    try {
      const {
        status,
        payload
      } = await commit({
        body: req.body,
        deps: { ...deps, actorId: req.timetableActorId ?? deps.actorId ?? null }
      });
      res.status(status).json(payload);
    } catch (e) {
      next(e);
    }
  });
  router.get('/committed', async (_req, res, next) => {
    try {
      res.json({
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.OK,
        ok: true,
        count: (await schedules.list()).length,
        schedules: await schedules.list()
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/committed/:scheduleId', async (req, res, next) => {
    try {
      const described = await describeCommitted(schedules, req.params.scheduleId);
      if (!described) {
        return res.status(404).json({
          apiVersion: API_VERSION,
          status: SCHEDULER_STATUS.INVALID_INPUT,
          ok: false,
          error: {
            code: 'UNKNOWN_SCHEDULE',
            message: `No committed schedule ${req.params.scheduleId}.`
          }
        });
      }
      return res.json({
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.OK,
        ok: true,
        schedule: described
      });
    } catch (error) {
      next(error);
    }
  });
  router.get('/committed/:scheduleId/full', async (req, res, next) => {
    try {
      const full = await readCommitted(schedules, req.params.scheduleId);
      if (!full) {
        return res.status(404).json({
          apiVersion: API_VERSION,
          status: SCHEDULER_STATUS.INVALID_INPUT,
          ok: false,
          error: {
            code: 'UNKNOWN_SCHEDULE',
            message: `No committed schedule ${req.params.scheduleId}.`
          }
        });
      }
      return res.json({
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.OK,
        ok: true,
        schedule: full
      });
    } catch (error) {
      next(error);
    }
  });
  router.delete('/committed/:scheduleId', async (req, res, next) => {
    try {
      if (typeof schedules.remove !== 'function') return res.status(501).json({ ok: false, error: { code: 'DELETE_UNSUPPORTED', message: 'Driver hiện tại chưa hỗ trợ xóa phiên bản.' } });
      const existing = await schedules.read(req.params.scheduleId);
      if (!existing) return res.status(404).json({ ok: false, error: { code: 'UNKNOWN_SCHEDULE', message: 'Không tìm thấy phiên bản thời khóa biểu.' } });
      const result = await schedules.remove(req.params.scheduleId);
      return res.json({ ok: true, ...result, deletedVersion: existing.version });
    } catch (error) { next(error); }
  });
  router.get('/health', async (_req, res, next) => {
    try {
      const scheduleHealth = await schedules.health();
      const previewHealth = typeof store?.stats === 'function' ? await store.stats() : null;
      let healthInput = null;
      try {
        healthInput = (await deps.loadDataset()).input;
      } catch {}
      res.json({
        ok: true,
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.OK,
        request: {
          allowedFields: ALLOWED_REQUEST_KEYS,
          allowedCandidateCounts: ALLOWED_CANDIDATE_COUNTS,
          allowedOptimizationModes: Object.values(OPTIMIZATION_MODES),
          allowedCommitFields: ALLOWED_COMMIT_KEYS
        },
        placementDetail: {
          allowed: Object.values(PLACEMENT_DETAIL),
          default: PLACEMENT_DETAIL.ALL
        },
        commit: {
          implemented: true,
          mode: 'COMMIT_ENABLED',
          driver: schedules.driver ?? 'file',
          atomic: true,
          idempotency: 'requestId+solutionId',
          outcomeStatuses: Object.values(COMMIT_STATUS),
          committedCount: (await schedules.list()).length,
          versionAllocation: scheduleHealth.versionAllocation,
          versionHighWaterMark: scheduleHealth.versionHighWaterMark,
          corruptRecordCount: scheduleHealth.corruptRecordCount,
          staleTempFileCount: scheduleHealth.staleTempFileCount
        },
        preview: {
          driver: store?.driver ?? 'unknown',
          durable: ['file', 'mongodb'].includes(store?.driver),
          crossProcess: ['file', 'mongodb'].includes(store?.driver),
          integrity: ['file', 'mongodb'].includes(store?.driver) ? PREVIEW_INTEGRITY.VERIFIED : PREVIEW_INTEGRITY.NOT_TRACKED,
          lifecycles: Object.values(PREVIEW_LIFECYCLE),
          ttlSeconds: previewHealth?.ttlSeconds ?? null,
          expiration: previewHealth?.ttlSeconds ? 'TTL_CONFIGURED' : 'NONE',
          limit: previewHealth?.limit ?? null,
          stored: previewHealth?.stored ?? 0,
          available: typeof store?.available === 'function' ? (await store.available()).length : null
        },
        travel: healthInput ? mapTravelStatus(healthInput, null) : {
          h14: 'NOT_EVALUATED'
        },
        transfer: healthInput ? mapTransferStatus(healthInput, null) : {
          h13: 'NOT_EVALUATED'
        }
      });
    } catch (error) {
      next(error);
    }
  });
  return router;
}
export default createSchedulesRouter;
