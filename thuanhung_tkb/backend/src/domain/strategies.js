// Strategy presets. The AI layer can mutate these; the solver only
// consumes them. The Strategy contract is the public interface.

/** @typedef {{
 *   id: string,
 *   description: string,
 *   weights: { preference: number, workload: number, travel: number, transfer: number, diversity: number },
 *   diversification: { mode: 'random_seed'|'objective_mix'|'solution_penalty', seed: number|null, minEditDistance: number },
 *   objectives: { noGapTeacherDay: boolean, balancedWorkload: boolean, sessionDiversity: boolean },
 *   solver: { timeLimitMs: number, maxSolutions: number },
 * }} Strategy */

export const STRATEGY_A = {
  id: 'A_PREFERENCE_FIRST',
  description: 'Preference-first; balanced otherwise.',
  weights: { preference: 2.0, workload: 1.0, travel: 0.5, transfer: 0.5, diversity: 1.0 },
  diversification: { mode: 'solution_penalty', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: false },
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_B = {
  id: 'B_WORKLOAD_TRAVEL',
  description: 'Workload and travel first; diversity second.',
  weights: { preference: 0.5, workload: 2.0, travel: 1.5, transfer: 1.5, diversity: 1.0 },
  diversification: { mode: 'objective_mix', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const STRATEGY_C = {
  id: 'C_BALANCED',
  description: 'Balanced across all dimensions.',
  weights: { preference: 1.0, workload: 1.0, travel: 1.0, transfer: 1.0, diversity: 1.0 },
  diversification: { mode: 'random_seed', seed: null, minEditDistance: 0.15 },
  objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: true },
  solver: { timeLimitMs: 5000, maxSolutions: 5 },
};

export const PRESETS = [STRATEGY_A, STRATEGY_B, STRATEGY_C];

export function withSeed(strategy, seed) {
  return { ...strategy, diversification: { ...strategy.diversification, seed } };
}

export function clampWeights(strategy) {
  const clamp = (n) => Math.max(0, Math.min(3, n));
  return {
    ...strategy,
    weights: {
      preference: clamp(strategy.weights.preference),
      workload: clamp(strategy.weights.workload),
      travel: clamp(strategy.weights.travel),
      transfer: clamp(strategy.weights.transfer),
      diversity: clamp(strategy.weights.diversity),
    },
  };
}
