// PHASE 33 — COMMIT SERVICE: the write path.
//
// THIS IS THE ONLY MODULE THAT CAN WRITE A SCHEDULE.
// ---------------------------------------------
// `generate.js` cannot reach a store. The router cannot. Only the
// function below holds a `ScheduleStore`, and it holds it as an
// injected dependency, so a test supplies a temporary directory and a
// production run supplies the configured one. There is no second
// route to the store and no "quick save" helper anywhere in the tree
// (brief §1: no auto-commit; brief §7: the write path is auditable in
// one file).
//
// THE ORDER IS THE CONTRACT (brief §17)
// ------------------------------------
//
//   1. validate the request vocabulary      -> 4xx, nothing touched
//   2. look the candidate up BY ID          -> 404, nothing touched
//   3. re-validate with the evaluator      -> 409, nothing written
//   4. re-score (no search)                 -> recorded, not a gate
//   5. build rows from the CANDIDATE        -> refusal if a row is
//                                              not derivable
//   6. persist atomically                   -> the only write
//   7. read back and compare                -> 500 if the readback
//                                              does not match
//
// Steps 1-5 all run before step 6, and none of them writes. A
// rejection at any of them leaves the store byte-identical, which is
// what "Schedule was not saved" means (brief §15).
//
// WHY THE CANDIDATE IS THE ONLY SOURCE
// ------------------------------------
// The request body carries `requestId` and `solutionId` and nothing
// else. Every persisted field is derived from the solver candidate the
// backend itself produced and kept. A client cannot reach
// `teacherId`, `day`, `period` or `branchId` on the way to disk, and
// a body that tries is rejected at step 1 before it is even parsed as
// a request (brief §4, §22, §29).
//
// RE-VALIDATION RE-EVALUATES THE SOLVER OBJECT
// --------------------------------------------
// Not a reconstruction from the flattened display rows. Rebuilding a
// solver-shaped candidate from a projection was the first version of
// this code and it reported 479 phantom H05 violations, because the
// reconstruction was a second implementation of the same thing and the
// evaluator correctly rejected it. The thing re-validated is the thing
// that was validated (brief §5).
//
// NO AI IN THIS PATH
// ------------------
// There is no planner reference anywhere below, and `deps.makePlanner`
// is not called. The AI contributes a strategy at GENERATION time; a
// commit re-uses the candidate that strategy produced and never
// re-asks (brief §21). A test asserts the planner call count is
// unchanged across a commit.

import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';
import { scoreCandidate, GLOBAL_SCORING_DEFAULTS } from '../domain/global-scoring.js';

import { validateCommitRequest, ALLOWED_COMMIT_KEYS, API_VERSION } from './contract.js';
import { mapTravelStatus, mapTransferStatus } from './status.js';
import {
  buildScheduleRows,
  compareRows,
  contentHash,
  normalizeReadback,
  buildAuditBlock,
} from '../persistence/schedule-record.js';
import { ScheduleStore, scheduleIdFor } from '../persistence/schedule-store.js';

/** The commit outcomes. A client branches on these, not on HTTP alone. */
export const COMMIT_STATUS = Object.freeze({
  COMMITTED: 'COMMITTED',
  /** Same (requestId, solutionId) already stored; the same record. */
  COMMITTED_DUPLICATE: 'COMMITTED_DUPLICATE',
  REJECTED: 'COMMIT_REJECTED',
});

/**
 * commit(options) -> Promise<{ status, payload }>
 *
 * deps:
 *   previewStore  PreviewStore — the generation's candidates
 *   loadDataset   () => { input, provenance }
 *   scheduleStore ScheduleStore — where committed schedules go
 *   scoringConfig optional Phase 28 config, for the re-score step
 */
export async function commit(options = {}) {
  const { body, requestId: bodyRequestId, solutionId: bodySolutionId, deps } = options;
  const start = Date.now();
  const store = deps?.previewStore;
  const schedules = deps?.scheduleStore;

  // The service is callable two ways: the route passes the parsed
  // `body`, and a test that drives the service directly passes the
  // two fields it already has. Both funnel into ONE validated body,
  // so there is a single vocabulary check rather than two code paths
  // that could drift.
  const effectiveBody = body !== undefined && body !== null
    ? body
    : { requestId: bodyRequestId, solutionId: bodySolutionId };

  // ---- 1. request vocabulary --------------------------------------
  const validated = validateCommitRequest(effectiveBody);
  if (!validated.ok) {
    return failure(400, {
      errors: validated.issues,
      detail: `A commit request may only carry: ${ALLOWED_COMMIT_KEYS.join(', ')}.`,
    });
  }
  const { requestId, solutionId } = validated.request;

  if (!schedules) {
    return failure(500, {
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'This deployment has no schedule store configured, so nothing can be committed.',
    });
  }

  // ---- 2. lookup BY ID (never trust the client) -------------------
  const stored = store?.get(requestId);
  if (!stored) {
    return failure(404, {
      requestId,
      solutionId,
      code: 'UNKNOWN_REQUEST',
      message: 'This generation is no longer available. Generate again before committing.',
    });
  }
  const entry = stored.find((e) => e.id === solutionId);
  if (!entry) {
    return failure(404, {
      requestId,
      solutionId,
      code: 'UNKNOWN_SOLUTION',
      message: `Solution ${solutionId} is not part of generation ${requestId}.`,
      // `available` lives INSIDE the error object, not beside it: the
      // Phase 32 contract put the recovery hint at
      // `error.available`, and a client that reads it there must keep
      // working.
      errorExtra: { available: stored.map((e) => e.id) },
    });
  }

  // ---- 3. re-validation with the independent evaluator ------------
  let loaded;
  try {
    loaded = deps.loadDataset();
  } catch {
    return failure(500, {
      requestId,
      solutionId,
      code: 'REVALIDATION_UNAVAILABLE',
      message: 'Could not re-load the scheduling input to re-validate this solution.',
    });
  }
  const { input, provenance } = loaded;

  const evaluation = evaluateSafe(entry.candidate, input);
  if (!evaluation.ok || !evaluation.accepted) {
    // Nothing has been written at this point and nothing will be.
    return {
      status: 409,
      payload: {
        apiVersion: API_VERSION,
        status: COMMIT_STATUS.REJECTED,
        ok: false,
        requestId,
        solutionId,
        error: {
          code: 'HARD_VIOLATION',
          message: 'The solution failed re-validation. The schedule was not saved.',
          hardViolations: evaluation.hardViolations,
          reasons: evaluation.reasons,
        },
        validation: {
          accepted: false,
          hardViolations: evaluation.hardViolations,
          reasons: evaluation.reasons,
        },
        persisted: false,
        elapsedMs: Date.now() - start,
      },
    };
  }

  // ---- 4. re-score, without searching -----------------------------
  // Brief §6: the global score may be recomputed, a new search may
  // not. `scoreCandidate` is pure and reads the candidate, the input
  // and the dimension catalog; it produces no new candidate, so the
  // schedule that gets persisted is still the one the user chose.
  //
  // WHAT THE RE-SCORE IS AND IS NOT
  // -------------------------------
  // It is a FEASIBILITY re-check: the scorer runs its own
  // `evaluateCandidate` internally, so agreeing with the evaluator
  // above is a second, independent confirmation that the candidate
  // about to be written is hard-feasible.
  //
  // It is NOT a new ranking. The pool here is this candidate alone,
  // and per-dimension min/max normalization over a one-element pool
  // collapses every dimension to the neutral 0.5, so the recomputed
  // `total` is 0.5 by construction — it carries no ranking
  // information. Reporting it as `globalScore` would contradict the
  // score the response already showed the user (and it did, before
  // this was fixed). So the authoritative numbers come from the
  // generation's own scoring of this candidate, and the re-score is
  // reported separately, labelled for what it is.
  const recheck = rescoreSafe(entry.candidate, input, deps.scoringConfig ?? GLOBAL_SCORING_DEFAULTS);
  const sourceSolution = entry.solution ?? {};
  const score = {
    // From the generation that produced this candidate: the score
    // the user was shown when they picked it.
    globalScore: numberOrNull(sourceSolution.globalScore),
    qualityScore: numberOrNull(sourceSolution.qualityScore),
    feasibility: recheck.feasibility,
    hardViolations: recheck.hardViolations,
    rankReason: sourceSolution.scoring?.rankReason ?? null,
    recheck: {
      ran: true,
      searched: false,
      feasibility: recheck.feasibility,
      hardViolations: recheck.hardViolations,
      note: 'Re-scored against the single-candidate pool, so per-dimension normalization is '
        + 'neutral at n=1. This confirms feasibility; it does not re-rank.',
    },
  };

  // ---- 5. rows, derived from the candidate ------------------------
  const { rows, warnings } = buildScheduleRows(entry.candidate, input);
  if (warnings.length > 0) {
    return {
      status: 409,
      payload: {
        apiVersion: API_VERSION,
        status: COMMIT_STATUS.REJECTED,
        ok: false,
        requestId,
        solutionId,
        error: {
          code: 'UNRESOLVABLE_SLOTS',
          message: 'The solution could not be resolved into a complete set of slots. The schedule was not saved.',
          reasons: warnings.map((w) => w.message),
        },
        validation: { accepted: true, hardViolations: 0, reasons: warnings.map((w) => `${w.code}: ${w.message}`) },
        persisted: false,
        elapsedMs: Date.now() - start,
      },
    };
  }

  const hash = contentHash(rows);
  const scheduleId = scheduleIdFor(requestId, solutionId);
  const committedAt = deps.now ? deps.now() : new Date().toISOString();

  const audit = buildAuditBlock({
    requestId,
    solutionId,
    provenance,
    // `entry.strategy` and `entry.ai` are the generation's own
    // decision, kept by `generateSchedules` precisely so the commit
    // does not have to reconstruct them from a two-field request.
    strategy: entry.strategy ?? null,
    ai: entry.ai ?? null,
    rank: sourceSolution.rank ?? null,
    score,
  });

  // ---- 6. persist, atomically, exactly once -----------------------
  let outcome;
  try {
    outcome = await schedules.withLock(scheduleId, async () => {
      const built = ScheduleStore.buildRecord({
        scheduleId,
        requestId,
        solutionId,
        version: schedules.takeVersion(),
        rows,
        contentHash: hash,
        audit,
        clockValue: committedAt,
        validated: true,
      });
      return schedules.create(built);
    });
  } catch (e) {
    return failure(500, {
      requestId,
      solutionId,
      code: 'PERSISTENCE_FAILED',
      message: 'The schedule could not be written. Nothing was saved.',
      internalDetail: String(e?.message ?? e),
    });
  }

  // `created: false` means this exact (requestId, solutionId) was
  // already stored. That is the idempotent path: the SAME schedule is
  // returned, not a second one, and not an error either — a retried
  // request is a request that already succeeded.
  const storedRecord = outcome.record;
  const duplicate = outcome.created === false;

  // ---- 7. readback verification -----------------------------------
  // Brief §24: HTTP 200 is not proof. The record is read back off the
  // store and compared to the candidate, row for row. A mismatch is a
  // 500 even though the write "succeeded", because the contract this
  // response makes ("these 802 slots are what is on disk") would be
  // false.
  const readBack = schedules.read(scheduleId);
  const readRows = normalizeReadback(readBack);
  const diff = compareRows(rows, readRows);
  if (!readBack || !diff.equal) {
    return failure(500, {
      requestId,
      solutionId,
      scheduleId,
      code: 'READBACK_MISMATCH',
      message: 'The schedule was written but could not be read back unchanged. Treat it as not saved.',
      detail: {
        expectedSlots: rows.length,
        readSlots: readRows.length,
        onlyInCandidate: diff.onlyInLeft.length,
        onlyInStore: diff.onlyInRight.length,
      },
    });
  }

  // ---- response ---------------------------------------------------
  return {
    status: 200,
    payload: {
      apiVersion: API_VERSION,
      status: duplicate ? COMMIT_STATUS.COMMITTED_DUPLICATE : COMMIT_STATUS.COMMITTED,
      ok: true,
      requestId,
      solutionId,
      scheduleId,
      version: storedRecord.version ?? null,
      validated: true,
      committed: true,
      duplicate,
      committedAt: storedRecord.committedAt ?? committedAt,
      // Renamed from Phase 32's `written`, and both are present:
      // `written` is what the Phase 32 UI reads, `committed` is the
      // Phase 33 word. Dropping `written` would break a client that
      // is checking for it, and a client that only knows the old name
      // would otherwise see `undefined` and guess.
      written: true,
      slotCount: readRows.length,
      contentHash: storedRecord.contentHash ?? hash,
      persistence: {
        implemented: true,
        mode: 'COMMIT_ENABLED',
        driver: 'file',
        atomic: true,
        location: relativeLocation(schedules),
      },
      validation: {
        accepted: true,
        hardViolations: 0,
        reasons: [],
        constraintStatuses: evaluation.constraintStatuses ?? null,
      },
      score,
      // The AI did not participate in this commit. The block is
      // present so the UI can say so rather than leaving the user
      // wondering whether the model approved the write.
      ai: { used: false, reason: 'COMMIT_DOES_NOT_CALL_AI' },
      travel: mapTravelStatus(input, null),
      transfer: mapTransferStatus(input, null),
      readback: { slots: readRows.length, matchesCandidate: true },
      elapsedMs: Date.now() - start,
    },
  };
}

/**
 * GET-side helper: the header of one committed schedule, or null.
 *
 * Returns the HEADER only. The 802 slots are readable through
 * `GET /api/schedules/committed/:id/full`, which is an explicit ask
 * for the slot table; a list or a header response must never carry
 * megabytes it was not asked for (brief §12).
 */
export function describeCommitted(schedules, scheduleId) {
  const record = schedules?.read?.(scheduleId);
  if (!record) return null;
  return {
    scheduleId: record.scheduleId,
    status: record.status,
    version: record.version ?? null,
    requestId: record.requestId ?? null,
    solutionId: record.solutionId ?? null,
    validated: record.validated === true,
    committedAt: record.committedAt ?? null,
    slotCount: record.slotCount ?? null,
    contentHash: record.contentHash ?? null,
    audit: record.audit ?? null,
  };
}

/** The full record including slots, for an explicit read-back request. */
export function readCommitted(schedules, scheduleId) {
  const record = schedules?.read?.(scheduleId);
  if (!record) return null;
  return {
    ...describeCommitted(schedules, scheduleId),
    slots: normalizeReadback(record),
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Run the independent evaluator. Never throws: an evaluator that
 * throws on a candidate means the candidate is not acceptable, not
 * that the request is broken.
 */
function evaluateSafe(candidate, input) {
  try {
    const placements = new Map();
    const raw = candidate?.placements;
    const entries = raw instanceof Map ? raw.entries() : (Array.isArray(raw) ? raw : []);
    for (const [aId, p] of entries) {
      placements.set(aId, { teacherId: p?.teacherId, branchId: p?.branchId });
    }
    const evaluation = evaluateCandidate(
      { assignments: candidate?.assignments, placements },
      input,
    );
    return {
      ok: true,
      accepted: isAccepted(evaluation),
      hardViolations: evaluation?.summary?.totalHardViolations ?? 0,
      reasons: evaluation?.summary?.reasons ?? [],
      constraintStatuses: evaluation?.constraintStatuses ?? null,
    };
  } catch (e) {
    return {
      ok: false,
      accepted: false,
      hardViolations: 0,
      reasons: [`evaluation failed: ${String(e?.message ?? e)}`],
      constraintStatuses: null,
    };
  }
}

/**
 * Re-score one candidate. A scorer that throws must not fail a commit
 * that already passed validation: the score is an audit value here,
 * not a gate, so a failure degrades to nulls rather than to a
 * rejection.
 */
function rescoreSafe(candidate, input, config) {
  try {
    const scored = scoreCandidate(candidate, {
      input,
      // The pool is this candidate alone. Re-normalizing against the
      // other solutions would make the committed schedule's stored
      // score depend on what else was in the batch, which is not a
      // property of the schedule.
      pool: [candidate],
      config,
    });
    return {
      feasibility: scored?.feasibility ?? null,
      hardViolations: scored?.hardViolations ?? 0,
    };
  } catch {
    return { feasibility: null, hardViolations: null };
  }
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function failure(httpStatus, extra) {
  const { code, message, detail, errorExtra, internalDetail, ...rest } = extra;
  return {
    status: httpStatus,
    payload: {
      apiVersion: API_VERSION,
      status: COMMIT_STATUS.REJECTED,
      ok: false,
      persisted: false,
      ...(code ? { error: { code, message, ...(detail ? { detail } : {}), ...(errorExtra ?? {}) } } : {}),
      ...rest,
      // Server-side only. Never serialized to the client, exactly as
      // in `generate.js` — a stack trace in a browser is a disclosure
      // bug, not a debugging aid.
      ...(internalDetail ? { diagnostics: { internalDetail } } : {}),
    },
  };
}

function relativeLocation(store) {
  const dir = store?.dir ?? null;
  return dir ? String(dir) : null;
}

export { ALLOWED_COMMIT_KEYS };
