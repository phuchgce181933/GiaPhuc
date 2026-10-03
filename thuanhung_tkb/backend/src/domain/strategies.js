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
 *   solver: { timeLimitMs: number, maxSolutions: number },
 * }} Strategy */

export const STRATEGY_A = {
  id: 'A_PREFERENCE_FIRST',
  description: 'Preference-first; balanced otherwise.',
  weights: { preference: 2.0, workload: 1.0, travel: 0.5, transfer: 0.5, diversity: 1.0, noGap: 0.5, sessionDiversity: 0.0 },
  diversification: { mode: 'solution_penalty', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: false },
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_B = {
  id: 'B_WORKLOAD_TRAVEL',
  description: 'Workload and travel first; diversity second.',
  weights: { preference: 0.5, workload: 2.0, travel: 1.5, transfer: 1.5, diversity: 1.0, noGap: 1.5, sessionDiversity: 1.5 },
  diversification: { mode: 'objective_mix', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_C = {
  id: 'C_BALANCED',
  description: 'Balanced across all dimensions.',
  weights: { preference: 1.0, workload: 1.0, travel: 1.0, transfer: 1.0, diversity: 1.0, noGap: 1.0, sessionDiversity: 1.0 },
  diversification: { mode: 'random_seed', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
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
