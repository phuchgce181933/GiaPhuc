// PHASE 31 — TIER B: STRATEGY QUALITY BENCHMARK.
//
//   DETERMINISTIC_FALLBACK   vs   AIRLLM
//
// on one fixed SchedulingInput, through one solver, one evaluator, one
// scorer, one seed, and one candidate count. The only variable is
// which AIPlanner produced the strategy.
//
// THE SHAPE OF A RUN
// ------------------
//   1. PLAN   N times per arm. No solving. This is brief §20's
//             strategy-only comparison, and it is where the fair
//             candidate count is decided (brief §19).
//   2. ALIGN  one candidate count, the maximum any arm asked for.
//             Both arms solve for it. The natural counts are recorded
//             so the report can say the baseline was raised.
//   3. SOLVE  each captured plan through generateSolutions + Phase 28
//             selectFinalSolutions, with identical settings.
//   4. MEASURE  quality, latency, validity, diversity.
//   5. DECIDE  by AI_STRATEGY_EVALUATION_POLICY, and no other way.
//
// WHY PLAN BEFORE SOLVE
// ---------------------
// Two reasons, and the second is the important one.
//
//   - Brief §20 asks for it: comparing the strategies before solving
//     is what proves the AI changed anything. If every AI decision
//     hashes the same as the fallback's, the benchmark reports
//     AIRLLM_DECISION_EQUIVALENT and makes no quality claim, because
//     there is nothing to attribute a difference to.
//   - It halves the AirLLM calls. The decision that was compared is
//     the decision that gets solved, so a sampling model is not
//     sampled twice for one row of the table.
//
// WHY THE BASELINE RUNS N TIMES FOR A DETERMINISTIC ANSWER
// ---------------------------------------------------------
// Because running it N times is the measurement. If the fallback
// produced two different schedules across N identical runs, the
// "deterministic" baseline would not be deterministic and every
// comparison against it would be meaningless. The repetition is a
// test of the baseline, not padding.

import { GLOBAL_SCORING_DEFAULTS, scorePool } from '../domain/global-scoring.js';
import {
  AIRLLM_FAILURE,
  classifyAirLLMOutcome,
  tallyFailures,
} from './classification.js';
import {
  LATENCY_METRIC_NAMES,
  QUALITY_METRIC_NAMES,
  aggregate,
  aggregateRuns,
  decisionDiversity,
  validityAndFallbackRates,
} from './metrics.js';
import {
  BENCHMARK_SOLVER_PROFILE,
  SOLVER_PROFILE_HASH,
  alignCandidateCount,
  planStrategyOnce,
  solvePlannedInput,
  strategyHashOf,
} from './runner.js';
import { RUNTIME_RESULT, isAirLLMPlanner } from './smoke.js';
import {
  AI_STRATEGY_EVALUATION_POLICY,
  BENCHMARK_CONCLUSION,
  BENCHMARK_TIER,
  RUN_VERDICT,
  evaluationPolicyVersion,
  hashValue,
} from './versions.js';

export const BENCHMARK_ARMS = Object.freeze({
  BASELINE: 'BASELINE',
  AI: 'AIRLLM',
});

/** Why a benchmark could not reach a quality conclusion. */
export const BLOCKED_ON = Object.freeze({
  ENVIRONMENT: 'ENVIRONMENT',
  RUNTIME_FAILURE: 'RUNTIME_FAILURE',
  STRATEGY_VALIDITY: 'STRATEGY_VALIDITY',
  NO_SOLUTION: 'NO_SOLUTION',
  NOT_RUN: 'NOT_RUN',
});

/** The equivalence signal of brief §20. */
export const DECISION_EQUIVALENT = 'AIRLLM_DECISION_EQUIVALENT';

/**
 * The third signal. Needed because "not equivalent" and "nothing to
 * compare" are different facts, and a report that conflates them will
 * claim the AI differed from the fallback on a run where the AI
 * produced nothing at all.
 */
export const DECISION_NONE = 'AIRLLM_DECISION_ABSENT';

export const BENCHMARK_DEFAULTS = Object.freeze({
  // Brief §11: N small but big enough to see variance.
  repetitions: 5,
  profile: BENCHMARK_SOLVER_PROFILE,
});

/**
 * runStrategyBenchmark(options) -> BenchmarkResult
 *
 *   {
 *     tier: 'TIER_B_STRATEGY_QUALITY',
 *     ran: boolean,
 *     blockedOn: string | null,
 *     fairness: { solverProfile, solverProfileHash, candidateCount, ... },
 *     arms: {
 *       BASELINE: { runs, quality, latency, rates, diversity, failures },
 *       AIRLLM:   { runs, quality, latency, rates, diversity, failures },
 *     },
 *     comparison: { verdict, separation, medianDelta, perRun, ... },
 *     decisionEffect: { equivalent, baselineHashes, aiHashes },
 *     conclusion: one of the five allowed strings,
 *     conclusionReason: string,
 *   }
 *
 * `ran: false` with a `blockedOn` is a first-class, honest outcome
 * (brief §35). It is never converted into a pass, and a skipped
 * integration run is never counted as a result.
 */
export async function runStrategyBenchmark(options = {}) {
  const {
    input,
    aiPlanner = null,
    repetitions = BENCHMARK_DEFAULTS.repetitions,
    // `null` = decide automatically (N, or 1 when Tier A was BLOCKED).
    aiRepetitions = null,
    profile = BENCHMARK_DEFAULTS.profile,
    planOptions = {},
    probe = null,
    smoke = null,
    provenance = null,
  } = options;

  const n = Math.max(1, Math.floor(Number(repetitions) || 1));

  // The AI arm's repetition count, decided BEFORE any run.
  //
  // When Tier A came back BLOCKED, the AirLLM service is not reachable
  // on this host. Every AI request will therefore fail at the socket,
  // fall back, and produce a schedule indistinguishable from the
  // baseline's. Repeating it N times buys nothing except N more
  // multi-minute solves of a 479-assignment input, and the baseline
  // arm still runs N times because THAT repetition is the determinism
  // test (brief §11) — the AI arm's is not.
  //
  // The reduction is recorded in `fairness` rather than made silently,
  // and it cannot be cherry-picking: an arm that produced zero valid
  // decisions is excluded from the score distribution entirely, so
  // there is nothing to select a favourable run from. One AI run is
  // still made, because the fallback invariant of brief §24 — a dead
  // service must still yield a hard-feasible schedule — has to be
  // demonstrated, not asserted.
  const serviceProvablyDown = smoke?.result === RUNTIME_RESULT.BLOCKED;
  const nAi = Number.isInteger(aiRepetitions) && aiRepetitions > 0
    ? aiRepetitions
    : (serviceProvablyDown ? 1 : n);

  const fairness = {
    solverProfile: profile ?? BENCHMARK_SOLVER_PROFILE,
    solverProfileHash: SOLVER_PROFILE_HASH,
    // Filled in once the natural counts are known. `null` here means
    // the benchmark did not get far enough to align them, which is
    // itself a fact the report prints.
    candidateCount: null,
    naturalCandidateCounts: { BASELINE: [], AIRLLM: [] },
    raisedBaselineToFairCount: false,
    sameSeed: true,
    sameSolverImplementation: true,
    sameEvaluator: true,
    sameScoringLayer: true,
    differingFactor: 'strategy source only',
    baselineRepetitions: n,
    airllmRepetitions: nAi,
    airllmRepetitionsReduced: nAi !== n,
    airllmRepetitionsReason: nAi === n
      ? null
      : 'Tier A was BLOCKED: the AirLLM service is unreachable, so every AI request would fall '
        + 'back at the socket. One run is enough to demonstrate the brief §24 fallback invariant.',
  };

  if (!input || typeof input !== 'object') {
    throw new TypeError('runStrategyBenchmark requires a SchedulingInput');
  }

  // ---- 1. PLAN (no solving yet) ------------------------------------
  // Baseline first, N times. The plan is cheap (no solving) and the
  // baseline is deterministic, so there is nothing to interleave.
  const baselinePlans = [];
  for (let i = 0; i < n; i++) {
    baselinePlans.push(await planStrategyOnce({
      input, planner: null, arm: BENCHMARK_ARMS.BASELINE, index: i, profile, planOptions,
    }));
  }
  // The AI arm second, one at a time.
  //
  // Sequential, never concurrent: AirLLM streams model layers from disk
  // and a benchmark that fires five inferences at once measures the
  // machine's contention rather than the model. The same answer then
  // applies to the solves below.
  const aiPlans = [];
  for (let i = 0; i < nAi; i++) {
    aiPlans.push(await planStrategyOnce({
      input, planner: aiPlanner, arm: BENCHMARK_ARMS.AI, index: i, profile, planOptions,
    }));
  }

  // WHO actually planned the AI arm.
  //
  // The arm is called `AIRLLM` because that is what it is meant to
  // measure, not because it is assumed. `AI_PROVIDER` defaults to
  // `mock`, so a caller who forgets to set it would otherwise get an
  // arm of five perfectly valid decisions, a `validityRate` of 1.0,
  // and a report titled "AirLLM results". The observed planner name
  // is recorded, and `conclude` refuses every AirLLM quality verdict
  // unless it really is an AirLLM provider.
  const observedPlanners = [...new Set(aiPlans
    .map((p) => p?.plannerName ?? null)
    .filter(Boolean))]
    .sort();
  const aiProviderObserved = observedPlanners.length === 1
    ? observedPlanners[0]
    : (observedPlanners.length === 0 ? null : 'MIXED');
  const armIsAirLLM = isAirLLMPlanner(aiPlanner);
  fairness.aiProviderObserved = aiProviderObserved;
  fairness.armIsAirLLM = armIsAirLLM;
  if (!armIsAirLLM) {
    fairness.providerNote =
      `The AI arm was planned by ${aiProviderObserved ?? 'no provider at all'}, not by AirLLM. `
      + 'Its numbers are real measurements of that planner, but no AirLLM conclusion may be drawn '
      + 'from them (brief §29, §35, §41).';
  }

  // ---- 2. ALIGN THE CANDIDATE COUNT (brief §19) ---------------------
  // `BENCHMARK_ARMS.AI` is the string `'AIRLLM'`; the key is written
  // through the constant rather than as a literal so the map and the
  // arm label cannot drift apart.
  for (const [arm, plans] of [[BENCHMARK_ARMS.BASELINE, baselinePlans], [BENCHMARK_ARMS.AI, aiPlans]]) {
    for (const p of plans) {
      const c = p.plan?.decision?.candidateCount;
      if (Number.isInteger(c)) fairness.naturalCandidateCounts[arm].push(c);
    }
  }
  const aligned = alignCandidateCount(
    [
      ...fairness.naturalCandidateCounts[BENCHMARK_ARMS.BASELINE],
      ...fairness.naturalCandidateCounts[BENCHMARK_ARMS.AI],
    ],
    // "Raised" means raised above what the BASELINE asked for, so the
    // report can say the baseline's own preference was overridden.
    { baselineNatural: Math.min(
      ...(fairness.naturalCandidateCounts[BENCHMARK_ARMS.BASELINE].length > 0
        ? fairness.naturalCandidateCounts[BENCHMARK_ARMS.BASELINE]
        : [profile.count]),
    ) },
  );
  fairness.candidateCount = aligned.count;
  fairness.raisedBaselineToFairCount = aligned.raised;
  fairness.naturalCandidateCounts = {
    [BENCHMARK_ARMS.BASELINE]: [...new Set(fairness.naturalCandidateCounts[BENCHMARK_ARMS.BASELINE])].sort((a, b) => a - b),
    [BENCHMARK_ARMS.AI]: [...new Set(fairness.naturalCandidateCounts[BENCHMARK_ARMS.AI])].sort((a, b) => a - b),
  };

  // ---- 3. SOLVE -----------------------------------------------------
  const solve = async (plans, arm) => {
    const out = [];
    for (const p of plans) {
      out.push(await solvePlannedInput({
        planned: p, arm, index: p.index, profile, count: fairness.candidateCount, probe,
      }));
    }
    return out;
  };
  const baselineRuns = await solve(baselinePlans, BENCHMARK_ARMS.BASELINE);
  const aiRuns = await solve(aiPlans, BENCHMARK_ARMS.AI);

  // ---- 3b. SHARED-POOL RE-SCORING ---------------------------------
  // Before anything is aggregated. `aggregateRuns` snapshots the
  // distribution, so a score written after the summary would appear
  // in `run.quality` and be missing from `arm.quality` — the report
  // would then print a shared-pool column that silently read `n/a`.
  const sharedPool = applySharedPoolScore([...baselineRuns, ...aiRuns], { input });

  // ---- 4. MEASURE ---------------------------------------------------
  const baseline = summariseArm(baselineRuns, { arm: BENCHMARK_ARMS.BASELINE });
  const ai = summariseArm(aiRuns, { arm: BENCHMARK_ARMS.AI });

  // ---- 5. DECIDE ----------------------------------------------------
  const comparison = compareArms(baseline, ai);
  // The same policy, run a second time on the shared-pool score. Two
  // yardsticks disagreeing means the data does not establish a gain,
  // so `conclude` needs to see both rather than just the flattering
  // one.
  const sharedPoolComparison = compareArms(baseline, ai, {
    ...AI_STRATEGY_EVALUATION_POLICY, primaryMetric: 'sharedPoolGlobalScore',
  });
  const decisionEffect = compareDecisions(baselineRuns, aiRuns);
  const { conclusion, conclusionReason, blockedOn } = conclude({
    smoke,
    comparison,
    sharedPoolComparison,
    decisionEffect,
    ai,
    baseline,
    qualityRan: true,
    armIsAirLLM,
    aiProviderObserved,
  });

  return {
    tier: BENCHMARK_TIER.QUALITY,
    ran: true,
    blockedOn,
    repetitions: n,
    fairness,
    evaluationPolicy: {
      ...AI_STRATEGY_EVALUATION_POLICY,
      hash: evaluationPolicyVersion(),
    },
    provenance,
    sharedPool,
    arms: {
      [BENCHMARK_ARMS.BASELINE]: baseline,
      [BENCHMARK_ARMS.AI]: ai,
    },
    comparison,
    sharedPoolComparison,
    decisionEffect,
    conclusion,
    conclusionReason,
  };
}

// ============================================================================
// Per-arm summary
// ============================================================================

/**
 * summariseArm(runs, { arm })
 *
 * TWO QUALITY SUMMARIES, AND THE DIFFERENCE IS THE POINT
 * -----------------------------------------------------
 * `quality` is aggregated over the runs that CONTRIBUTED A STRATEGY
 * for this arm:
 *
 *   BASELINE — every run. The deterministic fallback IS the baseline's
 *              strategy, not a failure to obtain one, so all of its
 *              runs are real measurements of it.
 *   AIRLLM   — only runs where a provider was consulted AND the
 *              decision was accepted (`aiDecisionUsed`).
 *
 * This is policy rule 4 (`gatesOnValidity`) made concrete. A run that
 * fell back contributes no AI decision, so it contributes no score:
 * letting it into the median is how "the AI's median score equals the
 * baseline's" becomes true on a run where the AI produced nothing at
 * all.
 *
 * `qualityIncludingFallback` aggregates over every run regardless, and
 * exists so the brief §24 safety invariant is still visible in
 * numbers: a dead service must still yield a hard-feasible schedule,
 * and that schedule's metrics are worth reading even though they are
 * not the AI's.
 */
function summariseArm(runs, { arm }) {
  const scoredRuns = arm === BENCHMARK_ARMS.AI
    ? runs.filter((r) => r?.aiDecisionUsed === true)
    : runs;

  return {
    runs,
    runCount: runs.length,
    // How many runs the quality distribution below actually rests on.
    scoredRunCount: scoredRuns.length,
    excludedFromQuality: runs.length - scoredRuns.length,
    quality: aggregateRuns(scoredRuns, QUALITY_METRIC_NAMES),
    qualityIncludingFallback: aggregateRuns(runs, QUALITY_METRIC_NAMES),
    latency: Object.fromEntries(
      LATENCY_METRIC_NAMES.map((name) => [
        name,
        // Latency is reported over EVERY run, not only the scored
        // ones. A fallback that took 3 ms of failed HTTP is a real
        // operational number, and hiding it would make the AI look
        // faster or slower than it was depending on how many times
        // the service happened to be down.
        aggregate(runs.map((r) => r?.latency?.[name] ?? null)),
      ]),
    ),
    rates: validityAndFallbackRates(runs),
    diversity: decisionDiversity(runs),
    failures: tallyFailures(runs.map((r) => r?.failure ?? null)),
    // The feasibility gate of brief §18, stated as a fact rather
    // than assumed: any run with hard violations is a FAILURE, and
    // the benchmark refuses to average over it.
    feasibility: {
      runsWithHardViolations: runs.filter((r) => (r?.quality?.hardViolations ?? 0) > 0).length,
      runsNotAccepted: runs.filter((r) => r?.accepted !== true).length,
      acceptedCount: runs.filter((r) => r?.accepted === true).length,
      oracleDisagreements: runs.filter(
        (r) => r?.quality?.oracleIndependentCheck
          && r.quality.oracleIndependentCheck.hardViolations !== (r.quality.hardViolations ?? 0),
      ).length,
      // Brief §24. Every run of every arm must be hard-feasible,
      // INCLUDING the runs that fell back. This is the safety
      // invariant, and it is counted over all runs, not the scored
      // subset.
      fallbackRunsHardFeasible: runs
        .filter((r) => r?.fallbackUsed === true)
        .every((r) => (r?.quality?.hardViolations ?? 0) === 0 && r?.accepted === true),
    },
  };
}

// ============================================================================
// Comparison (brief §17, §20, §21, §22)
// ============================================================================

/**
 * compareArms(baseline, ai) -> Comparison
 *
 * Per-run pairing AND aggregate, both present. Brief §22 forbids
 * cherry-picking and §23 demands the distribution be visible, so the
 * per-run list is not a convenience — it is the evidence. A reader
 * who wants to see "AI run 1 good, run 2 bad, run 3 good" has to be
 * able to see exactly that.
 *
 * `separation` is the honesty check on `verdict`. When the two arms'
 * [min, max] ranges overlap, a BETTER or WORSE verdict describes the
 * median only, and at N = 5 that is not evidence of improvement.
 */
export function compareArms(baselineArm, aiArm, policy = AI_STRATEGY_EVALUATION_POLICY) {
  const primary = policy.primaryMetric;
  const b = baselineArm.quality[primary];
  const a = aiArm.quality[primary];

  // The table spans the LONGER arm. The AI arm may legitimately run
  // fewer times than the baseline (brief: the AI arm is reduced only
  // when the service is provably down), and iterating over the AI arm
  // alone would hide every extra baseline run from the reader — which
  // is the opposite of what brief §22 is for.
  const bRuns = baselineArm.runs ?? [];
  const aRuns = aiArm.runs ?? [];
  const perRun = Array.from({ length: Math.max(bRuns.length, aRuns.length) }, (_, i) => {
    const bRun = bRuns[i] ?? null;
    const aiRun = aRuns[i] ?? null;
    const aiScore = aiRun?.quality?.[primary] ?? null;
    const bScore = bRun?.quality?.[primary] ?? null;
    return {
      index: i,
      baseline: bScore,
      airllm: aiScore,
      delta: aiScore !== null && bScore !== null ? round6(aiScore - bScore) : null,
      baselineFallbackUsed: bRun?.fallbackUsed ?? null,
      airllmFallbackUsed: aiRun?.fallbackUsed ?? null,
      // Every other quality metric, side by side. Brief §17: the
      // decision is made on the primary metric, but the comparison
      // must not be made on the primary metric alone.
      quality: {
        BASELINE: bRun?.quality ?? null,
        AIRLLM: aiRun?.quality ?? null,
      },
    };
  });

  // Validity gates the verdict (policy rule 4). A run that fell back
  // contributed no AI decision, so it contributes no score.
  if (a.n === 0) {
    return {
      primaryMetric: primary,
      verdict: RUN_VERDICT.INVALID,
      separation: 'NOT_APPLICABLE',
      medianDelta: null,
      note: 'no valid AirLLM run produced a score; the comparison cannot be made',
      baseline: b,
      airllm: a,
      perRun,
    };
  }

  const overlap = !(a.max < b.min || b.max < a.min);
  const separation = overlap ? 'OVERLAPPING' : 'SEPARATED';
  const delta = round6(a.median - b.median);
  let verdict;
  if (Math.abs(delta) <= policy.epsilon) verdict = RUN_VERDICT.EQUIVALENT;
  else verdict = delta > 0 ? RUN_VERDICT.BETTER : RUN_VERDICT.WORSE;

  return {
    primaryMetric: primary,
    verdict,
    separation,
    medianDelta: delta,
    note: overlap
      ? 'The two arms\' ranges overlap, so the verdict describes the median only. At this N that is not evidence of a real difference.'
      : 'The two arms\' ranges do not overlap.',
    baseline: b,
    airllm: a,
    perRun,
  };
}

/**
 * compareDecisions(baselineRuns, aiRuns) -> DecisionEffect
 *
 * Brief §20. When every AI decision hashes the same as the
 * deterministic fallback's, the AI chose exactly what the fallback
 * would have chosen, and any difference in the resulting schedules
 * would be solver noise rather than an effect of the AI. The
 * benchmark says so explicitly instead of reporting a quality delta
 * it cannot attribute.
 */
export function compareDecisions(baselineRuns, aiRuns) {
  const bHashes = [...new Set((baselineRuns ?? []).map((r) => r?.strategyHash).filter(Boolean))].sort();
  const aHashes = [...new Set((aiRuns ?? []).map((r) => r?.strategyHash).filter(Boolean))].sort();
  const acceptedAi = (aiRuns ?? []).filter((r) => r?.aiDecisionUsed === true);
  const aiAcceptedHashes = [...new Set(acceptedAi.map((r) => r?.strategyHash).filter(Boolean))].sort();

  // Three states, not two. A run that fell back has a strategy hash —
  // the FALLBACK's — and including it here would let a benchmark with
  // zero accepted AI decisions report "the AI's strategy matched" or
  // "differed", both of which are claims about a decision that was
  // never made.
  if (aiAcceptedHashes.length === 0) {
    return {
      baselineHashes: bHashes,
      aiHashes: aHashes,
      aiAcceptedHashes: [],
      equivalent: false,
      signal: DECISION_NONE,
      note:
        'No AirLLM decision was accepted, so there is no AI strategy to compare against the '
        + `fallback's. The ${aHashes.length} hash(es) listed above belong to fallback runs, not to `
        + 'the model. Brief §20\'s equivalence test is not applicable.',
    };
  }

  const allMatchBaseline = bHashes.length > 0
    && aiAcceptedHashes.every((h) => bHashes.includes(h));

  return {
    baselineHashes: bHashes,
    aiHashes: aHashes,
    aiAcceptedHashes,
    equivalent: allMatchBaseline,
    signal: allMatchBaseline ? DECISION_EQUIVALENT : 'AIRLLM_DECISION_DISTINCT',
    note: allMatchBaseline
      ? 'Every accepted AirLLM decision is byte-identical to the deterministic fallback\'s. Any schedule difference is solver variance, not an effect of the AI, and no improvement may be claimed.'
      : 'At least one accepted AirLLM decision differs from the deterministic fallback\'s.',
  };
}

// ============================================================================
// Shared-pool re-scoring (brief §3, §17, §26)
// ============================================================================

/**
 * Why a second scoring pass is necessary
 * -------------------------------------
 *
 * `bestGlobalScore` is the Phase 28 `scoring.total` of a run's rank-1
 * solution, and `scoring.total` is NOT an absolute quality. Phase 28
 * normalizes every dimension against the min and max of the pool it is
 * scoring (`computePoolRaws` / `normalize`), so a total is a statement
 * about a candidate's POSITION WITHIN ITS OWN POOL.
 *
 * Two consequences the benchmark must not paper over:
 *
 *   1. Comparing the baseline's pool-relative total against the AI's
 *      pool-relative total compares two different scales. The
 *      `sharedPoolGlobalScore` below fixes that by scoring both arms'
 *      shipped schedules inside ONE pool, where the min/max is
 *      common. That number is comparable; `bestGlobalScore` is not.
 *
 *   2. A per-run pool flatters both arms for free. The best candidate
 *      of a pool is near that pool's best value on every axis by
 *      construction, so "high total" is partly a statement about
 *      being rank 1 rather than about the schedule. A common pool
 *      makes a rank-1 schedule of one arm compete against rank-1
 *      schedules of the other, which is the only way the number says
 *      anything about the schedules.
 *
 * This pass does NOT re-rank, does NOT re-select, and does NOT
 * replace `bestGlobalScore`. The schedule that would ship is still
 * the one the Phase 28 selection chose. This is a measurement taken
 * on the shipped artifact under a common scale, nothing more — and it
 * uses the scorer's own `scorePool` and its own default weights, so
 * the AI's weights cannot reach it (brief §26).
 */

/**
 * applySharedPoolScore(runs, { input, weights })
 *   -> { poolSize, scored, unscoreable, weights, byArm }
 *
 * Scores every run's rank-1 candidate in ONE shared pool and writes
 * the result onto `run.quality.sharedPoolGlobalScore`.
 *
 * The pool is deliberately built from the SHIPPED candidates only —
 * one per run — and never from the run's own candidate set. Pooling
 * a run's losers in would reintroduce the per-run scale the pass
 * exists to remove.
 *
 * `weights` defaults to the scorer's own defaults rather than to
 * either arm's strategy. Using the AI's weights here would measure
 * "how well does this schedule score under the objective the AI
 * asked for", which answers a different question: the AI's weights
 * are a legitimate part of its strategy, but they are not the yardstick.
 * One fixed yardstick, both arms.
 *
 * Mutates the run objects it is given. `qualityOf` returns a fresh
 * object per run and nothing downstream re-reads
 * `sharedPoolGlobalScore` before this runs, so in-place is the honest
 * shape: two parallel score fields would let a caller read one and
 * report the other.
 */
export function applySharedPoolScore(runs, options = {}) {
  const {
    input = null,
    weights = GLOBAL_SCORING_DEFAULTS.weights,
  } = options;

  const all = Array.isArray(runs) ? runs : [];

  // Reset first, so a re-run with a different input cannot leave a
  // stale score behind on a run that is no longer in the pool.
  for (const r of all) {
    if (r?.quality) r.quality.sharedPoolGlobalScore = null;
  }

  const withCandidate = all.filter((r) => r && r.rank1Candidate);
  const summary = {
    poolSize: withCandidate.length,
    scored: 0,
    // Runs that shipped nothing: a fallback that produced no
    // schedule, or a rejected decision. They cannot be scored, and
    // they are counted rather than dropped so the report can say how
    // many schedules the comparison actually rests on.
    unscoreable: all.length - withCandidate.length,
    weights,
    scaleNote:
      'Phase 28 normalizes each dimension against its own pool\'s min and max, so a total is a '
      + 'position within a pool, not an absolute quality. These scores share ONE pool across both '
      + 'arms, which is what makes them comparable to each other.',
  };

  if (withCandidate.length === 0) return summary;

  const pool = withCandidate.map((r, i) => tagCandidate(r.rank1Candidate, `phase31-shared-${i}`));
  const { scores } = scorePool(pool, input, { ...GLOBAL_SCORING_DEFAULTS, weights });

  // `scorePool` returns scores in pool order (`pool.map((c) =>
  // scoreCandidate(c, context))`), so positional mapping is exact and
  // no id round-trip is needed.
  withCandidate.forEach((r, i) => {
    const total = scores?.[i]?.total;
    r.quality.sharedPoolGlobalScore = typeof total === 'number' && Number.isFinite(total)
      ? Math.round(total * 1e6) / 1e6
      : null;
  });
  summary.scored = withCandidate.filter((r) => r.quality.sharedPoolGlobalScore !== null).length;
  return summary;
}

/**
 * A shallow clone that carries a unique `id`.
 *
 * `findBestCandidate` breaks exact objective ties on `id`, and two
 * runs' rank-1 candidates can share the solver's id. Left alone that
 * is harmless but makes the shared pool impossible to read back from
 * a score, so the id is replaced. The prototype and every own
 * property — including a Map-valued `placements` — are preserved by
 * reference: this is a labelling operation, not a deep copy.
 */
function tagCandidate(candidate, id) {
  return Object.assign(
    Object.create(Object.getPrototypeOf(candidate) ?? Object.prototype),
    candidate,
    { id },
  );
}

// ============================================================================
// Conclusion (brief §21, §41)
// ============================================================================

/**
 * conclude({ smoke, comparison, decisionEffect, ai, baseline, qualityRan })
 *   -> { conclusion, conclusionReason, blockedOn }
 *
 * Exactly the five values of brief §41 are reachable. The order of
 * the checks matters: an unrunnable benchmark is reported as BLOCKED
 * even if a stale verdict would have looked better, because "we could
 * not measure" must never be rendered as "we measured and it was
 * fine".
 */
export function conclude(input = {}) {
  const {
    smoke = null,
    comparison = null,
    decisionEffect = null,
    ai = null,
    baseline = null,
    qualityRan = false,
    // Whether the AI arm was really planned by AirLLM. `null` means
    // the caller did not say, which is treated as "no": a conclusion
    // that depends on the arm being AirLLM must not be reachable by
    // omission.
    armIsAirLLM = null,
    aiProviderObserved = null,
    // The same comparison run on `sharedPoolGlobalScore`. Optional:
    // when it is absent the primary metric decides alone, which is
    // what happened before the shared pool existed.
    sharedPoolComparison = null,
  } = input;

  // ---- the arm was not AirLLM at all -----------------------------
  // Ahead of every other check, including a smoke-test PASS. A
  // `validityRate` of 1.0 and five perfectly good schedules prove
  // that SOMETHING planned well; naming it AirLLM would be a
  // substitution the brief forbids three times over (§7, §29, §35).
  if (qualityRan && armIsAirLLM !== true) {
    return {
      conclusion: BENCHMARK_CONCLUSION.BLOCKED,
      blockedOn: BLOCKED_ON.ENVIRONMENT,
      conclusionReason:
        `the AI arm was planned by ${aiProviderObserved ?? 'no provider'}, not by an AirLLM provider, `
        + 'so these measurements say nothing about AirLLM. No runtime or quality conclusion about AirLLM '
        + 'is drawn from them.',
    };
  }

  // ---- blocked ----------------------------------------------------
  if (smoke && smoke.result === RUNTIME_RESULT.BLOCKED) {
    return {
      conclusion: BENCHMARK_CONCLUSION.BLOCKED,
      blockedOn: BLOCKED_ON.ENVIRONMENT,
      conclusionReason: smoke.rootCause
        ?? 'the AirLLM service is not reachable on this host, so no AirLLM measurement was possible',
    };
  }
  if (smoke && smoke.result === RUNTIME_RESULT.FAIL) {
    return {
      conclusion: BENCHMARK_CONCLUSION.BLOCKED,
      blockedOn: BLOCKED_ON.RUNTIME_FAILURE,
      conclusionReason: smoke.rootCause ?? 'the AirLLM runtime smoke test failed',
    };
  }
  if (!qualityRan) {
    return {
      conclusion: smoke && smoke.result === RUNTIME_RESULT.PASS
        ? BENCHMARK_CONCLUSION.RUNTIME_READY
        : BENCHMARK_CONCLUSION.BLOCKED,
      blockedOn: BLOCKED_ON.NOT_RUN,
      conclusionReason: 'Tier B was not run. Only the runtime is established; no quality claim is made.',
    };
  }

  // ---- the AI never produced a usable strategy --------------------
  if (!comparison || comparison.verdict === RUN_VERDICT.INVALID) {
    const rates = ai?.rates ?? { requests: 0, valid: 0, fallback: 0, invalid: 0 };
    const noSolution = (ai?.feasibility?.runsNotAccepted ?? 0) > 0 && rates.valid > 0;
    return {
      conclusion: BENCHMARK_CONCLUSION.BLOCKED,
      blockedOn: noSolution ? BLOCKED_ON.NO_SOLUTION : BLOCKED_ON.STRATEGY_VALIDITY,
      conclusionReason: noSolution
        ? `${rates.valid} of ${rates.requests} AirLLM decisions were valid, but at least one produced no feasible schedule, so no quality comparison is possible.`
        : `0 of ${rates.requests} AirLLM requests produced a valid decision, so there is nothing to compare.`,
    };
  }

  // ---- equivalent decisions (brief §20) ---------------------------
  if (decisionEffect?.equivalent) {
    return {
      conclusion: BENCHMARK_CONCLUSION.VALID_NO_GAIN,
      blockedOn: null,
      conclusionReason: decisionEffect.note,
    };
  }

  // ---- the measured verdict ----------------------------------------
  const overlapping = comparison.separation === 'OVERLAPPING';
  const agreed = yardstickAgreement(comparison, sharedPoolComparison);

  if (!agreed.agree) {
    return {
      conclusion: BENCHMARK_CONCLUSION.VALID_NO_GAIN,
      blockedOn: null,
      conclusionReason: agreed.note,
    };
  }

  if (comparison.verdict === RUN_VERDICT.BETTER) {
    if (overlapping) {
      return {
        conclusion: BENCHMARK_CONCLUSION.VALID_NO_GAIN,
        blockedOn: null,
        conclusionReason:
          `the AirLLM median bestGlobalScore is higher by ${comparison.medianDelta}, but the two arms' `
          + 'ranges overlap, so at this repetition count the data does not establish a real improvement.',
      };
    }
    return {
      conclusion: BENCHMARK_CONCLUSION.IMPROVES,
      blockedOn: null,
      conclusionReason:
        `the AirLLM median bestGlobalScore is higher by ${comparison.medianDelta} and the two arms' `
        + `ranges do not overlap (n=${ai?.quality?.[comparison.primaryMetric]?.n ?? 0} valid runs).`,
    };
  }

  if (comparison.verdict === RUN_VERDICT.WORSE) {
    if (overlapping) {
      return {
        conclusion: BENCHMARK_CONCLUSION.VALID_NO_GAIN,
        blockedOn: null,
        conclusionReason:
          `the AirLLM median bestGlobalScore is lower by ${Math.abs(comparison.medianDelta ?? 0)}, but the two arms' `
          + 'ranges overlap, so at this repetition count the data does not establish a real regression.',
      };
    }
    return {
      conclusion: BENCHMARK_CONCLUSION.WORSE,
      blockedOn: null,
      conclusionReason:
        `the AirLLM median bestGlobalScore is lower by ${Math.abs(comparison.medianDelta ?? 0)} and the two arms' `
        + `ranges do not overlap (n=${ai?.quality?.[comparison.primaryMetric]?.n ?? 0} valid runs).`,
    };
  }

  return {
    conclusion: BENCHMARK_CONCLUSION.VALID_NO_GAIN,
    blockedOn: null,
    conclusionReason:
      `the two arms are equivalent on ${comparison.primaryMetric} within the policy epsilon.`,
  };
}

/**
 * Do the two yardsticks tell the same story?
 *
 * `bestGlobalScore` is a position within a run's own candidate pool.
 * `sharedPoolGlobalScore` is a position within one pool containing
 * every arm's shipped schedule. They measure different things, which
 * is the point — but it also means they can disagree, and when they
 * do, the honest reading is that the data does not establish a
 * direction. A BETTER on one and WORSE on the other is not a small
 * disagreement to average away; it is a benchmark that has not
 * decided what "better" means, and must not claim an improvement.
 *
 * `EQUIVALENT` counts as agreement with either BETTER or WORSE: a
 * yardstick that cannot see a difference is not evidence against a
 * difference the other one saw, and requiring strict unanimity would
 * make a genuine improvement unclaimable whenever one scale is
 * degenerate. A BETTER/WORSE pair, or either side INVALID, is not
 * agreement.
 */
function yardstickAgreement(primary, sharedPool) {
  if (!sharedPool) return { agree: true, note: null };
  const p = primary?.verdict ?? null;
  const s = sharedPool.verdict ?? null;

  const contradicts = (p === RUN_VERDICT.BETTER && s === RUN_VERDICT.WORSE)
    || (p === RUN_VERDICT.WORSE && s === RUN_VERDICT.BETTER);
  const oneInvalid = p === RUN_VERDICT.INVALID || s === RUN_VERDICT.INVALID;

  if (!contradicts && !oneInvalid) return { agree: true, note: null };

  return {
    agree: false,
    note:
      `the two yardsticks disagree. Within its own pool the AirLLM arm is \`${p}\` `
      + `(median delta ${primary?.medianDelta ?? 'n/a'} on ${primary?.primaryMetric}), while in one shared pool `
      + `across both arms it is \`${s}\` (median delta ${sharedPool.medianDelta} on ${sharedPool.primaryMetric}). `
      + 'Neither direction is established, so no improvement and no regression is claimed.',
  };
}

/**
 * The prompt / model provenance every benchmark row carries. Collected
 * from the runs themselves rather than from configuration, so a report
 * cannot claim a model version the run did not actually use.
 */
export function collectProvenance(runs) {
  const models = new Set();
  const prompts = new Set();
  const providers = new Set();
  for (const r of runs ?? []) {
    if (r?.providerProvenance?.model) models.add(r.providerProvenance.model);
    if (r?.providerProvenance?.promptVersion) prompts.add(String(r.providerProvenance.promptVersion));
    if (r?.providerProvenance?.provider) providers.add(r.providerProvenance.provider);
  }
  return {
    providers: [...providers].sort(),
    models: [...models].sort(),
    // Brief §31: one prompt version per benchmark. If a run reports a
    // different one, mixing them is not allowed and the reader must
    // see that the set has more than one element.
    promptVersions: [...prompts].sort(),
    singlePromptVersion: prompts.size === 1 ? [...prompts][0] : null,
    mixedPromptVersions: prompts.size > 1,
  };
}

export { AIRLLM_FAILURE, classifyAirLLMOutcome, hashValue, strategyHashOf };

// ============================================================================
// Helpers
// ============================================================================

function round6(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}
