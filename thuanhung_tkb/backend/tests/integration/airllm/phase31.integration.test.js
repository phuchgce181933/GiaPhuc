// PHASE 31 — REAL AIRLLM RUNTIME SMOKE + STRATEGY QUALITY BENCHMARK (opt-in).
//
//   node --test "tests/integration/airllm/*.test.js"      # skips
//   AIRLLM_INTEGRATION=1 node --test "tests/integration/airllm/*.test.js"   # runs
//
// Separate from `airllm.integration.test.js` on purpose. Phase 30's
// file asks "does the provider work?". This one asks Phase 31's two
// questions — Tier A "does the SERVICE work", Tier B "is the STRATEGY
// useful" — and it is the only place in the repository that runs the
// two-tier benchmark against a real model on the real
// 479-assignment dataset.
//
// WHAT IT DELIBERATELY DOES NOT ASSERT
// ------------------------------------
// It does not assert that the AI is better than the fallback. There
// is no value here that would make that assertion pass on a host
// without a model, and a test that passed only where a good model
// happened to be installed would be a worse test than none.
//
// What it asserts is everything that must be true REGARDLESS of what
// the model says:
//
//   - Tier A reaches exactly one of PASS / FAIL / BLOCKED, and BLOCKED
//     is never laundered into PASS.
//   - Every metadata field is either what the service reported or
//     null. Never "unknown", never "latest".
//   - Every run of both arms is hard-feasible and accepted, including
//     the ones that fell back.
//   - The independent evaluator and the Phase 28 scorer never
//     disagree with each other.
//   - The AI arm's runs contain no field that names a slot, a day, a
//     period, or a teacher.
//   - The conclusion is one of the five permitted values.
//   - H13 stays INACTIVE and H14 stays UNSUPPORTED.
//   - H1-H12 agree on the dataset and H1-H2 agree on the solver
//     conditions between the two arms.
//
// A Tier A FAIL is a real failure and fails the suite. A Tier A
// BLOCKED also fails the suite — loudly, and with a message saying
// the environment is the reason — because the operator explicitly set
// AIRLLM_INTEGRATION=1 and said a model was available.

import test from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../../src/config/index.js';
import { createAIPlannerFromConfig } from '../../../src/domain/ai/providers/index.js';
import { evaluateCandidate } from '../../../src/domain/constraints/index.js';
import { listActiveDimensions } from '../../../src/domain/dimension-catalog.js';
import { loadBenchmarkDataset } from '../../../src/benchmark/dataset.js';
import { runRuntimeSmokeTest, runStrategyBenchmark } from '../../../src/benchmark/index.js';
import { RUNTIME_RESULT } from '../../../src/benchmark/smoke.js';
import { ALLOWED_CONCLUSIONS } from '../../../src/benchmark/versions.js';
import { ALL_AIRLLM_FAILURES } from '../../../src/benchmark/classification.js';

const ENABLED = config.ai.integrationEnabled === true;

const OPTS = {
  skip: ENABLED
    ? false
    : 'set AIRLLM_INTEGRATION=1 and start ai-service to run the real AirLLM benchmark',
};

const REPS = 3;

// The expensive part of this file is computed once and shared, so the
// three tests below assert against ONE real measurement rather than
// each paying for a fresh set of solves. AirLLM is slow by design; the
// benchmark is a measurement, not a test-of-the-measurement.
let cache = null;
async function measure() {
  if (cache) return cache;
  const { input, provenance } = loadBenchmarkDataset();
  const planner = createAIPlannerFromConfig(config.ai, { provider: 'airllm' });

  const smoke = await runRuntimeSmokeTest({
    planner,
    serviceUrl: config.ai.serviceUrl,
    serviceToken: config.ai.serviceToken,
    input,
    timeoutMs: 15_000,
    planTimeoutMs: config.ai.requestTimeoutMs,
  });

  const quality = await runStrategyBenchmark({
    input,
    aiPlanner: planner,
    repetitions: REPS,
    smoke,
    provenance,
  });

  cache = { input, provenance, planner, smoke, quality };
  return cache;
}

test('H1 the AirLLM runtime smoke test reaches PASS, FAIL, or BLOCKED — never a fake pass', OPTS, async () => {
  const { smoke } = await measure();

  assert.ok(
    [RUNTIME_RESULT.PASS, RUNTIME_RESULT.FAIL, RUNTIME_RESULT.BLOCKED].includes(smoke.result),
    `unexpected smoke result: ${smoke.result}`,
  );

  if (smoke.result === RUNTIME_RESULT.BLOCKED) {
    // The honest failure: the operator said a model was available and
    // it was not. This must NOT be reported as a pass.
    assert.equal(smoke.modelReady, false, 'a blocked run must not claim modelReady');
    assert.equal(smoke.decision, null);
    assert.ok(smoke.rootCause, 'a blocked run must name its root cause');
    assert.fail(`AIRLLM_RUNTIME_FAILURE — the AirLLM service did not answer on this host: ${smoke.rootCause}`);
  }

  if (smoke.result === RUNTIME_RESULT.FAIL) {
    assert.fail(`AIRLLM_RUNTIME_FAILURE — the service answered but the runtime failed: ${smoke.rootCause}`);
  }

  // PASS. Both claims must be grounded in what the service said.
  assert.equal(smoke.modelReady, true);
  assert.equal(smoke.decision.fallbackUsed, false, 'a PASS with a fallback is not a PASS');
  assert.equal(smoke.decision.accepted, true);
  assert.equal(smoke.decision.status !== 'REJECTED', true);
  assert.equal(smoke.rootCause, null);
});

test('H2 model and hardware metadata is exactly what the service reported', OPTS, async () => {
  const { smoke } = await measure();
  const env = smoke.environment;

  if (smoke.result !== RUNTIME_RESULT.PASS) {
    // Nothing was reported, so every field must be null — not
    // "unknown", not "latest" (brief §8).
    for (const k of ['airllmVersion', 'pythonVersion', 'torchVersion', 'transformersVersion',
      'modelIdentifier', 'device', 'cudaAvailable', 'dtype']) {
      assert.equal(env[k], null, `${k} must be null, not "${env[k]}"`);
    }
    return;
  }

  // A PASS means the service answered /health and /ready, so the
  // required fields must be populated from those answers.
  assert.equal(env.metadataComplete, true,
    `a PASS with incomplete metadata: ${JSON.stringify(env)}`);
  assert.equal(typeof env.airllmVersion, 'string');
  assert.equal(typeof env.pythonVersion, 'string');
  assert.equal(typeof env.torchVersion, 'string');
  assert.equal(typeof env.transformersVersion, 'string');
  assert.equal(typeof env.modelIdentifier, 'string');
  assert.equal(typeof env.device, 'string');
  assert.equal(typeof env.cudaAvailable, 'boolean');
  assert.equal(typeof env.dtype, 'string');
  assert.equal(env.modelLoaded, true);
  assert.equal(env.serviceState, 'MODEL_READY');

  // brief §10: the generation settings are reported as the service
  // gave them, and `fullyReported` says whether all four are known.
  assert.equal(smoke.generation.temperature !== null, true);
  assert.equal(smoke.generation.maxTokens !== null, true);
  assert.equal(smoke.generation.seed !== null || smoke.determinism.guaranteed === false, true);

  // brief §9: instruct-vs-base is never asserted by the harness.
  assert.equal(smoke.instruct.status, 'UNVERIFIED');
});

test('H3 every run of both arms is hard-feasible and accepted', OPTS, async () => {
  const { input, quality } = await measure();

  for (const arm of ['BASELINE', 'AIRLLM']) {
    const a = quality.arms[arm];
    assert.equal(a.feasibility.runsWithHardViolations, 0,
      `${arm} produced a schedule with hard violations`);
    assert.equal(a.feasibility.runsNotAccepted, 0,
      `${arm} produced a run with no feasible schedule`);
    assert.equal(a.feasibility.oracleDisagreements, 0,
      `${arm}'s scorer and the independent evaluator disagreed`);
    assert.equal(a.feasibility.fallbackRunsHardFeasible, true,
      `${arm}'s fallback schedule was not hard-feasible`);

    for (const run of a.runs) {
      assert.equal(run.accepted, true, `${arm} run ${run.index} produced no schedule`);
      assert.equal(run.quality.hardViolations, 0);
      if (run.rank1Candidate) {
        const ev = evaluateCandidate(run.rank1Candidate, input);
        assert.equal(ev.summary.totalHardViolations, 0,
          `${arm} run ${run.index} failed an independent re-check`);
      }
    }
  }
});

test('H4 the two arms were held identical apart from the strategy source', OPTS, async () => {
  const { quality } = await measure();
  const f = quality.fairness;

  assert.equal(f.armIsAirLLM, true,
    `the AI arm was planned by ${f.aiProviderObserved}, not AirLLM`);
  assert.equal(f.sameSeed, true);
  assert.equal(f.sameEvaluator, true);
  assert.equal(f.sameScoringLayer, true);
  assert.equal(f.differingFactor, 'strategy source only');

  const serialised = new Set();
  for (const arm of ['BASELINE', 'AIRLLM']) {
    for (const run of quality.arms[arm].runs) {
      assert.equal(run.candidateCountRequested, f.candidateCount,
        `${arm} run ${run.index} was solved with a different candidate count`);
      serialised.add(JSON.stringify(run.solverOptions));
    }
  }
  assert.equal(serialised.size, 1, 'the two arms were not solved with identical settings');
});

test('H5 validity, fallback, and diversity are measured, not assumed', OPTS, async () => {
  const { quality } = await measure();
  const ai = quality.arms.AIRLLM;

  assert.equal(ai.rates.requests, quality.fairness.airllmRepetitions,
    'every repetition must have produced exactly one request');
  assert.equal(ai.rates.valid + ai.rates.fallback + ai.rates.invalid, ai.rates.requests,
    'the counts must add up; a fallback is never also counted as valid');
  assert.equal(ai.scoredRunCount, ai.rates.valid,
    'exactly the valid runs contribute a score');
  assert.equal(ai.quality.bestGlobalScore.n, ai.rates.valid,
    'the quality distribution must rest only on valid runs');

  // brief §15: rates are printed with their counts, so a 100% figure
  // over one request is visible as such.
  if (ai.rates.valid === ai.rates.requests) {
    assert.equal(ai.rates.requests > 0, true);
  }
  // brief §12/§16: diversity is reported whether or not the model
  // varies. Same-hash-every-time is a finding, not a pass.
  const d = ai.diversity;
  assert.equal(d.runs, ai.runCount);
  assert.equal(d.distinctStrategyHashes >= 1, true);
  assert.equal(d.distinctStrategyHashes <= d.runs, true);
});

test('H6 every run carries latency and every failure is classified', OPTS, async () => {
  const { quality } = await measure();

  for (const arm of ['BASELINE', 'AIRLLM']) {
    const a = quality.arms[arm];
    for (const metric of ['aiLatencyMs', 'strategyValidationMs', 'solverMs', 'scoringMs', 'totalPipelineMs']) {
      assert.equal(a.latency[metric].n, a.runCount, `${arm}.${metric} was not measured for every run`);
    }
    // brief §30: a failure is never collapsed into one catch-all.
    const tally = a.failures;
    for (const cls of ALL_AIRLLM_FAILURES) {
      assert.equal(typeof tally[cls], 'number', `${arm} is missing the ${cls} bucket`);
    }
    assert.equal('AI_ERROR' in tally, false, 'brief §30 forbids a single AI_ERROR bucket');
  }
});

test('H7 the AI never produced a slot, and travel/transfer stay off', OPTS, async () => {
  const { input, quality } = await measure();

  // brief §2: the AI may propose a strategy and nothing else. The
  // decision vocabulary is a closed set, so any slot-like field is
  // rejected by the validator rather than reaching the solver.
  const allowed = new Set([
    'optimizationMode', 'candidateCount', 'scoringWeights', 'confidence',
    'rationale', 'source',
  ]);
  for (const run of quality.arms.AIRLLM.runs) {
    for (const key of Object.keys(run.decision ?? {})) {
      assert.equal(allowed.has(key), true, `the AI produced a forbidden field: ${key}`);
    }
    for (const key of Object.keys(run.decision?.scoringWeights ?? {})) {
      assert.equal(/^[A-Z_]+$/.test(key), true, `${key} is not a dimension catalog id`);
    }
  }

  // brief §37/§38, on the real dataset.
  assert.equal(input.travelTime, null, 'the benchmark dataset must still carry no travel matrix');
  const active = listActiveDimensions(input).map((d) => d.id);
  assert.equal(active.includes('TRAVEL'), false, 'H14 must stay UNSUPPORTED');
  assert.equal(active.includes('TRANSFER'), false, 'H13 must stay INACTIVE');
  assert.equal(quality.arms.BASELINE.runs[0].scoringDiagnostics.h13, 'INACTIVE');
  assert.equal(quality.arms.BASELINE.runs[0].scoringDiagnostics.h14, 'UNSUPPORTED');
});

test('H8 the conclusion is one of the five permitted values', OPTS, async () => {
  const { quality, provenance } = await measure();

  assert.equal(ALLOWED_CONCLUSIONS.includes(quality.conclusion), true,
    `"${quality.conclusion}" is not one of the five permitted conclusions`);
  assert.ok(quality.conclusionReason && quality.conclusionReason.length > 0,
    'a conclusion must carry its reason');

  // brief §33: the report is only comparable if the dataset stamp is
  // there and the scorer stamp has not drifted.
  assert.equal(provenance.benchmarkInputHash.length, 8);
  assert.equal(provenance.scoringDefaultsVersion.length, 8);
  assert.equal(provenance.dimensionCatalogVersion.length, 8);

  // The whole result must be serialisable, so it can be written to
  // `docs/PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md` and read back.
  assert.doesNotThrow(() => JSON.stringify(quality));
});
