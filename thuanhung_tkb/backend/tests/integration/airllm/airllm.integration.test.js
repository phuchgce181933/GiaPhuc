// PHASE 30 — AIRLLM REAL-SERVICE INTEGRATION TEST (opt-in).
//
//   node --test "tests/integration/airllm/*.test.js"   # skips
//   set AIRLLM_INTEGRATION=1, then the same command        # runs
//
// The glob form is deliberate. `node --test <dir>` works on some
// platforms and not others — on Windows a trailing separator makes
// Node treat the path as a module to load, and it fails with
// MODULE_NOT_FOUND rather than skipping. Quoting the glob works
// everywhere, including through PowerShell.
//
// Brief §28, §30, §45. This file is NOT part of `npm test`: the
// script is `node --test tests/*.test.js`, a one-level glob that does
// not descend into `tests/integration/`. Even when run explicitly,
// every test here is gated on `AIRLLM_INTEGRATION=1` and reports
// `skip` rather than `fail` when the service is absent.
//
// WHAT IT PROVES (brief §30, §31, §46, §59, §60)
//   29. the AirLLM model loads and the service reports MODEL_READY
//   30. POST /plan returns a VALID StrategyDecision
//   31. the real SchedulingInput reaches the solver through the AI
//   32. the final candidate is HARD-FEASIBLE
//   + the fallback path with the service deliberately down
//
// TEST 60 IS THE ONE THAT MATTERS MOST, AND IT NEEDS NO MODEL.
// It points the provider at a closed port, so it runs on a machine
// with no AirLLM, no checkpoint, and no GPU. It is still behind the
// flag because it runs the real solver on the real 479-assignment
// input, which takes minutes — expensive for a default run, cheap
// enough to run first whenever this suite is invoked.
//
// WHAT IT DOES NOT PROVE
//   Anything about model quality. AirLLM is not required to beat the
//   deterministic default in Phase 30 (brief §34). Two different
//   valid decisions are a legitimate outcome, not a failure
//   (brief §56).

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../../../src/loader/legacy-saplich/index.js';
import { STRATEGY_C } from '../../../src/domain/strategies.js';
import { generateSolutions } from '../../../src/domain/multi-solution.js';
import { evaluateCandidate } from '../../../src/domain/constraints/index.js';
import { selectFinalSolutions } from '../../../src/domain/global-scoring.js';
import {
  AirLLMPlanner,
  createAIPlannerFromConfig,
  probeAirLLMService,
} from '../../../src/domain/ai/providers/index.js';
import { planStrategy } from '../../../src/domain/ai/index.js';
import { config } from '../../../src/config/index.js';

const ENABLED = config.ai.integrationEnabled === true;

const OPTS = {
  skip: ENABLED
    ? false
    : 'set AIRLLM_INTEGRATION=1 and start ai-service to run the AirLLM integration tests',
};

const REAL = loadFromLegacySaplich().scheduling;
const INPUT = { ...REAL, strategy: STRATEGY_C };

const SOLVE_OPTS = Object.freeze({
  count: 3,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  // The AI's whole budget. AirLLM is slow by design — it streams
  // layers from disk — so the plan call is allowed minutes, while
  // the solver keeps its normal budget.
  timeoutMs: 600_000,
});

test('29 the AirLLM service is reachable and reports MODEL_READY', OPTS, async () => {
  const planner = createAIPlannerFromConfig(config.ai);
  assert.ok(planner instanceof AirLLMPlanner, 'AI_PROVIDER must be airllm for this suite');

  // `plan` is the only contract; probe it first so a failure here
  // reads as "the service is not ready" rather than as a bad answer.
  const probe = await probeAirLLMService({ serviceUrl: config.ai.serviceUrl, timeoutMs: 10_000 });
  assert.equal(probe.reachable, true, `service unreachable: ${probe.error}`);
  assert.equal(probe.health?.provider, 'airllm');
  assert.equal(probe.state, 'MODEL_READY', `service is ${probe.state}: ${JSON.stringify(probe.ready)}`);
  assert.equal(probe.health?.modelLoaded, true);
});

test('30 POST /plan returns a valid StrategyDecision', OPTS, async () => {
  const planner = createAIPlannerFromConfig(config.ai);
  const r = await planStrategy(INPUT, { planner, ...SOLVE_OPTS });

  // Either the model produced something acceptable, or it fell back
  // with an honest reason. Both are correct outcomes (brief §56);
  // what must never happen is an invalid decision reaching the solver.
  assert.equal(r.audit.validation.status === 'ACCEPTED'
    || r.audit.validation.status === 'CLAMPED'
    || r.audit.fallbackUsed, true);
  if (r.fallbackUsed) {
    assert.ok(r.audit.failure, 'a fallback must record why');
    return;
  }
  assert.ok(['BASE_FEASIBLE', 'ASSIGNMENT_BALANCED', 'PREFERENCE_FIRST', 'GLOBAL_ASSIGNMENT_BALANCED']
    .includes(r.decision.optimizationMode));
  assert.ok([1, 3, 5, 10].includes(r.decision.candidateCount));
  assert.equal(r.decision.scoringWeights.TRAVEL, 0, 'H14 stays unsupported');
  assert.equal(r.decision.scoringWeights.TRANSFER, 0, 'H13 stays inactive');
  assert.equal(r.rawOutput.__airllm.model !== null, true, 'the decision must name the model that made it');
});

test('31 the real SchedulingInput reaches the solver through the AI', OPTS, async () => {
  const planner = createAIPlannerFromConfig(config.ai);
  const r = await planStrategy(INPUT, { planner, ...SOLVE_OPTS });

  // The influence check of brief §33: the decision is visible in the
  // input the solver actually receives, not merely in a rationale.
  assert.equal(r.input.strategy.optimizationMode, r.decision.optimizationMode);
  assert.deepEqual(r.applied.scoringConfig.weights, { ...r.decision.scoringWeights });
  assert.notEqual(r.input, INPUT, 'the input must be a copy');
  assert.equal(INPUT.strategy.optimizationMode, STRATEGY_C.optimizationMode, 'the original is untouched');
});

test('32 the final candidate is hard-feasible (brief §46)', OPTS, async () => {
  const planner = createAIPlannerFromConfig(config.ai);
  const r = await planStrategy(INPUT, { planner, ...SOLVE_OPTS });

  const out = generateSolutions(r.input, SOLVE_OPTS);
  assert.ok(out.solutions.length >= 1, 'the pipeline must produce at least one schedule');

  for (const s of out.solutions) {
    const evaluation = evaluateCandidate(s.candidate, r.input);
    assert.equal(evaluation.hardViolations.length, 0, 'hard violations must be 0 regardless of the AI');
  }

  const final = selectFinalSolutions(out.solutions, { count: 3 });
  assert.ok(final.length >= 1, 'global scoring must surface at least one solution');
});

test('60 with the AI service DOWN the pipeline still produces a feasible schedule', OPTS, async () => {
  // Point the provider at a closed port. This is the most important
  // test in the file: it is the guarantee that AirLLM is optional.
  const offline = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:1', // nothing listens here
    requestTimeoutMs: 2_000,
  });
  const r = await planStrategy(INPUT, { planner: offline, timeoutMs: 10_000 });

  assert.equal(r.fallbackUsed, true, 'an unreachable service must fall back');
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');

  const out = generateSolutions(r.input, SOLVE_OPTS);
  assert.ok(out.solutions.length >= 1, 'the solver still runs');
  for (const s of out.solutions) {
    const evaluation = evaluateCandidate(s.candidate, r.input);
    assert.equal(evaluation.hardViolations.length, 0, 'the fallback schedule is still hard-feasible');
  }
});
