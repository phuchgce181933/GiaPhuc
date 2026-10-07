import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';
import { scoreCandidate, GLOBAL_SCORING_DEFAULTS } from '../domain/global-scoring.js';
import { validateInput } from '../domain/validate.js';
import { validateCommitRequest, ALLOWED_COMMIT_KEYS, API_VERSION } from './contract.js';
import { mapTravelStatus, mapTransferStatus } from './status.js';
import { buildIndex, mapDirectory, mapCalendar } from './mappers.js';
import { buildScheduleRows, compareRows, contentHash, normalizeReadback, buildAuditBlock } from '../persistence/schedule-record.js';
import { ScheduleStore, ScheduleStoreError, scheduleIdFor } from '../persistence/schedule-store.js';
import { PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../persistence/preview-record.js';
export const COMMIT_STATUS = Object.freeze({
  COMMITTED: 'COMMITTED',
  COMMITTED_DUPLICATE: 'COMMITTED_DUPLICATE',
  REJECTED: 'COMMIT_REJECTED'
});
export async function commit(options = {}) {
  const {
    body,
    requestId: bodyRequestId,
    solutionId: bodySolutionId,
    deps
  } = options;
  const start = Date.now();
  const store = deps?.previewStore;
  const schedules = deps?.scheduleStore;
  const effectiveBody = body !== undefined && body !== null ? body : {
    requestId: bodyRequestId,
    solutionId: bodySolutionId
  };
  const validated = validateCommitRequest(effectiveBody);
  if (!validated.ok) {
    return failure(400, {
      errors: validated.issues,
      detail: `A commit request may only carry: ${ALLOWED_COMMIT_KEYS.join(', ')}.`
    });
  }
  const {
    requestId,
    solutionId
  } = validated.request;
  if (!schedules) {
    return failure(500, {
      code: 'PERSISTENCE_UNAVAILABLE',
      message: 'This deployment has no schedule store configured, so nothing can be committed.'
    });
  }
  const described = await describePreview(store, requestId);
  if (described.lifecycle === PREVIEW_LIFECYCLE.EXPIRED) {
    return failure(410, {
      requestId,
      solutionId,
      code: 'PREVIEW_EXPIRED',
      message: 'This generation has passed its configured lifetime and can no longer be committed. Generate again.',
      preview: described
    });
  }
  if (described.lifecycle === PREVIEW_LIFECYCLE.INVALID) {
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
          mismatched: described.mismatched ?? []
        },
        validation: {
          accepted: false,
          hardViolations: 0,
          reasons: [`preview integrity: ${described.reason ?? 'INVALID'}`]
        },
        preview: described,
        persisted: false,
        elapsedMs: Date.now() - start
      }
    };
  }
  if (described.lifecycle === PREVIEW_LIFECYCLE.MISSING) {
    return failure(404, {
      requestId,
      solutionId,
      code: 'UNKNOWN_REQUEST',
      message: 'This generation is no longer available. Generate again before committing.',
      preview: described
    });
  }
  const stored = await store?.get(requestId);
  if (!stored) {
    return failure(500, {
      requestId,
      solutionId,
      code: 'PREVIEW_UNREADABLE',
      message: 'This generation was found but could not be read. Nothing was saved.',
      preview: described
    });
  }
  const entry = stored.find(e => e.id === solutionId);
  if (!entry) {
    return failure(404, {
      requestId,
      solutionId,
      code: 'UNKNOWN_SOLUTION',
      message: `Solution ${solutionId} is not part of generation ${requestId}.`,
      errorExtra: {
        available: stored.map(e => e.id)
      }
    });
  }
  if (!entry.candidate?.assignments) {
    return failure(409, {
      requestId,
      solutionId,
      code: 'PREVIEW_INVALID',
      message: 'The stored candidate for this solution is not readable. Nothing was saved.',
      preview: described
    });
  }
  let loaded;
  try {
    loaded = await deps.loadDataset();
  } catch {
    return failure(500, {
      requestId,
      solutionId,
      code: 'REVALIDATION_UNAVAILABLE',
      message: 'Could not re-load the scheduling input to re-validate this solution.'
    });
  }
  const {
    input,
    provenance
  } = loaded;
  const inputValidation = validateInput(input);
  const missingCritical = inputValidation.missing.filter(entry => ['Branch', 'Class', 'Curriculum', 'Assignment'].includes(entry.entity));
  if (inputValidation.issues.length || missingCritical.length) {
    return failure(409, {
      requestId,
      solutionId,
      code: 'INVALID_SCHEDULING_INPUT',
      message: 'The reloaded scheduling input is invalid or incomplete; nothing was saved.',
      detail: [...inputValidation.issues, ...missingCritical]
    });
  }
  const evaluation = evaluateSafe(entry.candidate, input);
  if (!evaluation.ok || !evaluation.accepted) {
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
          reasons: evaluation.reasons
        },
        validation: {
          accepted: false,
          hardViolations: evaluation.hardViolations,
          reasons: evaluation.reasons
        },
        preview: described,
        persisted: false,
        elapsedMs: Date.now() - start
      }
    };
  }
  const recheck = rescoreSafe(entry.candidate, input, deps.scoringConfig ?? GLOBAL_SCORING_DEFAULTS);
  const sourceSolution = entry.solution ?? {};
  const score = {
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
      note: 'Re-scored against the single-candidate pool, so per-dimension normalization is ' + 'neutral at n=1. This confirms feasibility; it does not re-rank.'
    }
  };
  const {
    rows,
    warnings
  } = buildScheduleRows(entry.candidate, input);
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
          reasons: warnings.map(w => w.message)
        },
        validation: {
          accepted: true,
          hardViolations: 0,
          reasons: warnings.map(w => `${w.code}: ${w.message}`)
        },
        persisted: false,
        elapsedMs: Date.now() - start
      }
    };
  }
  const hash = contentHash(rows);
  const scheduleId = scheduleIdFor(requestId, solutionId);
  const committedAt = deps.now ? deps.now() : new Date().toISOString();
  const audit = buildAuditBlock({
    actorId: deps.actorId ?? null,
    requestId,
    solutionId,
    provenance,
    strategy: entry.strategy ?? null,
    rank: sourceSolution.rank ?? null,
    score
  });
  let outcome;
  try {
    outcome = await schedules.withLock(scheduleId, async () => schedules.create(scheduleId, version => ({
      ...ScheduleStore.buildRecord({
        scheduleId,
        requestId,
        solutionId,
        version,
        rows,
        contentHash: hash,
        audit,
        clockValue: committedAt,
        validated: true
      }),
      directory: mapDirectory(input, buildIndex(input)),
      calendar: mapCalendar(input, buildIndex(input)),
      travel: mapTravelStatus(input, null)
    })));
  } catch (e) {
    if (e instanceof ScheduleStoreError) {
      return failure(500, {
        requestId,
        solutionId,
        scheduleId,
        code: e.code,
        message: e.code === 'RECORD_CORRUPT' ? 'A schedule with this id already exists but could not be read. Nothing was saved.' : 'The schedule could not be written. Nothing was saved.',
        internalDetail: String(e?.message ?? e)
      });
    }
    return failure(500, {
      requestId,
      solutionId,
      code: 'PERSISTENCE_FAILED',
      message: 'The schedule could not be written. Nothing was saved.',
      internalDetail: String(e?.message ?? e)
    });
  }
  const storedRecord = outcome.record;
  const duplicate = outcome.created === false;
  const readBack = await schedules.read(scheduleId);
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
        onlyInStore: diff.onlyInRight.length
      }
    });
  }
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
      written: true,
      slotCount: readRows.length,
      contentHash: storedRecord.contentHash ?? hash,
      persistence: {
        implemented: true,
        mode: 'COMMIT_ENABLED',
        driver: schedules.driver ?? 'file',
        atomic: true,
        location: relativeLocation(schedules),
        versionAllocation: schedules.driver === 'mongodb' ? 'MONGODB_COUNTER' : 'LINK_CLAIM_CROSS_PROCESS',
        idempotency: 'requestId+solutionId'
      },
      preview: described,
      validation: {
        accepted: true,
        hardViolations: 0,
        reasons: [],
        constraintStatuses: evaluation.constraintStatuses ?? null
      },
      score,
      travel: mapTravelStatus(input, null),
      transfer: mapTransferStatus(input, null),
      readback: {
        slots: readRows.length,
        matchesCandidate: true
      },
      elapsedMs: Date.now() - start
    }
  };
}
export async function describeCommitted(schedules, scheduleId) {
  const record = await schedules?.read?.(scheduleId);
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
    audit: record.audit ?? null
  };
}
export async function readCommitted(schedules, scheduleId) {
  const record = await schedules?.read?.(scheduleId);
  if (!record) return null;
  return {
    ...(await describeCommitted(schedules, scheduleId)),
    directory: record.directory ?? null,
    calendar: record.calendar ?? null,
    travel: record.travel ?? null,
    slots: normalizeReadback(record)
  };
}
function evaluateSafe(candidate, input) {
  try {
    const placements = new Map();
    const raw = candidate?.placements;
    const entries = raw instanceof Map ? raw.entries() : Array.isArray(raw) ? raw : [];
    for (const [aId, p] of entries) {
      placements.set(aId, {
        teacherId: p?.teacherId,
        branchId: p?.branchId
      });
    }
    const evaluation = evaluateCandidate({
      assignments: candidate?.assignments,
      placements
    }, input);
    return {
      ok: true,
      accepted: isAccepted(evaluation),
      hardViolations: evaluation?.summary?.totalHardViolations ?? 0,
      reasons: evaluation?.summary?.reasons ?? [],
      constraintStatuses: evaluation?.constraintStatuses ?? null
    };
  } catch (e) {
    return {
      ok: false,
      accepted: false,
      hardViolations: 0,
      reasons: [`evaluation failed: ${String(e?.message ?? e)}`],
      constraintStatuses: null
    };
  }
}
function rescoreSafe(candidate, input, config) {
  try {
    const scored = scoreCandidate(candidate, {
      input,
      pool: [candidate],
      config
    });
    return {
      feasibility: scored?.feasibility ?? null,
      hardViolations: scored?.hardViolations ?? 0
    };
  } catch {
    return {
      feasibility: null,
      hardViolations: null
    };
  }
}
function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
async function describePreview(store, requestId) {
  if (typeof store?.describe === 'function') return store.describe(requestId);
  const solutions = (await store?.get?.(requestId)) ?? null;
  return solutions ? {
    requestId,
    lifecycle: PREVIEW_LIFECYCLE.AVAILABLE,
    integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
    reason: null,
    createdAt: null,
    expiresAt: null,
    solutionIds: solutions.map(s => s?.id ?? null)
  } : {
    requestId,
    lifecycle: PREVIEW_LIFECYCLE.MISSING,
    integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
    reason: 'NOT_STORED',
    solutionIds: []
  };
}
function failure(httpStatus, extra) {
  const {
    code,
    message,
    detail,
    errorExtra,
    internalDetail,
    ...rest
  } = extra;
  return {
    status: httpStatus,
    payload: {
      apiVersion: API_VERSION,
      status: COMMIT_STATUS.REJECTED,
      ok: false,
      persisted: false,
      ...(code ? {
        error: {
          code,
          message,
          ...(detail ? {
            detail
          } : {}),
          ...(errorExtra ?? {})
        }
      } : {}),
      ...rest,
      ...(internalDetail ? {
        diagnostics: {
          internalDetail
        }
      } : {})
    }
  };
}
function relativeLocation(store) {
  const dir = store?.dir ?? null;
  return dir ? String(dir) : null;
}
export { ALLOWED_COMMIT_KEYS };
