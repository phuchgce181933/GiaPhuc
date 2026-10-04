// PHASE 32 — GENERATION SERVICE.
//
// The one place where the whole backend pipeline is assembled for a
// user-facing request:
//
//   legacy-derived SchedulingInput        (loadDataset — a dependency)
//        ↓
//   validateInput                         (Phase 14 pre-scheduler gate)
//        ↓
//   planStrategy                          (Phase 29 AI boundary, optional)
//        ↓
//   generateSolutions                     (Phase 27 multi-solution)
//        ↓
//   selectFinalSolutions                  (Phase 28 global scoring)
//        ↓
//   mappers.js                            (PII boundary → response)
//
// WHY THIS IS A SEPARATE MODULE FROM `orchestrator/index.js`
// ---------------------------------------------------------
// The Phase 14-17 orchestrator is a different pipeline, not an older
// version of this one. It runs the pre-Phase-24 `solve()` path once
// per A/B/C strategy preset and scores with the Phase 17 scorer; it
// has no multi-solution layer, no Phase 28 global scoring, no AI
// boundary, and no situation report. It is still mounted at
// `/api/scheduling/*` and is still exercised by the Phase 14-21
// tests, so it is left exactly as it is. Reusing it here would have
// meant either dropping the layers Phase 27-29 added or rewriting
// the old orchestrator and the tests that pin its behaviour. Neither
// is a Phase 32 change to make silently, so the new pipeline is a new
// module and the difference is documented in
// `docs/PHASE_32_E2E_API_UI.md`.
//
// NO WRITE HAPPENS HERE
// ---------------------
// `generateSchedules` never writes. The write path is `commit.js`,
// which is the only module in the tree that holds a `ScheduleStore`,
// and this module cannot reach one. Generate still keeps the SOLUTION
// OBJECTS in an in-process preview cache, so `/commit` can re-validate
// the exact solver candidate before it persists it, and it never
// mutates a stored schedule (brief §20, §21).
//
// THE FOUR SCHEDULER STATUSES
// ---------------------------
// `OK | EMPTY | MISSING_DATA | INVALID_INPUT` are the Phase 16
// contract and are preserved verbatim. They are not collapsed into a
// generic error, and EMPTY in particular is NOT an error: it means
// the pipeline ran and no candidate was hard-feasible, which is a
// different statement from "the request was malformed" and a
// different statement again from "the data is incomplete".
//
// The six GENERATION STAGES are a separate axis. A single HTTP
// request passes through them in order and the response records the
// timeline, so a client can tell a slow solve from a fast rejection
// without parsing a log (brief §8).

import { validateInput } from '../domain/validate.js';
import { planStrategy, fallbackDecision, applyDecisionToInput } from '../domain/ai/index.js';
import { generateSolutions } from '../domain/multi-solution.js';
import { selectFinalSolutions } from '../domain/global-scoring.js';
import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';
import { STRATEGY_C } from '../domain/strategies.js';

import { validateGenerateRequest, API_VERSION } from './contract.js';
import {
  buildIndex,
  mapCalendar,
  mapDirectory,
  mapProvenance,
  mapSolution,
  PLACEMENT_DETAIL,
} from './mappers.js';
import { mapTravelStatus, mapTransferStatus, mapAiStatus } from './status.js';

/** The generation stage vocabulary (brief §8). */
export const GENERATION_STATUS = Object.freeze({
  REQUEST_RECEIVED: 'REQUEST_RECEIVED',
  GENERATING: 'GENERATING',
  SCORING: 'SCORING',
  COMPLETED: 'COMPLETED',
  NO_SOLUTION: 'NO_SOLUTION',
  FAILED: 'FAILED',
});

/** The Phase 16 scheduler statuses (brief §9). */
export const SCHEDULER_STATUS = Object.freeze({
  OK: 'OK',
  EMPTY: 'EMPTY',
  MISSING_DATA: 'MISSING_DATA',
  INVALID_INPUT: 'INVALID_INPUT',
});

/**
 * Solver conditions for an interactive request.
 *
 * The wall-clock budgets are safety valves, not the determinism
 * mechanism. Phase 31.1 established that a wall-clock bound makes the
 * result a property of the machine: on a busy host the search stops
 * earlier and a different candidate wins. `maxSearchIterations` is a
 * COUNT, so the same request produces the same solutions on any
 * host, and the two budgets below are sized to be far above what a
 * bounded search actually needs.
 *
 * They are still here because a pathological input must not be able
 * to hold an HTTP request open, and because an unbounded solve is
 * exactly the failure mode the caller cannot see from the outside.
 */
export const GENERATION_SOLVER_OPTIONS = Object.freeze({
  perSolveTimeBudgetMs: 10_000,
  overallTimeBudgetMs: 60_000,
  maxSearchIterations: 12,
  // `true` because the mode in `input.strategy` is the APPROVED
  // mode: it came out of `planStrategy`, which validated it against
  // the allow-list, or it came from the deterministic fallback. It
  // is never a raw provider string. See the note in
  // `runner.js` (Phase 31) on why this flag is the difference
  // between measuring a strategy and discarding it.
  respectStrategyMode: true,
  requireFeasibility: true,
});

/**
 * In-process preview cache.
 *
 * Bounded, because it holds full solution objects and a server that
 * leaks them is a memory leak with a UI on the other end. The bound
 * is insertion-ordered (a `Map` preserves it), so eviction removes
 * the OLDEST generation first and the most recent results — the ones
 * a user is looking at — survive.
 */
export class PreviewStore {
  constructor(limit = 6) {
    this.limit = limit;
    this.byId = new Map();
  }

  /** Store one generation's solutions under a single request id. */
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

  clear() {
    this.byId.clear();
  }
}

/** Monotonic-per-process request id. Not a UUID and not persisted. */
let requestCounter = 0;
function nextRequestId() {
  requestCounter += 1;
  return `req-${requestCounter.toString(36).padStart(6, '0')}`;
}

// ============================================================================
// generate
// ============================================================================

/**
 * generateSchedules({ body, deps, placementDetail }) -> { status, payload }
 *
 * `deps` carries everything environment-specific, so the whole
 * pipeline is exercisable in a test against a controlled fixture
 * (brief §35) with no server and no BSON on disk:
 *
 *   loadDataset()  -> { input, provenance }
 *   makePlanner()  -> an AIPlanner, or null
 *   previewStore   -> a PreviewStore
 *   aiProviderName -> the configured provider, for the status block
 *
 * `placementDetail` selects how many solutions carry their full slot
 * table (brief §40). It is validated by the route, and an
 * unrecognized value is refused there rather than silently treated as
 * the default.
 */
export async function generateSchedules(options = {}) {
  const { body, deps, placementDetail = PLACEMENT_DETAIL.ALL } = options;
  const start = Date.now();
  const stages = [];
  const mark = (status) => stages.push({ status, atMs: Date.now() - start });
  mark(GENERATION_STATUS.REQUEST_RECEIVED);

  const requestId = nextRequestId();

  // ---- 1. REQUEST VALIDATION (before anything else) --------------
  // The solver does not run for a malformed request. Not "runs and
  // then reports", not "runs and is ignored" — never runs (brief §22,
  // §34).
  const validated = validateGenerateRequest(body);
  if (!validated.ok) {
    mark(GENERATION_STATUS.FAILED);
    return {
      status: 400,
      payload: {
        apiVersion: API_VERSION,
        requestId,
        status: SCHEDULER_STATUS.INVALID_INPUT,
        generation: { status: GENERATION_STATUS.FAILED, stages, totalTimeMs: Date.now() - start },
        ai: null,
        strategy: null,
        solutions: [],
        diagnostics: { errors: validated.issues, solver: null, scoring: null, data: null },
        errors: validated.issues,
      },
    };
  }
  const request = validated.request;

  // ---- 2. DATA ---------------------------------------------------
  mark(GENERATION_STATUS.GENERATING);
  let loaded;
  try {
    loaded = deps.loadDataset();
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'DATASET_LOAD_FAILED', e);
  }
  const { input, provenance } = loaded;
  const index = buildIndex(input);

  // ---- 3. PRE-SCHEDULER VALIDATION (Phase 14) --------------------
  // `issues` is structural damage -> refuse. `missing` is a
  // legitimate absence of optional data -> report, do not refuse.
  const { issues, missing } = validateInput(input);
  if (issues.length > 0) {
    mark(GENERATION_STATUS.FAILED);
    return {
      status: 400,
      payload: basePayload(requestId, SCHEDULER_STATUS.INVALID_INPUT, {
        generation: generationBlock(GENERATION_STATUS.FAILED, stages, start),
        errors: issues.map((i) => ({
          field: `${i.entity ?? ''}${i.entityId ? `/${i.entityId}` : ''}/${i.field ?? ''}`.replace(/^\/+/, ''),
          code: 'INVALID_INPUT',
          message: `${i.entity ?? 'entity'} ${i.entityId ?? ''} ${i.field ?? ''}: ${i.detail ?? ''}`.trim(),
        })),
        data: { provenance: mapProvenance(provenance), missingData: missing, warnings: input.warnings ?? [] },
      }),
    };
  }

  const hasMissingCriticalData = missing.some(
    (m) => ['Branch', 'Class', 'Curriculum', 'Assignment'].includes(m.entity),
  );
  if (hasMissingCriticalData) {
    mark(GENERATION_STATUS.NO_SOLUTION);
    return {
      status: 200,
      payload: basePayload(requestId, SCHEDULER_STATUS.MISSING_DATA, {
        generation: generationBlock(GENERATION_STATUS.NO_SOLUTION, stages, start),
        // MISSING_DATA is a 200, not a 400: the request was valid and
        // the data is what is absent. The UI renders it as an empty
        // state with a reason, never as an error banner.
        errors: missing.map((m) => ({
          field: `${m.entity ?? ''}/${m.field ?? ''}`,
          code: 'MISSING_DATA',
          message: m.reason ?? `${m.entity} is missing`,
        })),
        data: { provenance: mapProvenance(provenance), missingData: missing, warnings: input.warnings ?? [] },
      }),
    };
  }

  // ---- 4. AI STRATEGY BOUNDARY (optional) -------------------------
  // The planner is null when the client sent `useAI: false`. That is
  // not a failure and not a 500: `planStrategy` treats "no planner"
  // as the deterministic-fallback arm, which is the same code path
  // the benchmark's baseline arm uses (brief §7, §33).
  const planner = request.useAI ? deps.makePlanner() : null;
  const baseStrategy = {
    ...(input.strategy ?? STRATEGY_C),
    optimizationMode: request.optimizationMode,
  };

  let planned;
  try {
    planned = await planStrategy(input, {
      planner,
      baseStrategy,
      requestedCandidateCount: request.candidateCount,
      revalidate: true,
    });
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'PLAN_THREW', e);
  }

  // The client's explicit `optimizationMode` is authoritative on
  // every fallback path. `fallbackDecision` is given the override so
  // that "AI off" / "AI unreachable" / "AI output rejected" all
  // produce the mode the user asked for instead of the global
  // default. When the AI IS available and approved a different mode,
  // that mode wins — it went through the allow-list — and the
  // response reports both, so the difference is visible rather than
  // silent.
  if (planned.fallbackUsed && request.optimizationMode) {
    const forced = applyDecisionToInput(
      input,
      fallbackDecision(input, {
        optimizationMode: request.optimizationMode,
        candidateCount: request.candidateCount,
      }),
      baseStrategy,
    );
    planned = { ...planned, input: forced.input, applied: forced.applied, fallbackModeForced: true };
  }

  const ai = mapAiStatus({
    request,
    planner,
    planned,
    configuredProvider: deps.aiProviderName ?? null,
  });

  // ---- 5. MULTI-SOLUTION -----------------------------------------
  // The count is the CLIENT's count. The AI's preferred
  // `candidateCount` is echoed back in `ai.decision` for the audit,
  // but it does not change what the client gets: a client that asked
  // for 5 and received 3 would be a contract violation, and the AI is
  // an optimization, not the customer.
  const count = request.candidateCount;
  let generated;
  try {
    generated = generateSolutions(planned.input, {
      ...GENERATION_SOLVER_OPTIONS,
      count,
      seed: 0xC0FFEE,
    });
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'SOLVER_THREW', e);
  }

  // ---- 6. GLOBAL SCORING -----------------------------------------
  mark(GENERATION_STATUS.SCORING);
  // Phase 27 returns solution WRAPPERS (`{ id, candidate, ... }`)
  // while Phase 28 wants bare candidates. Passing the wrappers would
  // make the feasibility gate read `wrapper.assignments` —
  // undefined — and accept an empty candidate as feasible. This is
  // the same unwrap the benchmark runner performs, for the same
  // reason.
  //
  // The wrapper is kept alongside each candidate so the response can
  // report the Phase 27 multi-solution id (`ms-…`) rather than the
  // solver's per-iteration id. Identity is by OBJECT REFERENCE, not
  // by array index: an index is not an identity, and two iterations
  // can legitimately produce candidates in a different order than
  // they were generated (brief §11).
  const byReference = new Map();
  for (const wrapper of generated.solutions) {
    if (wrapper?.candidate) byReference.set(wrapper.candidate, wrapper);
  }
  const candidates = generated.solutions.map((w) => w.candidate).filter(Boolean);

  let scored;
  try {
    scored = selectFinalSolutions(candidates, {
      count,
      input: planned.input,
      scoringConfig: planned.applied?.scoringConfig ?? null,
      requireFeasibility: true,
    });
  } catch (e) {
    return infrastructureFailure(requestId, stages, start, 'SCORING_THREW', e);
  }

  // ---- 7. INDEPENDENT VALIDATION ----------------------------------
  // Phase 28 already gated the pool on the independent evaluator.
  // It is re-run here because this response is the one a human acts
  // on: the same `evaluateCandidate` the tests use, re-applied to
  // what is actually about to be serialized, so the reported verdict
  // belongs to the reported schedule and not to an intermediate
  // object. A solution that fails here is DROPPED rather than
  // reported as invalid — an infeasible timetable must never reach a
  // user-facing list, even labelled (brief §32).
  const accepted = [];
  for (const solution of scored.solutions) {
    const evaluation = evaluateSafe(solution.candidate, planned.input);
    if (!evaluation.ok || !evaluation.accepted) continue;
    const wrapper = byReference.get(solution.candidate);
    accepted.push({
      solution,
      id: solution.id ?? wrapper?.id ?? null,
      // The Phase 27 id is the multi-solution-unique one, so it is
      // preferred over the solver's per-iteration id, which two
      // iterations can collide on.
      multiSolutionId: wrapper?.id ?? null,
      evaluation,
      // Kept so `/commit` re-validates this exact solver object.
      candidate: solution.candidate,
    });
  }

  const solutions = accepted.map(({ solution, id, multiSolutionId, evaluation, candidate }, idx) => {
    const mapped = mapSolution({ ...solution, id: multiSolutionId ?? id }, {
      candidate: solution.candidate,
      index,
    });
    return {
      ...mapped,
      rank: idx + 1,
      validation: {
        accepted: evaluation.accepted,
        hardViolations: evaluation.hardViolations,
        reasons: evaluation.reasons,
      },
      // Held in the return value, never serialized. The preview store
      // needs the SOLVER candidate so `/commit` can re-validate the
      // exact object that was evaluated, and rebuilding a
      // solver-shaped candidate from the flattened rows would be a
      // second, subtly different implementation of the same thing.
      _candidate: candidate,
    };
  });

  // Uniqueness is asserted, not assumed: a duplicate id would make
  // React's key reconciliation and the "select solution" round-trip
  // point at the wrong row (brief §11). A collision here is a defect
  // in the id derivation, so it is reported rather than papered over
  // with the array index.
  const ids = solutions.map((s) => s.id);
  const duplicateIds = [...new Set(ids.filter((id, i) => id != null && ids.indexOf(id) !== i))];

  // Apply the placement detail level, then split the solver candidate
  // off so it is never serialized. Order matters: the store keeps the
  // candidate, the response keeps the rows, and neither sees the
  // other's private field.
  //
  // PHASE 33: the stored entry also keeps the strategy and the AI
  // decision, because the committed record's audit block is written
  // from THEM at commit time (brief §30/§31) and the commit request
  // carries only two ids. Without this the audit would have to be
  // reconstructed — and a reconstructed provenance is a guess.
  const strategyInfo = mapStrategyInfo({ request, planned, count });
  const previewStore = deps.previewStore;
  previewStore?.put(requestId, solutions.map((s) => ({
    id: s.id,
    solution: stripCandidate(s),
    candidate: s._candidate,
    strategy: strategyInfo,
    ai: {
      provider: ai?.provider ?? null,
      used: ai?.used === true,
      fallbackUsed: ai?.fallbackUsed === true,
    },
  })));
  const responseSolutions = solutions.map((s, idx) => {
    const { _candidate, ...rest } = s;
    const withDetail = shouldIncludePlacements(placementDetail, idx) ? s : { ...rest, placements: [] };
    return withoutCandidate(withDetail);
  });

  const status = responseSolutions.length > 0 ? SCHEDULER_STATUS.OK : SCHEDULER_STATUS.EMPTY;
  mark(status === SCHEDULER_STATUS.OK ? GENERATION_STATUS.COMPLETED : GENERATION_STATUS.NO_SOLUTION);

  const payload = basePayload(requestId, status, {
    generation: generationBlock(
      status === SCHEDULER_STATUS.OK ? GENERATION_STATUS.COMPLETED : GENERATION_STATUS.NO_SOLUTION,
      stages,
      start,
    ),
    ai,
    strategy: strategyInfo,
    solutions: responseSolutions,
    // Always present, always an array. A client must never have to
    // branch on whether the field exists: `[]` means "no errors" and
    // is a normal 200, not an absence (brief §28).
    errors: [],
    placementDetail: {
      level: placementDetail,
      includedSolutionRanks: responseSolutions
        .filter((_, idx) => shouldIncludePlacements(placementDetail, idx))
        .map((s) => s.rank),
      // A client on `selected` or `none` is told how to get the rest,
      // rather than having to discover it. Regenerating with `all` is
      // the documented path and costs a solve; a dedicated detail
      // endpoint would be the alternative, and the brief asks for it
      // only if this is measured to be a problem.
      note: 'Re-run with ?placements=all to include every solution\'s slots.',
    },
    calendar: mapCalendar(input, index),
    directory: mapDirectory(input, index),
    travel: mapTravelStatus(input, responseSolutions[0] ?? null),
    transfer: mapTransferStatus(input, responseSolutions[0] ?? null),
    diagnostics: {
      errors: [],
      solver: generated.diagnostics,      scoring: scored.diagnostics,
      data: { provenance: mapProvenance(provenance), missingData: missing, warnings: input.warnings ?? [] },
      // Surface (never silently repair) a duplicate-id defect. A
      // duplicate makes the response ambiguous, and an ambiguous
      // response is a bug report the client should file.
      duplicateSolutionIds: duplicateIds,
      timing: {
        totalTimeMs: Date.now() - start,
        solverMs: generated.diagnostics?.generationMs ?? null,
        scoringMs: scored.diagnostics?.totalTimeMs ?? null,
        aiMs: planned?.timing?.aiMs ?? 0,
        // Brief §39 — recorded, not optimized. These are the four
        // numbers that identify the bottleneck; Phase 32 does not
        // change the solver to make any of them better.
        breakdown: {
          solveMs: generated.diagnostics?.generationMs ?? null,
          scoreMs: scored.diagnostics?.totalTimeMs ?? null,
          strategyMs: planned?.timing?.totalMs ?? 0,
          apiOverheadMs: Math.max(
            0,
            (Date.now() - start)
            - (generated.diagnostics?.generationMs ?? 0)
            - (scored.diagnostics?.totalTimeMs ?? 0)
            - (planned?.timing?.totalMs ?? 0),
          ),
        },
      },
    },
  });

  return { status: 200, payload };
}

/** Rank 1 always carries its slots: it is the schedule a user lands on. */
function shouldIncludePlacements(level, idx) {
  if (level === PLACEMENT_DETAIL.ALL) return true;
  if (level === PLACEMENT_DETAIL.SELECTED) return idx === 0;
  return false;
}

function withoutCandidate(solution) {
  const { _candidate, ...rest } = solution;
  return rest;
}

function stripCandidate(solution) {
  return withoutCandidate(solution);
}

// ============================================================================
// commit
// ============================================================================
//
// The commit implementation moved to `./commit.js` in Phase 33, which
// is where the persistence boundary lives: the write path, the
// readback verification, and the idempotency rule are all in one file
// and nowhere else. It is re-exported from here because this module is
// where `/api/schedules` is assembled, and because the Phase 32 test
// suite reaches `commit` through this path.
//
// WHAT CHANGED IN PHASE 33
// -------------------------
// `commit` is now ASYNCHRONOUS and it now WRITES. Phase 32 answered
// `written: false` / `PREVIEW_ONLY` because the project had no
// persistence workflow; Phase 33 defines one. The guarantee Phase 32
// established is preserved and is now load-bearing rather than
// vacuous: the solution is still re-validated with the independent
// evaluator BEFORE the write path is reachable, and a solution that
// fails is still refused with 409 and no write of any kind.

export { commit, COMMIT_STATUS, describeCommitted, readCommitted } from './commit.js';

// ============================================================================
// Helpers
// ============================================================================

function basePayload(requestId, status, extra) {
  return { apiVersion: API_VERSION, requestId, status, ...extra };
}

function generationBlock(status, stages, start) {
  return { status, stages, totalTimeMs: Date.now() - start };
}

/**
 * An infrastructure failure — a thrown loader, a thrown solver, a
 * thrown scorer. These are the ONLY cases that become a 500, and
 * they are reported as `FAILED` with a stable code. The message is
 * a one-line summary; the stack trace is not in the response, because
 * a stack trace in a browser is a disclosure bug, not a debugging
 * aid (brief §28).
 */
function infrastructureFailure(requestId, stages, start, code, error) {
  return {
    status: 500,
    payload: {
      apiVersion: API_VERSION,
      requestId,
      status: SCHEDULER_STATUS.INVALID_INPUT,
      generation: generationBlock(GENERATION_STATUS.FAILED, stages, start),
      ai: null,
      strategy: null,
      solutions: [],
      diagnostics: {
        errors: [{
          field: 'pipeline',
          code,
          message: 'The scheduling pipeline failed. See the server log for details.',
        }],
        // Recorded for the server log only; NOT serialized under a
        // client-facing key.
        internalDetail: String(error?.message ?? error),
      },
      errors: [{
        field: 'pipeline',
        code,
        message: 'The scheduling pipeline failed. See the server log for details.',
      }],
    },
  };
}

/**
 * Re-run the independent evaluator. Never throws: an evaluator that
 * throws on a malformed candidate means the candidate is not
 * acceptable, not that the request is broken.
 */
function evaluateSafe(candidate, input) {
  try {
    const placements = new Map();
    if (candidate?.placements instanceof Map) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, { teacherId: p.teacherId, branchId: p.branchId });
      }
    } else if (Array.isArray(candidate?.placements)) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, { teacherId: p.teacherId, branchId: p.branchId });
      }
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
    };
  } catch (e) {
    return { ok: false, accepted: false, hardViolations: 0, reasons: [`evaluation failed: ${String(e?.message ?? e)}`] };
  }
}

function mapStrategyInfo({ request, planned, count }) {
  const applied = planned.applied?.strategy ?? {};
  return {
    optimizationMode: request.optimizationMode,
    appliedOptimizationMode: applied.optimizationMode ?? null,
    modeSource: planned.fallbackUsed ? 'DETERMINISTIC_FALLBACK' : 'AI',
    candidateCount: count,
    // The seed is reported so a client can tell two identical
    // requests apart, not so it can set one: the request vocabulary
    // has no `seed` field on purpose.
    seed: 0xC0FFEE,
    baseStrategyId: applied.id ?? null,
  };
}
