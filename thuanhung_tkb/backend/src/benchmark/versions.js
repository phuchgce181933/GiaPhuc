// PHASE 31 — BENCHMARK VERSION STAMPS + EVALUATION POLICY.
//
// Phase 31 measures. It makes no change to the AI strategy layer,
// the solver, the evaluator, or the scorer; it only calls them and
// records what came back. This file exists so that "which numbers
// were produced, and under which rules" is answerable from the report
// itself rather than from memory (brief §31, §32, §33).
//
// TWO KINDS OF VERSION, AND THE DIFFERENCE MATTERS
// ------------------------------------------------
//
//   DECLARED  — a label a human bumps by hand when behaviour
//               changes. Cheap to write, easy to forget.
//   DERIVED   — a content hash computed from the thing itself at
//               run time. Cannot drift, because it is recomputed
//               from the live object on every run.
//
// The Phase 31 guarantee rests on the DERIVED stamps. The declared
// labels are documentation; a forgotten bump degrades a label, never
// the ability to detect that two runs used different inputs.
//
// Concretely, the report carries both, and a reader who distrusts the
// labels can compare the hashes instead.
//
// WHAT IS NEVER RECORDED
// ----------------------
// No teacher name, e-mail, or phone number. The dataset stamp hashes
// sorted opaque identifiers and reports only the hash, so two runs can
// be proven to have used the same data without the data being
// reproduced in an artifact (brief §33, Phase 29 §26).

import { DIMENSION_CATALOG } from '../domain/dimension-catalog.js';
import { GLOBAL_SCORING_DEFAULTS } from '../domain/global-scoring.js';
import { canonicalStringify } from '../domain/ai/situation-report.js';

// ============================================================================
// Declared labels — bump by hand
// ============================================================================

/**
 * The benchmark contract itself. Bump when a metric, a run, or the
 * report layout changes in a way that makes older numbers
 * incomparable.
 */
export const BENCHMARK_VERSION = 'PHASE_31.1';

/** The prompt template is versioned on the Python side (app/prompt.py). */
export const PROMPT_VERSION_LABEL = 'AI_STRATEGY_PROMPT_VERSION (Python, read from the service)';

/**
 * Which domain phase the measured pipeline belongs to. These are not
 * invented version numbers; each names the phase that owns the
 * behaviour, so "which code produced this score" is one lookup.
 */
export const SOLVER_VERSION = 'phase25-global-assignment-optimization';
export const SCORING_CONFIG_VERSION = 'phase28-global-scoring-selection';
export const CONSTRAINT_CATALOG_VERSION = 'phase22-constraint-audit';
export const STRATEGY_LAYER_VERSION = 'phase29-ai-strategy-layer';
export const PROVIDER_VERSION = 'phase30-airllm-local-provider';

/** Where the benchmark dataset came from. */
export const DATASET_SOURCE = 'legacy-saplich/real';

// ============================================================================
// Derived stamps — computed, never typed
// ============================================================================

/**
 * FNV-1a, 32 bit, 8 lowercase hex chars. Identical in spirit to
 * `hashSituationReport`; duplicated rather than imported so this
 * module has no dependency on the AI layer's internals, and because a
 * benchmark hash that could silently share an implementation with the
 * thing it is measuring is one bug away from agreeing with itself.
 */
export function fnv1a32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Hash any JSON-shaped value. Keys are sorted, so order cannot leak in. */
export function hashValue(value) {
  return fnv1a32(canonicalStringify(value));
}

/**
 * Hash of the dimension catalogue: every dimension's id, direction,
 * default weight, and whether it is active on the benchmark input.
 * A new dimension, a retuned default, or a flipped activation flag
 * all change it, so two runs with the same hash scored the same axes
 * the same way (brief §32).
 */
export function dimensionCatalogVersion(input) {
  return hashValue(DIMENSION_CATALOG.map((d) => ({
    id: d.id,
    direction: d.direction,
    defaultWeight: d.defaultWeight,
    active: Boolean(d.active(input)),
  })));
}

/**
 * Hash of the Phase 28 scorer's own defaults. `scoringConfigVersion`
 * is derived from this rather than typed, so a re-tuned
 * `qualityWeightInSelection` cannot be presented as the same scorer.
 */
export function scoringDefaultsVersion() {
  const d = GLOBAL_SCORING_DEFAULTS;
  return hashValue({
    weights: d.weights,
    qualityFloor: d.qualityFloor,
    qualityWeightInSelection: d.qualityWeightInSelection,
    diversityWeightInSelection: d.diversityWeightInSelection,
    requireFeasibility: d.requireFeasibility,
    minSlotDiversity: d.minSlotDiversity,
  });
}

// ============================================================================
// Evaluation policy
// ============================================================================

/** The five per-run verdicts of brief §21. */
export const RUN_VERDICT = Object.freeze({
  BETTER: 'BETTER',
  EQUIVALENT: 'EQUIVALENT',
  WORSE: 'WORSE',
  INVALID: 'INVALID',
  FALLBACK: 'FALLBACK',
});

/** The five conclusions of brief §41. Nothing else is permitted. */
export const BENCHMARK_CONCLUSION = Object.freeze({
  RUNTIME_READY: 'AIRLLM_RUNTIME_READY',
  VALID_NO_GAIN: 'AI_STRATEGY_VALID_BUT_NO_MEASURABLE_GAIN',
  IMPROVES: 'AI_STRATEGY_IMPROVES_RESULTS',
  WORSE: 'AI_STRATEGY_WORSE_THAN_FALLBACK',
  BLOCKED: 'AIRLLM_BENCHMARK_BLOCKED',
});

/** The nine allowed conclusion values, as a set, for validation. */
export const ALLOWED_CONCLUSIONS = Object.freeze(Object.values(BENCHMARK_CONCLUSION));

/** The two tiers of brief §1. They are never merged into one verdict. */
export const BENCHMARK_TIER = Object.freeze({
  RUNTIME: 'TIER_A_RUNTIME_SMOKE',
  QUALITY: 'TIER_B_STRATEGY_QUALITY',
});

/**
 * AI_STRATEGY_EVALUATION_POLICY v1 — the documented rule that turns
 * two sets of measurements into one of `RUN_VERDICT`.
 *
 * Stated in full here because brief §21 requires the comparison to
 * follow a *documented* policy rather than a judgement call, and
 * because a policy that lives only in prose cannot be tested.
 *
 *   1. The arms are compared on `bestGlobalScore` — the Phase 28
 *      `scoring.total` of the rank-1 solution, which is the score of
 *      the schedule the system would actually ship. It is the only
 *      metric produced by the scorer; workload spread, stdev, and
 *      diversity are RECORDED but never used to decide, because each
 *      of them favours a different strategy and letting them vote
 *      would let the policy be tuned after the fact.
 *   2. Each arm is summarised by the MEDIAN over its N runs. The
 *      median is used rather than the mean because one pathological
 *      run must not move the answer, and rather than the best run
 *      because brief §22 and §23 forbid cherry-picking.
 *   3. `EPSILON = 1e-6` on the score. Below it the arms are
 *      EQUIVALENT; a float tie is not a result.
 *   4. Validity gates the verdict. A run whose decision was rejected
 *      contributes NO score at all — it is counted in
 *      `validityRate`/`fallbackRate` and excluded from the arm's
 *      median. A fallback run is never scored as if it were an AI run.
 *   5. `separation` is reported next to the verdict. When the two
 *      arms' [min, max] ranges OVERLAP, a BETTER/WORSE verdict is a
 *      statement about the median only, and the report is required to
 *      downgrade the overall conclusion to
 *      `AI_STRATEGY_VALID_BUT_NO_MEASURABLE_GAIN` (brief §41: the
 *      data does not prove improvement at N = 5).
 */
export const AI_STRATEGY_EVALUATION_POLICY = Object.freeze({
  version: 'AIRLLM_EVAL_POLICY_V1',
  primaryMetric: 'bestGlobalScore',
  aggregator: 'median',
  epsilon: 1e-6,
  gatesOnValidity: true,
  overlappingRangesDowngradeConclusion: true,
  decidedBy: Object.freeze(['bestGlobalScore']),
  recordedOnly: Object.freeze([
    'bestQualityScore',
    'bestWorkloadSpread',
    'bestMaxTeacherLoad',
    'bestWorkloadStdev',
    'minSlotDiversity',
    'minStructuralDiversity',
    'aiLatencyMs',
    'strategyValidationMs',
    'solverMs',
    'scoringMs',
    'totalPipelineMs',
  ]),
});

/** Hash of the policy itself, so a policy edit invalidates old numbers. */
export function evaluationPolicyVersion() {
  return hashValue(AI_STRATEGY_EVALUATION_POLICY);
}
