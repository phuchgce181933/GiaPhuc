// PHASE 31 — AI STRATEGY BENCHMARK (public surface).
//
//   Real AirLLM smoke test  +  strategy quality benchmark
//
// WHAT THIS PACKAGE IS FOR
// -----------------------
// Phase 30 proved an AirLLM provider EXISTS. Phase 31 asks the two
// questions that were deliberately left open, and keeps them apart:
//
//   TIER A  does the AirLLM service actually work?
//            -> runRuntimeSmokeTest
//
//   TIER B  is the AirLLM strategy actually useful?
//            -> runStrategyBenchmark
//
// A Tier A PASS is not evidence for Tier B, and neither is reported as
// the other. The package's one hard rule is that a measurement which
// could not be taken is reported as not taken (brief §35, §41).
//
// WHERE THIS LIVES, AND WHY NOT UNDER `domain/ai/`
// ----------------------------------------------
// `domain/ai/` is the strategy layer, and Phase 29 imposed an import
// rule on it: nothing under `domain/ai/` may import the solver, the
// multi-solution generator, or the Phase 28 scorer, because an AI
// module that can reach the scorer can be suspected of influencing it.
// A benchmark must call all three. Putting it here, beside `domain/`
// and `loader/`, keeps that rule intact: `src/benchmark/` is a
// consumer of the whole pipeline and a member of none of it.
//
// WHAT IT DOES NOT DO
// -------------------
// It changes no production behaviour. It calls the same `planStrategy`,
// the same `generateSolutions`, the same `selectFinalSolutions`, and
// the same `evaluateCandidate` that production uses, with the same
// seeds. The only thing this package contributes is measurement, a
// classification vocabulary, and a report.

export {
  // versions + policy
  BENCHMARK_VERSION,
  PROMPT_VERSION_LABEL,
  BENCHMARK_TIER,
  BENCHMARK_CONCLUSION,
  ALLOWED_CONCLUSIONS,
  RUN_VERDICT,
  AI_STRATEGY_EVALUATION_POLICY,
  SOLVER_VERSION,
  SCORING_CONFIG_VERSION,
  CONSTRAINT_CATALOG_VERSION,
  STRATEGY_LAYER_VERSION,
  PROVIDER_VERSION,
  DATASET_SOURCE,
  fnv1a32,
  hashValue,
  dimensionCatalogVersion,
  scoringDefaultsVersion,
  evaluationPolicyVersion,
} from './versions.js';

export {
  // dataset
  loadBenchmarkDataset,
  projectInput,
  benchmarkInputHash,
  buildControlledFixture,
  controlledFixtureProvenance,
  FIXTURE_STRATEGY_MODES,
} from './dataset.js';

export {
  // failure classification (brief §30)
  AIRLLM_FAILURE,
  ALL_AIRLLM_FAILURES,
  classifyAirLLMOutcome,
  tallyFailures,
} from './classification.js';

export {
  // metrics + aggregation
  QUALITY_METRIC_NAMES,
  LATENCY_METRIC_NAMES,
  qualityOf,
  latencyOf,
  aggregate,
  aggregateRuns,
  validityAndFallbackRates,
  decisionDiversity,
} from './metrics.js';

export {
  // the frozen solver conditions + one run
  BENCHMARK_SOLVER_PROFILE,
  BENCHMARK_PLAN_DEFAULTS,
  SOLVER_PROFILE_HASH,
  planStrategyOnce,
  solvePlannedInput,
  runStrategyOnce,
  strategyHashOf,
  alignCandidateCount,
  establishFixtureGroundTruth,
} from './runner.js';

export {
  // Tier A
  RUNTIME_RESULT,
  RUNTIME_FAILURE_CODE,
  isAirLLMPlanner,
  runRuntimeSmokeTest,
} from './smoke.js';

export {
  // Tier B
  BENCHMARK_ARMS,
  BENCHMARK_DEFAULTS,
  BLOCKED_ON,
  DECISION_EQUIVALENT,
  DECISION_NONE,
  compareArms,
  compareDecisions,
  conclude,
  collectProvenance,
  applySharedPoolScore,
  runStrategyBenchmark,
} from './quality.js';

export { renderBenchmarkReport } from './report.js';
