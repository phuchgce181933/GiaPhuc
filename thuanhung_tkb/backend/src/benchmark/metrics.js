// PHASE 31 — QUALITY + OPERATIONAL METRICS, AND AGGREGATION.
//
// Two rules govern everything in this file.
//
//  1. THE INDEPENDENT EVALUATOR AND THE PHASE 28 SCORER ARE THE
//     ORACLE. Not the AI's rationale, not a comment, not a human's
//     opinion. Brief §26 forbids letting a model grade itself, and
//     §27 says its rationale is explanation, not evidence. So
//     `accepted` and `hardViolations` here come from
//     `evaluateCandidate`, and `bestGlobalScore` comes from
//     `scoring.total` as produced by the Phase 28 scorer. The
//     benchmark reads those values; it never computes its own
//     opinion of quality.
//
//  2. NOTHING IS COLLAPSED TO ONE NUMBER. Brief §17 forbids judging
//     on a single metric, and §13 lists the set that must be
//     recorded. `qualityOf()` returns all of them side by side, and
//     only `bestGlobalScore` is ever *decided* on (see
//     AI_STRATEGY_EVALUATION_POLICY in versions.js). The rest are
//     recorded so a reader can see whether an improvement in the
//     score came with a regression in workload balance, which is
//     the thing worth knowing.
//
// ON "best"
// ----------
// `best*` means "the rank-1 solution of the Phase 28 selection" — the
// schedule the system would actually ship. It is not the maximum over
// all solutions: selecting a different solution per metric would mean
// reporting numbers from up to nine different schedules under one
// run's name, which is a form of cherry-picking that brief §22 does
// not carve out for metrics.

import { evaluateCandidate, isAccepted } from '../domain/constraints/index.js';

// ============================================================================
// Quality metrics for ONE run
// ============================================================================

/**
 * qualityOf(solutions, input) -> QualityMetrics
 *
 * `solutions` is the Phase 28 `selectFinalSolutions` output.
 * Returns all-null metrics when no solution was selected, which is a
 * legitimate and important outcome: an empty pool is a result, and
 * the benchmark records it as DOWNSTREAM_NO_SOLUTION rather than
 * quietly producing zeros that would average into a fake score.
 */
export function qualityOf(solutions, input = null) {
  const empty = {
    selectedCount: 0,
    bestGlobalScore: null,
    bestQualityScore: null,
    bestWorkloadSpread: null,
    bestMaxTeacherLoad: null,
    bestWorkloadStdev: null,
    minSlotDiversity: null,
    minStructuralDiversity: null,
    hardViolations: null,
    accepted: null,
    oracleIndependentCheck: null,
  };
  const list = Array.isArray(solutions) ? solutions : solutions?.solutions ?? [];
  if (list.length === 0) return empty;

  const best = list[0];
  const metrics = best.metrics ?? {};

  // `minSlotDiversity` / `minStructuralDiversity` are taken over the
  // WHOLE selected set, not just rank 1: a benchmark that only ever
  // looked at the first solution could not see a strategy that
  // produces one good schedule and several near-duplicates.
  const slotDivs = list.map((s) => numberOrNull(s.diversity?.slotToPrevious)).filter((v) => v !== null);
  const structural = list.map((s) => numberOrNull(s.structuralDiversity?.overall)).filter((v) => v !== null);

  // The independent re-check. `selectFinalSolutions` already gates on
  // feasibility internally; re-running the evaluator here is what
  // makes "the oracle said yes" a recorded fact in the report rather
  // than an assumption about a caller's internals.
  let oracle = null;
  if (best.candidate && input) {
    const ev = evaluateCandidate(best.candidate, input);
    oracle = {
      hardViolations: ev.summary.totalHardViolations,
      softPenalty: ev.summary.totalSoftPenalty,
      accepted: isAccepted(ev),
      constraintStatuses: ev.constraintStatuses,
    };
  }

  return {
    selectedCount: list.length,
    bestGlobalScore: numberOrNull(best.scoring?.total),
    bestQualityScore: numberOrNull(best.qualityScore),
    bestWorkloadSpread: numberOrNull(metrics.workloadSpread),
    bestMaxTeacherLoad: numberOrNull(metrics.maxTeacherLoad),
    bestWorkloadStdev: numberOrNull(metrics.workloadStdev),
    minSlotDiversity: slotDivs.length ? Math.min(...slotDivs) : null,
    minStructuralDiversity: structural.length ? Math.min(...structural) : null,
    hardViolations: numberOrNull(best.scoring?.hardViolations),
    accepted: best.scoring?.feasibility === undefined ? null : Boolean(best.scoring.feasibility),
    // Filled in by the benchmark's shared-pool pass. `null` until then,
    // and `null` is also the honest value for a run with no schedule.
    sharedPoolGlobalScore: null,
    oracleIndependentCheck: oracle,
  };
}

// ============================================================================
// Operational metrics for ONE run
// ============================================================================

/**
 * latencyOf({ plan, planMs, solverMs, scoringMs }) -> OperationalMetrics
 *
 * `aiLatencyMs` is the provider round trip as the orchestrator
 * measured it, not as the Python service reported it. The service's
 * own number is kept alongside it as `serviceReportedAiMs`, because
 * the difference between the two is the HTTP + validation overhead
 * and an operator debugging a slow AI needs to see it.
 *
 * `strategyValidationMs` comes from `plan.timing.validationMs`,
 * which `planStrategy` measures around `validateStrategyDecision`
 * specifically. It is a real measurement rather than
 * `total - report - ai`, so a regression in the validator is
 * visible as its own number instead of hiding in a residual.
 */
export function latencyOf(observed = {}) {
  const { plan = null, planMs = null, solverMs = null, scoringMs = null } = observed;
  const aiLatencyMs = plan?.timing?.aiMs ?? null;
  const service = plan?.rawOutput?.__airllm ?? null;
  return {
    aiLatencyMs,
    serviceReportedAiMs: numberOrNull(service?.latencyMs ?? null),
    strategyValidationMs: plan?.timing?.validationMs ?? null,
    reportBuildMs: plan?.timing?.reportMs ?? null,
    planMs,
    solverMs,
    scoringMs,
    totalPipelineMs: sum([aiLatencyMs, plan?.timing?.validationMs ?? null, plan?.timing?.reportMs ?? null, solverMs, scoringMs]),
  };
}

// ============================================================================
// Aggregation (brief §22, §23)
// ============================================================================

/**
 * aggregate(values) -> Distribution
 *
 * Every run that produced a value contributes. Runs that produced
 * `null` — a fallback, a rejected decision, an empty solution pool —
 * are EXCLUDED, and `excluded` says how many, so a mean over 3 valid
 * runs is never presented as a mean over 5.
 *
 * Reported: n, mean, median, min, max, variance (population),
 * stdev, and the values themselves. The raw list is part of the
 * output on purpose: brief §23 is explicit that a reader must be able
 * to see run 1 good / run 2 bad / run 3 good rather than a summary
 * that hides the alternation.
 */
export function aggregate(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => numberOrNull(v))
    .filter((v) => v !== null);
  const excluded = (Array.isArray(values) ? values : []).length - nums.length;

  if (nums.length === 0) {
    return {
      n: 0, excluded, mean: null, median: null, min: null, max: null,
      variance: null, stdev: null, values: [],
    };
  }

  const sorted = [...nums].sort((a, b) => a - b);
  const sum = nums.reduce((a, b) => a + b, 0);
  const mean = sum / nums.length;
  const variance = nums.reduce((a, v) => a + (v - mean) ** 2, 0) / nums.length;

  return {
    n: nums.length,
    excluded,
    mean: round(mean),
    median: round(medianOf(sorted)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    variance: round(variance),
    stdev: round(Math.sqrt(variance)),
    values: nums.map((v) => round(v)),
  };
}

/**
 * Aggregate a numeric field across a set of runs.
 * `metricNames` is the full list to report, so a metric that is null
 * everywhere still appears with `n: 0` instead of vanishing.
 */
export function aggregateRuns(runs, metricNames) {
  const out = {};
  for (const name of metricNames) {
    out[name] = aggregate((runs ?? []).map((r) => r?.quality?.[name] ?? null));
  }
  return out;
}

// ============================================================================
// Rates (brief §15)
// ============================================================================

/**
 * validityAndFallbackRates(runs)
 *   -> { requests, valid, fallback, invalid, validityRate, fallbackRate }
 *
 *   requests      — runs that CONSULTED A PROVIDER
 *   valid         — a decision was APPROVED and reached the solver
 *   fallback      — a provider was consulted and the deterministic
 *                   fallback was used instead
 *   invalid       — not valid AND not fallback: an accepted decision
 *                   that then produced no feasible schedule, i.e.
 *                   DOWNSTREAM_NO_SOLUTION
 *   validityRate  — valid / requests
 *   fallbackRate  — fallback / requests
 *
 * `requests` counts `plannerName !== null`, NOT `runs.length`. The
 * baseline arm consults no provider by construction, so counting it
 * as N "requests, 0 valid, N fallback" would describe a 0% validity
 * rate for a run that never asked anything. It would also make the
 * baseline row of the report unreadable next to the AI row.
 *
 * Brief §15's worked example: 5 requests, 4 valid, 1 fallback gives
 * `0.8` and `0.2`. The rates are computed, never rounded to a
 * flattering figure, and the counts are reported next to them so
 * "100% success" over 1 request is visible as such.
 */
export function validityAndFallbackRates(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => r?.plannerName != null);
  const requests = list.length;
  let valid = 0;
  let fallback = 0;
  for (const r of list) {
    if (r?.fallbackUsed === true) fallback += 1;
    else if (r?.aiDecisionUsed === true) valid += 1;
  }
  const invalid = requests - valid - fallback;
  return {
    requests,
    valid,
    fallback,
    invalid,
    validityRate: requests === 0 ? null : round(valid / requests),
    fallbackRate: requests === 0 ? null : round(fallback / requests),
  };
}

/**
 * Decision diversity (brief §12, §16).
 *
 * `distinctStrategyHashes` is the headline: with sampling on, N runs
 * producing N different hashes is expected and is NOT a defect. The
 * function reports the distribution so "same situation -> same
 * strategy?" is answered with evidence.
 */
export function decisionDiversity(runs) {
  const list = Array.isArray(runs) ? runs : [];
  const hashes = list.map((r) => r?.strategyHash ?? null);
  const modes = list.map((r) => r?.decision?.optimizationMode ?? null);
  const counts = list.map((r) => r?.decision?.candidateCount ?? null);
  const unique = (arr) => [...new Set(arr.filter((v) => v !== null))];

  return {
    runs: list.length,
    distinctStrategyHashes: unique(hashes).length,
    strategyHashes: unique(hashes).sort(),
    distinctModes: unique(modes).length,
    modes: unique(modes).sort(),
    distinctCandidateCounts: unique(counts).length,
    candidateCounts: unique(counts).sort(),
    stable: unique(hashes).length <= 1,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sum(values) {
  const nums = values.map(numberOrNull).filter((v) => v !== null);
  return nums.length === 0 ? null : round(nums.reduce((a, b) => a + b, 0));
}

/** Round to 6 decimals. Enough to separate 1e-6, coarse enough to read. */
function round(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

function medianOf(sorted) {
  const n = sorted.length;
  if (n === 0) return null;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The full metric list the report must carry.
 *
 * `bestGlobalScore` is listed first and separately: it is the policy's
 * `primaryMetric` and the comparison reads `arm.quality.bestGlobalScore`
 * directly, so it must be present in every arm's aggregate map. The
 * rest are the brief §13 metrics, recorded but never decided on.
 *
 * `accepted` is NOT in this list because it is a boolean, not a
 * measurement: averaging `true`/`false` into a "mean acceptance" is a
 * number that means nothing. It is counted instead, in
 * `summariseArm().feasibility` and `rates`.
 */
export const QUALITY_METRIC_NAMES = Object.freeze([
  'sharedPoolGlobalScore',
  'bestGlobalScore',
  'bestQualityScore',
  'bestWorkloadSpread',
  'bestMaxTeacherLoad',
  'bestWorkloadStdev',
  'minSlotDiversity',
  'minStructuralDiversity',
  'hardViolations',
]);

export const LATENCY_METRIC_NAMES = Object.freeze([
  'aiLatencyMs',
  'strategyValidationMs',
  'solverMs',
  'scoringMs',
  'totalPipelineMs',
]);
