// PHASE 28 — GLOBAL SCORING + FINAL SOLUTION SELECTION.
//
// Goal
// ----
// Given a pool of hard-feasible candidates (from
// `generateSolutions` or any other producer), compute a
// deterministic, explainable product-level quality score and
// select the final N solutions to surface to the user.
//
// Phase 28 does NOT:
//   - change feasibility rules (independent evaluator still
//     decides hard/soft violations; H14 stays UNSUPPORTED;
//     H13 stays INACTIVE; the historical transfer count is
//     never used as a score);
//   - change the Phase 25 GLOBAL_ASSIGNMENT_BALANCED engine
//     or the comparator (Phase 28 sits on TOP of the
//     comparator, never INSIDE it);
//   - know that an AI provider exists. Phase 30 added one, but the
//     scorer only ever sees the WEIGHTS that survived
//     `validateStrategyDecision`, handed to it as `config.weights`.
//     It never imports an AI module, never calls a provider, and
//     never re-reads the rationale — a provider cannot rank its own
//     output (brief §2, §35, §36);
//   - introduce a new solver or change the search control;
//   - mutate any candidate, the input, or the pool.
//
// Four layers (per brief §2):
//
//   Constraint evaluation        (evaluateCandidate — Phase 22)
//        ↓
//   Raw metrics                  (deriveMetrics — Phase 24)
//        ↓
//   Dimension scores             (this module — Phase 28)
//        ↓
//   Global score                 (this module — Phase 28)
//
// The dimension layer is the first one to expose a per-candidate
// SCORE VECTOR (a list of dimension contributions), which is
// what the consumer uses to answer "why is A better than B?".
// The global score is the weighted sum of the normalized
// dimension scores; it is a single number in [0, 1] (higher is
// better) that drives the final ranking.
//
// Determinism
// -----------
// Given the same (candidates, input, config), the function
// returns the same { solutions, diagnostics }. No Math.random(),
// no Date.now()-derived randomness, no network. The function
// MAY read Date.now() ONLY for the timing report (it does
// NOT affect the score).
//
// Travel / transfer
// -----------------
// H14 (Travel) is UNSUPPORTED on the real dataset. The
// TRAVEL dimension is therefore INACTIVE and contributes 0 to
// the global score. When a real travel matrix arrives, the
// dimension's `active(input)` predicate flips to true and the
// score is computed without further code changes.
//
// H13 (Transfer) is INACTIVE. The TRANSFER dimension is
// therefore INACTIVE for the same reason. Historical transfer
// counts are not consulted (they are not a "score").
//
// Phase 28 deliberately does NOT add a transfer penalty. The
// transfer-policy surface (Phase 26) is preserved verbatim.

import { evaluateCandidate, isAccepted } from './constraints/index.js';
import {
  DIMENSION_CATALOG,
  DIRECTION,
  getDimension,
  listActiveDimensions,
  inactiveReason,
  slotDiversity,
  structuralDiversity,
} from './dimension-catalog.js';
import { qualityScore as phase27QualityScore } from './multi-solution.js';
import { compareOptimizationCandidates } from './comparator.js';

// ============================================================================
// Default options
// ============================================================================

/**
 * Centralized weight configuration. Weights are non-negative
 * numbers. A weight of 0 disables a dimension from the global
 * score (the dimension is still REPORTED on each candidate's
 * score vector, but it does not contribute).
 *
 * `qualityWeightInSelection` and `diversityWeightInSelection`
 * control the quality-first greedy farthest-point algorithm.
 * The two weights do NOT need to sum to 1; the selection
 * algorithm uses a normalized blend.
 */
export const GLOBAL_SCORING_DEFAULTS = Object.freeze({
  weights: Object.freeze({
    WORKLOAD_BALANCE: 1.0,
    MAX_TEACHER_LOAD: 0.5,
    WORKLOAD_STDEV: 0.3,
    PREFERENCE: 0.3,
    STRUCTURAL_DIVERSITY: 0.4,
    SLOT_DIVERSITY: 0.2,
  }),
  // §17 — quality floor is OPTIONAL. When set, candidates with
  // qualityScore < qualityFloor are excluded from the final
  // selection. null = disabled.
  qualityFloor: null,
  // §15 — quality-first selection weights. The first solution
  // is always the best quality (rank-1 by the comparator). The
  // next solutions blend quality and diversity.
  qualityWeightInSelection: 0.7,
  diversityWeightInSelection: 0.3,
  // §2 — every returned solution must be hard-feasible.
  requireFeasibility: true,
  // §16 — preserved from Phase 27.
  minSlotDiversity: 0.15,
});

function mergeOptions(options) {
  const base = GLOBAL_SCORING_DEFAULTS;
  const o = options ?? {};
  // Brief §33 — `scoringConfig` is the documented way to
  // pass weights; we ALSO accept the bare `weights` field
  // for backward-compat with the original Phase 28 surface.
  // The two are equivalent; the explicit `scoringConfig` wins.
  const weightsFromScoringConfig = o.scoringConfig?.weights ?? null;
  const weights = weightsFromScoringConfig
    ? { ...base.weights, ...weightsFromScoringConfig }
    : { ...base.weights, ...(o.weights ?? {}) };
  return {
    weights,
    qualityFloor: o.qualityFloor ?? base.qualityFloor,
    qualityWeightInSelection: Number.isFinite(o.qualityWeightInSelection)
      ? o.qualityWeightInSelection
      : base.qualityWeightInSelection,
    diversityWeightInSelection: Number.isFinite(o.diversityWeightInSelection)
      ? o.diversityWeightInSelection
      : base.diversityWeightInSelection,
    requireFeasibility: o.requireFeasibility ?? base.requireFeasibility,
    minSlotDiversity: Number.isFinite(o.minSlotDiversity)
      ? o.minSlotDiversity
      : base.minSlotDiversity,
    count: o.count,
    input: o.input ?? null,
  };
}

// ============================================================================
// Dimension catalog (re-exported)
// ============================================================================
//
// PHASE 29 — the catalog was MOVED to the leaf module
// `dimension-catalog.js` and is re-exported from here so this
// module's public API is byte-for-byte unchanged.
//
// The reason is import hygiene, not cosmetics: the Phase 29 AI
// Strategy Layer must read the dimension vocabulary (allow-list,
// activation status, direction, bounds) WITHOUT importing this
// module, because this module transitively imports
// `multi-solution.js` -> `solver.js`. Brief §36 forbids the AI
// layer from reaching solver internals.
//
// Do not move the catalog back. Add new dimensions in
// `dimension-catalog.js`.

export { DIMENSION_CATALOG, DIRECTION, getDimension, listActiveDimensions };


// ============================================================================
// Normalization
// ============================================================================
//
// Per brief §7 / §8, normalization is candidate-set-relative
// (min-max scaling). When the pool is degenerate (max === min
// for a dimension), the normalized score is 0.5 (neutral) and
// the dimension contributes `0.5 * weight` to the global
// score — NEVER NaN, NEVER Infinity.
//
//   MINIMIZE  (lower raw is better):
//     raw = min  -> norm = 1.0   (best)
//     raw = max  -> norm = 0.0   (worst)
//     linear interpolation otherwise
//
//   MAXIMIZE  (higher raw is better):
//     raw = min  -> norm = 0.0   (worst)
//     raw = max  -> norm = 1.0   (best)
//     linear interpolation otherwise
//
//   Degenerate (max === min)        -> norm = 0.5 (neutral)
//
// All normalized values are clamped to [0, 1].

function clamp01(x) {
  if (!Number.isFinite(x)) return 0.5;
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function normalize(raw, min, max, direction) {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return 0.5; // INACTIVE or non-numeric -> neutral
  }
  if (max === min) {
    return 0.5; // degenerate pool -> neutral
  }
  const t = (raw - min) / (max - min);
  if (direction === DIRECTION.MAXIMIZE) {
    return clamp01(t);
  }
  // MINIMIZE: invert.
  return clamp01(1 - t);
}

// ============================================================================
// Weight validation
// ============================================================================

/**
 * Validate a weight object. Returns:
 *   { ok: true, weights }        if every weight is >= 0 and finite
 *   { ok: false, reason, ... }   otherwise
 *
 * Per brief §23, "all-zero weights" is allowed but degrades to
 * a quality-only score (the function returns ok=true with the
 * same weights; the global score formula naturally becomes
 * zero). An INVALID weight (negative, NaN, Infinity) is
 * rejected.
 */
export function validateWeights(weights) {
  if (!weights || typeof weights !== 'object') {
    return { ok: false, reason: 'weights must be an object' };
  }
  for (const d of DIMENSION_CATALOG) {
    if (!(d.id in weights)) continue;
    const w = weights[d.id];
    if (typeof w !== 'number' || !Number.isFinite(w)) {
      return { ok: false, reason: `weight for ${d.id} is not a finite number`, dimension: d.id };
    }
    if (w < 0) {
      return { ok: false, reason: `weight for ${d.id} is negative (${w})`, dimension: d.id };
    }
  }
  return { ok: true, weights };
}

// ============================================================================
// Per-candidate scoring
// ============================================================================

/**
 * Build a score object for a single candidate. The function is
 * PURE: it reads the candidate, the context, and the dimension
 * catalog; it does not mutate any of them.
 *
 *   context = { input, pool, bestCandidate, config }
 *
 *   result = {
 *     id:                       string,
 *     feasibility:              'FEASIBLE' | 'INFEASIBLE',
 *     hardViolations:           number,
 *     qualityScore:             number,  (Phase 27 backward-compat)
 *     total:                    number,  (global score in [0, 1])
 *     dimensions: { [id]: { raw, normalized, weight, contribution, direction, active, reason } },
 *     rankReason:               string,
 *   }
 */
export function scoreCandidate(candidate, context) {
  const cfg = context?.config ?? GLOBAL_SCORING_DEFAULTS;
  const input = context?.input ?? null;

  // --- feasibility gate ---------------------------------------------
  let hardViolations = Number(candidate?.metrics?.hardViolations ?? 0);
  if (hardViolations === 0 && cfg.requireFeasibility) {
    // Defense in depth: re-check with the independent evaluator.
    const ev = evaluateCandidateSafe(candidate, input);
    hardViolations = ev?.hard?.violations?.length ?? hardViolations;
  }
  const feasibility = hardViolations === 0 ? 'FEASIBLE' : 'INFEASIBLE';

  // --- per-dimension raw values + normalization ---------------------
  // We compute min/max for each dimension across the POOL first, so
  // every candidate in the pool uses the same scale.
  //
  // IMPORTANT: the RAW value is always computed (for
  // reporting) regardless of the dimension's `active` flag.
  // The `active` flag controls:
  //   - whether the dimension contributes to the global score
  //   - whether the raw value participates in pool min/max
  // The CHANGED_ASSIGNMENTS dimension, in particular, is
  // reporting-only: its raw is always shown but its
  // contribution is always 0.
  const pool = Array.isArray(context?.pool) ? context.pool : [candidate];
  const poolRaws = computePoolRaws(pool, input, context);
  const dimensions = {};
  for (const d of DIMENSION_CATALOG) {
    const isActive = d.active(input);
    const raw = d.source(candidate, context);
    const { min, max } = poolRaws[d.id] ?? { min: 0, max: 0 };
    const normalized = isActive ? normalize(raw, min, max, d.direction) : 0.5;
    const weight = (cfg.weights?.[d.id] ?? d.defaultWeight) ?? 0;
    const contribution = isActive ? normalized * weight : 0;
    dimensions[d.id] = {
      raw,
      normalized,
      weight,
      contribution,
      direction: d.direction,
      active: isActive,
      reason: isActive ? 'active' : inactiveReason(d.id, input),
    };
  }

  // --- total score --------------------------------------------------
  // Sum the contributions of all ACTIVE dimensions. Clamp to
  // [0, 1] by dividing by the total weight (so the result is
  // bounded regardless of weight choice).
  let totalWeight = 0;
  let totalContribution = 0;
  for (const id of Object.keys(dimensions)) {
    const dim = dimensions[id];
    if (!dim.active) continue;
    totalWeight += dim.weight;
    totalContribution += dim.contribution;
  }
  const total = totalWeight > 0 ? totalContribution / totalWeight : 0;

  return {
    id: candidate?.id ?? null,
    feasibility,
    hardViolations,
    qualityScore: phase27QualityScore(candidate),
    total: clamp01(total),
    dimensions,
    rankReason: feasibility === 'INFEASIBLE'
      ? 'INFEASIBLE: hard violations > 0, candidate not selectable'
      : `total = weighted blend of ${Object.values(dimensions).filter((d) => d.active).length} active dimensions`,
  };
}

// PHASE 29 — `inactiveReason(id, input)` now lives in
// `dimension-catalog.js` so the AI layer reports the same reason
// strings without importing the scorer.

/**
 * Compute raw values for every active dimension across the
 * pool. We do this in one pass so the normalization is
 * consistent across the pool.
 */
function computePoolRaws(pool, input, context) {
  const out = {};
  for (const d of DIMENSION_CATALOG) {
    if (!d.active(input)) continue;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const c of pool) {
      const v = d.source(c, context);
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 0;
    }
    out[d.id] = { min, max };
  }
  return out;
}

// ============================================================================
// Independent feasibility re-check
// ============================================================================

/**
 * Re-evaluate a candidate for the feasibility gate. The
 * function NEVER throws — it returns a "safe" evaluation
 * object even on error. The safe object is shaped like a
 * normal `evaluateCandidate` result so the caller can use it
 * with `isAccepted` without further checks.
 *
 * If `input` is null, we return:
 *   { hard: { violations: [] }, soft: { penalty: 0 },
 *     summary: { accepted: true, ... } }
 *
 * (The candidate is "accepted" by default when the input is
 * missing; the per-candidate `metrics.hardViolations` is
 * the source of truth in that case.)
 */
function evaluateCandidateSafe(candidate, input) {
  try {
    if (!input) {
      // No input → fall back to the candidate's own metrics
      // (which the candidate carries from the original solve
      // call). If the candidate claims hardViolations > 0, we
      // return INFEASIBLE.
      const hv = Number(candidate?.metrics?.hardViolations ?? 0);
      return {
        hard: { violated: hv > 0, violations: hv > 0 ? [{ reason: 'METRICS' }] : [] },
        soft: { penalty: 0, violations: [] },
        summary: {
          accepted: hv === 0,
          totalHardViolations: hv,
          totalSoftPenalty: 0,
          reasons: hv === 0 ? [] : [`hardViolations=${hv} (from candidate.metrics)`],
        },
      };
    }
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
    return evaluateCandidate({ assignments: candidate.assignments, placements }, input);
  } catch (e) {
    return {
      hard: { violated: false, violations: [] },
      soft: { penalty: 0, violations: [] },
      summary: { accepted: true, totalHardViolations: 0, totalSoftPenalty: 0, reasons: [] },
    };
  }
}

// ============================================================================
// Pool scoring
// ============================================================================

/**
 * Score every candidate in the pool. The function is PURE.
 * The `bestCandidate` for the pairwise diversity dimensions is
 * determined by the Phase 27 comparator (or by qualityScore
 * when comparator is not available).
 */
export function scorePool(candidates, input, config = GLOBAL_SCORING_DEFAULTS) {
  if (!Array.isArray(candidates)) return { scores: [], bestCandidate: null };
  const pool = [...candidates];

  // Determine the best candidate (the "diversity-to-best" anchor).
  // We use the Phase 27 comparator when both candidates carry
  // assignments; otherwise we fall back to qualityScore.
  const best = findBestCandidate(pool, input);
  const context = { input, pool, bestCandidate: best, config };

  const scores = pool.map((c) => scoreCandidate(c, context));
  return { scores, bestCandidate: best };
}

function findBestCandidate(pool, input) {
  if (pool.length === 0) return null;
  // Brief §14 — "best quality by primary quality objective".
  // The primary quality objective is the Phase 25 comparator
  // (workloadSpread primary, maxTeacherLoad secondary, ...).
  // Ties are broken deterministically: a candidate is
  // considered "better" iff compareOptimizationCandidates
  // returns a negative value. When two candidates are
  // objectively equal, we fall back to the qualityScore
  // (Phase 27 backward-compat) and then to id ASC.
  let best = pool[0];
  for (let i = 1; i < pool.length; i++) {
    const a = pool[i];
    const cmp = compareOptimizationCandidates(a, best);
    if (cmp < 0) {
      best = a;
    } else if (cmp === 0) {
      // Tie-break: qualityScore DESC, then id ASC.
      const qA = phase27QualityScore(a);
      const qB = phase27QualityScore(best);
      if (qA > qB) {
        best = a;
      } else if (qA === qB && String(a.id ?? '') < String(best.id ?? '')) {
        best = a;
      }
    }
  }
  return best;
}

// ============================================================================
// Final selection
// ============================================================================
//
// Per brief §14 / §15:
//
//   1. Filter to FEASIBLE candidates (independent evaluator
//      accepted = true).
//   2. Apply qualityFloor if configured.
//   3. Apply minSlotDiversity near-duplicate filter.
//   4. Sort by globalScore DESC (with deterministic tiebreak).
//   5. Greedy farthest-point:
//      a. Add rank 1 (best quality).
//      b. For each remaining pick: pick the candidate that
//         maximizes
//           qualityWeightInSelection * qualityScore
//         + diversityWeightInSelection * avgSlotDiversityToSelected
//      c. Stop at `count`.
//   6. Build the output with rank / scoring / diversity fields.
//
// If `count` is supplied, it is clamped to a positive integer
// (the Phase 27 {1, 3, 5, 10} snap applies to GENERATION
// requests, not to selection: a caller that generated 10
// candidates may legitimately want to surface only 2 of them).

const MIN_COUNT = 1;

function clampCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return MIN_COUNT;
  const i = Math.floor(v);
  if (i < MIN_COUNT) return MIN_COUNT;
  return i;
}

/**
 * selectFinalSolutions(candidates, options) →
 *   {
 *     solutions: [
 *       {
 *         id, rank, candidate, metrics, qualityScore, scoring,
 *         diversityToBest, diversityToPrevious, structuralDiversity,
 *         selected, rejected, rejectionReason, ...
 *       }
 *     ],
 *     diagnostics: {
 *       inputSize, feasibleSize, selectedSize,
 *       rejectedInfeasible, rejectedQualityFloor, rejectedNearDuplicate,
 *       rejectedSelectionFull, scoringTimeMs, totalTimeMs,
 *       h13: 'INACTIVE', h14: 'UNSUPPORTED',
 *       rejected: [{ id, reason }],
 *     },
 *   }
 *
 * The function NEVER mutates `candidates` or `input`. The
 * returned `solutions` is a NEW array of NEW objects.
 *
 * Brief §33 contract:
 *   options = {
 *     count,             // 1, 3, 5, or 10 (clamped)
 *     minSlotDiversity,  // 0.15 default
 *     qualityFloor,      // null default
 *     scoringConfig,     // { weights, ... }
 *     input,             // scheduling input (used for feasibility re-check)
 *     weights,           // legacy top-level (equivalent to scoringConfig.weights)
 *     qualityWeightInSelection, diversityWeightInSelection,
 *     requireFeasibility,
 *   }
 */
export function selectFinalSolutions(candidates, options = {}) {
  const start = Date.now();
  const cfg = mergeOptions(options);
  const count = clampCount(cfg.count ?? 5);

  const diag = {
    inputSize: Array.isArray(candidates) ? candidates.length : 0,
    feasibleSize: 0,
    selectedSize: 0,
    rejectedInfeasible: 0,
    rejectedQualityFloor: 0,
    rejectedNearDuplicate: 0,
    rejectedSelectionFull: 0,
    rejected: [],
    scoringTimeMs: 0,
    totalTimeMs: 0,
    h13: 'INACTIVE',
    h14: 'UNSUPPORTED',
  };

  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { solutions: [], diagnostics: { ...diag, totalTimeMs: Date.now() - start } };
  }

  // ---- 0. INPUT RESOLUTION --------------------------------------
  // The scheduling input is used for the independent
  // feasibility re-check. It can come from (in priority order):
  //   1. `options.input` (explicit, recommended)
  //   2. `candidates[i].__input` (backward-compat with the
  //      original Phase 28 surface)
  //   3. `null` (no re-check; rely on `metrics.hardViolations`)
  const input = cfg.input
    ?? candidates.find((c) => c && c.__input != null)?.__input
    ?? null;

  // ---- 1. FEASIBILITY GATE ---------------------------------------
  const feasible = [];
  const feasibleIdx = new Map(); // candidate -> index in feasible
  for (const c of candidates) {
    const ev = evaluateCandidateSafe(c, input);
    if (isAccepted(ev)) {
      feasibleIdx.set(c, feasible.length);
      feasible.push(c);
    } else {
      diag.rejectedInfeasible += 1;
      diag.rejected.push({ id: c?.id ?? null, reason: 'INFEASIBLE' });
    }
  }
  diag.feasibleSize = feasible.length;

  if (feasible.length === 0) {
    return { solutions: [], diagnostics: { ...diag, totalTimeMs: Date.now() - start } };
  }

  // ---- 2. SCORE POOL ---------------------------------------------
  const scoringStart = Date.now();
  const { scores, bestCandidate } = scorePool(feasible, input, cfg);
  diag.scoringTimeMs = Date.now() - scoringStart;

  // Index scores by candidate reference (avoid id collisions).
  const scoreByRef = new Map();
  for (let i = 0; i < feasible.length; i++) {
    scoreByRef.set(feasible[i], scores[i]);
  }

  // ---- 3. QUALITY FLOOR -----------------------------------------
  let afterFloor = feasible;
  if (typeof cfg.qualityFloor === 'number' && Number.isFinite(cfg.qualityFloor)) {
    afterFloor = feasible.filter((c) => {
      const s = scoreByRef.get(c);
      const ok = s.qualityScore >= cfg.qualityFloor;
      if (!ok) {
        diag.rejectedQualityFloor += 1;
        diag.rejected.push({ id: c?.id ?? null, reason: 'QUALITY_FLOOR' });
      }
      return ok;
    });
  }
  if (afterFloor.length === 0) {
    return { solutions: [], diagnostics: { ...diag, totalTimeMs: Date.now() - start } };
  }

  // ---- 4. GREEDY FARTHEST-POINT (quality-first) -----------------
  // Brief §15:
  //   1. select best-quality candidate (anchor)
  //   2. for each remaining pick, select the candidate that
  //      maximizes a quality + diversity blend, subject to
  //      minSlotDiversity vs every selected candidate.
  //   3. repeat until `count` reached.
  //
  // The blend for pick `i` (i >= 1) is:
  //
  //   blend(c) = qualityWeightInSelection * c.qualityScore
  //            + diversityWeightInSelection * avgSlotDiversityToSelected(c)
  //
  // where avgSlotDiversityToSelected(c) is the mean of
  // slotDiversity(c, s) over every s already in `selected`.
  //
  // The algorithm is O(N^2) which is fine for the small
  // candidate pool (default count = 5; max = 10).
  const selected = [];
  const remaining = new Set(afterFloor); // identity-based membership

  // Step 4a: anchor is the best-quality candidate in afterFloor.
  // The anchor is the comparator-best candidate that survived
  // the quality floor.
  let anchor = afterFloor[0];
  for (let i = 1; i < afterFloor.length; i++) {
    if (compareOptimizationCandidates(afterFloor[i], anchor) < 0) {
      anchor = afterFloor[i];
    }
  }
  selected.push(anchor);
  remaining.delete(anchor);

  // Step 4b: greedy farthest-point.
  while (selected.length < count && remaining.size > 0) {
    let bestPick = null;
    let bestBlend = -Infinity;
    for (const c of remaining) {
      // Hard near-duplicate filter: c must have
      // slotDiversity(c, s) >= minSlotDiversity for every s
      // already in `selected`. If not, c is rejected and
      // never considered again.
      let nearDup = false;
      for (const s of selected) {
        if (slotDiversity(s, c) < cfg.minSlotDiversity) {
          nearDup = true;
          break;
        }
      }
      if (nearDup) {
        // The brief says near-duplicates are dropped; we
        // remove them from `remaining` so we never reconsider.
        // (This is a one-time reject, not a "rejected by
        // quality floor" reject.)
        remaining.delete(c);
        diag.rejectedNearDuplicate += 1;
        diag.rejected.push({ id: c?.id ?? null, reason: 'NEAR_DUPLICATE' });
        continue;
      }
      // Compute the quality + diversity blend.
      const sC = scoreByRef.get(c);
      const qScore = sC.qualityScore;
      // avgSlotDiversityToSelected
      let sumDiv = 0;
      for (const s of selected) sumDiv += slotDiversity(s, c);
      const avgDiv = sumDiv / selected.length;
      const blend = cfg.qualityWeightInSelection * qScore
                  + cfg.diversityWeightInSelection * avgDiv;
      if (blend > bestBlend) {
        bestBlend = blend;
        bestPick = c;
      }
    }
    if (bestPick === null) {
      // All remaining candidates were near-duplicates. The
      // pool is exhausted; stop.
      break;
    }
    selected.push(bestPick);
    remaining.delete(bestPick);
  }

  // The "remaining" set now contains candidates that survived
  // the floor and feasibility gate but were not selected. Some
  // were near-duplicates (already counted); the rest were
  // simply not picked because the greedy algorithm stopped at
  // `count`.
  for (const c of remaining) {
    diag.rejectedSelectionFull = diag.rejectedSelectionFull + 1;
    diag.rejected.push({ id: c?.id ?? null, reason: 'SELECTION_FULL' });
  }

  // ---- 5. BUILD OUTPUT ------------------------------------------
  const solutions = selected.map((c, idx) => {
    const s = scoreByRef.get(c);
    const diversityToBest = idx === 0
      ? 0
      : slotDiversity(selected[0], c);
    const diversityToPrevious = idx === 0
      ? 0
      : slotDiversity(selected[Math.max(0, idx - 1)], c);
    const structural = selected.length > 1 && idx > 0
      ? structuralDiversity(selected[0], c)
      : { teacherDay: 0, sessionMix: 0, overall: 0 };
    return {
      id: c.id ?? `idx-${feasibleIdx.get(c) ?? 0}`,
      rank: idx + 1,
      candidate: c,
      metrics: c.metrics,
      qualityScore: s.qualityScore,
      scoring: {
        total: s.total,
        rank: idx + 1,
        feasibility: s.feasibility,
        hardViolations: s.hardViolations,
        dimensions: s.dimensions,
        rankReason: idx === 0
          ? `quality-first: best by primary quality objective (workloadSpread=${c.metrics?.workloadSpread}, maxLoad=${c.metrics?.maxTeacherLoad})`
          : `quality+diversity blend: qScore=${s.qualityScore.toFixed(4)}, slotDivToBest=${diversityToBest.toFixed(4)}, slotDivToPrev=${diversityToPrevious.toFixed(4)}`,
      },
      diversity: {
        slotToBest: diversityToBest,
        slotToPrevious: diversityToPrevious,
        teacherDay: structural.teacherDay,
        sessionMix: structural.sessionMix,
        overall: structural.overall,
      },
      diversityToBest,
      diversityToPrevious,
      structuralDiversity: structural,
      selected: true,
      rejected: false,
    };
  });

  diag.selectedSize = solutions.length;
  diag.totalTimeMs = Date.now() - start;

  return {
    solutions,
    diagnostics: diag,
  };
}

// ============================================================================
// Backward-compatible re-exports
// ============================================================================

export { phase27QualityScore as qualityScore };
