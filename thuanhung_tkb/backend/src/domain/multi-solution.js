// PHASE 27 — MULTI-SOLUTION + STRUCTURAL DIVERSITY.
//
// Goal
// ----
// Generate N hard-feasible, high-quality candidates that are
// MEANINGFULLY different from one another (not 5 rewrites of
// the same TKB with a few slots flipped).
//
// Phase 27 does NOT:
//   - introduce a new solver; the existing GLOBAL_ASSIGNMENT_BALANCED
//     mode in `solver.js` is the only engine;
//   - fabricate quality scores (all metrics come from the existing
//     `deriveMetrics` and `globalObjective` helpers);
//   - bias diversity against the legacy baseline;
//   - know that an AI provider exists. Phase 30 added one, but it
//     reaches this module only as `input.strategy.optimizationMode`
//     and `respectStrategyMode`, both set by the caller after the
//     decision has been validated. This module never imports an AI
//     module and never calls a provider, so "introduce AI" is still
//     true of THIS file even though the project as a whole now has
//     one (brief §2, §3, §36);
//   - introduce travel data; H14 remains UNSUPPORTED.
//   - mutate the input; every iteration is given a shallow
//     copy with its own strategy object.
//
// Phase 27 is deterministic: same input + strategy + seed + N
// produces the same output set, in the same order.
//
// Quality-First Principle
// -----------------------
// A candidate that is "very different" but "very low quality"
// does NOT automatically win. The brief §11 requires an explicit
// quality-first policy. Phase 27 implements:
//
//   1. Generate candidates via the existing solver.
//   2. Keep only hard-feasible candidates (independent evaluator
//      accepted = true).
//   3. Quality rank by the global comparator (workloadSpread
//      primary, maxTeacherLoad secondary, etc.).
//   4. The best-quality candidate is ALWAYS the first solution
//      in the returned set (the "anchor").
//   5. Subsequent solutions are added only if their slot diversity
//      vs the kept set is >= `minSlotDiversity` (default 0.15).
//   6. A `minimumQualityRelativeToBest` (default disabled) caps
//      how far a solution's quality may fall below the best.
//
// Determinism
// -----------
// Each candidate is produced from a per-iteration seed derived
// from the user-supplied seed via a deterministic LCG step.
// The iteration seeds are NOT random; they are deterministic.
//
// ID uniqueness
// -------------
// The solver's per-iteration candidate id is a hash of
// (inputSeed, per-solve counter). Two different multi-solution
// iterations that happen to find candidates at the same per-solve
// counter would otherwise share an id. Phase 27 REPLACES the
// solver's id with a deterministic, multi-solution-unique id
// derived from (baseSeed, iteration, per-solve counter). The new
// id is opaque but reproducible.
//
// Time budget
// -----------
// Each solve call still respects `strategy.solver.timeLimitMs`
// (or `cfg.perSolveTimeBudgetMs`). The orchestrator-level caller
// (this module) divides the overall budget across the requested
// iterations, so the total wall-clock never exceeds the configured
// overall budget.

import { solve } from './solver.js';
import { evaluateCandidate } from './constraints/index.js';
import { compareOptimizationCandidates } from './comparator.js';
import { diversity as slotDiversity, structuralDiversity } from './diversity.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from './strategies.js';

// ============================================================================
// Default options
// ============================================================================

export const MULTI_SOLUTION_DEFAULTS = Object.freeze({
  count: 3,                            // 1, 3, 5, or 10 (clamped to nearest allowed)
  minSlotDiversity: 0.15,              // §4: slot symmetric-difference threshold
  overallTimeBudgetMs: 30_000,         // §29: wall-clock for the whole generation
  perSolveTimeBudgetMs: 5_000,         // each individual solve's inner budget
  // PHASE 31.1 — the seed-stable search bound handed to every
  // per-iteration solve. When set, each solve stops after this many
  // search iterations instead of when the wall clock runs out, so a
  // whole generation is reproducible on any machine. When null (the
  // default) the wall clock is the bound, exactly as before, and
  // `diagnostics.searchLimited` reports whether it bound.
  // Rationale in the determinism contract below.
  maxSearchIterations: null,
  minimumQualityRelativeToBest: null,  // §23: null = disabled; a number in [0, 1]
  // PHASE 29 — when true, the per-iteration engine is taken from
  // `input.strategy.optimizationMode` instead of being forced to
  // GLOBAL_ASSIGNMENT_BALANCED. This exists so an approved AI
  // StrategyDecision can actually drive generation; the
  // multi-solution path would otherwise discard the AI's mode
  // choice. DEFAULT FALSE on purpose: the Phase 27 contract is
  // "GLOBAL is the only engine", its tests assert that, and the
  // forced behavior is correct whenever the caller did not ask
  // for anything else. An unrecognized mode falls back to
  // GLOBAL rather than reaching the solver.
  respectStrategyMode: false,
  requireFeasibility: true,            // §2: every solution must be hard-feasible
  seed: 0xC0FFEE,                      // base seed; per-iteration seeds are derived
  // §17 — slot diversity is the GATE; the structural diversity is
  // measured for the audit but does NOT replace the gate. The
  // constants below document the existing semantics and are not
  // changeable from this module.
  structuralWeights: Object.freeze({ teacherDay: 0.6, sessionMix: 0.4 }),
});

// Allowed solution counts (per brief §1). PHASE 29 — the canonical
// list now lives in strategies.js (ALLOWED_CANDIDATE_COUNTS) so the
// AI layer can share it without importing this module.
const ALLOWED_COUNTS = ALLOWED_CANDIDATE_COUNTS;

function clampCount(n) {
  if (!Number.isFinite(n) || n < 1) return 1;
  if (ALLOWED_COUNTS.includes(n)) return n;
  // Snap to nearest allowed value.
  let best = ALLOWED_COUNTS[0];
  let bestDiff = Math.abs(n - best);
  for (const a of ALLOWED_COUNTS) {
    const d = Math.abs(n - a);
    if (d < bestDiff) { best = a; bestDiff = d; }
  }
  return best;
}

function mergeOptions(options) {
  return { ...MULTI_SOLUTION_DEFAULTS, ...(options ?? {}) };
}

// ============================================================================
// Deterministic seed derivation (brief §8)
// ============================================================================

/**
 * Deterministic per-iteration seed. Same `baseSeed + iteration`
 * always yields the same numeric seed. The function is PURE.
 *
 *   seed_i = (baseSeed * 1103515245 + 12345 + iteration * 2654435761) >>> 0
 *
 * This is a TinyLF2-style LCG with a unique offset per
 * iteration. The output is a non-negative 32-bit integer.
 */
export function deriveSeed(baseSeed, iteration) {
  const baseU = (Number(baseSeed) >>> 0) || 0;
  const iterU = (Number(iteration) >>> 0) || 0;
  const mixed = (Math.imul(baseU, 1103515245) + 12345 + Math.imul(iterU, 2654435761)) >>> 0;
  return mixed >>> 0;
}

/**
 * Phase 27 multi-solution-unique id. The id is a 32-bit
 * hash of (baseSeed, iteration, per-solveCounter), rendered
 * as 8 lowercase hex characters with a `ms-` prefix to mark
 * it as a Phase 27 multi-solution id. The id is:
 *   - deterministic: same (baseSeed, iteration, counter) always
 *     yields the same id;
 *   - unique: two iterations with different `iteration` always
 *     yield different ids (because the iteration enters the
 *     hash in a multiplicative form);
 *   - opaque: it is not a guarantee of distinct candidate
 *     structure. Distinctness is the comparator's job.
 *
 *   mix = (baseSeed * GOLDEN + 0x9E3779B1) >>> 0
 *   mix = (mix  + iteration * 0x100000001B3) >>> 0
 *   mix = (mix  + counter   * 0xCBF29CE484222325) >>> 0
 */
function makeMultiSolutionId(baseSeed, iteration, counter) {
  const baseU = (Number(baseSeed) >>> 0) || 0;
  const iterU = (Number(iteration) >>> 0) || 0;
  const cntU = (Number(counter) >>> 0) || 0;
  let mix = (Math.imul(baseU, 0x9E3779B1) + 0x9E3779B1) >>> 0;
  mix = (Math.imul(mix + 1, 0x100000001B3) ^ Math.imul(iterU + 1, 0x9E3779B1)) >>> 0;
  mix = (mix ^ Math.imul(cntU + 1, 0xCBF29CE484222325 & 0xFFFFFFFF)) >>> 0;
  return `ms-${mix.toString(16).padStart(8, '0')}`;
}

// ============================================================================
// Pairwise diversity matrix (brief §18)
// ============================================================================

/**
 * Pairwise diversity matrix. For N solutions, the matrix is
 * N×N; the diagonal is 0; the matrix is symmetric. The matrix
 * is a structured report suitable for direct serialization.
 *
 *   metric: 'slot'        → slot symmetric-difference [0, 1]
 *           'structural'  → structural diversity.overall [0, 1]
 *           'teacherDay'  → structural diversity.teacherDay [0, 1]
 *           'sessionMix'  → structural diversity.sessionMix [0, 1]
 */
export function pairwiseDiversityMatrix(solutions, metric = 'slot') {
  if (!Array.isArray(solutions)) return [];
  const out = [];
  for (let i = 0; i < solutions.length; i++) {
    const row = [];
    for (let j = 0; j < solutions.length; j++) {
      if (i === j) { row.push(0); continue; }
      if (j < i) { row.push(out[j][i]); continue; }
      row.push(pairwiseScore(solutions[i], solutions[j], metric));
    }
    out.push(row);
  }
  return out;
}

function pairwiseScore(a, b, metric) {
  if (metric === 'slot') return slotDiversity(a, b);
  if (metric === 'structural') return structuralDiversity(a, b).overall;
  if (metric === 'teacherDay') return structuralDiversity(a, b).teacherDay;
  if (metric === 'sessionMix') return structuralDiversity(a, b).sessionMix;
  return slotDiversity(a, b);
}

// ============================================================================
// Quality score (brief §11 / §22 / §23)
// ============================================================================

/**
 * A simple 0-1 quality score derived from the candidate's
 * metrics. Higher is better.
 *
 *   q = 1 / (1 + workloadSpread + preferencePenalty)
 *
 * The formula is monotonic decreasing in workloadSpread and
 * preferencePenalty. Both are non-negative. The output is in
 * (0, 1] (a perfectly balanced candidate with zero preference
 * penalty scores 1; an infinitely bad candidate scores 0).
 *
 * The score is REPORTING. The comparator (see
 * `compareOptimizationCandidates`) is the actual ranking
 * function. The score exists so the diagnostics surface a
 * one-number quality that downstream consumers can use without
 * re-deriving the metric chain.
 */
export function qualityScore(candidate) {
  if (!candidate || !candidate.metrics) return 0;
  const spread = Number(candidate.metrics.workloadSpread ?? 0);
  const pref = Number(candidate.metrics.preferencePenalty ?? 0);
  const safe = (spread + pref) || 0;
  return 1 / (1 + safe);
}

// ============================================================================
// Independent feasibility check (brief §2)
// ============================================================================

function isHardFeasible(candidate, input) {
  try {
    const placements = new Map();
    if (candidate.placements instanceof Map) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, { teacherId: p.teacherId, branchId: p.branchId });
      }
    } else if (Array.isArray(candidate.placements)) {
      for (const [aId, p] of candidate.placements) {
        placements.set(aId, { teacherId: p.teacherId, branchId: p.branchId });
      }
    }
    const evaluation = evaluateCandidate(
      { assignments: candidate.assignments, placements },
      input,
    );
    return Boolean(evaluation) && evaluation.summary.accepted === true;
  } catch {
    return false;
  }
}

// ============================================================================
// Quality comparator (wraps comparator.js)
// ============================================================================

function compareCandidates(a, b) {
  return compareOptimizationCandidates(a, b);
}

// ============================================================================
// Non-mutation guard (brief §22)
// ============================================================================

/**
 * The function NEVER mutates `input`. This helper builds a
 * per-iteration copy that:
 *   - shallow-copies the input object (so the caller cannot
 *     observe the iteration's `strategy` mutation),
 *   - attaches a fresh `strategy` object for this iteration,
 *   - attaches a fresh `solver` and `diversification` object
 *     on the strategy (so the original `strategy` is not
 *     mutated either).
 *
 * The `assignments` Map and `timeSlotsByBranch` Map inside
 * `input` are NEVER mutated by the solver. Phase 23 / 25
 * contracts guarantee this (the solver reads Maps, never
 * writes them). Phase 27 does NOT add any writer.
 */
function makeIterationInput(input, iterStrategy) {
  return {
    ...input,
    strategy: iterStrategy,
  };
}

// ============================================================================
// Engine mode resolution (PHASE 29)
// ============================================================================

/**
 * Decide which optimization engine the generation iterations use.
 *
 * Default (respectStrategyMode = false):
 *   GLOBAL_ASSIGNMENT_BALANCED, unconditionally. That is the
 *   Phase 27 contract and is left untouched.
 *
 * Opt-in (respectStrategyMode = true):
   the caller's `input.strategy.optimizationMode`, so an approved
 *   AI StrategyDecision can drive generation. An unrecognized or
 *   missing mode falls back to GLOBAL rather than handing the
 *   solver something it does not understand.
 */
function resolveEngineMode(requested, respectStrategyMode) {
  if (!respectStrategyMode) return OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
  return Object.values(OPTIMIZATION_MODES).includes(requested)
    ? requested
    : OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
}

// ============================================================================
// Generation pipeline (PURE orchestrator over the existing solver)
// ============================================================================

/**
 * Generate multiple solutions from a SchedulingInput. The
 * function is the Phase 27 multi-solution API.
 *
 *   generateSolutions(input, options) →
 *     {
 *       solutions: [
 *         { id, rank, candidate, metrics, score, qualityScore,
 *           diversity, seed, iteration,
 *           diversityToBest, diversityToPrevious,
 *           structuralDiversity, slotCount, assignmentCount }
 *       ],
 *       diagnostics: {
 *         requested, produced,
 *         searchesExecuted,
 *         feasibleCount, rejectedInfeasible, rejectedReasons,
 *         duplicatesRejected, nearDuplicatesRejected,
 *         generationMs, timeBudgetHit, searchLimited,
 *         h14: 'UNSUPPORTED',
 *         solverFailed: number,
 *       },
 *     }
 *
 * Pipeline:
 *   1. `iteration i = 1..maxAttempts`:
 *        - derive seed_i from baseSeed
 *        - call the existing solver with GLOBAL_ASSIGNMENT_BALANCED
 *          + seed_i + perSolveTimeBudgetMs
 *        - keep the returned candidate if it is hard-feasible
 *   2. Quality rank by the global comparator (best first).
 *   3. Near-duplicate filter (slot diversity vs every kept candidate).
 *   4. Quality floor (if enabled).
 *   5. Build output with rank / diversity / quality fields.
 *   6. Replace the candidate id with a multi-solution-unique id
 *      so two iterations never share an id.
 *
 * The function NEVER mutates `input`. The function NEVER uses
 * `Math.random()` for randomization. `Date.now()` is used ONLY
 * for the time-budget check (not for randomization).
 *
 * DETERMINISM CONTRACT (PHASE 31.1)
 * --------------------------------
 * A result is byte-identical across runs when, and only when, all
 * four of these hold:
 *
 *     same input
 *   + same seed
 *   + same strategy
 *   + the search was not truncated by the wall clock
 *
 * The fourth condition is the one that used to be assumed rather
 * than established, and it is what made this suite flaky.
 *
 * WHY A BUDGET IS NOT A DETERMINISM MECHANISM
 * In GLOBAL_ASSIGNMENT_BALANCED the solver's iteration ceiling is
 * `Number.MAX_SAFE_INTEGER`, so the wall clock is the only real
 * bound. A wall clock is a property of the MACHINE, not of the
 * input: on a busy host the search completes fewer iterations, so
 * fewer candidates are compared and a different candidate can end
 * up as the incumbent. Two runs of the same seed then legitimately
 * disagree. This is not RNG nondeterminism — the search is a pure
 * function of the seed — it is a SHORTER SEARCH.
 *
 * TWO WAYS TO ESTABLISH THE FOURTH CONDITION
 *
 *   1. DETERMINISTIC_SEARCH (preferred for property tests).
 *      Pass `maxSearchIterations: N`. The search then stops after
 *      N iterations — a count, not a duration — so every run does
 *      the same work and reaches the same incumbent on any machine.
 *      `diagnostics.searchLimited` is false and
 *      `diagnostics.searchStoppedBy` is `ITERATION_LIMIT` (or
 *      `SEARCH_EXHAUSTED` / `SOLUTION_CAP` if it finished sooner).
 *      Reproducible by construction, not by luck.
 *
 *   2. TIME_BUDGETED_SEARCH (for real-data behavior).
 *      Leave `maxSearchIterations` null and give the solver a budget
 *      the search finishes inside. The result is then still
 *      reproducible, but only while the budget does not bind, which
 *      depends on machine load. A caller MUST therefore check
 *      `diagnostics.searchLimited === false` before claiming
 *      determinism, and MUST NOT claim byte-identical output when
 *      `searchLimited` is true.
 *
 * `searchLimited` is true ONLY when `searchStoppedBy ===
 * 'TIME_BUDGET'`. A search that stopped on the iteration limit, the
 * solution cap, or exhaustion is complete with respect to its own
 * contract, is reproducible, and is NOT limited.
 *
 * The function NEVER fabricates a solution. If fewer than `count`
 * feasible candidates survive, the returned `solutions` array is
 * shorter and the diagnostics explain the gap.
 */
export function generateSolutions(input, options = {}) {
  const start = Date.now();
  const cfg = mergeOptions(options);
  cfg.count = clampCount(cfg.count);

  if (!input || typeof input !== 'object') {
    return emptyResult(cfg, start, 'INVALID_INPUT', 0);
  }
  if (!input.strategy || typeof input.strategy !== 'object') {
    return emptyResult(cfg, start, 'MISSING_STRATEGY', 0);
  }

  // PHASE 29 — which engine the iterations will actually use.
  // Resolved once, before anything reads it, and reported in the
  // diagnostics so an audit can never be misled about what ran.
  const engineMode = resolveEngineMode(input.strategy?.optimizationMode, cfg.respectStrategyMode);

  const diag = {
    requested: cfg.count,
    produced: 0,
    searchesExecuted: 0,
    feasibleCount: 0,
    rejectedInfeasible: 0,
    rejectedReasons: [],
    duplicatesRejected: 0,
    nearDuplicatesRejected: 0,
    generationMs: 0,
    timeBudgetHit: false,
    searchLimited: false,
    // PHASE 31.1 — the set of stop reasons seen across the
    // generation's per-iteration solves, plus the bound that was
    // requested. Empty when no solve ran. A caller asserting
    // determinism reads `searchLimited` (true only on TIME_BUDGET)
    // and can inspect this to see exactly why each solve stopped.
    searchStoppedBy: [],
    iterationBound: cfg.maxSearchIterations ?? null,
    h14: 'UNSUPPORTED',
    solverFailed: 0,
    // PHASE 29 — the engine the iterations actually used.
    optimizationMode: engineMode,
  };

  const overallExpired = () => (Date.now() - start) > cfg.overallTimeBudgetMs;

  // ------------------------------------------------------------------------
  // Phase A: GENERATE candidates via the existing solver
  // ------------------------------------------------------------------------
  const candidates = [];
  const baseSeed = (Number(cfg.seed) >>> 0) || 0;
  // We need at least `count` candidates; near-duplicates may
  // reduce the kept set, so we may overshoot. We never
  // re-iterate a value.
  const maxAttempts = Math.max(cfg.count * 4, cfg.count + 4);
  for (let i = 1; i <= maxAttempts; i++) {
    if (overallExpired()) {
      diag.timeBudgetHit = true;
      break;
    }
    if (candidates.length >= cfg.count) break;
    diag.searchesExecuted += 1;
    const iterSeed = deriveSeed(baseSeed, i);
    const iterStrategy = {
      ...input.strategy,
      optimizationMode: engineMode,
      diversification: { ...(input.strategy.diversification ?? {}), seed: iterSeed },
      solver: {
        ...(input.strategy.solver ?? {}),
        timeLimitMs: cfg.perSolveTimeBudgetMs,
        // PHASE 31.1 — the caller's seed-stable iteration bound, when
        // one was supplied. `null`/undefined is passed through
        // unchanged, which the solver reads as "no iteration bound"
        // (wall clock only) so the default behavior is untouched.
        ...(cfg.maxSearchIterations == null
          ? {}
          : { maxSearchIterations: cfg.maxSearchIterations }),
      },
    };
    const iterInput = makeIterationInput(input, iterStrategy);
    let out;
    try {
      out = solve(iterInput);
    } catch (e) {
      diag.solverFailed += 1;
      diag.rejectedReasons.push({ iteration: i, reason: 'solver_threw', detail: String(e?.message ?? e) });
      continue;
    }
    if (!out || out.failure || !out.solutions || out.solutions.length === 0) {
      diag.solverFailed += 1;
      diag.searchLimited = diag.searchLimited || Boolean(out?.diagnostics?.searchLimited);
      recordStopReason(diag, out?.diagnostics?.searchStoppedBy);
      diag.rejectedReasons.push({ iteration: i, reason: 'solver_no_solution', failure: out?.failure ?? null });
      continue;
    }
    diag.searchLimited = diag.searchLimited || Boolean(out.diagnostics?.searchLimited);
    recordStopReason(diag, out.diagnostics?.searchStoppedBy);
    const candidate = out.solutions[0];
    if (cfg.requireFeasibility) {
      if (!isHardFeasible(candidate, iterInput)) {
        diag.rejectedInfeasible += 1;
        diag.rejectedReasons.push({ iteration: i, reason: 'INDEPENDENT_EVALUATOR_REJECTED' });
        continue;
      }
    }
    diag.feasibleCount += 1;
    candidates.push({
      candidate,
      seed: iterSeed,
      iteration: i,
      perSolveCounter: extractPerSolveCounter(candidate),
    });
  }

  // ------------------------------------------------------------------------
  // Phase B: QUALITY rank (best anchor first)
  // ------------------------------------------------------------------------
  candidates.sort((a, b) => compareCandidates(a.candidate, b.candidate));

  // ------------------------------------------------------------------------
  // Phase C: NEAR-DUPLICATE filter
  // ------------------------------------------------------------------------
  const kept = [];
  for (const c of candidates) {
    if (kept.length === 0) {
      kept.push(c);
      continue;
    }
    let nearDup = false;
    for (const k of kept) {
      const d = slotDiversity(k.candidate, c.candidate);
      if (d < cfg.minSlotDiversity) {
        nearDup = true;
        diag.nearDuplicatesRejected += 1;
        diag.rejectedReasons.push({
          iteration: c.iteration,
          reason: 'NEAR_DUPLICATE',
          slotDiversity: d,
        });
        break;
      }
    }
    if (!nearDup) kept.push(c);
    if (kept.length >= cfg.count) break;
  }

  // ------------------------------------------------------------------------
  // Phase D: QUALITY FLOOR (if enabled)
  // ------------------------------------------------------------------------
  let filteredKept = kept;
  if (
    typeof cfg.minimumQualityRelativeToBest === 'number' &&
    cfg.minimumQualityRelativeToBest >= 0 &&
    cfg.minimumQualityRelativeToBest <= 1
  ) {
    const bestSpread = kept[0]?.candidate?.metrics?.workloadSpread ?? null;
    if (Number.isFinite(bestSpread)) {
      const tolerance = bestSpread * cfg.minimumQualityRelativeToBest;
      filteredKept = kept.filter((c) => {
        const s = c.candidate?.metrics?.workloadSpread ?? Infinity;
        return s <= bestSpread + tolerance;
      });
    }
  }

  // ------------------------------------------------------------------------
  // Phase E: BUILD the output (rank, diversity fields, unique id)
  // ------------------------------------------------------------------------
  const solutions = filteredKept.map((k, idx) => {
    const cand = k.candidate;
    const diversityToBest = idx === 0
      ? 0
      : slotDiversity(filteredKept[0].candidate, cand);
    const diversityToPrevious = idx === 0
      ? 0
      : slotDiversity(filteredKept[Math.max(0, idx - 1)].candidate, cand);
    const structural = filteredKept.length > 1 && idx > 0
      ? structuralDiversity(filteredKept[0].candidate, cand)
      : { teacherDay: 0, sessionMix: 0, overall: 0 };
    const qScore = qualityScore(cand);
    // Replace the candidate id with a multi-solution-unique id so
    // that two iterations that happen to find candidates at the
    // same per-solve counter position do not share an id. The
    // underlying candidate object retains its original id for
    // auditability; only the surfaced `id` is replaced.
    const newId = makeMultiSolutionId(baseSeed, k.iteration, k.perSolveCounter);
    return {
      id: newId,
      originalSolverId: cand.id,
      rank: idx + 1,
      candidate: cand,
      metrics: cand.metrics,
      score: { overallScore: qScore },
      qualityScore: qScore,
      diversity: {
        slotToBest: diversityToBest,
        slotToPrevious: diversityToPrevious,
        teacherDay: structural.teacherDay,
        sessionMix: structural.sessionMix,
        overall: structural.overall,
      },
      diversityToBest: diversityToBest,
      diversityToPrevious: diversityToPrevious,
      structuralDiversity: structural,
      seed: k.seed,
      iteration: k.iteration,
      slotCount: countSlots(cand),
      assignmentCount: cand.assignments?.size ?? 0,
    };
  });

  diag.produced = solutions.length;
  diag.generationMs = Date.now() - start;

  return {
    solutions,
    diagnostics: diag,
  };
}

/**
 * The solver embeds the per-solve counter in the candidate id
 * (`sol-XXXXXXXX`). The counter is the second 32-bit word of
 * the id, encoded as 8 hex characters. We extract it so the
 * multi-solution id can be derived deterministically.
 */
function extractPerSolveCounter(candidate) {
  const id = candidate?.id ?? '';
  if (typeof id !== 'string') return 0;
  const m = id.match(/^sol-([0-9a-f]{8})$/i);
  if (!m) return 0;
  return parseInt(m[1], 16) >>> 0;
}

function countSlots(candidate) {
  if (!candidate?.assignments) return 0;
  let n = 0;
  for (const arr of candidate.assignments.values()) n += arr.length;
  return n;
}

/**
 * PHASE 31.1 — record one per-iteration solve's stop reason in the
 * generation diagnostics, preserving first-seen order and without
 * duplicates. Unknown/absent reasons are ignored rather than
 * recorded, so the field only ever contains reasons the solver
 * actually reported.
 */
function recordStopReason(diag, reason) {
  if (typeof reason !== 'string' || reason.length === 0) return;
  if (diag.searchStoppedBy.includes(reason)) return;
  diag.searchStoppedBy.push(reason);
}

function emptyResult(cfg, start, error, searchesExecuted) {
  return {
    solutions: [],
    diagnostics: {
      requested: cfg.count,
      produced: 0,
      searchesExecuted,
      feasibleCount: 0,
      rejectedInfeasible: 0,
      rejectedReasons: [],
      duplicatesRejected: 0,
      nearDuplicatesRejected: 0,
      generationMs: Date.now() - start,
      timeBudgetHit: false,
      searchLimited: false,
      // PHASE 31.1 — mirror the generation diagnostics shape. No
      // solve ran, so no stop reason was observed.
      searchStoppedBy: [],
      iterationBound: cfg.maxSearchIterations ?? null,
      h14: 'UNSUPPORTED',
      solverFailed: 0,
      error,
    },
  };
}

// ============================================================================
// Backward-compatible single-solution path (brief §25)
// ============================================================================
//
// The existing `solve(input)` is preserved. The orchestrator and
// callers continue to use `solve(input)` for the single-solution
// path; Phase 27 only adds `generateSolutions(input, options)`
// for the multi-solution path. They share the same engine.
//
// A `count = 1` call into `generateSolutions` is equivalent to
// `solve` for the quality-first anchor: it returns exactly one
// feasible candidate. The semantics are preserved (the same
// solver, the same comparator, the same time budget).

export { solve };
