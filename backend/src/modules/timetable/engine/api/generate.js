import { validateInput } from '../domain/validate.js';
import { generateSolutions } from '../domain/multi-solution.js';
import { selectFinalSolutions } from '../domain/global-scoring.js';
import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';
import { STRATEGY_C } from '../domain/strategies.js';
import { validateGenerateRequest, API_VERSION } from './contract.js';
import { buildIndex, mapCalendar, mapDirectory, mapProvenance, mapSolution, PLACEMENT_DETAIL } from './mappers.js';
import { mapTravelStatus, mapTransferStatus } from './status.js';
import { PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../persistence/preview-record.js';
import { createHash, randomUUID } from 'node:crypto';
export const GENERATION_STATUS = Object.freeze({
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  GENERATING: 'GENERATING',
  SCORING: 'SCORING',
  COMPLETED: 'COMPLETED',
  NO_SOLUTION: 'NO_SOLUTION',
  FAILED: 'FAILED'
});
export const SCHEDULER_STATUS = Object.freeze({
  OK: 'OK',
  EMPTY: 'EMPTY',
  MISSING_DATA: 'MISSING_DATA',
  INVALID_INPUT: 'INVALID_INPUT'
});
export const GENERATION_SOLVER_OPTIONS = Object.freeze({
  perSolveTimeBudgetMs: 10_000,
  overallTimeBudgetMs: 60_000,
  maxSearchIterations: 12,
  respectStrategyMode: true,
  requireFeasibility: true
});
export class PreviewStore {
  constructor(limit = 6) {
    this.limit = limit;
    this.byId = new Map();
  }
  get driver() {
    return 'memory';
  }
  put(requestId, solutions) {
    this.byId.set(requestId, solutions);
    while (this.byId.size > this.limit) {
      const oldest = this.byId.keys().next().value;
      this.byId.delete(oldest);
    }
  }
  get(requestId) {
    return this.byId.get(requestId) ?? null;
  }
  describe(requestId) {
    const solutions = this.byId.get(requestId) ?? null;
    if (!solutions) {
      return {
        requestId,
        lifecycle: PREVIEW_LIFECYCLE.MISSING,
        integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
        reason: 'NOT_STORED',
        solutionIds: []
      };
    }
    return {
      requestId,
      lifecycle: PREVIEW_LIFECYCLE.AVAILABLE,
      integrity: PREVIEW_INTEGRITY.NOT_TRACKED,
      reason: null,
      createdAt: null,
      expiresAt: null,
      solutionIds: solutions.map(s => s?.id ?? null)
    };
  }
  clear() {
    this.byId.clear();
  }
}
let requestCounter = 0;
const PROCESS_TAG = createHash('sha256').update(`${process.pid}:${randomUUID()}`).digest('hex').slice(0, 8);
function nextRequestId() {
  requestCounter += 1;
  return `req-${requestCounter.toString(36).padStart(6, '0')}-${PROCESS_TAG}`;
}
export async function generateSchedules(options = {}) {
  const {
    body,
    deps,
    placementDetail = PLACEMENT_DETAIL.ALL
  } = options;
  const start = Date.now();
  const stages = [];
  const mark = status => stages.push({
    status,
    atMs: Date.now() - start
  });
  mark(GENERATION_STATUS.REQUEST_RECEIVED);
  const requestId = nextRequestId();
  const validated = validateGenerateRequest(body);
  if (!validated.ok) {
    mark(GENERATION_STATUS.FAILED);
    return {
      status: 400,
      payload: {
        apiVersion: API_VERSION,
        requestId,
        status: SCHEDULER_STATUS.INVALID_INPUT,
        generation: {
          status: GENERATION_STATUS.FAILED,
          stages,
          totalTimeMs: Date.now() - start
        },
        strategy: null,
        solutions: [],
        diagnostics: {
          errors: validated.issues,
          solver: null,
          scoring: null,
          data: null
        },
        errors: validated.issues
      }
    };
  }
  const request = validated.request;
  mark(GENERATION_STATUS.GENERATING);
  let loaded;
  try {
    loaded = await deps.loadDataset();
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'DATASET_LOAD_FAILED', e);
  }
  const {
    input,
    provenance
  } = loaded;
  const index = buildIndex(input);
  const {
    issues,
    missing
  } = validateInput(input);
  if (issues.length > 0) {
    mark(GENERATION_STATUS.FAILED);
    return {
      status: 400,
      payload: basePayload(requestId, SCHEDULER_STATUS.INVALID_INPUT, {
        generation: generationBlock(GENERATION_STATUS.FAILED, stages, start),
        errors: issues.map(i => ({
          field: `${i.entity ?? ''}${i.entityId ? `/${i.entityId}` : ''}/${i.field ?? ''}`.replace(/^\/+/, ''),
          code: 'INVALID_INPUT',
          message: `${i.entity ?? 'entity'} ${i.entityId ?? ''} ${i.field ?? ''}: ${i.detail ?? ''}`.trim()
        })),
        data: {
          provenance: mapProvenance(provenance),
          missingData: missing,
          warnings: input.warnings ?? []
        }
      })
    };
  }
  const hasMissingCriticalData = missing.some(m => ['Branch', 'Class', 'Curriculum', 'Assignment'].includes(m.entity));
  if (hasMissingCriticalData) {
    mark(GENERATION_STATUS.NO_SOLUTION);
    return {
      status: 200,
      payload: basePayload(requestId, SCHEDULER_STATUS.MISSING_DATA, {
        generation: generationBlock(GENERATION_STATUS.NO_SOLUTION, stages, start),
        errors: missing.map(m => ({
          field: `${m.entity ?? ''}/${m.field ?? ''}`,
          code: 'MISSING_DATA',
          message: m.reason ?? `${m.entity} is missing`
        })),
        data: {
          provenance: mapProvenance(provenance),
          missingData: missing,
          warnings: input.warnings ?? []
        }
      })
    };
  }
  const strategy = {
    ...(input.strategy ?? STRATEGY_C),
    optimizationMode: request.optimizationMode
  };
  const planned = {
    input: {
      ...input,
      strategy
    },
    applied: {
      strategy,
      scoringConfig: null
    },
    timing: {
      totalMs: 0
    }
  };
  const count = request.candidateCount;
  let generated;
  try {
    generated = generateSolutions(planned.input, {
      ...GENERATION_SOLVER_OPTIONS,
      overallTimeBudgetMs: Math.max(GENERATION_SOLVER_OPTIONS.overallTimeBudgetMs, count * 12_000),
      count,
      seed: 0xC0FFEE
    });
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'SOLVER_THREW', e);
  }
  mark(GENERATION_STATUS.SCORING);
  const byReference = new Map();
  for (const wrapper of generated.solutions) {
    if (wrapper?.candidate) byReference.set(wrapper.candidate, wrapper);
  }
  const candidates = generated.solutions.map(w => w.candidate).filter(Boolean);
  let scored;
  try {
    scored = selectFinalSolutions(candidates, {
      count,
      input: planned.input,
      scoringConfig: planned.applied?.scoringConfig ?? null,
      requireFeasibility: true
    });
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'SCORING_THREW', e);
  }
  const accepted = [];
  for (const solution of scored.solutions) {
    const evaluation = evaluateSafe(solution.candidate, planned.input);
    if (!evaluation.ok || !evaluation.accepted) continue;
    const wrapper = byReference.get(solution.candidate);
    accepted.push({
      solution,
      id: solution.id ?? wrapper?.id ?? null,
      multiSolutionId: wrapper?.id ?? null,
      evaluation,
      candidate: solution.candidate
    });
  }
  const solutions = accepted.map(({
    solution,
    id,
    multiSolutionId,
    evaluation,
    candidate
  }, idx) => {
    const mapped = mapSolution({
      ...solution,
      id: multiSolutionId ?? id
    }, {
      candidate: solution.candidate,
      index
    });
    return {
      ...mapped,
      rank: idx + 1,
      validation: {
        accepted: evaluation.accepted,
        hardViolations: evaluation.hardViolations,
        reasons: evaluation.reasons
      },
      _candidate: candidate
    };
  });
  const ids = solutions.map(s => s.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => id != null && ids.indexOf(id) !== i))];
  const strategyInfo = mapStrategyInfo({
    request,
    planned,
    count
  });
  const previewStore = deps.previewStore;
  let previewPersistence = null;
  if (previewStore) {
    try {
      const stored = await previewStore.put(requestId, solutions.map(s => ({
        id: s.id,
        solution: stripCandidate(s),
        candidate: s._candidate,
        strategy: strategyInfo
      })));
      previewPersistence = {
        stored: stored?.stored !== false,
        duplicate: stored?.duplicate === true,
        driver: previewStore.driver ?? 'unknown',
        reason: stored?.reason ?? null
      };
    } catch (e) {
      previewPersistence = {
        stored: false,
        duplicate: false,
        driver: previewStore.driver ?? 'unknown',
        reason: String(e?.message ?? e)
      };
    }
  }
  const responseSolutions = solutions.map((s, idx) => {
    const {
      _candidate,
      ...rest
    } = s;
    const withDetail = shouldIncludePlacements(placementDetail, idx) ? s : {
      ...rest,
      placements: []
    };
    return withoutCandidate(withDetail);
  });
  const status = responseSolutions.length > 0 ? SCHEDULER_STATUS.OK : SCHEDULER_STATUS.EMPTY;
  mark(status === SCHEDULER_STATUS.OK ? GENERATION_STATUS.COMPLETED : GENERATION_STATUS.NO_SOLUTION);
  const payload = basePayload(requestId, status, {
    generation: generationBlock(status === SCHEDULER_STATUS.OK ? GENERATION_STATUS.COMPLETED : GENERATION_STATUS.NO_SOLUTION, stages, start),
    strategy: strategyInfo,
    solutions: responseSolutions,
    previewPersistence,
    errors: [],
    placementDetail: {
      level: placementDetail,
      includedSolutionRanks: responseSolutions.filter((_, idx) => shouldIncludePlacements(placementDetail, idx)).map(s => s.rank),
      note: 'Re-run with ?placements=all to include every solution\'s slots.'
    },
    calendar: mapCalendar(input, index),
    directory: mapDirectory(input, index),
    travel: mapTravelStatus(input, responseSolutions[0] ?? null),
    transfer: mapTransferStatus(input, responseSolutions[0] ?? null),
    diagnostics: {
      errors: [],
      solver: generated.diagnostics,
      scoring: scored.diagnostics,
      data: {
        provenance: mapProvenance(provenance),
        missingData: missing,
        warnings: input.warnings ?? []
      },
      duplicateSolutionIds: duplicateIds,
      timing: {
        totalTimeMs: Date.now() - start,
        solverMs: generated.diagnostics?.generationMs ?? null,
        scoringMs: scored.diagnostics?.totalTimeMs ?? null,
        breakdown: {
          solveMs: generated.diagnostics?.generationMs ?? null,
          scoreMs: scored.diagnostics?.totalTimeMs ?? null,
          strategyMs: planned?.timing?.totalMs ?? 0,
          apiOverheadMs: Math.max(0, Date.now() - start - (generated.diagnostics?.generationMs ?? 0) - (scored.diagnostics?.totalTimeMs ?? 0) - (planned?.timing?.totalMs ?? 0))
        }
      }
    }
  });
  return {
    status: 200,
    payload
  };
}
function shouldIncludePlacements(level, idx) {
  if (level === PLACEMENT_DETAIL.ALL) return true;
  if (level === PLACEMENT_DETAIL.SELECTED) return idx === 0;
  return false;
}
function withoutCandidate(solution) {
  const {
    _candidate,
    ...rest
  } = solution;
  return rest;
}
function stripCandidate(solution) {
  return withoutCandidate(solution);
}
export { commit, COMMIT_STATUS, describeCommitted, readCommitted } from './commit.js';
function basePayload(requestId, status, extra) {
  return {
    apiVersion: API_VERSION,
    requestId,
    status,
    ...extra
  };
}
function generationBlock(status, stages, start) {
  return {
    status,
    stages,
    totalTimeMs: Date.now() - start
  };
}
function infrastructureFailure(requestId, stages, start, code, error) {
  return {
    status: 500,
    payload: {
      apiVersion: API_VERSION,
      requestId,
      status: SCHEDULER_STATUS.INVALID_INPUT,
      generation: generationBlock(GENERATION_STATUS.FAILED, stages, start),
      strategy: null,
      solutions: [],
      diagnostics: {
        errors: [{
          field: 'pipeline',
          code,
          message: 'The scheduling pipeline failed. See the server log for details.'
        }],
        internalDetail: String(error?.message ?? error)
      },
      errors: [{
        field: 'pipeline',
        code,
        message: 'The scheduling pipeline failed. See the server log for details.'
      }]
    }
  };
}
function evaluateSafe(candidate, input) {
  try {
    const placements = new Map();
    if (candidate?.placements instanceof Map) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, {
          teacherId: p.teacherId,
          branchId: p.branchId
        });
      }
    } else if (Array.isArray(candidate?.placements)) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, {
          teacherId: p.teacherId,
          branchId: p.branchId
        });
      }
    }
    const evaluation = evaluateCandidate({
      assignments: candidate?.assignments,
      placements
    }, input);
    return {
      ok: true,
      accepted: isAccepted(evaluation),
      hardViolations: evaluation?.summary?.totalHardViolations ?? 0,
      reasons: evaluation?.summary?.reasons ?? []
    };
  } catch (e) {
    return {
      ok: false,
      accepted: false,
      hardViolations: 0,
      reasons: [`evaluation failed: ${String(e?.message ?? e)}`]
    };
  }
}
function mapStrategyInfo({
  request,
  planned,
  count
}) {
  const applied = planned.applied?.strategy ?? {};
  return {
    optimizationMode: request.optimizationMode,
    appliedOptimizationMode: applied.optimizationMode ?? null,
    modeSource: 'DETERMINISTIC',
    candidateCount: count,
    seed: 0xC0FFEE,
    baseStrategyId: applied.id ?? null
  };
}
