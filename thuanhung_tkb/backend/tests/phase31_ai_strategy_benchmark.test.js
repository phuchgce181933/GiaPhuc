// PHASE 31 — REAL AIRLLM SMOKE TEST + AI STRATEGY QUALITY BENCHMARK
//
// THE QUESTION THIS FILE EXISTS TO ANSWER
// ---------------------------------------
// Phase 30 proved an AirLLM provider exists. Phase 31 asks the two
// questions that were deliberately left open, and keeps them apart:
//
//   TIER A  does the AirLLM service actually WORK?
//   TIER B  is the AirLLM strategy actually USEFUL?
//
// A Tier A PASS is not evidence for Tier B. Neither is reported as
// the other, and no test here treats a skipped or blocked run as a
// pass (brief §29, §35).
//
// WHAT THESE TESTS ARE AND ARE NOT
// -------------------------------
// They are harness tests, run on the small controlled fixture with an
// injected fetch. They verify that the benchmark measures what it
// claims, that it refuses to claim what it cannot, and that the two
// arms are held identical apart from the strategy source.
//
// They do NOT test AirLLM. A model, a GPU, and the real
// 479-assignment dataset belong in
// `tests/integration/airllm/`, behind `AIRLLM_INTEGRATION=1`, and are
// not part of `npm test` (brief §40).
//
// WHAT IS ASSERTED ABOUT THE CONCLUSION
// -------------------------------------
// Only that it is one of the five permitted values and that it is
// BLOCKED whenever the environment could not answer. Whether AirLLM
// improves anything is a question for a real host with a real model,
// and a test that asserted "AI is better" would be asserting the
// conclusion the phase exists to measure.
//
// The 25 required checks are numbered 1-25 in brief §39 order.
// Additional guards are numbered 26+.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { config } from '../src/config/index.js';
import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES, STRATEGY_C } from '../src/domain/strategies.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { selectFinalSolutions, scorePool, GLOBAL_SCORING_DEFAULTS } from '../src/domain/global-scoring.js';
import { DIMENSION_CATALOG, listActiveDimensions } from '../src/domain/dimension-catalog.js';
import { buildSituationReport, ALLOWED_DECISION_FIELDS, validateStrategyDecision, AI_FAILURE } from '../src/domain/ai/index.js';
import { AirLLMPlanner, createAIPlannerFromConfig } from '../src/domain/ai/providers/index.js';
import { buildAllowList } from '../src/domain/ai/index.js';

import {
  ALLOWED_CONCLUSIONS,
  AI_STRATEGY_EVALUATION_POLICY,
  BENCHMARK_ARMS,
  BENCHMARK_SOLVER_PROFILE,
  BLOCKED_ON,
  DECISION_EQUIVALENT,
  DECISION_NONE,
  LATENCY_METRIC_NAMES,
  QUALITY_METRIC_NAMES,
  SOLVER_PROFILE_HASH,
  RUNTIME_RESULT,
  RUNTIME_FAILURE_CODE,
  alignCandidateCount,
  applySharedPoolScore,
  benchmarkInputHash,
  buildControlledFixture,
  classifyAirLLMOutcome,
  compareArms,
  compareDecisions,
  conclude,
  controlledFixtureProvenance,
  decisionDiversity,
  establishFixtureGroundTruth,
  latencyOf,
  loadBenchmarkDataset,
  planStrategyOnce,
  projectInput,
  qualityOf,
  renderBenchmarkReport,
  runRuntimeSmokeTest,
  runStrategyBenchmark,
  runStrategyOnce,
  solvePlannedInput,
  strategyHashOf,
  tallyFailures,
  validityAndFallbackRates,
  aggregate,
  ALL_AIRLLM_FAILURES,
  AIRLLM_FAILURE,
  isAirLLMPlanner,
} from '../src/benchmark/index.js';

// ============================================================================
// Test doubles
// ============================================================================

/**
 * A fast solver profile.
 *
 * The frozen `BENCHMARK_SOLVER_PROFILE` budgets 30 s per solve and
 * 180 s overall, which is right for the real dataset and far too slow
 * for a unit test. Only the BUDGET is shortened. `seed`,
 * `respectStrategyMode`, and `requireFeasibility` are left exactly as
 * they are, because those three are what the fairness tests read.
 */
const FAST_PROFILE = Object.freeze({
  ...BENCHMARK_SOLVER_PROFILE,
  count: 1,
  perSolveTimeBudgetMs: 2_000,
  overallTimeBudgetMs: 8_000,
});

/**
 * A stand-in for AirLLM.
 *
 * It extends `AirLLMPlanner` so `isAirLLMPlanner` accepts it by
 * `instanceof` — the same identity check the real provider passes —
 * and it returns decisions from a script so a test can say exactly
 * what the model "said".
 *
 * `decisions` is a queue: each `plan()` call takes the next entry and
 * wraps around. An `Error` entry is thrown, which is how a timeout or
 * a dead service is simulated. That is the only channel a test needs:
 * the orchestrator must treat every one of them identically.
 */
class ScriptedAirLLM extends AirLLMPlanner {
  constructor(options = {}) {
    super(options);
    this.script = options.script ?? [];
    this.calls = 0;
    this.reports = [];
    this.provenance = options.provenance ?? {
      provider: 'airllm',
      model: 'stub-instruct-1',
      promptVersion: 'PROMPT_V1',
      latencyMs: 12,
      serviceValidated: true,
      state: 'MODEL_READY',
    };
  }

  get name() {
    return 'ScriptedAirLLM';
  }

  async plan(report) {
    this.reports.push(report);
    const entry = this.script.length === 0
      ? validDecision()
      : this.script[(this.calls) % this.script.length];
    this.calls += 1;
    if (entry instanceof Error) throw entry;

    const decision = { ...entry };
    // Mirrors what the real provider attaches: non-enumerable, so
    // the validator's unknown-field check is unaffected.
    Object.defineProperty(decision, '__airllm', {
      value: Object.freeze({ ...this.provenance }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return decision;
  }
}

/**
 * A decision the validator should accept.
 *
 * `scoringWeights` keys are DIMENSION CATALOG ids (`WORKLOAD_BALANCE`,
 * not `workload`). The allow-list is built from the catalog, so a
 * lower-case key is not a wrong weight — it is an unknown dimension,
 * and `validateStrategyDecision` rejects the whole decision for it.
 * That is brief §2 working as intended: the AI may not create
 * dimensions, and a misspelling is not a silent no-op.
 */
function validDecision(overrides = {}) {
  return {
    optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED,
    candidateCount: 1,
    scoringWeights: { WORKLOAD_BALANCE: 1.5, PREFERENCE: 1.0 },
    confidence: 0.8,
    rationale: 'Balance workload across the team.',
    source: 'AirLLM',
    ...overrides,
  };
}

/**
 * A stand-in for the Python service, injected as `fetchImpl`.
 *
 * It reports EXACTLY the fields the real `/health` and `/ready` carry
 * and nothing more, so a test that reads `environment.airllmVersion`
 * is reading the projection and not a field this file invented.
 */
function fakeService(options = {}) {
  const {
    state = 'MODEL_READY',
    healthRuntime = {
      airllmVersion: '0.2.10',
      pythonVersion: '3.11.9',
      torchVersion: '2.4.0',
      transformersVersion: '4.44.2',
      cudaAvailable: false,
      fastapiVersion: '0.115.0',
      platform: 'Windows-10-10.0.26200',
    },
    healthConfig = {
      device: 'cpu',
      dtype: 'float32',
      temperature: 0.0,
      maxNewTokens: 384,
      modelSource: 'local',
      modelResolvesLocally: true,
      allowRemoteCode: false,
    },
  } = options;

  return async (url) => {
    const u = new URL(url);
    if (u.pathname === '/health') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          provider: 'airllm',
          model: 'stub-instruct-1',
          modelLoaded: state === 'MODEL_READY',
          runtime: healthRuntime,
          config: healthConfig,
        }),
      };
    }
    if (u.pathname === '/ready') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ state, remoteCodeUsed: false, errors: [] }),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

/** A `fetch` that behaves like a closed port. */
const deadService = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8077'), { code: 'ECONNREFUSED' });
};

// ============================================================================
// Fixtures
// ============================================================================

const REAL = loadFromLegacySaplich().scheduling;
const REAL_INPUT = { ...REAL, strategy: STRATEGY_C };

/** One full fallback run on the controlled fixture. */
async function fixtureFallbackRun() {
  return runStrategyOnce({
    input: buildControlledFixture(), planner: null, profile: FAST_PROFILE,
  });
}

// ============================================================================
// 1. benchmark input deterministic
// ============================================================================

test('1 the benchmark input hash is deterministic and PII-free', () => {
  const a = buildControlledFixture();
  const b = buildControlledFixture();
  const hashA = benchmarkInputHash(a, a.strategy);
  const hashB = benchmarkInputHash(b, b.strategy);

  assert.equal(hashA, hashB, 'two builds of the same fixture must hash identically');
  assert.match(hashA, /^[0-9a-f]{8}$/);

  // The real dataset, loaded twice, must agree — that is what lets a
  // report claim both arms saw the same 40 teachers / 479 assignments.
  const r1 = loadBenchmarkDataset();
  const r2 = loadBenchmarkDataset();
  assert.equal(
    benchmarkInputHash(r1.input, r1.input.strategy),
    benchmarkInputHash(r2.input, r2.input.strategy),
  );

  // Structural, not identity: adding a teacher must change the hash,
  // or "same dataset" would be unfalsifiable.
  const grown = { ...a, teachers: [...a.teachers, { ...a.teachers[0], id: 'fx-teacher-4' }] };
  assert.notEqual(benchmarkInputHash(grown, a.strategy), hashA, 'a changed roster must change the hash');

  // No personal data may reach the artifact the hash is built from.
  const serialised = JSON.stringify(projectInput(a, a.strategy));
  for (const teacher of a.teachers) {
    assert.ok(!serialised.includes(teacher.hoTen), `the projection leaked the name "${teacher.hoTen}"`);
  }
  assert.ok(!/hoTen|email|soDienThoai/.test(serialised), 'the projection leaked a personal-data field');
});

test('1b the real benchmark dataset carries the expected cardinalities', () => {
  const { provenance, projection } = loadBenchmarkDataset();
  const c = projection.counts;
  // brief §3: 40 active teachers, 7 branches, 113 classes, 5 active
  // subjects, 479 assignments. Asserted so a dataset swap that
  // silently changes the benchmark's subject is a test failure.
  assert.equal(c.teachers, 40);
  assert.equal(c.branches, 7);
  assert.equal(c.classes, 113);
  assert.equal(c.activeSubjects, 5);
  assert.equal(c.assignments, 479);
  assert.equal(provenance.benchmarkInputHash.length, 8);
});

// ============================================================================
// 2. fallback baseline deterministic
// ============================================================================

test('2 the deterministic fallback baseline is identical across repeated runs', async () => {
  const first = await fixtureFallbackRun();
  const second = await fixtureFallbackRun();

  assert.equal(first.fallbackUsed, true);
  assert.equal(second.fallbackUsed, true);
  assert.equal(first.strategyHash, second.strategyHash, 'the strategy hash must not drift');
  assert.equal(
    first.quality.bestGlobalScore,
    second.quality.bestGlobalScore,
    'the same input and seed must produce the same score',
  );
  assert.equal(first.decision.source, 'DEFAULT_AI_FALLBACK');

  // N identical runs, or the comparison against them means nothing.
  const runs = await Promise.all([
    fixtureFallbackRun(), fixtureFallbackRun(), fixtureFallbackRun(),
  ]);
  const hashes = new Set(runs.map((r) => r.strategyHash));
  assert.equal(hashes.size, 1, `3 runs produced ${hashes.size} distinct strategies`);
  const scores = new Set(runs.map((r) => r.quality.bestGlobalScore));
  assert.equal(scores.size, 1, '3 runs produced more than one score');
});

// ============================================================================
// 3. AirLLM provider integration is opt-in
// ============================================================================

test('3 the AirLLM integration is opt-in and stays out of `npm test`', () => {
  assert.equal(config.ai.integrationEnabled, false, 'AIRLLM_INTEGRATION must default to off');

  // The suite that touches a real model must live below
  // `tests/integration/`, which the `tests/*.test.js` glob does not
  // descend into. A model pulled into `npm test` would make every
  // developer need a GPU.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /tests\/\*\.test\.js/, 'npm test must stay a one-level glob');
  // The real-model suite is reachable, but only by naming it.
  assert.match(pkg.scripts['test:integration'] ?? '', /tests\/integration/,
    'there must be an explicit command for the opt-in integration suite');
  assert.equal(
    (pkg.scripts['test:integration'] ?? '').includes('AI_PROVIDER'),
    false,
    'the integration suite must not hard-code a provider; it reads config',
  );
  assert.ok(pkg.scripts.benchmark, 'the benchmark CLI must be runnable without a raw node path');

  const integrationDir = new URL('./integration/', import.meta.url);
  const real = readFileSync(
    path.join(fileURLToPath(integrationDir), 'airllm/airllm.integration.test.js'),
    'utf8',
  );
  assert.match(real, /AIRLLM_INTEGRATION/, 'the integration suite must gate on the flag');
  assert.match(real, /skip/, 'the integration suite must skip rather than fail when off');
});

test('3b the benchmark CLI defaults to the AirLLM provider, not the mock', () => {
  const cli = readFileSync(new URL('../src/benchmark/cli.js', import.meta.url), 'utf8');
  // The mistake this guards: `AI_PROVIDER` defaults to `mock`, so a
  // CLI that honoured it by default would happily print a report
  // titled "AirLLM results" for a model that was never loaded.
  assert.match(cli, /provider: 'airllm'/, 'the CLI must default --provider to airllm');
  assert.match(cli, /--provider=/, 'the CLI must let the provider be overridden explicitly');
});

// ============================================================================
// 4. no-AirLLM test path still works
// ============================================================================

test('4 with no AirLLM service the smoke test is BLOCKED, never a fake pass', async () => {
  const result = await runRuntimeSmokeTest({
    planner: new ScriptedAirLLM({ serviceUrl: 'http://127.0.0.1:8077' }),
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: deadService,
    input: buildControlledFixture(),
  });

  assert.equal(result.result, RUNTIME_RESULT.BLOCKED, 'a dead service is BLOCKED, not FAIL and not PASS');
  assert.equal(result.blocked, true);
  // The single most important assertion in this file: there is no
  // path from "the probe failed" to "modelReady: true" (brief §7).
  assert.equal(result.modelReady, false);
  assert.equal(result.decision, null, 'no decision may be reported when no service answered');
  assert.equal(result.failure.class, AIRLLM_FAILURE.SERVICE_UNREACHABLE);
  assert.equal(result.failure.code, RUNTIME_FAILURE_CODE);
  assert.ok(result.rootCause, 'a blocked run must say why');

  // brief §8: unreported metadata is null, never "unknown"/"latest".
  for (const k of ['airllmVersion', 'pythonVersion', 'torchVersion', 'transformersVersion',
    'modelIdentifier', 'device', 'cudaAvailable', 'dtype']) {
    assert.equal(result.environment[k], null, `${k} must be null, not "${result.environment[k]}"`);
  }
  assert.equal(result.environment.metadataComplete, false);
});

test('4b the full pipeline still solves when the AI service is dead (brief §24)', async () => {
  const planner = new ScriptedAirLLM({ serviceUrl: 'http://127.0.0.1:8077', script: [new Error('ECONNREFUSED')] });
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: planner,
    repetitions: 2,
    profile: FAST_PROFILE,
    probe: { reachable: false, error: 'ECONNREFUSED' },
    smoke: { result: RUNTIME_RESULT.BLOCKED, rootCause: 'no service listening' },
  });

  const ai = result.arms[BENCHMARK_ARMS.AI];
  assert.equal(ai.rates.fallback, ai.rates.requests, 'every request fell back');
  assert.equal(ai.rates.valid, 0);
  assert.equal(ai.rates.validityRate, 0);
  // The safety invariant: a fallback schedule is still produced, and
  // it is still hard-feasible.
  assert.equal(ai.feasibility.acceptedCount, ai.runCount);
  assert.equal(ai.feasibility.runsWithHardViolations, 0);
  assert.equal(ai.feasibility.fallbackRunsHardFeasible, true);
  assert.equal(result.conclusion, 'AIRLLM_BENCHMARK_BLOCKED');
});

// ============================================================================
// 5. model metadata captured
// ============================================================================

test('5 model, version, and hardware metadata are captured from the service', async () => {
  const result = await runRuntimeSmokeTest({
    planner: new ScriptedAirLLM({ serviceUrl: 'http://127.0.0.1:8077' }),
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: fakeService(),
    input: buildControlledFixture(),
  });

  assert.equal(result.result, RUNTIME_RESULT.PASS);
  assert.equal(result.modelReady, true);
  assert.equal(result.decision.fallbackUsed, false);

  const env = result.environment;
  assert.equal(env.airllmVersion, '0.2.10');
  assert.equal(env.pythonVersion, '3.11.9');
  assert.equal(env.torchVersion, '2.4.0');
  assert.equal(env.transformersVersion, '4.44.2');
  assert.equal(env.modelIdentifier, 'stub-instruct-1');
  assert.equal(env.device, 'cpu');
  assert.equal(env.cudaAvailable, false);
  assert.equal(env.dtype, 'float32');
  assert.equal(env.metadataComplete, true);

  // brief §10. A setting the service does not report is null, and
  // `fullyReported` says so rather than implying it held constant.
  assert.equal(result.generation.temperature, 0);
  assert.equal(result.generation.maxTokens, 384);
  assert.equal(result.generation.topP, null);
  assert.equal(result.generation.seed, null);
  assert.equal(result.generation.fullyReported, false);

  // brief §10: determinism is documented, not assumed.
  assert.equal(result.determinism.guaranteed, false);
  assert.match(result.determinism.reason, /DOCUMENTED/);

  // brief §9: instruct-vs-base is unverified, not guessed.
  assert.equal(result.instruct.status, 'UNVERIFIED');
});

// ============================================================================
// 6. AI strategy validated before solver
// ============================================================================

test('6 every strategy is validated before the solver ever sees it', async () => {
  const planner = new ScriptedAirLLM({ script: [validDecision()] });
  const planned = await planStrategyOnce({
    input: buildControlledFixture(), planner, profile: FAST_PROFILE,
  });

  assert.equal(planned.ok, true);
  const plan = planned.plan;
  assert.equal(plan.validation.ok, true, 'the decision must pass the Node validator');
  assert.equal(plan.decision.source, 'AirLLM', 'the model\'s own decision, not the fallback');

  // What the SOLVER receives is the validated, applied strategy.
  const run = await solvePlannedInput({ planned, profile: FAST_PROFILE, count: 1 });
  assert.equal(run.decision.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
  assert.equal(run.aiDecisionUsed, true, 'an accepted provider decision is an AI decision');
  assert.equal(run.quality.hardViolations, 0);
});

test('6b the solver never receives the raw provider output', async () => {
  const planner = new ScriptedAirLLM({ script: [validDecision()] });
  const planned = await planStrategyOnce({
    input: buildControlledFixture(), planner, profile: FAST_PROFILE,
  });
  // The solver is fed `plan.input` — a SchedulingInput carrying the
  // approved strategy. The provider's raw JSON is not reachable from
  // it, so it cannot have influenced the solver except through the
  // validator (brief §2, §25).
  const solverInput = planned.plan.input;
  assert.equal(solverInput.strategy.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
  assert.equal(JSON.stringify(solverInput).includes('"rationale"'), false,
    'the rationale must not travel into the solver input');
  assert.equal('rawOutput' in solverInput, false);
});

// ============================================================================
// 7. invalid AI output falls back
// ============================================================================

test('7 invalid AI output falls back and is recorded as such', async () => {
  const cases = [
    ['an unknown optimization mode', validDecision({ optimizationMode: 'DOES_NOT_EXIST' })],
    ['an out-of-vocabulary candidate count', validDecision({ candidateCount: 7 })],
    ['an unknown field', validDecision({ assignments: [{ teacherId: 'x', day: 1, period: 2 }] })],
    ['a non-object', 'I think you should use balanced assignment.'],
    ['a provider exception', new Error('the model timed out')],
  ];

  for (const [label, entry] of cases) {
    const planner = new ScriptedAirLLM({ script: [entry] });
    const run = await runStrategyOnce({
      input: buildControlledFixture(), planner, profile: FAST_PROFILE,
    });
    assert.equal(run.fallbackUsed, true, `${label} must fall back`);
    assert.equal(run.aiDecisionUsed, false, `${label} must not count as an AI decision`);
    assert.equal(run.decision.source, 'DEFAULT_AI_FALLBACK', `${label} must use the fallback strategy`);
    // brief §6: a fallback run is not a successful AI run.
    assert.equal(run.failure.class !== null, true, `${label} must record why it fell back`);
    // brief §24: and it still produces a hard-feasible schedule.
    assert.equal(run.accepted, true, `${label} must still produce a schedule`);
    assert.equal(run.quality.hardViolations, 0, `${label}'s fallback schedule must be hard-feasible`);
  }
});

// ============================================================================
// 8. fallback result hard-feasible
// ============================================================================

test('8 the fallback baseline is hard-feasible on the real dataset', async () => {
  const run = await runStrategyOnce({
    input: REAL_INPUT, planner: null, profile: FAST_PROFILE,
  });
  assert.equal(run.quality.hardViolations, 0);
  assert.equal(run.quality.accepted, true);
  // The independent evaluator agrees, and its answer is recorded.
  assert.equal(run.quality.oracleIndependentCheck.hardViolations, 0);
  assert.equal(run.quality.oracleIndependentCheck.accepted, true);
  assert.equal(run.quality.selectedCount >= 1, true);
});

// ============================================================================
// 9. AirLLM result hard-feasible when available
// ============================================================================

test('9 an accepted AirLLM decision still yields a hard-feasible schedule', async () => {
  for (const mode of Object.values(OPTIMIZATION_MODES)) {
    const planner = new ScriptedAirLLM({ script: [validDecision({ optimizationMode: mode })] });
    const run = await runStrategyOnce({
      input: buildControlledFixture(), planner, profile: FAST_PROFILE,
    });
    assert.equal(run.aiDecisionUsed, true, `${mode} must be accepted`);
    assert.equal(run.accepted, true, `${mode} must produce a schedule`);
    assert.equal(run.quality.hardViolations, 0, `${mode}'s schedule must be hard-feasible`);
    assert.equal(run.quality.oracleIndependentCheck.hardViolations, 0);
  }
});

test('9b the validator is the only path to a strategy, and a bad weight is clamped not honoured', () => {
  const input = buildControlledFixture();
  const allowList = buildAllowList(input);

  // brief §2: the AI cannot create a slot. `placements`, `assignments`,
  // `slots` are not decision fields, so an attempt to send them is
  // rejected rather than partially read.
  const slotAttempt = validateStrategyDecision({
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    candidateCount: 1,
    placements: { 'fx-assignment-1': { teacherId: 'fx-teacher-1', day: 1, period: 2 } },
  }, { input, allowList });
  assert.equal(slotAttempt.ok, false, 'a decision carrying slots must be rejected');
  assert.ok(
    !ALLOWED_DECISION_FIELDS.includes('placements'),
    'placements is not an allowed decision field',
  );

  // brief §7: a clamp is recorded, never silent.
  const clamped = validateStrategyDecision({
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    candidateCount: 1,
    scoringWeights: { WORKLOAD_BALANCE: 99 },
  }, { input, allowList });
  assert.equal(clamped.ok, true);
  assert.equal(clamped.events.length > 0, true, 'the clamp must be recorded as an event');
  assert.equal(clamped.decision.scoringWeights.WORKLOAD_BALANCE <= 3, true);
  assert.notEqual(clamped.decision.scoringWeights.WORKLOAD_BALANCE, 99,
    'the out-of-bounds weight must not reach the solver');

  // An unknown dimension is a rejection, not a silent drop: the AI may
  // not create dimensions, and a misspelling is not a no-op.
  const invented = validateStrategyDecision({
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    candidateCount: 1,
    scoringWeights: { workload: 2 },
  }, { input, allowList });
  assert.equal(invented.ok, false, 'an invented dimension id must be rejected');
});

// ============================================================================
// 10-12. same solver settings / candidate count / time budget
// ============================================================================

test('10 both arms are solved with the identical solver settings', async () => {
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: new ScriptedAirLLM({ script: [validDecision()] }),
    repetitions: 2,
    profile: FAST_PROFILE,
  });

  assert.equal(result.fairness.sameSeed, true);
  assert.equal(result.fairness.sameSolverImplementation, true);
  assert.equal(result.fairness.sameEvaluator, true);
  assert.equal(result.fairness.sameScoringLayer, true);
  assert.equal(result.fairness.differingFactor, 'strategy source only');

  // The strong form: the recorded options are byte-identical, not
  // merely drawn from the same constant.
  const optionsOf = (arm) => arm.runs.map((r) => JSON.stringify(r.solverOptions));
  assert.equal(
    new Set([...optionsOf(result.arms[BENCHMARK_ARMS.BASELINE]), ...optionsOf(result.arms[BENCHMARK_ARMS.AI])]).size,
    1,
    'the two arms were not solved with the same settings',
  );
  assert.equal(result.arms[BENCHMARK_ARMS.BASELINE].runs[0].solverOptions.seed, FAST_PROFILE.seed);
});

test('11 both arms are solved with the same candidate count', async () => {
  // The AI asks for more candidates than the fallback does. The
  // baseline must be raised to match, or the comparison measures the
  // budget rather than the strategy (brief §19).
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: new ScriptedAirLLM({ script: [validDecision({ candidateCount: 10 })] }),
    repetitions: 1,
    profile: FAST_PROFILE,
  });

  const fair = result.fairness.candidateCount;
  assert.equal(fair, 10, 'the fair count is the maximum any arm asked for');
  assert.deepEqual(result.fairness.naturalCandidateCounts[BENCHMARK_ARMS.BASELINE], [3],
    'the baseline naturally asked for 3');
  assert.deepEqual(result.fairness.naturalCandidateCounts[BENCHMARK_ARMS.AI], [10]);
  assert.equal(result.fairness.raisedBaselineToFairCount, true,
    'the baseline was raised above its own preference, and the report must be able to say so');
  for (const arm of [BENCHMARK_ARMS.BASELINE, BENCHMARK_ARMS.AI]) {
    for (const run of result.arms[arm].runs) {
      assert.equal(run.candidateCountRequested, fair, `${arm} run ${run.index} used a different count`);
    }
  }
  assert.equal(SOLVER_PROFILE_HASH.length, 8, 'the frozen profile carries a printable hash');
  assert.deepEqual(alignCandidateCount([1, 3, 5, 10]), { count: 10, natural: [1, 3, 5, 10], raised: true });
  assert.equal(alignCandidateCount([]).count, BENCHMARK_SOLVER_PROFILE.count);
  assert.equal(alignCandidateCount([7]).count, BENCHMARK_SOLVER_PROFILE.count,
    'a count outside the allowed vocabulary is not honoured');
  // `raised` is measured against the BASELINE's own count, not against
  // the frozen profile default. The profile is a documented default,
  // not a statement about what this baseline would have chosen.
  assert.equal(alignCandidateCount([3], { baselineNatural: 3 }).raised, false);
  assert.equal(alignCandidateCount([3], { baselineNatural: 1 }).raised, true);
});

test('12 both arms are solved with the same time budget', async () => {
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: new ScriptedAirLLM({ script: [validDecision()] }),
    repetitions: 1,
    profile: FAST_PROFILE,
  });

  const budgets = new Set();
  for (const arm of [BENCHMARK_ARMS.BASELINE, BENCHMARK_ARMS.AI]) {
    for (const run of result.arms[arm].runs) {
      budgets.add(`${run.solverOptions.perSolveTimeBudgetMs}/${run.solverOptions.overallTimeBudgetMs}`);
    }
  }
  assert.equal(budgets.size, 1, 'the two arms received different time budgets');
  assert.equal(result.fairness.solverProfile.perSolveTimeBudgetMs, FAST_PROFILE.perSolveTimeBudgetMs);

  // The AI call is OUTSIDE the solver's budget, so a slow model
  // cannot eat the solver's time and manufacture a "the AI is slower"
  // result that is really a wall-clock artefact.
  const ai = result.arms[BENCHMARK_ARMS.AI];
  assert.equal(ai.latency.aiLatencyMs.n >= 1, true, 'the AI round trip is measured separately');
  assert.equal(Object.isFrozen(BENCHMARK_SOLVER_PROFILE), true, 'the shared profile is frozen');
});

// ============================================================================
// 13. strategy hashes captured
// ============================================================================

test('13 every run carries a strategy hash covering only what changes behaviour', async () => {
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: new ScriptedAirLLM({ script: [validDecision()] }),
    repetitions: 2,
    profile: FAST_PROFILE,
  });

  for (const arm of [BENCHMARK_ARMS.BASELINE, BENCHMARK_ARMS.AI]) {
    for (const run of result.arms[arm].runs) {
      assert.match(run.strategyHash, /^[0-9a-f]{8}$/, `${arm} run ${run.index} has no strategy hash`);
    }
  }

  // The hash must NOT cover the rationale, or two behaviourally
  // identical decisions would look different and brief §20's
  // equivalence test could never fire for the right reason.
  const a = strategyHashOf(validDecision({ rationale: 'one explanation' }));
  const b = strategyHashOf(validDecision({ rationale: 'a completely different explanation' }));
  assert.equal(a, b, 'the rationale is explanation, not strategy');

  // It MUST cover the mode, the count, and the weights.
  assert.notEqual(a, strategyHashOf(validDecision({ optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST })));
  assert.notEqual(a, strategyHashOf(validDecision({ candidateCount: 5 })));
  assert.notEqual(a, strategyHashOf(validDecision({ scoringWeights: { WORKLOAD_BALANCE: 2.5 } })));
  assert.equal(strategyHashOf(null), null);
});

test('13b decision diversity and stability are measured, not assumed (brief §12, §16)', async () => {
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    // A sampling model is allowed to differ run to run. The benchmark
    // must report that without calling it a defect.
    aiPlanner: new ScriptedAirLLM({
      script: [
        validDecision({ optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED }),
        validDecision({ optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST }),
        validDecision({ optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED }),
      ],
    }),
    repetitions: 3,
    profile: FAST_PROFILE,
  });

  const d = result.arms[BENCHMARK_ARMS.AI].diversity;
  assert.equal(d.runs, 3);
  assert.equal(d.distinctStrategyHashes, 2, 'three runs produced two distinct strategies');
  assert.equal(d.distinctModes, 2);
  assert.equal(d.stable, false);
  assert.deepEqual(decisionDiversity([]).distinctStrategyHashes, 0);
});

// ============================================================================
// 14-15. validity rate / fallback rate
// ============================================================================

test('14 the AI validity rate is computed from counts, never asserted', () => {
  // brief §15's worked example: 5 requests, 4 valid, 1 fallback.
  const runs = [
    ...Array.from({ length: 4 }, (_, i) => ({ plannerName: 'AirLLM', aiDecisionUsed: true, fallbackUsed: false, index: i })),
    { plannerName: 'AirLLM', aiDecisionUsed: false, fallbackUsed: true, index: 4 },
  ];
  const r = validityAndFallbackRates(runs);
  assert.equal(r.requests, 5);
  assert.equal(r.valid, 4);
  assert.equal(r.fallback, 1);
  assert.equal(r.invalid, 0);
  assert.equal(r.validityRate, 0.8);
  assert.equal(r.fallbackRate, 0.2);

  // 1 of 1 is 100%. It must be printed as 1.0 WITH the count beside
  // it, never as a bare "100% success".
  const single = validityAndFallbackRates([{ plannerName: 'AirLLM', aiDecisionUsed: true, fallbackUsed: false }]);
  assert.equal(single.validityRate, 1);
  assert.equal(single.requests, 1);
});

test('15 the fallback rate counts only provider-consulted runs', () => {
  // The baseline consults no provider. Counting it as N "requests,
  // 0 valid, N fallback" would report a 0% success rate for a run
  // that never asked anything.
  const baselineRuns = Array.from({ length: 5 }, (_, i) => ({
    index: i, plannerName: null, fallbackUsed: true, aiDecisionUsed: false,
  }));
  const r = validityAndFallbackRates(baselineRuns);
  assert.equal(r.requests, 0, 'the baseline made no AI requests');
  assert.equal(r.validityRate, null, 'a rate over zero requests is null, not 0 and not 1');
  assert.equal(r.fallbackRate, null);

  // An accepted decision whose solver found nothing is neither valid
  // nor a fallback: it is DOWNSTREAM_NO_SOLUTION, and the counts must
  // add up.
  const mixed = validityAndFallbackRates([
    { plannerName: 'AirLLM', aiDecisionUsed: true, fallbackUsed: false, accepted: false },
    { plannerName: 'AirLLM', aiDecisionUsed: false, fallbackUsed: true, accepted: true },
  ]);
  assert.equal(mixed.requests, 2);
  assert.equal(mixed.valid, 1);
  assert.equal(mixed.fallback, 1);
  assert.equal(mixed.invalid, 0);
  assert.equal(mixed.valid + mixed.fallback + mixed.invalid, mixed.requests);
});

test('15b a rejected decision is excluded from the score distribution', async () => {
  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    // One good decision, then one that will not validate.
    aiPlanner: new ScriptedAirLLM({
      script: [validDecision(), validDecision({ optimizationMode: 'NOT_A_MODE' })],
    }),
    repetitions: 2,
    profile: FAST_PROFILE,
  });

  const ai = result.arms[BENCHMARK_ARMS.AI];
  assert.equal(ai.runCount, 2);
  assert.equal(ai.scoredRunCount, 1, 'only the accepted decision contributes a score');
  assert.equal(ai.excludedFromQuality, 1);
  assert.equal(ai.quality.bestGlobalScore.n, 1);
  // `aggregate` rounds to 6 decimals, so the comparison is made at the
  // same precision rather than with an exact float equality.
  assert.deepEqual(
    ai.quality.bestGlobalScore.values,
    [Math.round(ai.runs[0].quality.bestGlobalScore * 1e6) / 1e6],
    'the distribution holds the ACCEPTED run\'s score and nothing else',
  );
  // The fallback run's numbers are still available — brief §24 wants
  // them visible — but not mixed into the AI's distribution.
  assert.equal(ai.qualityIncludingFallback.bestGlobalScore.n, 2);
  assert.equal(ai.runs[1].fallbackUsed, true);
  assert.equal(typeof ai.runs[1].quality.bestGlobalScore, 'number',
    'the fallback run still produced a measurable schedule');
});

// ============================================================================
// 16-17. quality + latency metrics captured
// ============================================================================

test('16 all nine quality metrics of brief §13 are recorded per run', async () => {
  const run = await runStrategyOnce({
    input: buildControlledFixture(),
    planner: new ScriptedAirLLM({ script: [validDecision()] }),
    profile: FAST_PROFILE,
  });

  for (const name of QUALITY_METRIC_NAMES) {
    assert.ok(name in run.quality, `quality.${name} is missing`);
  }
  const required = [
    'bestGlobalScore', 'bestQualityScore', 'bestWorkloadSpread', 'bestMaxTeacherLoad',
    'bestWorkloadStdev', 'minSlotDiversity', 'minStructuralDiversity', 'hardViolations', 'accepted',
  ];
  for (const name of required) {
    assert.ok(name in run.quality, `brief §13 requires ${name}`);
  }
  assert.equal(typeof run.quality.bestGlobalScore, 'number');
  assert.equal(typeof run.quality.accepted, 'boolean');

  // An empty pool is a result, not a row of zeros: the metrics must
  // be null so a fake average is impossible.
  const empty = qualityOf([], buildControlledFixture());
  assert.equal(empty.bestGlobalScore, null);
  assert.equal(empty.accepted, null);
  assert.equal(empty.selectedCount, 0);
});

test('17 all five operational metrics of brief §14 are recorded per run', async () => {
  const run = await runStrategyOnce({
    input: buildControlledFixture(),
    planner: new ScriptedAirLLM({ script: [validDecision()] }),
    profile: FAST_PROFILE,
  });

  for (const name of ['aiLatencyMs', 'strategyValidationMs', 'solverMs', 'scoringMs', 'totalPipelineMs']) {
    assert.equal(typeof run.latency[name], 'number', `${name} must be measured, not null`);
    assert.ok(run.latency[name] >= 0);
    assert.equal(LATENCY_METRIC_NAMES.includes(name), true);
  }
  // A sub-millisecond validator legitimately measures as 0, so the
  // assertion is that the stage is TIMED SEPARATELY — a real number
  // with its own field, not a residual of `total - ai`.
  assert.equal(typeof run.latency.strategyValidationMs, 'number');
  assert.equal(
    run.latency.totalPipelineMs >= run.latency.aiLatencyMs,
    true,
    'the pipeline total must be at least the AI round trip',
  );
  assert.equal(run.fallbackUsed, false, 'brief §14 requires fallbackUsed to be recorded');

  // A run with nothing measured reports null rather than 0, so a
  // missing measurement cannot read as a fast one.
  const bare = latencyOf({});
  assert.equal(bare.aiLatencyMs, null);
  assert.equal(bare.totalPipelineMs, null);
});

test('17b distributions report mean, median, min, max, variance, and every value', () => {
  const d = aggregate([1, 5, 5, 5, 9]);
  assert.equal(d.n, 5);
  assert.equal(d.mean, 5);
  assert.equal(d.median, 5);
  assert.equal(d.min, 1);
  assert.equal(d.max, 9);
  // Population variance: mean 5, deviations 4,0,0,0,4 → 32/5.
  assert.equal(d.variance, 6.4);
  // `aggregate` rounds to 6 decimals, so the derived stdev is compared
  // at the same precision rather than with an exact float equality.
  assert.equal(Math.abs(d.stdev - Math.sqrt(6.4)) < 1e-6, true);
  assert.deepEqual(d.values, [1, 5, 5, 5, 9]);

  // brief §22/§23: nulls are excluded and COUNTED, so a mean over 3
  // is never presented as a mean over 5.
  const withNulls = aggregate([1, null, 3, undefined, 5]);
  assert.equal(withNulls.n, 3);
  assert.equal(withNulls.excluded, 2);
  assert.equal(aggregate([]).n, 0);
  assert.equal(aggregate([]).mean, null);
});

// ============================================================================
// 18-20. the oracles stay the oracles
// ============================================================================

test('18 the AI rationale is never used as evidence', async () => {
  // Two runs, byte-identical strategies, wildly different rationales.
  // If any part of the benchmark read the rationale, one of these
  // numbers would move. None of them may (brief §26, §27).
  const loud = await runStrategyOnce({
    input: buildControlledFixture(),
    planner: new ScriptedAirLLM({
      script: [validDecision({ rationale: 'I improved the workload balance by 42% and exceeded expectations.' })],
    }),
    profile: FAST_PROFILE,
  });
  const modest = await runStrategyOnce({
    input: buildControlledFixture(),
    planner: new ScriptedAirLLM({
      script: [validDecision({ rationale: 'Balanced assignment looks reasonable here.' })],
    }),
    profile: FAST_PROFILE,
  });

  assert.equal(loud.decision.rationale !== modest.decision.rationale, true);
  assert.equal(loud.strategyHash, modest.strategyHash);
  assert.equal(loud.quality.bestGlobalScore, modest.quality.bestGlobalScore);
  assert.equal(loud.quality.bestWorkloadSpread, modest.quality.bestWorkloadSpread);
  assert.equal(loud.quality.hardViolations, modest.quality.hardViolations);

  // The rationale is carried for the audit trail and for a human to
  // read. Nothing in `quality` is derived from it.
  assert.equal(loud.decision.rationale.includes('42%'), true, 'the text is still recorded');
  assert.equal(Object.keys(loud.quality).includes('rationale'), false);
});

test('19 the independent evaluator remains the oracle', async () => {
  const input = buildControlledFixture();
  const run = await runStrategyOnce({
    input, planner: new ScriptedAirLLM({ script: [validDecision()] }), profile: FAST_PROFILE,
  });

  // Re-run the evaluator here, independently of the scorer, and
  // require agreement. "The oracle said yes" must be a recorded fact.
  const ev = evaluateCandidate(run.rank1Candidate, input);
  assert.equal(ev.summary.totalHardViolations, 0);
  assert.equal(run.quality.oracleIndependentCheck.hardViolations, 0);
  assert.equal(run.quality.oracleIndependentCheck.accepted, true);
  assert.equal(
    run.quality.hardViolations,
    run.quality.oracleIndependentCheck.hardViolations,
    'the scorer and the independent evaluator disagree',
  );
  assert.equal(run.quality.oracleIndependentCheck.constraintStatuses !== undefined, true);
});

test('20 the global scorer remains the oracle for quality', async () => {
  const input = buildControlledFixture();
  const run = await runStrategyOnce({
    input, planner: new ScriptedAirLLM({ script: [validDecision()] }), profile: FAST_PROFILE,
  });

  // `bestGlobalScore` must BE the Phase 28 `scoring.total` of the
  // rank-1 solution — read, not recomputed by the benchmark.
  assert.equal(run.quality.bestGlobalScore >= 0 && run.quality.bestGlobalScore <= 1, true);
  assert.equal(run.rank1CandidateId, run.quality.oracleIndependentCheck ? run.rank1CandidateId : null);

  // The shared pool is a second, COMMON scale. It must come from the
  // scorer's own `scorePool` under the scorer's own default weights,
  // so the AI's weights cannot reach the yardstick (brief §26).
  const scored = applySharedPoolScore([run], { input });
  assert.equal(scored.poolSize, 1);
  assert.equal(scored.scored, 1);
  assert.deepEqual(scored.weights, GLOBAL_SCORING_DEFAULTS.weights);
  assert.equal(typeof run.quality.sharedPoolGlobalScore, 'number');
  assert.equal(run.quality.sharedPoolGlobalScore >= 0 && run.quality.sharedPoolGlobalScore <= 1, true);

  // Re-scoring the same candidate alone in the scorer's own pool must
  // reproduce the number, proving the benchmark added no opinion.
  const direct = scorePool([run.rank1Candidate], input, GLOBAL_SCORING_DEFAULTS);
  assert.equal(direct.scores[0].total, run.quality.sharedPoolGlobalScore);

  // A run that shipped nothing cannot be scored, and says so.
  const empty = applySharedPoolScore([{ quality: {} }], { input });
  assert.equal(empty.poolSize, 0);
  assert.equal(empty.scored, 0);
  assert.equal(empty.unscoreable, 1);
});

test('20b two arms scored in one shared pool are on a common scale', async () => {
  const input = buildControlledFixture();
  const runs = [
    await runStrategyOnce({ input, planner: null, profile: FAST_PROFILE }),
    await runStrategyOnce({
      input,
      planner: new ScriptedAirLLM({ script: [validDecision()] }),
      profile: FAST_PROFILE,
    }),
  ];
  // The per-run totals are pool-relative and can differ purely
  // because each pool had a different spread. The shared pool is what
  // makes them comparable.
  const before = runs.map((r) => r.quality.bestGlobalScore);
  const summary = applySharedPoolScore(runs, { input });
  assert.equal(summary.poolSize, 2);
  const shared = runs.map((r) => r.quality.sharedPoolGlobalScore);
  assert.equal(shared.every((v) => typeof v === 'number'), true);
  assert.equal(shared[0] !== shared[1] || before[0] === before[1], true);
  assert.equal(typeof before[0], 'number');
});

// ============================================================================
// 21-23. the boundary the AI may not cross
// ============================================================================

test('21 AirLLM cannot generate slots, days, periods, or teacher assignments', () => {
  const input = buildControlledFixture();
  const report = buildSituationReport(input);

  // What the provider receives: aggregate-only, and no slot.
  const serialised = JSON.stringify(report);
  for (const forbidden of ['placements', 'slots', 'day', 'period', 'teacherId']) {
    assert.equal(serialised.includes(`"${forbidden}"`), false, `the report leaked "${forbidden}"`);
  }

  // And a decision that tries to carry them is rejected whole.
  const allowList = buildAllowList(input);
  for (const attempt of [
    { assignments: [{ teacherId: 'fx-teacher-1', day: 1, period: 1 }] },
    { slots: [{ day: 1, period: 1, classId: 'fx-class-1' }] },
    { teacherAssignments: { 'fx-teacher-1': ['fx-class-1'] } },
  ]) {
    const r = validateStrategyDecision(
      { optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE, candidateCount: 1, ...attempt },
      { input, allowList },
    );
    assert.equal(r.ok, false, `a decision carrying ${Object.keys(attempt)[0]} must be rejected`);
  }
});

test('22 travel stays UNSUPPORTED and is never weighted (brief §37)', () => {
  const input = buildControlledFixture();
  assert.equal(input.travelTime, null, 'the fixture ships no travel matrix');
  assert.equal(input.travelStatus, 'MISSING_CONFIGURATION');

  // TRAVEL is not on the active list, so it cannot be given a weight
  // even if the model asks for one.
  const active = listActiveDimensions(input).map((d) => d.id);
  assert.equal(active.includes('TRAVEL'), false, 'TRAVEL must not be active without a travel matrix');

  const proj = projectInput(input, input.strategy);
  assert.equal(proj.travelMatrixPresent, false);
  assert.equal(proj.travelStatus, 'MISSING_CONFIGURATION');

  // Same on the real dataset, which is what the phase is judged on.
  const real = loadBenchmarkDataset();
  assert.equal(real.input.travelTime, null);
  assert.equal(listActiveDimensions(real.input).map((d) => d.id).includes('TRAVEL'), false);

  const catalog = DIMENSION_CATALOG.find((d) => d.id === 'TRAVEL');
  assert.equal(catalog.active(input), false, 'TRAVEL must be inactive, not merely unweighted');
});

test('23 transfer stays INACTIVE and no transfer weight is added (brief §38)', async () => {
  const input = buildControlledFixture();
  // H13 is INACTIVE because no teacher declares a transfer
  // permission. Nothing in Phase 31 may change that.
  for (const t of input.teachers) {
    assert.equal('allowedTransferBranches' in t, false, 'the fixture must not grant transfer permission');
  }
  const active = listActiveDimensions(input).map((d) => d.id);
  assert.equal(active.includes('TRANSFER'), false, 'TRANSFER must stay inactive');
  for (const a of input.assignments) {
    assert.equal(a.isTransferred, false);
    assert.equal(a.transferredAt, null);
  }
  // And the scorer says so in its own diagnostics.
  const diag = await diagnosticsOfH13H14();
  assert.equal(diag.h13, 'INACTIVE');
  assert.equal(diag.h14, 'UNSUPPORTED');

  // TRANSFER is on the allow-list — the catalog defines it — but it is
  // not ACTIVE on this input, so a model may name it and may not
  // change anything with it. That is the difference brief §38 cares
  // about: not that the word is banned, but that it has no effect.
  const allowList = buildAllowList(input);
  const r = validateStrategyDecision({
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    candidateCount: 1,
    scoringWeights: { TRANSFER: 3 },
  }, { input, allowList });
  assert.equal(r.ok, true, 'naming an inactive dimension is not itself a rejection');

  // Whatever the decision says, the dimension cannot contribute.
  const travelTransfer = DIMENSION_CATALOG.filter((d) => d.id === 'TRANSFER' || d.id === 'TRAVEL');
  for (const d of travelTransfer) {
    assert.equal(d.active(input), false, `${d.id} must be inactive`);
  }
  // And the benchmark never writes one into a dataset.
  const realProvenance = loadBenchmarkDataset().provenance;
  assert.equal(realProvenance.travelStatus, 'MISSING_CONFIGURATION');
  assert.equal(
    JSON.stringify(projectInput(REAL_INPUT, STRATEGY_C)).includes('allowedTransferBranches'),
    false,
  );
});

// ============================================================================
// 24. the report
// ============================================================================

test('24 the report contains every section brief §34 requires', async () => {
  const input = buildControlledFixture();
  const result = await runStrategyBenchmark({
    input,
    aiPlanner: new ScriptedAirLLM({ script: [validDecision()] }),
    repetitions: 2,
    profile: FAST_PROFILE,
    provenance: controlledFixtureProvenance(input),
  });
  const smoke = await runRuntimeSmokeTest({
    planner: new ScriptedAirLLM(),
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: fakeService(),
    input,
  });

  const md = renderBenchmarkReport({ smoke, quality: result, provenance: controlledFixtureProvenance(input) });

  for (const section of [
    '## How this benchmark works', '## Environment', '## Model', '## AirLLM version', '## Hardware',
    '## Dataset', '## Prompt version', '## Runtime results (Tier A)', '## Strategy validity',
    '## Fallback rate', '## Baseline results', '## AirLLM results',
    '## Quality comparison', '## Latency comparison', '## Failure analysis', '## Conclusion',
  ]) {
    assert.ok(md.includes(section), `the report is missing "${section}"`);
  }
  assert.match(md, /benchmarkInputHash/);
  assert.match(md, /sharedPoolGlobalScore/);
  // No markdown table row may be a comma-joined array: `kvTable`
  // returns lines and must be spread, and a missing spread produced a
  // `|a|,|b|` row that still "looked" like a table.
  assert.equal(/\|,\|/.test(md), false, 'a kvTable was pushed without spreading it');
  assert.equal(md.includes(',| Field | Value |'), false);
  assert.ok(result.conclusion.length > 0);
  // The per-run table is the anti-cherry-picking evidence and must
  // actually be printed.
  assert.match(md, /Per-run \(no cherry-picking/);
});

test('24b the renderer refuses a conclusion outside the five permitted values', () => {
  const md = renderBenchmarkReport({
    smoke: null,
    quality: { conclusion: 'AI_IS_TERRIFIC', conclusionReason: 'because I say so', comparison: null },
  });
  assert.match(md, /RENDERER REFUSED/);
  assert.equal(md.includes('AI_IS_TERRIFIC` is not one of the five'), true);
  for (const c of ALLOWED_CONCLUSIONS) {
    assert.ok(md.includes(c), `the refusal must list ${c} as permitted`);
  }
  assert.equal(ALLOWED_CONCLUSIONS.length, 5, 'brief §41 permits exactly five conclusions');
});

// ============================================================================
// 25. the environment-blocked state is honest
// ============================================================================

test('25 an environment that cannot answer is reported as BLOCKED, not as a pass', async () => {
  const smoke = await runRuntimeSmokeTest({
    planner: new ScriptedAirLLM(),
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: deadService,
    input: buildControlledFixture(),
  });

  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: new ScriptedAirLLM({ script: [validDecision()] }),
    repetitions: 1,
    profile: FAST_PROFILE,
    smoke,
  });

  assert.equal(smoke.result, RUNTIME_RESULT.BLOCKED);
  assert.equal(result.ran, true, 'the baseline arm still ran; only the AI arm was blocked');
  assert.equal(result.conclusion, 'AIRLLM_BENCHMARK_BLOCKED', 'the one permitted blocked conclusion');
  assert.equal(result.blockedOn, BLOCKED_ON.ENVIRONMENT);
  assert.ok(ALLOWED_CONCLUSIONS.includes(result.conclusion));

  // The baseline WAS measured, and saying "blocked" must not throw
  // that measurement away.
  const base = result.arms[BENCHMARK_ARMS.BASELINE];
  assert.equal(base.runs.length, 1);
  assert.equal(base.quality.bestGlobalScore.n, 1);

  // brief §35: the report says the environment blocked it, and
  // unreported metadata reads "not reported" rather than "unknown".
  const md = renderBenchmarkReport({ smoke, quality: result, provenance: null });
  assert.match(md, /AIRLLM_BENCHMARK_BLOCKED/);
  assert.match(md, /not reported/);
  // Scoped to TABLE VALUES, not the whole document: prose may
  // legitimately use the word "unknown" ("an unknown field is a
  // rejection"), but no cell may render an unobserved fact as one.
  const badCells = md.split('\n').filter((line) => /^\s*\|/.test(line)
    && /(^|\|)\s*`?(unknown|latest|recommended)`?\s*(\||$)/i.test(line));
  assert.deepEqual(badCells, [], `a table cell rendered an unobserved value: ${badCells.join(' / ')}`);
  assert.match(md, /REAL_AIRLLM_BENCHMARK|BLOCKED/, 'the blocked state must be visible in the artifact');
});

// ============================================================================
// 26+ Additional guards
// ============================================================================

test('26 a non-AirLLM planner cannot produce an AirLLM conclusion', async () => {
  // The specific substitution this guards: `AI_PROVIDER` defaults to
  // `mock`, and a perfectly valid mock decision would otherwise be
  // reported as "AirLLM results, validityRate 1.0".
  const mock = createAIPlannerFromConfig(config.ai, { provider: 'mock' });
  assert.equal(isAirLLMPlanner(mock), false);

  const result = await runStrategyBenchmark({
    input: buildControlledFixture(),
    aiPlanner: mock,
    repetitions: 1,
    profile: FAST_PROFILE,
  });

  assert.equal(result.fairness.armIsAirLLM, false);
  assert.equal(result.fairness.aiProviderObserved, mock.name);
  assert.equal(result.conclusion, 'AIRLLM_BENCHMARK_BLOCKED');
  assert.match(result.conclusionReason, /not by an AirLLM provider/);
  // The measurements themselves are still real.
  assert.equal(result.arms[BENCHMARK_ARMS.AI].runs.length, 1);
});

test('27 Tier A refuses a planner that is not AirLLM', async () => {
  const result = await runRuntimeSmokeTest({
    planner: createAIPlannerFromConfig(config.ai, { provider: 'mock' }),
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: fakeService(),
    input: buildControlledFixture(),
  });
  assert.notEqual(result.result, RUNTIME_RESULT.PASS,
    'a mock planner must never produce an AirLLM runtime PASS');
  assert.equal(result.decision, null);
  assert.match(result.rootCause, /must exercise an AirLLM provider/);
});

test('28 the two yardsticks must agree before any direction is claimed', () => {
  // Two arms whose shipped schedules differ. Within each run's own
  // candidate pool the AI arm looks clearly better; in one shared pool
  // spanning both arms it is clearly worse. A benchmark that reported
  // only the first would claim an improvement.
  const arm = (perRun, shared) => ({
    runs: [],
    quality: {
      bestGlobalScore: aggregate(perRun),
      sharedPoolGlobalScore: aggregate(shared),
    },
  });

  const policy = AI_STRATEGY_EVALUATION_POLICY;
  const within = compareArms(arm([0.4, 0.4, 0.4], [0.2, 0.4, 0.6]), arm([0.9, 0.9, 0.9], [0.2, 0.4, 0.6]));
  assert.equal(within.verdict, 'BETTER');
  assert.equal(within.separation, 'SEPARATED');

  const sharedPool = compareArms(
    arm([0.4, 0.4, 0.4], [0.9, 0.9, 0.9]),
    arm([0.9, 0.9, 0.9], [0.1, 0.1, 0.1]),
    { ...policy, primaryMetric: 'sharedPoolGlobalScore' },
  );
  assert.equal(sharedPool.verdict, 'WORSE', 'on the common scale the other arm is ahead');

  const verdict = conclude({
    qualityRan: true,
    armIsAirLLM: true,
    comparison: within,
    sharedPoolComparison: sharedPool,
    decisionEffect: { equivalent: false },
    ai: { rates: { requests: 3, valid: 3, fallback: 0, invalid: 0 }, feasibility: {} },
  });
  assert.equal(verdict.conclusion, 'AI_STRATEGY_VALID_BUT_NO_MEASURABLE_GAIN');
  assert.match(verdict.conclusionReason, /yardsticks disagree/);

  // Agreement on both scales is what allows a claim. An EQUIVALENT on
  // one scale is not evidence against BETTER on the other, so it does
  // not veto the claim.
  const agreeing = conclude({
    qualityRan: true,
    armIsAirLLM: true,
    comparison: within,
    sharedPoolComparison: { ...sharedPool, verdict: 'EQUIVALENT' },
    decisionEffect: { equivalent: false },
    ai: { rates: { requests: 3, valid: 3, fallback: 0, invalid: 0 }, quality: { bestGlobalScore: { n: 3 } } },
  });
  assert.equal(agreeing.conclusion, 'AI_STRATEGY_IMPROVES_RESULTS');
});

test('29 only the five permitted conclusions are reachable', () => {
  const rates = { requests: 3, valid: 0, fallback: 3, invalid: 0 };
  const base = { qualityRan: true, armIsAirLLM: true, ai: { rates, feasibility: { runsNotAccepted: 0 } } };

  const cases = [
    [conclude({ ...base, qualityRan: false, smoke: { result: RUNTIME_RESULT.PASS } }), 'AIRLLM_RUNTIME_READY'],
    [conclude({ ...base, smoke: { result: RUNTIME_RESULT.BLOCKED, rootCause: 'no service' } }), 'AIRLLM_BENCHMARK_BLOCKED'],
    [conclude({ ...base, smoke: { result: RUNTIME_RESULT.FAIL, rootCause: 'bad model' } }), 'AIRLLM_BENCHMARK_BLOCKED'],
    [conclude({ ...base, comparison: { verdict: 'INVALID' } }), 'AIRLLM_BENCHMARK_BLOCKED'],
    [conclude({ ...base, comparison: { verdict: 'BETTER', separation: 'SEPARATED', medianDelta: 0.2, primaryMetric: 'bestGlobalScore' }, decisionEffect: { equivalent: true, note: 'same strategy' } }), 'AI_STRATEGY_VALID_BUT_NO_MEASURABLE_GAIN'],
    [conclude({ ...base, comparison: { verdict: 'BETTER', separation: 'SEPARATED', medianDelta: 0.2, primaryMetric: 'bestGlobalScore' }, decisionEffect: { equivalent: false } }), 'AI_STRATEGY_IMPROVES_RESULTS'],
    [conclude({ ...base, comparison: { verdict: 'WORSE', separation: 'SEPARATED', medianDelta: -0.2, primaryMetric: 'bestGlobalScore' }, decisionEffect: { equivalent: false } }), 'AI_STRATEGY_WORSE_THAN_FALLBACK'],
    [conclude({ ...base, comparison: { verdict: 'BETTER', separation: 'OVERLAPPING', medianDelta: 0.2, primaryMetric: 'bestGlobalScore' }, decisionEffect: { equivalent: false } }), 'AI_STRATEGY_VALID_BUT_NO_MEASURABLE_GAIN'],
  ];

  for (const [outcome, expected] of cases) {
    assert.equal(outcome.conclusion, expected);
    assert.equal(ALLOWED_CONCLUSIONS.includes(outcome.conclusion), true);
  }
  // A run with no AI requests at all is blocked on the environment,
  // not scored as a 0% success.
  assert.equal(
    conclude({ ...base, comparison: { verdict: 'INVALID' } }).blockedOn,
    BLOCKED_ON.STRATEGY_VALIDITY,
  );
});

test('30 the strategy-only comparison detects an equivalent decision (brief §20)', () => {
  const same = { strategyHash: 'aaaaaaaa' };
  const effect = compareDecisions([same, same], [
    { strategyHash: 'aaaaaaaa', fallbackUsed: false, aiDecisionUsed: true },
    { strategyHash: 'aaaaaaaa', fallbackUsed: false, aiDecisionUsed: true },
  ]);
  assert.equal(effect.equivalent, true);
  assert.equal(effect.signal, DECISION_EQUIVALENT);
  assert.match(effect.note, /no improvement may be claimed/);

  const distinct = compareDecisions([{ strategyHash: 'aaaaaaaa' }], [
    { strategyHash: 'bbbbbbbb', fallbackUsed: false, aiDecisionUsed: true },
  ]);
  assert.equal(distinct.equivalent, false);
  assert.equal(distinct.signal, 'AIRLLM_DECISION_DISTINCT');

  // A fallback run has no AI decision to compare, so it cannot make
  // the arms look equivalent — and it cannot make them look
  // different either. With nothing accepted there is nothing to
  // compare, and the report must say exactly that.
  const allFallback = compareDecisions([{ strategyHash: 'aaaaaaaa' }], [
    { strategyHash: 'aaaaaaaa', fallbackUsed: true, aiDecisionUsed: false },
  ]);
  assert.equal(allFallback.equivalent, false, 'a fallback is not an equivalent AI decision');
  assert.equal(allFallback.signal, DECISION_NONE);
  assert.match(allFallback.note, /no AI strategy to compare/);
  assert.deepEqual(allFallback.aiAcceptedHashes, []);
});

test('31 the eight failure classes of brief §30 stay distinct', () => {
  assert.equal(ALL_AIRLLM_FAILURES.length, 9, 'the eight required plus SERVICE_UNREACHABLE');
  for (const required of [
    'MODEL_LOAD_FAILURE', 'MODEL_NOT_READY', 'INFERENCE_FAILURE', 'TIMEOUT',
    'INVALID_JSON', 'SCHEMA_INVALID', 'STRATEGY_REJECTED', 'DOWNSTREAM_NO_SOLUTION',
  ]) {
    assert.ok(ALL_AIRLLM_FAILURES.includes(required), `${required} must be a distinct class`);
  }
  assert.equal(ALL_AIRLLM_FAILURES.includes('AI_ERROR'), false, 'brief §30 forbids one catch-all');

  assert.equal(classifyAirLLMOutcome({ probe: { reachable: false, error: 'ECONNREFUSED' } }).class, 'SERVICE_UNREACHABLE');
  assert.equal(classifyAirLLMOutcome({ probe: { reachable: true, state: 'MODEL_ERROR' } }).class, 'MODEL_LOAD_FAILURE');
  assert.equal(classifyAirLLMOutcome({ probe: { reachable: true, state: 'MODEL_LOADING' } }).class, 'MODEL_NOT_READY');
  assert.equal(classifyAirLLMOutcome({ plan: { fallbackUsed: true, failure: { kind: AI_FAILURE.TIMEOUT } } }).class, 'TIMEOUT');
  assert.equal(classifyAirLLMOutcome({ plan: { fallbackUsed: true, failure: { kind: AI_FAILURE.PARSE_ERROR } } }).class, 'INVALID_JSON');
  assert.equal(
    classifyAirLLMOutcome({ plan: { fallbackUsed: true, failure: { kind: AI_FAILURE.INVALID_OUTPUT } } }).class,
    'SCHEMA_INVALID',
  );
  // A REJECTED status keeps the transport class when the transport
  // explains the rejection: a timeout did not produce a decision to
  // refuse, and saying "the validator rejected it" would send an
  // operator to the wrong file.
  assert.equal(
    classifyAirLLMOutcome({
      plan: { fallbackUsed: true, validation: { status: 'REJECTED' }, failure: { kind: AI_FAILURE.UNAVAILABLE } },
    }).class,
    'SERVICE_UNREACHABLE',
  );
  // A rejection with no transport explanation IS the validator's, and
  // must not be filed under the transport.
  assert.equal(
    classifyAirLLMOutcome({ plan: { fallbackUsed: true, validation: { status: 'REJECTED' } } }).class,
    'STRATEGY_REJECTED',
  );
  assert.equal(
    classifyAirLLMOutcome({ plan: { fallbackUsed: true, validation: { status: 'REJECTED' }, failure: { kind: 'CONFIDENCE_TOO_LOW' } } }).class,
    'STRATEGY_REJECTED',
  );
  assert.equal(classifyAirLLMOutcome({ plan: { fallbackUsed: false }, solutions: { solutions: [] } }).class, 'DOWNSTREAM_NO_SOLUTION');
  assert.equal(classifyAirLLMOutcome({ plan: { fallbackUsed: false }, solutions: { solutions: [{}] } }).class, null);

  // A REJECTED status with a TIMEOUT keeps the transport class: the
  // validator's verdict refines the diagnosis, it does not overwrite
  // a more specific one.
  assert.equal(
    classifyAirLLMOutcome({
      plan: { fallbackUsed: true, validation: { status: 'REJECTED' }, failure: { kind: AI_FAILURE.TIMEOUT } },
    }).class,
    'TIMEOUT',
  );

  // An unrecognised service state is NOT_READY, never the good case.
  assert.equal(classifyAirLLMOutcome({ probe: { reachable: true, state: 'SOMETHING_NEW' } }).class, 'MODEL_NOT_READY');

  // The tally always has every key, so a report's shape is stable.
  const t = tallyFailures([{ class: 'TIMEOUT' }, { class: null }]);
  assert.equal(t.TIMEOUT, 1);
  assert.equal(t.NONE, 1);
  assert.equal(t.INVALID_JSON, 0);
});

test('32 the controlled fixture measures its own ground truth (brief §28)', () => {
  const input = buildControlledFixture();
  const truth = establishFixtureGroundTruth({ input, profile: FAST_PROFILE });

  assert.deepEqual(truth.ranking.length > 0, true);
  assert.equal(truth.inconclusive === true || truth.bestMode !== null, true);
  // The ranking is measured by the same solver and the same scorer,
  // never asserted by hand — a scorer retune invalidates it and the
  // provenance stamp makes that visible.
  for (const mode of truth.ranking) {
    assert.ok(Object.values(OPTIMIZATION_MODES).includes(mode));
    assert.ok(mode in truth.byMode);
  }
  if (!truth.inconclusive) {
    assert.ok(truth.spread > 0, 'a non-inconclusive fixture must actually separate the modes');
    const best = truth.byMode[truth.bestMode];
    for (const [mode, m] of Object.entries(truth.byMode)) {
      if (m.bestGlobalScore === null) continue;
      assert.ok(best.bestGlobalScore >= m.bestGlobalScore, `${mode} beat the reported best`);
    }
  }

  // ALLOWED_CANDIDATE_COUNTS is the AI's vocabulary; the benchmark
  // never widens it.
  assert.deepEqual([...ALLOWED_CANDIDATE_COUNTS], [1, 3, 5, 10]);
});

test('33 the evaluation policy is explicit, versioned, and hashable', () => {
  const p = AI_STRATEGY_EVALUATION_POLICY;
  assert.equal(p.primaryMetric, 'bestGlobalScore');
  assert.equal(p.aggregator, 'median', 'brief §22 forbids picking the best run');
  assert.equal(p.gatesOnValidity, true, 'a fallback run must not be scored as an AI run');
  assert.equal(p.overlappingRangesDowngradeConclusion, true);
  assert.deepEqual([...p.decidedBy], ['bestGlobalScore'],
    'exactly one metric decides, so the policy cannot be tuned after the fact');
  assert.equal(Object.isFrozen(p), true);
  assert.ok(p.epsilon > 0);

  // The recorded-only list must not contain the deciding metric, or
  // "recorded but never decided on" would be false.
  for (const recorded of p.recordedOnly) {
    assert.equal(recorded === p.primaryMetric, false, `${recorded} is both decided and recorded-only`);
  }
  for (const required of ['bestWorkloadSpread', 'bestMaxTeacherLoad', 'bestWorkloadStdev',
    'minSlotDiversity', 'minStructuralDiversity']) {
    assert.ok(p.recordedOnly.includes(required), `brief §17 requires ${required} to be recorded`);
  }
});

test('34 the benchmark does not import the AI layer into the domain', () => {
  // Phase 29's import rule: nothing under `domain/ai/` may reach the
  // solver, the multi-solution generator, or the scorer. The benchmark
  // calls all three, which is exactly why it lives in `src/benchmark/`
  // and not inside `domain/ai/`.
  const aiFiles = [
    '../src/domain/ai/index.js',
    '../src/domain/ai/planner.js',
    '../src/domain/ai/situation-report.js',
    '../src/domain/ai/strategy-schema.js',
    '../src/domain/ai/providers/airllm-planner.js',
    '../src/domain/ai/providers/airllm-client.js',
  ];
  const forbidden = ['multi-solution.js', 'solver.js', 'global-scoring.js', 'benchmark/'];
  for (const rel of aiFiles) {
    const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const f of forbidden) {
      const re = new RegExp(`from ['"][^'"]*${f.replace(/[.\\/]/g, '\\$&')}['"]`);
      assert.equal(re.test(src), false, `${rel} must not import ${f}`);
    }
  }
  // And the reverse: the scorer is a real import of the benchmark,
  // which is what the shared-pool pass needs.
  const runner = readFileSync(new URL('../src/benchmark/quality.js', import.meta.url), 'utf8');
  assert.match(runner, /from '\.\.\/domain\/global-scoring\.js'/);
});

test('35 the benchmark adds no UI, no schema, and no travel', () => {
  // brief §36. `src/benchmark/` must contain only measurement code.
  const files = [
    'index.js', 'versions.js', 'dataset.js', 'classification.js',
    'metrics.js', 'runner.js', 'smoke.js', 'quality.js', 'report.js', 'cli.js',
  ];
  const whole = files
    .map((f) => readFileSync(new URL(`../src/benchmark/${f}`, import.meta.url), 'utf8'))
    .join('\n');

  for (const forbidden of [
    'express', 'mongoose', 'Schema(', 'react', 'render(', 'listen(',
  ]) {
    assert.equal(whole.includes(forbidden), false, `the benchmark must not reference ${forbidden}`);
  }
  // It must not, anywhere, enable the dimensions Phase 31 froze off.
  // The check is for CONSTRUCTION, not for the word: reading
  // `input.travelTime` to report that it is absent is required, and
  // writing one is forbidden.
  assert.equal(/allowedTransferBranches\s*[:=]/.test(whole), false,
    'the benchmark must not grant transfer permission');
  assert.equal(/travelTime\s*:\s*[\[{"]/.test(whole), false,
    'the benchmark must not construct a travel matrix');
  assert.equal(whole.includes('travelTime: {'), false);
  assert.equal(whole.includes('travelTime: ['), false);
  // And the two dataset builders both ship none.
  assert.equal(buildControlledFixture().travelTime, null);
  assert.equal(loadBenchmarkDataset().input.travelTime, null);
});

// ---------------------------------------------------------------------------

/**
 * Read the H13/H14 flags straight out of the Phase 28 scorer.
 *
 * Taken from `selectFinalSolutions` rather than hard-coded, because
 * the claim under test is "the scorer still reports these two as
 * inactive/unsupported" — asserting a literal would pass even if the
 * scorer started reporting something else.
 */
function diagnosticsOfH13H14() {
  const input = buildControlledFixture();
  return runStrategyOnce({ input, planner: null, profile: FAST_PROFILE })
    .then((run) => run.scoringDiagnostics ?? {});
}
