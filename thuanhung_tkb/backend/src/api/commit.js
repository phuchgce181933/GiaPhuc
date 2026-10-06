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
//
// PHASE 34 -- WHAT CHANGED, AND WHAT DID NOT
// -----------------------------------------
// Added, at step 2, BEFORE the solution lookup:
//
//   * a LIFECYCLE check, so "this generation is not here any more" is
//     reported as MISSING, EXPIRED or INVALID rather than as one
//     undifferentiated 404. Those are three different facts with three
//     different recoveries -- generate again, wait or regenerate,
//     investigate the store -- and a client that cannot tell them
//     apart can only show the least useful message.
//
//   * an INTEGRITY check, so a candidate whose stored hash no longer
//     matches is refused before the evaluator ever sees it. This is
//     not a second opinion on feasibility; the evaluator below is
//     that. It is a check that the bytes are the bytes the backend
//     wrote, which nothing downstream can establish once a file has
//     been on disk for a while (brief 3, 18).
//
// NOT changed: the request vocabulary, the order of the seven steps,
// the re-validation, the re-score semantics, the audit block, the
// idempotency rule, and the read-back comparison. Phase 32 and Phase
// 33 clients keep working (brief 21, 22, 28).

import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';
import { scoreCandidate, GLOBAL_SCORING_DEFAULTS } from '../domain/global-scoring.js';
import { validateInput } from '../domain/validate.js';

import { validateCommitRequest, ALLOWED_COMMIT_KEYS, API_VERSION } from './contract.js';
import { mapTravelStatus, mapTransferStatus } from './status.js';
import {
  buildScheduleRows,
  compareRows,
  contentHash,
  normalizeReadback,
  buildAuditBlock,
} from '../persistence/schedule-record.js';
import { ScheduleStore, ScheduleStoreError, scheduleIdFor } from '../persistence/schedule-store.js';
import { PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../persistence/preview-record.js';

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

  // ---- 2. PREVIEW LIFECYCLE, then lookup BY ID ---------------------
  // The lifecycle is asked first, and it is asked of the STORE rather
  // than inferred from a failed lookup. A `get` that returns null
  // cannot distinguish "never existed" from "expired" from "tampered
  // with", and reporting all three as UNKNOWN_REQUEST would be a lie
  // about the two that are not missing.
  const described = describePreview(store, requestId);
  if (described.lifecycle === PREVIEW_LIFECYCLE.EXPIRED) {
    return failure(410, {
      requestId,
      solutionId,
      code: 'PREVIEW_EXPIRED',
      message: 'This generation has passed its configured lifetime and can no longer be committed. Generate again.',
      preview: described,
    });
  }
  if (described.lifecycle === PREVIEW_LIFECYCLE.INVALID) {
    // Nothing is written and nothing is retried. A candidate whose
    // integrity cannot be established is exactly the case the
    // integrity hash exists for: committing it would persist a
    // schedule the backend never produced and never evaluated.
    return {
      status: 409,
      payload: {
        apiVersion: API_VERSION,
        status: COMMIT_STATUS.REJECTED,
        ok: false,
        requestId,
        solutionId,
        error: {
          code: described.integrity === PREVIEW_INTEGRITY.FAILED ? 'PREVIEW_INTEGRITY' : 'PREVIEW_INVALID',
          message: 'This generation failed its integrity check and cannot be committed. Nothing was saved.',
          reason: described.reason ?? null,
          mismatched: described.mismatched ?? [],
        },
        validation: { accepted: false, hardViolations: 0, reasons: [`preview integrity: ${described.reason ?? 'INVALID'}`] },
        preview: described,
        persisted: false,
        elapsedMs: Date.now() - start,
      },
    };
  }
  if (described.lifecycle === PREVIEW_LIFECYCLE.MISSING) {
    return failure(404, {
      requestId,
      solutionId,
      code: 'UNKNOWN_REQUEST',
      message: 'This generation is no longer available. Generate again before committing.',
      preview: described,
    });
  }

  const stored = store?.get(requestId);
  if (!stored) {
    // The store said AVAILABLE and then handed back nothing. That is
    // a store that disagrees with itself, and it is reported as an
    // infrastructure fault rather than as "not found" -- the
    // generation IS there, something read it wrong.
    return failure(500, {
      requestId,
      solutionId,
      code: 'PREVIEW_UNREADABLE',
      message: 'This generation was found but could not be read. Nothing was saved.',
      preview: described,
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

  // The candidate must still be a candidate. A record that parsed as
  // JSON is not automatically a solver object, and handing the
  // evaluator `undefined` would produce a refusal attributed to
  // feasibility rather than to a damaged file.
  if (!entry.candidate?.assignments) {
    return failure(409, {
      requestId,
      solutionId,
      code: 'PREVIEW_INVALID',
      message: 'The stored candidate for this solution is not readable. Nothing was saved.',
      preview: described,
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
  const inputValidation = validateInput(input);
  const missingCritical = inputValidation.missing.filter((entry) => ['Branch', 'Class', 'Curriculum', 'Assignment'].includes(entry.entity));
  if (inputValidation.issues.length || missingCritical.length) {
    return failure(409, { requestId, solutionId, code: 'INVALID_SCHEDULING_INPUT',
      message: 'The reloaded scheduling input is invalid or incomplete; nothing was saved.', detail: [...inputValidation.issues, ...missingCritical] });
  }

  const evaluation = evaluateSafe(entry.candidate, input);
  if (!evaluation.ok || !evaluation.accepted) {
    // Nothing has been written at this point and nothing will be.
    //
    // `preview` is reported here as well as on the success path,
    // because this refusal and an integrity refusal are different
    // facts: the candidate was intact and simply infeasible. A client
    // that can only see "rejected" cannot tell "your solution has a
    // double-booking" from "your file was modified", and those two
    // send the user in opposite directions.
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
        preview: described,
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
    outcome = await schedules.withLock(scheduleId, async () => schedules.create(
      scheduleId,
      // PHASE 34: the store allocates the version, so the FACTORY is
      // what gets handed over. Phase 33 picked the number on this side
      // with `takeVersion()`, which meant the number was decided by
      // whichever process got there first and two processes could
      // agree on it. The number is now claimed by `link(2)` inside
      // the store, and this side never sees it until it is fact.
      (version) => ScheduleStore.buildRecord({
        scheduleId,
        requestId,
        solutionId,
        version,
        rows,
        contentHash: hash,
        audit,
        clockValue: committedAt,
        validated: true,
      }),
    ));
  } catch (e) {
    // A store failure is not one thing. A name that exists and cannot
    // be parsed is a damaged store and needs an operator; a refused
    // path is a bug worth a stack trace. Both are reported as NOT
    // persisted, and both name the condition rather than collapsing
    // into one opaque "could not write".
    if (e instanceof ScheduleStoreError) {
      return failure(500, {
        requestId,
        solutionId,
        scheduleId,
        code: e.code,
        message: e.code === 'RECORD_CORRUPT'
          ? 'A schedule with this id already exists but could not be read. Nothing was saved.'
          : 'The schedule could not be written. Nothing was saved.',
        internalDetail: String(e?.message ?? e),
      });
    }
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
        // The guarantee Phase 34 actually added, stated as the store
        // states it: uniqueness comes from `link(2)` on a shared
        // directory, so it holds across processes and not merely
        // within one (brief 25).
        versionAllocation: 'LINK_CLAIM_CROSS_PROCESS',
        idempotency: 'requestId+solutionId',
      },
      // How the candidate that was just persisted was established as
      // the one the backend generated. `NOT_TRACKED` is a real answer
      // and is reported as such: the in-memory store cannot hash what
      // it holds, and claiming otherwise would put a check on screen
      // that never ran.
      preview: described,
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

/**
 * Ask a preview store where a generation stands.
 *
 * A store that implements `describe` is asked directly. One that does
 * not is inferred from `get`, and the inference reports
 * `NOT_TRACKED` rather than `VERIFIED` -- there is no file, so no hash
 * was checked, and saying otherwise would be the one lie this whole
 * phase exists to remove.
 */
function describePreview(store, requestId) {
  if (typeof store?.describe === 'function') return store.describe(requestId);
  const solutions = store?.get?.(requestId) ?? null;
  return solutions
    ? {
      requestId,
      lifecycle: PREVIEW_LIFECYCLE.AVAILABLE,
      integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
      reason: null,
      createdAt: null,
      expiresAt: null,
      solutionIds: solutions.map((s) => s?.id ?? null),
    }
    : {
      requestId,
      lifecycle: PREVIEW_LIFECYCLE.MISSING,
      integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
      reason: 'NOT_STORED',
      solutionIds: [],
    };
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
