// PHASE 31 — ONE BENCHMARK RUN, END TO END.
//
//   SchedulingInput
//     -> SituationReport
//     -> AIPlanner (the arm under test)
//     -> StrategyValidator            <- still the only path to a strategy
//     -> generateSolutions (solver)
//     -> selectFinalSolutions (Phase 28 scorer)
//     -> quality + latency metrics
//
// This module calls the whole pipeline. It does not modify any part
// of it: same `planStrategy`, same solver, same evaluator, same
// scorer, same seeds. The ONLY thing that varies between the two arms
// of the comparison is which `AIPlanner` was supplied. That is the
// entire experimental design, and it is why the function is small
// and the fairness assertions live in `quality.js` where they can be
// tested.
//
// FAIRNESS, ENFORCED HERE RATHER THAN ASSUMED (brief §4, §19)
// -----------------------------------------------------------
// `BENCHMARK_SOLVER_PROFILE` is FROZEN and is the only source of
// solver settings. Both arms receive the identical object: same
// `count`, same `seed`, same `perSolveTimeBudgetMs`, same
// `overallTimeBudgetMs`, same `respectStrategyMode`, same
// `requireFeasibility`. There is no per-arm override, because a
// per-arm override is exactly how a benchmark stops being a
// comparison. The profile carries its own hash, and the report
// prints it, so a profile edited between two runs is detectable
// rather than silent.
//
// The one asymmetry the brief demands — brief §19: if the AI asks
// for `candidateCount = 10`, the baseline must also solve for 10 —
// is handled by `alignCandidateCount`, which is called BEFORE any
// solve happens. The natural counts are recorded, then one fair count
// is chosen and both arms use it.
//
// TIME BUDGET AND THE AI CALL
// ---------------------------
// The AI call is not inside the solver's budget. Each arm's solve
// starts with a full `overallTimeBudgetMs` of its own, so the AirLLM
// call — which is slow by design, because AirLLM streams layers from
// disk — cannot eat the baseline's solve time and manufacture a
// "the AI is slower" result that is really a wall-clock accounting
// artefact. `aiLatencyMs` is reported separately for exactly that
// reason.

import { planStrategy } from '../domain/ai/index.js';
import { generateSolutions } from '../domain/multi-solution.js';
import { selectFinalSolutions } from '../domain/global-scoring.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../domain/strategies.js';
import { AIRLLM_FAILURE, classifyAirLLMOutcome } from './classification.js';
import { latencyOf, qualityOf } from './metrics.js';
import { fnv1a32 } from './versions.js';

// ============================================================================
// The frozen solver profile
// ============================================================================

/**
 * The single, frozen set of solver conditions (brief §4, §19).
 *
 * `respectStrategyMode: true` is the one setting a reader should look
 * at twice. It is what makes the comparison a test of the AI at all:
 * with it `false` (the domain default, which Phase 27's tests pin)
 * the multi-solution generator forces every iteration to
 * GLOBAL_ASSIGNMENT_BALANCED and DISCARDS the AI's `optimizationMode`.
 * The weights would still reach the scorer, but the mode would not
 * reach the solver, so an AI that chose a different mode would be
 * measured on a schedule it did not ask for. Both arms get `true`,
 * so the asymmetry is not introduced — it is removed.
 */
export const BENCHMARK_SOLVER_PROFILE = Object.freeze({
  count: 3,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  respectStrategyMode: true,
  requireFeasibility: true,
  // PHASE 31.1 — the seed-stable search bound. Both arms receive this
  // from the same frozen object, so it cannot introduce an asymmetry.
  //
  // It exists because the benchmark's 5 repetitions are supposed to
  // measure the AI's strategy choice, not the host's speed. With only
  // a wall-clock bound, a repetition that happened to run on a busy
  // machine would compare fewer candidates and score differently —
  // a machine artefact reported as an AI effect. Bounding iterations
  // removes that channel entirely; the time budgets above are kept
  // unchanged and remain as a safety valve.
  maxSearchIterations: 12,
});

/** Hash of the frozen profile. Printed in the report. */
export const SOLVER_PROFILE_HASH = fnv1a32(JSON.stringify(BENCHMARK_SOLVER_PROFILE));

/**
 * Default ceiling for the AI call. Overridable per run.
 *
 * PHASE 35 -- RAISED, AND WHY
 * ---------------------------
 * 600 s was chosen when AirLLM had never executed on any host, so the
 * value encoded a guess about a system with no measurement behind it.
 * It is now measured. On the verified host (RTX 4060 Laptop, 8 GB;
 * AirLLM 4.0.0; Qwen2.5-0.5B-Instruct) AirLLM streams every layer
 * from disk for every generated token and sustains about 0.24
 * tokens/second. A decision needs room for the model's preamble as
 * well as its object: at a 340-token ceiling that is roughly 24
 * minutes. The old 600 s ceiling abandoned every real request
 * mid-answer and reported it as `AI_TIMEOUT`.
 *
 * The ceiling is the provider call only. The solver's own
 * `perSolveTimeBudgetMs` and `overallTimeBudgetMs` are untouched, and
 * both arms still receive the identical frozen profile. Brief §25 asks
 * that the two arms differ in strategy provider and nothing else; they
 * still do. The AI call was already outside the solver's budget by
 * design -- see the note at the top of this file -- and this keeps it
 * that way. Raising it does not give the AI arm more solving time, and
 * it cannot make the baseline slower: the baseline consults no
 * provider and never reaches this value.
 */
export const BENCHMARK_PLAN_DEFAULTS = Object.freeze({
  timeoutMs: 2_400_000,
  revalidate: true,
  minConfidence: null,
});

// ============================================================================
// Strategy identity (brief §20)
// ============================================================================

/**
 * strategyHashOf(decision) -> 8 hex chars
 *
 * Covers exactly the three fields that change what the pipeline does:
 * `optimizationMode`, `scoringWeights`, `candidateCount`.
 *
 * It deliberately EXCLUDES `rationale`, `confidence`, and `source`.
 * Those are explanation and provenance; including them would make
 * two behaviourally identical decisions hash differently, and
 * brief §20's `AIRLLM_DECISION_EQUIVALENT` test would then never fire
 * for the reason it exists — it would report "the AI always said
 * something new" when the real answer is "the AI always chose the
 * same strategy".
 */
export function strategyHashOf(decision) {
  if (!decision || typeof decision !== 'object') return null;
  const weights = {};
  for (const k of Object.keys(decision.scoringWeights ?? {}).sort()) {
    weights[k] = decision.scoringWeights[k];
  }
  return fnv1a32(JSON.stringify({
    optimizationMode: decision.optimizationMode ?? null,
    candidateCount: decision.candidateCount ?? null,
    scoringWeights: weights,
  }));
}

/**
 * alignCandidateCount(naturalCounts, { baselineNatural }) -> { count, natural, raised }
 *
 * Brief §19. The AI is allowed to ask for 1, 3, 5, or 10 candidates.
 * Solving 10 candidates and comparing against a baseline that solved
 * 1 is not a comparison, it is a measurement of the budget. So the
 * fair count is the MAXIMUM of everything any arm asked for, snapped
 * to the allowed set, and both arms solve that.
 *
 * `baselineNatural` is the count the BASELINE asked for, and `raised`
 * is measured against it. Comparing against the frozen profile's count
 * instead would answer a different question: the profile is a
 * documented default, not a statement about what this baseline would
 * have chosen, and the report's job is to say whether the baseline's
 * own preference was overridden.
 *
 * `natural` records what each arm actually wanted, so the report can
 * state plainly that the baseline was raised. Hiding that would make a
 * fair comparison look like the AI's own preference.
 */
export function alignCandidateCount(naturalCounts, options = {}) {
  const baselineNatural = Number.isInteger(options.baselineNatural) && options.baselineNatural > 0
    ? options.baselineNatural
    : BENCHMARK_SOLVER_PROFILE.count;

  const wanted = (Array.isArray(naturalCounts) ? naturalCounts : [])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && ALLOWED_CANDIDATE_COUNTS.includes(n));
  if (wanted.length === 0) {
    return { count: baselineNatural, natural: [], raised: false };
  }
  const max = Math.max(...wanted);
  return { count: max, natural: wanted, raised: max > baselineNatural };
}

// ============================================================================
// One run, in two halves
// ============================================================================
//
// Planning and solving are separated because brief §20 requires the
// strategies to be compared BEFORE anything is solved, and because
// separating them halves the number of AirLLM calls: a decision that
// was compared is the same decision that gets solved, rather than a
// second sample of a model that samples.
//
// The split is also what makes the fairness guarantee checkable. Both
// halves take their settings from the same frozen profile, and neither
// half accepts a per-arm override.

/**
 * planStrategyOnce({ input, planner, arm, index, profile, planOptions })
 *   -> PlanResult (the raw planStrategy result, plus labels)
 *
 * `planner: null` is the deterministic-fallback arm. It is not a
 * special case: `planStrategy` with no planner walks exactly the same
 * report -> allow-list -> validate -> fallback path, and the only
 * difference is that the provider call is skipped because there is no
 * provider. That is what "baseline" means here.
 */
export async function planStrategyOnce(options = {}) {
  const {
    input,
    planner = null,
    arm = 'UNLABELLED',
    index = 0,
    profile = BENCHMARK_SOLVER_PROFILE,
    planOptions = {},
  } = options;

  if (!input || typeof input !== 'object') {
    throw new TypeError('planStrategyOnce requires a SchedulingInput');
  }
  const solverProfile = profile ?? BENCHMARK_SOLVER_PROFILE;
  const planCfg = { ...BENCHMARK_PLAN_DEFAULTS, ...(planOptions ?? {}) };

  const start = Date.now();
  // Recorded on every plan, whatever the outcome. The benchmark needs
  // to know WHICH planner produced a decision, and the audit log does
  // not carry it: `planStrategy` only names the provider inside
  // `audit.provider`, which is the config value rather than the class.
  const plannerName = planner?.name ?? null;
  try {
    const plan = await planStrategy(input, {
      planner,
      timeoutMs: planCfg.timeoutMs,
      minConfidence: planCfg.minConfidence,
      revalidate: planCfg.revalidate,
      requestedCandidateCount: solverProfile.count,
      baseStrategy: input.strategy,
    });
    return {
      arm,
      index,
      ok: true,
      plannerName,
      plan,
      planMs: Date.now() - start,
      error: null,
    };
  } catch (e) {
    return {
      arm,
      index,
      ok: false,
      plannerName,
      plan: null,
      planMs: Date.now() - start,
      error: { code: 'PLAN_THREW', detail: String(e?.message ?? e) },
    };
  }
}

/**
 * solvePlannedInput({ planned, arm, index, profile, count, probe })
 *   -> RunResult
 *
 * Takes a captured plan, applies the fair candidate count, and runs
 * the real pipeline from there. `planned.plan.input` is the input the
 * solver will see — the one carrying the APPROVED strategy. The raw
 * provider output is not reachable from here.
 */
export async function solvePlannedInput(options = {}) {
  const {
    planned,
    arm = 'UNLABELLED',
    index = 0,
    profile = BENCHMARK_SOLVER_PROFILE,
    count = null,
    probe = null,
  } = options;

  const solverProfile = profile ?? BENCHMARK_SOLVER_PROFILE;
  const plan = planned?.plan ?? null;
  const effectiveCount = count ?? solverProfile.count;

  // The solver only ever sees `plan.input` — the input WITH the
  // approved strategy applied. It never sees the raw provider output
  // and never sees the situation report. `plan.input` is null only if
  // `planStrategy` itself threw, which is not an expected path.
  const solveInput = plan?.input ?? null;
  const solverOpts = {
    count: effectiveCount,
    seed: solverProfile.seed,
    perSolveTimeBudgetMs: solverProfile.perSolveTimeBudgetMs,
    overallTimeBudgetMs: solverProfile.overallTimeBudgetMs,
    respectStrategyMode: solverProfile.respectStrategyMode,
    requireFeasibility: solverProfile.requireFeasibility,
    // PHASE 31.1 — the seed-stable search bound, taken from the
    // SAME frozen profile both arms receive, so neither arm gets a
    // per-run override. It makes each repetition reproducible on any
    // host; the time budgets above are unchanged and are no longer
    // what makes the result reproducible.
    ...(solverProfile.maxSearchIterations == null
      ? {}
      : { maxSearchIterations: solverProfile.maxSearchIterations }),
  };

  // ---- SOLVE ------------------------------------------------------
  const solveStart = Date.now();
  let generated = { solutions: [], diagnostics: { timeBudgetHit: false, solverFailed: 0 } };
  let solveError = null;
  try {
    if (solveInput) generated = generateSolutions(solveInput, solverOpts);
    else solveError = { code: 'NO_PLANNED_INPUT', detail: 'planStrategy produced no input to solve' };
  } catch (e) {
    solveError = { code: 'SOLVER_THREW', detail: String(e?.message ?? e) };
  }
  const solverMs = Date.now() - solveStart;

  // ---- SCORE ------------------------------------------------------
  // The AI's weights reach the scorer here and nowhere else. The
  // scorer is the Phase 28 layer, unmodified; the benchmark supplies
  // `scoringConfig` and lets the scorer apply its own defaults over
  // it exactly as production would.
  const scoringStart = Date.now();
  let scored = { solutions: [], diagnostics: {} };
  let scoringError = null;
  try {
    // Phase 28's `selectFinalSolutions` takes CANDIDATES, and
    // `generateSolutions` returns solution WRAPPERS that hold one.
    // Passing the wrappers would make the scorer's feasibility gate
    // read `wrapper.assignments` — undefined — and accept everything
    // on an empty candidate, which is exactly the kind of vacuous
    // pass this benchmark must not produce. The unwrap is therefore
    // mandatory, not cosmetic.
    scored = selectFinalSolutions(toCandidates(generated.solutions), {
      count: effectiveCount,
      scoringConfig: plan?.applied?.scoringConfig ?? null,
      input: solveInput,
      requireFeasibility: true,
    });
  } catch (e) {
    scoringError = { code: 'SCORING_THREW', detail: String(e?.message ?? e) };
  }
  const scoringMs = Date.now() - scoringStart;

  // ---- MEASURE ----------------------------------------------------
  const quality = qualityOf(scored.solutions, solveInput);
  const latency = latencyOf({ plan, planMs: planned?.planMs ?? null, solverMs, scoringMs });
  const fallbackUsed = plan ? plan.fallbackUsed === true : true;
  const accepted = (scored.solutions?.length ?? 0) > 0;

  const planError = planned?.error ?? null;
  const failure = planError
    ? { class: AIRLLM_FAILURE.INFERENCE_FAILURE, code: planError.code, detail: planError.detail, recoverable: false }
    : (solveError ?? scoringError
      ? {
        class: AIRLLM_FAILURE.DOWNSTREAM_NO_SOLUTION,
        code: (solveError ?? scoringError).code,
        detail: (solveError ?? scoringError).detail,
        recoverable: false,
      }
      : classifyAirLLMOutcome({ plan, probe, solutions: generated }));

  const airllm = plan?.rawOutput?.__airllm ?? null;

  return {
    arm,
    index,
    // Which planner produced this run's strategy. `null` means no
    // provider was consulted at all — the deterministic-fallback
    // baseline arm. Everything downstream reads this instead of
    // `fallbackUsed`, because `fallbackUsed: true` means two very
    // different things depending on the arm: for the BASELINE it is
    // the strategy under test, and for the AI arm it is a failure to
    // obtain one. Collapsing the two would let a fallback run be
    // scored as if the AI had chosen it.
    plannerName: planned?.plannerName ?? null,
    aiDecisionUsed: Boolean(planned?.plannerName) && fallbackUsed === false,
    decision: plan?.decision ?? null,
    strategyHash: strategyHashOf(plan?.decision ?? null),
    candidateCountRequested: effectiveCount,
    // The exact settings this run's solver received, recorded rather
    // than assumed. brief §4 and §12 claim both arms were solved
    // identically; this field is what makes that checkable — a test
    // compares the two arms' recorded options instead of trusting a
    // comment in the source.
    solverOptions: Object.freeze({ ...solverOpts }),
    fallbackUsed,
    accepted,
    quality,
    latency,
    failure,
    solverDiagnostics: generated.diagnostics ?? null,
    scoringDiagnostics: scored.diagnostics ?? null,
    // The rank-1 candidate — the schedule this run would ship. Kept on
    // the result so the benchmark can re-score every arm's shipped
    // schedule inside ONE shared pool. See applySharedPoolScore() in
    // quality.js for why that re-scoring is necessary rather than
    // optional.
    rank1Candidate: scored.solutions?.[0]?.candidate ?? null,
    rank1CandidateId: scored.solutions?.[0]?.id ?? null,
    providerProvenance: airllm
      ? {
        provider: airllm.provider ?? null,
        model: airllm.model ?? null,
        promptVersion: airllm.promptVersion ?? null,
        serviceValidated: airllm.serviceValidated ?? null,
        serviceState: airllm.state ?? null,
      }
      : null,
    // Corrections the validator applied. Recorded so a report can say
    // "the AI asked for TRAVEL and was clamped" instead of hiding it
    // behind an accepted verdict.
    validationEvents: plan?.validation?.events ?? [],
    validationStatus: plan?.validation?.status ?? null,
  };
}

/**
 * runStrategyOnce({ input, planner, arm, profile, planOptions, probe })
 *   -> RunResult
 *
 * plan + solve in one call, at the profile's own count. Convenient for
 * the fixture and the integration test; the benchmark itself uses the
 * two halves so the candidate count can be aligned first.
 */
export async function runStrategyOnce(options = {}) {
  const { input, planner = null, arm = 'UNLABELLED', index = 0, profile = BENCHMARK_SOLVER_PROFILE, planOptions = {}, probe = null } = options;
  const planned = await planStrategyOnce({ input, planner, arm, index, profile, planOptions });
  return solvePlannedInput({ planned, arm, index, profile, count: (profile ?? BENCHMARK_SOLVER_PROFILE).count, probe });
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * `generateSolutions` output -> the candidate list Phase 28 expects.
 *
 * A wrapper is passed through unchanged when it has no `.candidate`,
 * so a caller that already holds candidates is not double-unwrapped.
 */
function toCandidates(solutions) {
  return (Array.isArray(solutions) ? solutions : [])
    .map((s) => (s && typeof s === 'object' && s.candidate ? s.candidate : s))
    .filter(Boolean);
}

// ============================================================================
// Fixture ground truth (brief §28)
// ============================================================================

/**
 * establishFixtureGroundTruth({ input, profile, modes })
 *   -> { ranking, byMode, bestMode, spread, inconclusive }
 *
 * Runs EVERY optimization mode through the same solver and the same
 * Phase 28 scorer and reports which one actually scored best.
 *
 * Why measured and not asserted: brief §26 makes the independent
 * scorer the only truth, and brief §28 asks for a fixture "where it is
 * known which strategy produces the better objective". A hand-written
 * claim of which mode is better would be exactly the kind of
 * unverified assertion §26/§27 forbid — and it would be wrong the
 * moment the scorer was retuned. Measuring it means the fixture's
 * ground truth is invalidated automatically by a scorer change,
 * which the `scoringDefaultsVersion` stamp in the provenance then
 * makes visible.
 *
 * `inconclusive: true` when every mode ties, which is a legitimate
 * outcome for a fixture this small. The caller must then treat the
 * fixture as unable to discriminate, not as proving anything.
 */
export function establishFixtureGroundTruth(options = {}) {
  const {
    input,
    profile = BENCHMARK_SOLVER_PROFILE,
    modes = Object.values(OPTIMIZATION_MODES),
  } = options;
  if (!input || typeof input !== 'object') {
    throw new TypeError('establishFixtureGroundTruth requires a SchedulingInput');
  }

  const solverOpts = {
    count: profile.count,
    seed: profile.seed,
    perSolveTimeBudgetMs: profile.perSolveTimeBudgetMs,
    overallTimeBudgetMs: profile.overallTimeBudgetMs,
    respectStrategyMode: profile.respectStrategyMode,
    requireFeasibility: profile.requireFeasibility,
  };

  const byMode = {};
  for (const mode of modes) {
    const modeInput = {
      ...input,
      strategy: { ...input.strategy, optimizationMode: mode },
    };
    const generated = generateSolutions(modeInput, solverOpts);
    const scored = selectFinalSolutions(toCandidates(generated.solutions), {
      count: profile.count,
      input: modeInput,
      requireFeasibility: true,
    });
    const quality = qualityOf(scored.solutions, modeInput);
    byMode[mode] = {
      optimizationMode: mode,
      strategyHash: strategyHashOf({
        optimizationMode: mode,
        candidateCount: profile.count,
        scoringWeights: input.strategy?.weights ?? {},
      }),
      bestGlobalScore: quality.bestGlobalScore,
      bestQualityScore: quality.bestQualityScore,
      bestWorkloadSpread: quality.bestWorkloadSpread,
      bestMaxTeacherLoad: quality.bestMaxTeacherLoad,
      accepted: quality.accepted,
      selectedCount: quality.selectedCount,
    };
  }

  const scoredModes = Object.values(byMode)
    .filter((m) => m.bestGlobalScore !== null)
    .sort((a, b) => b.bestGlobalScore - a.bestGlobalScore || a.optimizationMode.localeCompare(b.optimizationMode));

  const best = scoredModes[0] ?? null;
  const worst = scoredModes[scoredModes.length - 1] ?? null;
  const spread = best && worst ? best.bestGlobalScore - worst.bestGlobalScore : null;
  const EPS = 1e-9;

  return {
    ranking: scoredModes.map((m) => m.optimizationMode),
    byMode,
    bestMode: best?.optimizationMode ?? null,
    worstMode: worst?.optimizationMode ?? null,
    spread,
    // Every mode produced no score, or every mode tied: the fixture
    // cannot rank strategies, and saying otherwise would be the
    // benchmark grading itself.
    inconclusive: !best || spread === null || spread <= EPS,
  };
}
