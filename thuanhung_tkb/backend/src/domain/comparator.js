// PHASE 25 — Global Assignment Comparator.
//
// The comparator is the single source of truth for "is candidate
// A better than candidate B?" at the GLOBAL level (i.e. when both
// candidates are COMPLETE — every assignment has its full set of
// placements and the candidate is hard-feasible).
//
// Why this lives in its own file:
//   - The metric `totalSoftCost` is REPORTING, not optimizing
//     (Phase 24.1 audit). The solver never reads metrics to rank
//     candidates.
//   - The global comparator must rank two complete candidates
//     using the GLOBAL assignment objective, not the per-step
//     `projectedLoad` heuristic.
//   - A pure, well-defined comparator is the only place that
//     can answer "is A better than B" deterministically.
//
// The comparator is:
//   - PURE: no IO, no clock, no mutation of candidates.
//   - DETERMINISTIC: same input → same output.
//   - LEXICOGRAPHIC: respects the brief's priority
//     (workloadSpread > maxTeacherLoad > workloadStdev >
//      preferencePenalty > deterministic tie-break).
//   - STRICT: a hard-infeasible candidate is never preferred
//     to a hard-feasible candidate.
//
// The comparator is a NUMERIC function: negative means A better,
// zero means equivalent, positive means B better. This is the
// conventional `Array.prototype.sort` comparator shape, and it
// composes naturally with sort utilities.
//
// No optimization is performed here — this is the EVALUATION
// function. The solver still does the search.

import { teacherLoads, workloadAggregate } from './metrics.js';

/**
 * Compute the global objective vector of a candidate. The
 * vector is read by the comparator; consumers that want a
 * single number should derive one (e.g. via `totalSoftCost`)
 * but the comparator itself uses the FULL vector to avoid
 * hiding trade-offs in a single scalar.
 *
 * The vector is a tuple:
 *   [
 *     workloadSpread,    // (max - min), lower is better
 *     maxTeacherLoad,    // highest per-teacher load, lower is better
 *     workloadStdev,     // population stdev, lower is better
 *     preferencePenalty, // mean S01 mismatch, lower is better
 *     tieBreak,          // deterministic (e.g. candidate id hash)
 *   ]
 *
 * All components are non-negative numbers. `tieBreak` is a
 * deterministic per-candidate value used to break ties.
 *
 * The function is PURE: it does not read clocks, IO, or mutate
 * the candidate.
 */
export function globalObjective(candidate) {
  if (!candidate || !candidate.assignments) {
    // Defensive: an empty / null candidate has the worst possible
    // objective. The comparator handles this case (an empty
    // candidate is never preferred over a real one).
    return {
      hardViolations: Number.POSITIVE_INFINITY,
      workloadSpread: Number.POSITIVE_INFINITY,
      maxTeacherLoad: Number.POSITIVE_INFINITY,
      workloadStdev: Number.POSITIVE_INFINITY,
      preferencePenalty: Number.POSITIVE_INFINITY,
      tieBreak: 0,
      _isEmpty: true,
    };
  }
  const loads = teacherLoads(candidate);
  const agg = workloadAggregate(loads);
  const hardViolations = candidate.metrics?.hardViolations ?? null;
  // `candidate.id` is the deterministic id produced by
  // `makeCandidateId` (Phase 23). The id is a 32-bit hash of
  // (inputSeed, candidateCounter); we use it as a deterministic
  // tie-break.
  const tieBreak = (candidate.id ?? '').length > 0
    ? stringHash32(candidate.id)
    : 0;
  return {
    hardViolations: hardViolations ?? 0,
    workloadSpread: agg.workloadSpread,
    maxTeacherLoad: agg.maxLoad,
    workloadStdev: agg.workloadStdev,
    preferencePenalty: candidate.metrics?.preferencePenalty ?? 0,
    tieBreak,
  };
}

/**
 * Deterministic 32-bit string hash. Used as a tie-break in the
 * global objective. NOT a cryptographic hash; the only requirement
 * is determinism + uniform distribution.
 */
export function stringHash32(s) {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0; // FNV prime
  }
  return h >>> 0;
}

/**
 * Compare two candidate objective vectors. Returns:
 *   < 0 if A is better than B
 *   = 0 if A and B are equivalent
 *   > 0 if B is better than A
 *
 * Priority:
 *   1. hardViolations ASC  (a hard-infeasible candidate is NEVER
 *                            preferred to a hard-feasible one)
 *   2. workloadSpread ASC
 *   3. maxTeacherLoad ASC
 *   4. workloadStdev ASC
 *   5. preferencePenalty ASC
 *   6. tieBreak (deterministic per candidate)
 *
 * The comparator is total: every pair of candidates is ordered.
 * Ties at level 6 are broken by the deterministic tie-break.
 *
 * The comparator is PURE. It does not mutate `a` or `b`. It
 * does not read clocks.
 */
export function compareOptimizationCandidates(a, b) {
  const va = globalObjective(a);
  const vb = globalObjective(b);
  // Defensive: an empty candidate is never preferred.
  if (va._isEmpty && !vb._isEmpty) return 1;
  if (!va._isEmpty && vb._isEmpty) return -1;
  if (va._isEmpty && vb._isEmpty) return 0;
  // Hard-violation gate: a hard-infeasible candidate is never
  // preferred to a hard-feasible one. If both are infeasible,
  // fall through to other criteria.
  if (va.hardViolations !== vb.hardViolations) {
    if (va.hardViolations === 0 && vb.hardViolations !== 0) return -1;
    if (va.hardViolations !== 0 && vb.hardViolations === 0) return 1;
    // Both infeasible: prefer the one with FEWER violations.
    return va.hardViolations - vb.hardViolations;
  }
  // 1. workloadSpread
  if (va.workloadSpread !== vb.workloadSpread) {
    return va.workloadSpread - vb.workloadSpread;
  }
  // 2. maxTeacherLoad (tie-break on spread)
  if (va.maxTeacherLoad !== vb.maxTeacherLoad) {
    return va.maxTeacherLoad - vb.maxTeacherLoad;
  }
  // 3. workloadStdev
  if (va.workloadStdev !== vb.workloadStdev) {
    return va.workloadStdev - vb.workloadStdev;
  }
  // 4. preferencePenalty
  if (va.preferencePenalty !== vb.preferencePenalty) {
    return va.preferencePenalty - vb.preferencePenalty;
  }
  // 5. deterministic tie-break (per-candidate id hash)
  if (va.tieBreak !== vb.tieBreak) {
    return va.tieBreak - vb.tieBreak;
  }
  return 0;
}

/**
 * Convenience wrapper: returns true iff `candidate` is strictly
 * better than `incumbent` per `compareOptimizationCandidates`.
 * This is the predicate the solver uses to decide whether to
 * replace the incumbent.
 */
export function isBetter(candidate, incumbent) {
  return compareOptimizationCandidates(candidate, incumbent) < 0;
}
