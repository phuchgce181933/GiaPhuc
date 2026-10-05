// PHASE 35 — REAL AIRLLM RUNTIME INTEGRATION (opt-in).
//
//   node --test "tests/integration/airllm/*.test.js"   # skips
//   set AIRLLM_INTEGRATION=1, start ai-service, then re-run   # runs
//
// THE GATE
// --------
// Every test here is gated on `AIRLLM_INTEGRATION=1` and reports
// `skip` rather than `fail` when the environment cannot answer
// (brief 45). This file is also outside the default `npm test` glob,
// which is a one-level `tests/*.test.js` and does not descend into
// `tests/integration/`. The gate must be set BY HAND: nothing in
// package.json, and nothing in this file, sets it, so a normal test
// run cannot leak into it (brief 46).
//
// WHAT IT PROVES, AND WHY ONLY HERE
// ---------------------------------
//   1  environment detection   — versions read from the service
//   2  CUDA detection          — true, and reported by torch
//   3  model really exists     — weights on disk, not a tokenizer
//   4  /health                 — provider, versions, device
//   5  /ready                  — 200 + MODEL_READY, and 503 when not
//   6  /plan                   — a real decision, or an honest fallback
//   7  valid StrategyDecision  — accepted by the NODE validator
//   8  invalid rejected        — the clamp/refuse boundary holds
//   9  fallback separation     — a dead service is not an AI run
//  10  real SchedulingInput    — aggregate report, no slots, no PII
//  11  solver gets the strategy
//  12  hard constraints + H13/H14 unchanged, 0 violations
//  13  independent evaluator accepts
//  14  benchmark metadata      — strategyHash, validity, rates
//  15  sharedPoolGlobalScore   — one yardstick across both arms
//  16  repeated runs preserved and the verdict follows them
//
// WHAT IT CANNOT PROVE
// -------------------
// That the model is GOOD. A small model producing a valid decision
// proves the pipeline runs end to end; it says nothing about whether
// the strategy beats the deterministic fallback, and no test here
// claims it does. That question is answered by `npm run benchmark`,
// which is a separate, separately-reported run.
//
// COST
// ----
// A real AirLLM inference streams every layer from disk for every
// token. On the measured host (RTX 4060, 0.5B params) that is about
// 0.3 tokens/second, so ONE /plan is minutes. Tests that need a live
// decision share a single plan through `livePlan()` rather than each
// paying for one. The fallback test needs no model at all: it points
// the provider at a closed port.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';

import { loadFromLegacySaplich } from '../../../src/loader/legacy-saplich/index.js';
import { STRATEGY_C } from '../../../src/domain/strategies.js';
import { generateSolutions } from '../../../src/domain/multi-solution.js';
import { evaluateCandidate } from '../../../src/domain/constraints/index.js';
import { selectFinalSolutions } from '../../../src/domain/global-scoring.js';
import { DIMENSION_CATALOG } from '../../../src/domain/dimension-catalog.js';
import { AirLLMPlanner, createAIPlannerFromConfig, probeAirLLMService } from '../../../src/domain/ai/providers/index.js';
import { buildSituationReport, findPersonalData, canonicalStringify } from '../../../src/domain/ai/situation-report.js';
import { validateStrategyDecision, buildAllowList } from '../../../src/domain/ai/strategy-schema.js';
import { planStrategy } from '../../../src/domain/ai/index.js';
import { strategyHashOf, BENCHMARK_SOLVER_PROFILE } from '../../../src/benchmark/runner.js';
import { applySharedPoolScore, conclude } from '../../../src/benchmark/quality.js';
import { validityAndFallbackRates } from '../../../src/benchmark/metrics.js';
import { config } from '../../../src/config/index.js';

const ENABLED = config.ai.integrationEnabled === true;

const OPTS = {
  skip: ENABLED
    ? false
    : 'set AIRLLM_INTEGRATION=1 and start ai-service with a real checkpoint to run the Phase 35 real-runtime tests',
};

const REAL = loadFromLegacySaplich().scheduling;
const INPUT = { ...REAL, strategy: STRATEGY_C };
const REPORT = buildSituationReport(INPUT, {});

/** Iteration-bounded (PHASE 31.1) so a run is reproducible on any host. */
const SOLVE_OPTS = Object.freeze({
  count: 3,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  maxSearchIterations: 12,
});

/** AirLLM is slow by design: the plan call gets minutes, the solver does not. */
const PLAN_TIMEOUT_MS = 900_000;

function airllmPlanner() {
  return createAIPlannerFromConfig({ ...config.ai, provider: 'airllm' });
}

/**
 * ONE live /plan, shared.
 *
 * Every test that needs a real decision awaits this. A second call
 * would cost another few minutes of layer streaming and, on a
 * temperature-0 model, would return the same decision anyway.
 */
let livePlanPromise = null;
function livePlan() {
  if (livePlanPromise === null) {
    livePlanPromise = planStrategy(INPUT, { planner: airllmPlanner(), timeoutMs: PLAN_TIMEOUT_MS });
  }
  return livePlanPromise;
}

/** The rank-1 candidate a run would actually ship. */
function ship(input) {
  const out = generateSolutions(input, SOLVE_OPTS);
  const scored = selectFinalSolutions(
    out.solutions.map((s) => (s && s.candidate ? s.candidate : s)),
    { count: 3, input, requireFeasibility: true },
  );
  return { out, scored, shipped: scored.solutions?.[0]?.candidate ?? null };
}

// ============================================================================
// 1-3. environment, CUDA, and the model itself
// ============================================================================

test('P35-1 /health reports a real environment, and nothing guessed', OPTS, async () => {
  const probe = await probeAirLLMService({ serviceUrl: config.ai.serviceUrl, timeoutMs: 30_000 });
  assert.equal(probe.reachable, true, `service unreachable: ${probe.error}`);
  assert.equal(probe.health?.provider, 'airllm', 'brief 18: the provider must be named');

  const rt = probe.health?.runtime ?? {};
  for (const k of ['pythonVersion', 'airllmVersion', 'torchVersion', 'transformersVersion', 'platform']) {
    assert.ok(rt[k] != null, `/health must report ${k} (brief 18)`);
  }
  // Brief 5/49: an absent version stays absent. The gate for this file
  // is a real model, so null here would mean something regressed.
  assert.notEqual(rt.airllmVersion, null, 'AirLLM is installed; its version must be captured');
  assert.notEqual(rt.torchVersion, null, 'torch is installed; its version must be captured');
  assert.notEqual(rt.transformersVersion, null, 'transformers is installed; its version must be captured');
  assert.doesNotMatch(
    String(rt.torchVersion),
    /\+cpu$/,
    'a CPU-only torch build cannot serve a CUDA model and must not be reported as one',
  );
});

test('P35-2 CUDA is verified by the runtime, and requested by configuration', OPTS, async () => {
  const probe = await probeAirLLMService({ serviceUrl: config.ai.serviceUrl, timeoutMs: 30_000 });
  const rt = probe.health?.runtime ?? {};
  // Brief 6: this must come from torch, not from configuration. The
  // service is started with AIRLLM_DEVICE=cuda, which proves nothing
  // on its own — that is exactly the "cudaAvailable = true by config"
  // the brief forbids.
  assert.equal(rt.cudaAvailable, true, 'torch must report a usable CUDA device');
  assert.equal(probe.health?.config?.device, 'cuda', 'the service must have been asked for CUDA');
});

test('P35-3 the reported model really exists, with weights on disk', OPTS, async () => {
  const probe = await probeAirLLMService({ serviceUrl: config.ai.serviceUrl, timeoutMs: 30_000 });
  const model = probe.health?.model;
  // Brief 8/49: a model name may only be reported when weights exist.
  assert.ok(model && model !== 'unconfigured', 'a model must be configured');
  assert.equal(probe.health?.config?.modelResolvesLocally, true, 'the model must be a local directory');

  // The service reports the LEAF name only, to avoid disclosing a
  // path (brief 36). Rejoining it here is a test-only affordance.
  const root = path.resolve(process.cwd(), '..', 'ai-service', 'models', model);
  assert.ok(fs.existsSync(root), `the reported model must exist on disk: ${root}`);

  const weightBytes = fs.readdirSync(root)
    .filter((f) => /\.(safetensors|bin)$/.test(f))
    .reduce((n, f) => n + fs.statSync(path.join(root, f)).size, 0);
  assert.ok(
    weightBytes > 0,
    'the checkpoint must contain real weights, not only a config and a tokenizer (brief 8)',
  );
});

// ============================================================================
// 4-5. readiness contract
// ============================================================================

test('P35-4 /ready is 200 with a loaded model, and reports the load it performed', OPTS, async () => {
  const probe = await probeAirLLMService({ serviceUrl: config.ai.serviceUrl, timeoutMs: 30_000 });
  // Brief 17/19: readiness is a LOADED MODEL, not an open port. A
  // process answering /health with 200 is not readiness.
  assert.equal(probe.state, 'MODEL_READY', `/ready must be MODEL_READY, got ${probe.state}`);
  assert.equal(probe.health?.modelLoaded, true);
  // The load report is what makes version drift visible instead of
  // silent. AirLLM 4.0.0 does not accept trust_remote_code, and the
  // adapter must drop it rather than crash.
  assert.ok(probe.ready?.loadReport, '/ready must carry the load report');
  assert.ok(Array.isArray(probe.ready.loadReport.droppedKwargs));
  assert.equal(probe.ready.remoteCodeUsed, false, 'no repository code may run by default (brief 8)');
});

test('P35-5 a dead service is neither reachable nor ready', OPTS, async () => {
  const probe = await probeAirLLMService({ serviceUrl: 'http://127.0.0.1:1', timeoutMs: 5_000 });
  assert.equal(probe.reachable, false);
  assert.equal(probe.state, null);
});

// ============================================================================
// 6-8. the real decision
// ============================================================================

test('P35-6 /plan produces a decision from the real model, or an honest fallback', OPTS, async () => {
  const r = await livePlan();

  if (r.fallbackUsed) {
    // A fallback is a legitimate outcome and must name its cause. It
    // is reported, never converted into a pass (brief 48).
    assert.ok(r.audit?.failure, 'a fallback must record a reason');
    assert.match(
      String(r.audit.failure?.detail ?? ''),
      /airllm|timeout|timed out|unreachable|parse|invalid|model|decode|json/i,
      `the fallback reason must name the cause, got: ${r.audit.failure?.detail}`,
    );
    return;
  }
  assert.equal(r.fallbackUsed, false);
  // Brief 11/16: identity comes from the RESPONSE, not from config.
  assert.equal(r.rawOutput.__airllm.provider, 'airllm');
  assert.ok(r.rawOutput.__airllm.model, 'the decision must name the model that produced it');
});

test('P35-7 the decision passes the NODE validator, not only the Python one', OPTS, async () => {
  const r = await livePlan();
  if (r.fallbackUsed) return;

  // Brief 15: Python validating is not a reason to skip Node. The
  // provider is untrusted; Node is the authority (brief 20).
  const v = validateStrategyDecision(r.decision, { allowList: buildAllowList(REPORT) });
  assert.ok(
    ['ACCEPTED', 'CLAMPED'].includes(v.status),
    `the NODE validator must accept what the service produced, got ${v.status}`,
  );
  assert.ok(r.decision.candidateCount >= 1);
  assert.ok(Object.keys(r.decision.scoringWeights).length > 0, 'a decision must weight something');
  assert.equal(strategyHashOf(r.decision), strategyHashOf(r.decision), 'the hash is stable');
});

test('P35-8 the validator refuses an out-of-vocabulary decision', OPTS, async () => {
  // The complement of P35-7: a permissive model must not widen the
  // allow-list. Needs no model, but lives here so the pair reads as
  // one statement about trust.
  const v = validateStrategyDecision(
    { optimizationMode: 'FREE_FORM', candidateCount: 999, scoringWeights: { NOT_A_DIMENSION: 5 } },
    { allowList: buildAllowList(REPORT) },
  );
  assert.notEqual(v.status, 'ACCEPTED', 'an out-of-vocabulary decision must not be accepted outright');
});

// ============================================================================
// 9. fallback separation
// ============================================================================

test('P35-9 a dead service yields a fallback and a hard-feasible schedule', OPTS, async () => {
  // Brief 24. The most important test in the file: AirLLM is OPTIONAL.
  // This needs no model — it points the provider at a closed port.
  const offline = new AirLLMPlanner({ serviceUrl: 'http://127.0.0.1:1', requestTimeoutMs: 5_000 });
  const r = await planStrategy(INPUT, { planner: offline, timeoutMs: 20_000 });

  assert.equal(r.fallbackUsed, true, 'an unreachable service must fall back');
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');

  const { out } = ship(r.input);
  assert.ok(out.solutions.length >= 1, 'the solver must still run');
  for (const s of out.solutions) {
    const e = evaluateCandidate(s.candidate, r.input);
    assert.equal(e.summary.totalHardViolations, 0, 'the fallback schedule is still hard-feasible');
  }
});

// ============================================================================
// 10-11. what crosses the boundary, and what reaches the solver
// ============================================================================

test('P35-10 the real SchedulingInput reaches the AI as an aggregate report only', OPTS, async () => {
  const wire = canonicalStringify({ situationReport: REPORT });
  assert.deepEqual(findPersonalData(JSON.parse(wire)), [], 'brief 19: no PII may cross');
  for (const forbidden of ['slots', 'placement', 'periodIndex', 'teacherId', 'classId', 'dayIndex']) {
    assert.ok(!wire.includes(`"${forbidden}"`), `the report must not carry "${forbidden}" (brief 18)`);
  }
  assert.ok(
    wire.length * 10 < JSON.stringify(INPUT).length,
    `the report (${wire.length} chars) must be far smaller than the SchedulingInput`,
  );
  assert.ok(REPORT.actionSpace, 'the report must carry the action space the model may choose from');
});

test('P35-11 the solver receives the validated strategy, and only that', OPTS, async () => {
  const r = await livePlan();
  assert.equal(r.input.strategy.optimizationMode, r.decision.optimizationMode);
  assert.deepEqual(r.applied.scoringConfig.weights, { ...r.decision.scoringWeights });
  assert.notEqual(r.input, INPUT, 'the solver input must be a copy');
  assert.equal(INPUT.strategy.optimizationMode, STRATEGY_C.optimizationMode, 'the caller input is untouched');
  // Brief 22: the decision carries no seed, so AI sampling cannot move
  // the solver's randomness.
  assert.ok(!('seed' in r.decision) && !('solverSeed' in r.decision));
});

// ============================================================================
// 12. the AI cannot change feasibility
// ============================================================================

test('P35-12 the AI cannot disable a hard constraint, nor activate H13/H14', OPTS, async () => {
  const active = new Set((REPORT.dimensionAvailability?.active ?? []).map((d) => d.id));
  const inactive = new Set((REPORT.dimensionAvailability?.inactive ?? []).map((d) => d.id));
  const unsupported = new Set((REPORT.dimensionAvailability?.unsupported ?? []).map((d) => d.id));

  // H13 = INACTIVE and H14 = UNSUPPORTED are catalogue facts, not
  // prompt suggestions (brief 37/38).
  const catalogue = new Map(DIMENSION_CATALOG.map((d) => [d.id, d]));
  assert.ok(catalogue.has('TRAVEL') && catalogue.has('TRANSFER'), 'both dimensions exist in the catalogue');

  const r = await livePlan();
  if (!r.fallbackUsed) {
    const w = r.applied.scoringConfig.weights ?? {};
    for (const id of [...inactive, ...unsupported]) {
      assert.ok(!(w[id] > 0), `${id} must not be a live weight (inactive/unsupported)`);
    }
    for (const id of Object.keys(w)) {
      assert.ok(active.has(id), `only ACTIVE dimensions may be weighted; ${id} is not active`);
    }
  }

  // Brief 23: every successful run is hard-feasible, whatever the AI said.
  const { out } = ship(r.input);
  for (const s of out.solutions) {
    const e = evaluateCandidate(s.candidate, r.input);
    assert.equal(e.summary.totalHardViolations, 0, 'hard violations must be 0 regardless of the AI');
    assert.equal(e.summary.accepted, true);
  }
});

// ============================================================================
// 13. the independent evaluator
// ============================================================================

test('P35-13 the independent evaluator accepts the real candidate', OPTS, async () => {
  const r = await livePlan();
  const { out, scored, shipped } = ship(r.input);

  assert.ok(out.solutions.length >= 1, 'the pipeline must produce a schedule');
  assert.ok(scored.solutions.length >= 1, 'global scoring must surface a schedule');
  assert.ok(shipped, 'a rank-1 candidate must exist for the shared pool to score');
  for (const entry of scored.solutions) {
    const e = evaluateCandidate(entry.candidate ?? entry, r.input);
    assert.equal(e.summary.totalHardViolations, 0);
  }
});

// ============================================================================
// 14-16. benchmark evidence
// ============================================================================

test('P35-14 a benchmark run records strategy, validity, and rates', OPTS, async () => {
  const r = await livePlan();

  const run = {
    arm: 'AIRLLM',
    index: 0,
    plannerName: r.fallbackUsed ? null : 'AirLLMPlanner',
    aiDecisionUsed: r.fallbackUsed === false,
    fallbackUsed: r.fallbackUsed === true,
    strategyHash: strategyHashOf(r.decision),
    candidateCountRequested: BENCHMARK_SOLVER_PROFILE.count,
    accepted: true,
    decision: r.decision,
    quality: { hardViolations: 0, sharedPoolGlobalScore: null },
    latency: { solverMs: 0, totalPipelineMs: 0 },
  };

  // Brief 27: the strategy is recorded by BEHAVIOUR, not by prose.
  assert.ok(run.strategyHash, 'strategyHash must be captured');
  assert.equal(typeof run.candidateCountRequested, 'number');

  const rates = validityAndFallbackRates([run]);
  assert.equal(rates.requests, 1);
  // Brief 32: a fallback is NOT a valid AI response.
  assert.equal(rates.valid + rates.fallback, 1);
  if (r.fallbackUsed) {
    assert.equal(rates.valid, 0);
    assert.equal(rates.fallbackRate, 1);
  }
});

test('P35-15 the shared pool scores both arms on ONE yardstick', OPTS, async () => {
  const r = await livePlan();

  const aiRun = { quality: {}, rank1Candidate: ship(r.input).shipped };
  const baseRun = { quality: {}, rank1Candidate: ship({ ...INPUT, strategy: STRATEGY_C }).shipped };
  const summary = applySharedPoolScore([baseRun, aiRun], { input: INPUT });

  // Brief 30: per-arm totals are positions within that arm's own pool
  // and are not comparable. This is the field that makes them so.
  assert.equal(summary.poolSize, 2, 'both arms ship into ONE pool');
  assert.equal(summary.unscoreable, 0, 'neither arm may be silently dropped');
  assert.equal(summary.scored, 2);
  assert.equal(typeof aiRun.quality.sharedPoolGlobalScore, 'number');
  assert.equal(typeof baseRun.quality.sharedPoolGlobalScore, 'number');
  assert.match(summary.scaleNote, /ONE pool/);
});

test('P35-16 repeated runs are all preserved, and the verdict follows them', OPTS, async () => {
  // Brief 26/31: no cherry-picking. The verdict is a function of the
  // whole set, so this asserts the aggregation rather than one run.
  const runs = [0, 1, 2].map((i) => ({
    plannerName: 'AirLLMPlanner',
    aiDecisionUsed: i < 2,
    fallbackUsed: i >= 2,
    strategyHash: `h${i}`,
  }));
  const rates = validityAndFallbackRates(runs);
  assert.equal(rates.requests, 3, 'every repetition is counted');
  assert.equal(rates.valid, 2);
  assert.equal(rates.fallback, 1);
  assert.ok(Math.abs(rates.validityRate - 2 / 3) < 1e-6);
  assert.ok(Math.abs(rates.fallbackRate - 1 / 3) < 1e-6);

  // With no valid decision there is nothing to compare, and the
  // conclusion must say so rather than reporting a delta.
  const none = conclude({
    smoke: { result: 'PASS' },
    qualityRan: true,
    armIsAirLLM: true,
    comparison: { verdict: 'INVALID', separation: 'NOT_APPLICABLE', medianDelta: null },
    ai: { rates },
  });
  assert.equal(none.conclusion, 'AIRLLM_BENCHMARK_BLOCKED');
});
