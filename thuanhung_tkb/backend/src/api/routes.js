// PHASE 32 — ROUTES.
//
// Mounted at `/api/schedules`. The Phase 14-17 surface at
// `/api/scheduling` is untouched: it is a different pipeline (see
// `generate.js` for why the two coexist rather than one replacing
// the other), and Phase 21 and earlier pin its behaviour.
//
// NO DOMAIN IMPORT HAPPENS HERE
// -----------------------------
// This file imports the API service and the dataset loader. It does
// not import `solver.js`, `multi-solution.js`, `global-scoring.js`,
// or anything under `constraints/` — the same boundary the brief
// draws for the UI, drawn on the server side so the layering is not
// a UI-only convention (brief §1).
//
// NO DATABASE IS REACHED BY GENERATE
// ----------------------------------
// `/generate` never writes. The only route that can reach the schedule
// store is `/commit`, and it does so exclusively through `commit.js`,
// which holds the store as an injected dependency. This file passes
// the store in; it does not know how a record is written, where it
// goes, or what atomicity means.

import { Router } from 'express';
import { loadBenchmarkDataset } from '../benchmark/dataset.js';
import { createAIPlannerFromConfig, AI_PROVIDERS } from '../domain/ai/providers/index.js';
import { config } from '../config/index.js';
import { generateSchedules, PreviewStore, SCHEDULER_STATUS } from './generate.js';
import { commit, describeCommitted, readCommitted, COMMIT_STATUS } from './commit.js';
import { ScheduleStore } from '../persistence/schedule-store.js';
import { DurablePreviewStore } from '../persistence/preview-store.js';
import { PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../persistence/preview-record.js';
import { API_VERSION, ALLOWED_REQUEST_KEYS, ALLOWED_COMMIT_KEYS } from './contract.js';
import { isPlacementDetail, PLACEMENT_DETAIL } from './mappers.js';
import { OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../domain/strategies.js';
import { mapTransferStatus, mapTravelStatus } from './status.js';

/**
 * PHASE 34 -- the preview store is DURABLE by default.
 *
 * It used to be `new PreviewStore(6)`, a `Map` in this process, and
 * that is what made a commit depend on which process served the
 * generate request: a restart, a second Node process, or a second tab
 * that hit a different worker all produced a 404 for a solution the
 * user had just been shown. The store below writes the generation to
 * `<PERSISTENCE_DIR>/previews/` with the same atomic create-if-absent
 * the schedule store uses, so any process that can see the directory
 * can commit from it.
 *
 * The in-memory `PreviewStore` is still exported from `generate.js`
 * and still accepted here, because it is the dependency-free way to
 * hand `commit` a known candidate -- several Phase 32/33 checks inject
 * a schedule the solver would never produce that way. The two are
 * interchangeable because both answer `describe(requestId)` with the
 * same shape (brief 1, 16, 17).
 *
 * One process-wide instance, memoized for the same reason the
 * schedule store is: constructing it creates a directory and sweeps
 * temp files, which is once-per-process work, not once-per-request.
 */
let sharedPreviewStore = null;
function defaultPreviewStore() {
  if (!sharedPreviewStore) {
    sharedPreviewStore = new DurablePreviewStore({
      dir: config.persistenceDir,
      limit: config.previewLimit,
      ttlSeconds: config.previewTtlSeconds,
    });
  }
  return sharedPreviewStore;
}

/**
 * One preview store for the process. Its bound is the only reason
 * this is not an unbounded `Map`: every entry holds full solution
 * objects, including up to 802 placement rows each.
 */

/**
 * The process-wide schedule store.
 *
 * Created lazily and memoized, because constructing it sweeps temp
 * files and scans the directory for the highest version — work that
 * belongs once per process, not once per request. A test injects its
 * own via `createSchedulesRouter({ scheduleStore })`, which is how
 * `phase33_schedule_commit.test.js` runs against a temporary
 * directory and never touches the operator's data.
 */
let sharedScheduleStore = null;
function defaultScheduleStore() {
  if (!sharedScheduleStore) sharedScheduleStore = new ScheduleStore({ dir: config.persistenceDir });
  return sharedScheduleStore;
}

/**
 * Dataset resolution.
 *
 * The default is the legacy-derived REAL SchedulingInput, which is
 * what brief §5 requires. `PHASE32_FIXTURE=impossible` swaps in a
 * deliberately infeasible input so the no-solution path can be
 * exercised against a real request rather than only in a unit test
 * (brief §35). Nothing else is switchable: there is no client-supplied
 * dataset, because a client that could name the dataset could also
 * name the teachers in it.
 */
function loadDataset() {
  if (process.env.PHASE32_FIXTURE === 'impossible') {
    const real = loadBenchmarkDataset();
    return {
      input: buildImpossibleFixture(real.input),
      // The provenance is the REAL dataset's, with a marker that says
      // the time grid was collapsed. Claiming a different data source
      // would make the EMPTY result impossible to trace back to the
      // data that produced it.
      provenance: { ...real.provenance, source: 'PHASE32_IMPOSSIBLE_FIXTURE' },
    };
  }
  return loadBenchmarkDataset();
}

/**
 * A genuinely infeasible input: the REAL dataset, with the weekly
 * time grid collapsed to a single placeable slot per branch.
 *
 * WHY THE REAL DATASET AND NOT THE SMALL FIXTURE
 * ---------------------------------------------
 * The first version of this used `buildControlledFixture()`. It never
 * reached the solver: that fixture ships an empty `curriculum`, so
 * `validateInput` classifies it MISSING_DATA and the request ends
 * before generation. The test then "passed" the no-solution assertion
 * for the wrong reason — it was measuring the pre-solver gate, not
 * the no-solution path.
 *
 * Shrinking the real input instead keeps every entity intact (so
 * validation genuinely passes) and makes the infeasibility
 * arithmetic rather than accidental: 7 branches x 1 day x 1 period =
 * 7 placeable slots, against 802 required periods. No candidate can
 * satisfy H05, so the pool is empty for a reason the diagnostics can
 * state.
 */
function buildImpossibleFixture(input) {
  return {
    ...input,
    branches: input.branches.map((b) => ({ ...b, schoolDays: [1], periods: [1] })),
    timeSlotsByBranch: new Map(
      input.branches.map((b) => [b.id, [{ branchId: b.id, day: 1, period: 1 }]]),
    ),
  };
}

export function createSchedulesRouter(options = {}) {
  const router = Router();
  const store = options.previewStore ?? defaultPreviewStore();
  const schedules = options.scheduleStore ?? defaultScheduleStore();
  const ai = config.ai;

  const deps = {
    loadDataset: options.loadDataset ?? (() => loadDataset()),
    previewStore: store,
    scheduleStore: schedules,
    aiProviderName: ai.provider,
    makePlanner: () => {
      if (ai.provider === AI_PROVIDERS.OFF) return null;
      return createAIPlannerFromConfig(ai);
    },
  };

  /**
   * POST /api/schedules/generate
   *
   * 200 — OK | EMPTY | MISSING_DATA
   * 400 — INVALID_INPUT
   * 500 — FAILED (infrastructure only)
   *
   * EMPTY and MISSING_DATA are 200 on purpose (brief §9, §35): the
   * pipeline ran and the honest answer is "no timetable" or "the data
   * is not there", which is not the same as a malformed request.
   *
   * `?placements=all|selected|none` chooses how many solutions carry
   * their slot table. The default is `all`; an unrecognized value is
   * a 400 rather than a silent default, so a client never believes it
   * asked for a level it did not get.
   */
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
            message: `placements must be one of: ${Object.values(PLACEMENT_DETAIL).join(', ')}.`,
          }],
        });
      }
      const { status, payload } = await generateSchedules({
        body: req.body,
        deps,
        placementDetail: requested || PLACEMENT_DETAIL.ALL,
      });
      res.status(status).json(payload);
    } catch (e) {
      // Nothing in `generateSchedules` is expected to throw, and
      // anything that does is a bug here rather than a bad request.
      // Express must not see it as an unhandled rejection.
      next(e);
    }
  });

  /**
   * POST /api/schedules/commit
   *
   * The write path. The order is the contract (brief §17): validate
   * the request vocabulary, look the candidate up by id, re-validate
   * it with the independent evaluator, then — and only then — persist
   * it atomically and read it back.
   *
   * 200 — COMMITTED | COMMITTED_DUPLICATE (a replay of the same
   *       request returns the same scheduleId and creates nothing)
   * 400 — the body is malformed or carries a forbidden field
   * 404 — the generation or the solution is not in the preview store
   * 409 — re-validation reported a hard violation, or the candidate
   *       cannot be resolved into complete slots. Nothing written.
   * 500 — the store failed, or the read-back did not match what was
   *       written. Both are reported as NOT persisted, because a
   *       write that cannot be verified must not be announced as a
   *       success.
   */
  router.post('/commit', async (req, res, next) => {
    try {
      const { status, payload } = await commit({ body: req.body, deps });
      res.status(status).json(payload);
    } catch (e) {
      next(e);
    }
  });

  /**
   * GET /api/schedules/committed
   *
   * The headers of every committed schedule, newest first. Headers
   * only: a list of ten 802-slot records would be ~5 MB of JSON that
   * nobody asked for. `slotCount` and `contentHash` are here so a
   * client can tell which one it wants without fetching it.
   */
  router.get('/committed', (_req, res) => {
    res.json({
      apiVersion: API_VERSION,
      status: SCHEDULER_STATUS.OK,
      ok: true,
      count: schedules.list().length,
      schedules: schedules.list(),
    });
  });

  /**
   * GET /api/schedules/committed/:scheduleId
   *
   * One committed schedule, header only.
   */
  router.get('/committed/:scheduleId', (req, res) => {
    const described = describeCommitted(schedules, req.params.scheduleId);
    if (!described) {
      return res.status(404).json({
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.INVALID_INPUT,
        ok: false,
        error: { code: 'UNKNOWN_SCHEDULE', message: `No committed schedule ${req.params.scheduleId}.` },
      });
    }
    return res.json({ apiVersion: API_VERSION, status: SCHEDULER_STATUS.OK, ok: true, schedule: described });
  });

  /**
   * GET /api/schedules/committed/:scheduleId/full
   *
   * The slot table. An explicit ask for the rows, kept separate from
   * the header endpoint so a client that only wants to verify a
   * `contentHash` never pays for 802 placements.
   */
  router.get('/committed/:scheduleId/full', (req, res) => {
    const full = readCommitted(schedules, req.params.scheduleId);
    if (!full) {
      return res.status(404).json({
        apiVersion: API_VERSION,
        status: SCHEDULER_STATUS.INVALID_INPUT,
        ok: false,
        error: { code: 'UNKNOWN_SCHEDULE', message: `No committed schedule ${req.params.scheduleId}.` },
      });
    }
    return res.json({ apiVersion: API_VERSION, status: SCHEDULER_STATUS.OK, ok: true, schedule: full });
  });

  /**
   * GET /api/schedules/health
   *
   * Reports what the deployment CAN do, so the UI can label its
   * controls before a request is made rather than after. The AI
   * provider name is config, not a reachability probe: a service that
   * is down still reports its configured name here, and the real
   * availability arrives in a generate response, where it is measured
   * rather than predicted.
   *
   * PHASE 34: this block now carries the things a multi-process or
   * restarted deployment needs to be honest about -- whether previews
   * are durable, whether a TTL was configured, how versions are
   * allocated, and whether the directory currently contains anything
   * unreadable. `preview.driver` is read from the store rather than
   * hard-coded, so a deployment injected with the in-memory store
   * (as several tests are) reports `memory` and does not claim a
   * durability it does not have.
   */
  router.get('/health', (_req, res) => {
    const scheduleHealth = schedules.health();
    const previewHealth = typeof store?.stats === 'function' ? store.stats() : null;
    let healthInput = null;
    try { healthInput = deps.loadDataset().input; } catch { /* liveness remains available */ }
    res.json({
      ok: true,
      apiVersion: API_VERSION,
      status: SCHEDULER_STATUS.OK,
      ai: {
        provider: ai.provider,
        // Deliberately not a health claim. See above.
        configured: true,
        integrationEnabled: ai.integrationEnabled === true,
      },
      request: {
        allowedFields: ALLOWED_REQUEST_KEYS,
        allowedCandidateCounts: ALLOWED_CANDIDATE_COUNTS,
        allowedOptimizationModes: Object.values(OPTIMIZATION_MODES),
        allowedCommitFields: ALLOWED_COMMIT_KEYS,
      },
      placementDetail: {
        allowed: Object.values(PLACEMENT_DETAIL),
        default: PLACEMENT_DETAIL.ALL,
      },
      // Phase 32 reported `{ implemented: false, mode: 'PREVIEW_ONLY' }`
      // because nothing could write. Phase 33 CAN, and the UI labels
      // its commit control from this block, so a deployment whose store
      // cannot be opened says so here rather than failing on the first
      // click with an opaque 500.
      commit: {
        implemented: true,
        mode: 'COMMIT_ENABLED',
        driver: 'file',
        atomic: true,
        idempotency: 'requestId+solutionId',
        outcomeStatuses: Object.values(COMMIT_STATUS),
        committedCount: schedules.list().length,
        // Uniqueness comes from `link(2)` against a shared directory,
        // so it holds across processes, not only within one. The
        // ordering it produces is an allocation order, not a clock.
        versionAllocation: scheduleHealth.versionAllocation,
        versionHighWaterMark: scheduleHealth.versionHighWaterMark,
        corruptRecordCount: scheduleHealth.corruptRecordCount,
        staleTempFileCount: scheduleHealth.staleTempFileCount,
      },
      // Whether a solution generated in one process can be committed
      // by another. This is the Phase 34 answer to the Phase 33
      // limitation, and it is read from the store so a test that
      // injects the in-memory store sees the truth about itself.
      preview: {
        driver: store?.driver ?? 'unknown',
        durable: (store?.driver ?? null) === 'file',
        crossProcess: (store?.driver ?? null) === 'file',
        integrity: (store?.driver ?? null) === 'file' ? PREVIEW_INTEGRITY.VERIFIED : PREVIEW_INTEGRITY.NOT_TRACKED,
        lifecycles: Object.values(PREVIEW_LIFECYCLE),
        ttlSeconds: previewHealth?.ttlSeconds ?? null,
        // `null` means no TTL is configured, which is the default and
        // is not the same as "expires immediately".
        expiration: previewHealth?.ttlSeconds ? 'TTL_CONFIGURED' : 'NONE',
        limit: previewHealth?.limit ?? null,
        stored: previewHealth?.stored ?? 0,
        available: typeof store?.available === 'function' ? store.available().length : null,
      },
      travel: healthInput ? mapTravelStatus(healthInput, null) : { h14: 'NOT_EVALUATED' },
      transfer: healthInput ? mapTransferStatus(healthInput, null) : { h13: 'NOT_EVALUATED' },
    });
  });

  return router;
}

export default createSchedulesRouter;
