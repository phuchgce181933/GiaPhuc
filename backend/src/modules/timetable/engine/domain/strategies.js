// Strategy presets. The AI layer can mutate these; the solver only
// consumes them. The Strategy contract is the public interface.
//
// PHASE 17 — strategy drives the SEARCH via three objective switches:
//   - `balancedWorkload`: variant ordering + per-slot pressure.
//   - `noGapTeacherDay`: per-slot pressure for contiguous day slots.
//   - `sessionDiversity` (PHASE 17.1): no longer affects the search;
//     the score is now "session compactness" (1 = no split day,
//     0 = split day) and is computed only at scoring time.
//
// PHASE 17.1 — `sessionDiversity` semantics
// ──────────────────────────────────────────
// The PHASE 17 v1 implementation REWARDED a teacher for having
// both sang and chieu on the same day, both at search time
// (slot-pool bias toward opposite session) and at score time
// (mixed-day ratio). This was found to fragment teacher
// schedules against the other objectives (S_PREFERRED_SESSION,
// S_MAX_SESSIONS_PER_WEEK, compactness, travel, usability).
//
// In PHASE 17.1, the search no longer consults `sessionDiversity`.
// The score still carries the field but with the INVERTED
// semantic: it now MEASURES SESSION COMPACTNESS — the share of
// teacher-days where the teacher has slots in at most one
// session. A teacher with 1 morning on Mon and 1 morning on Tue
// scores 1; a teacher with 1 morning on Mon and 1 afternoon on
// Mon scores 0.
//
// The `weights.sessionDiversity` weight in `overallScore` is
// preserved. Strategies B and C turn it on; A turns it off. The
// field is also consulted by the orchestrator's A/B/C comparison
// (so the audit-friendly `comparison` block continues to report
// the per-strategy top score).
//
// The SOLUTION-to-SOLUTION diversity (different teachers, different
// slot identities, different day patterns) is reported separately
// via `structuralDiversity` in diversity.js. The two concepts are
// now cleanly separated.
//
// PHASE 24 — `optimizationMode` switch
// ────────────────────────────────────
// The strategy now exposes a separate `optimizationMode` field
// that selects WHICH objective the solver uses to pick among
// eligible teachers for an assignment. The mode is consulted by
// the solver's variant sort (see `solver.js` §"Variant sort").
//
//   BASE_FEASIBLE         — variant list = pre-set teacher only.
//                           Legacy ordering, pre-set wins.
//   ASSIGNMENT_BALANCED   — variant list = pre-set + every
//                           eligible same-home-branch teacher.
//                           Sort prefers lower projected load,
//                           then later index, then rng.
//   PREFERENCE_FIRST      — variant list = pre-set + every
//                           eligible same-home-branch teacher.
//                           Sort prefers teachers whose
//                           `nguyenVong.buoiUuTien` matches the
//                           assignment's branch session (S01).
//   GLOBAL_ASSIGNMENT_BALANCED  — variant list same as
//                           ASSIGNMENT_BALANCED. The solver
//                           CONTINUES SEARCHING after the first
//                           feasible candidate, evaluates each
//                           complete candidate globally, and
//                           retains the best per the global
//                           comparator (see `comparator.js`).
//                           Returns `bestCandidateFound` (NOT
//                           "first feasible", NOT "global
//                           optimum") when the time budget is
//                           exhausted. The brief calls this
//                           `BEST_FOUND`; we never claim global
//                           optimum without proof.

/** @typedef {{
 *   id: string,
 *   description: string,
 *   weights: {
 *     preference: number, workload: number, travel: number,
 *     transfer: number, diversity: number, noGap: number,
 *     sessionDiversity: number
 *   },
 *   diversification: { mode: 'random_seed'|'objective_mix'|'solution_penalty', seed: number|null, minEditDistance: number },
 *   objectives: { noGapTeacherDay: boolean, balancedWorkload: boolean, sessionDiversity: boolean },
 *   optimizationMode: 'BASE_FEASIBLE'|'ASSIGNMENT_BALANCED'|'PREFERENCE_FIRST',
 *   solver: {
 *     timeLimitMs: number,
 *     maxSolutions: number,
 *     maxSearchIterations?: number,
 *   },
 * }} Strategy
 *
 * PHASE 31.1 — `maxSearchIterations` is OPTIONAL and bounds the
 * search by an iteration COUNT rather than by elapsed time, which is
 * what makes a solve reproducible regardless of machine load. Absent
 * means "no iteration bound", in which case `timeLimitMs` is the only
 * bound and the result is reproducible only while the budget does not
 * bind. The solver reports which bound applied in
 * `diagnostics.searchStoppedBy`. See the determinism contract in
 * `solver.js` and `multi-solution.js`.
 */

/**
 * Candidate-count vocabulary. This is the GENERATION-side
 * vocabulary ("how many candidates may be asked for"), and it is
 * the single source of truth for it.
 *
 * PHASE 29 moves it here from `multi-solution.js` so the AI
 * Strategy Layer can bound `candidateCount` WITHOUT importing
 * `multi-solution.js` -> `solver.js` (brief §36). The AI layer
 * may only ask for one of these four values.
 *
 * NOTE: this is deliberately NOT the same knob as the Phase 28
 * `selectFinalSolutions({ count })`, which clamps to any positive
 * integer. Generating 10 and surfacing 2 of them is legitimate.
 */
export const ALLOWED_CANDIDATE_COUNTS = Object.freeze([1, 3, 5, 10]);

export const OPTIMIZATION_MODES = Object.freeze({
  BASE_FEASIBLE: 'BASE_FEASIBLE',
  ASSIGNMENT_BALANCED: 'ASSIGNMENT_BALANCED',
  PREFERENCE_FIRST: 'PREFERENCE_FIRST',
  GLOBAL_ASSIGNMENT_BALANCED: 'GLOBAL_ASSIGNMENT_BALANCED',
});

export const STRATEGY_A = {
  id: 'A_PREFERENCE_FIRST',
  description: 'Preference-first; balanced otherwise.',
  weights: { preference: 2.0, workload: 1.0, travel: 0.5, transfer: 0.5, diversity: 1.0, noGap: 0.5, sessionDiversity: 0.0 },
  diversification: { mode: 'solution_penalty', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: false },
  optimizationMode: 'PREFERENCE_FIRST',
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_B = {
  id: 'B_WORKLOAD_TRAVEL',
  description: 'Workload and travel first; diversity second.',
  weights: { preference: 0.5, workload: 2.0, travel: 1.5, transfer: 1.5, diversity: 1.0, noGap: 1.5, sessionDiversity: 1.5 },
  diversification: { mode: 'objective_mix', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
  optimizationMode: 'ASSIGNMENT_BALANCED',
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_C = {
  id: 'C_BALANCED',
  description: 'Balanced across all dimensions.',
  weights: { preference: 1.0, workload: 1.0, travel: 1.0, transfer: 1.0, diversity: 1.0, noGap: 1.0, sessionDiversity: 1.0 },
  diversification: { mode: 'random_seed', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
  optimizationMode: 'BASE_FEASIBLE',
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const PRESETS = [STRATEGY_A, STRATEGY_B, STRATEGY_C];

export function withSeed(strategy, seed) {
  return { ...strategy, diversification: { ...strategy.diversification, seed } };
}

const ALL_WEIGHT_KEYS = [
  'preference', 'workload', 'travel', 'transfer', 'diversity',
  'noGap', 'sessionDiversity',
];

export function clampWeights(strategy) {
  const clamp = (n) => Math.max(0, Math.min(3, Number(n) || 0));
  const w = { ...strategy.weights };
  for (const k of ALL_WEIGHT_KEYS) w[k] = clamp(w[k]);
  return { ...strategy, weights: w };
}
