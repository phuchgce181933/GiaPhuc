// PHASE 29 — AI STRATEGY LAYER
//
// SCOPE
// -----
// Phase 29 puts AI in exactly one seat: choosing a STRATEGY for the
// existing deterministic solver. It builds:
//
//   1. `buildSituationReport(input)` — a deterministic, aggregate-only
//      summary of the problem. This is the only thing an AI provider
//      ever sees. No teacher names, no emails, no phone numbers, no
//      teacher ids, no schedule slots.
//
//   2. `AIPlanner` — the provider seam, `plan(report) -> raw decision`.
//      Untrusted input. `DeterministicMockAIPlanner` is the Phase 29
//      implementation; AirLLM is Phase 30 and is not installed.
//
//   3. `validateStrategyDecision(output, context)` — the boundary.
//      Mode enum, candidate-count vocabulary, per-dimension weight
//      bounds, inactive-dimension protection, unknown-field rejection.
//      Reject => deterministic fallback. Clamp => recorded, never
//      silent.
//
//   4. `planStrategy(input, options)` — the orchestrator: report ->
//      provider -> validate -> fallback -> applied strategy on a COPY
//      of the input. Timeout-guarded, never throws on provider
//      failure, never mutates the input.
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT
// ----------------------------------------
//   AI NEVER DIRECTLY CREATES SCHEDULE SLOTS, and AI NEVER OVERRIDES
//   A HARD CONSTRAINT. The AI proposes; the validator disposes; the
//   deterministic solver places; the independent evaluator judges.
//   Nothing in this file asserts that AI improves timetable quality —
//   that measurement is Phase 30 (brief §41).
//
// The brief lists 30 required checks. They are all here, numbered in
// the same order, plus additional guards (31+) covering import
// hygiene, allow-list immutability, the confidence gate, audit
// privacy, and Phase 28 regression.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import {
  STRATEGY_C,
  OPTIMIZATION_MODES,
  ALLOWED_CANDIDATE_COUNTS,
} from '../src/domain/strategies.js';
import { solve } from '../src/domain/solver.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { generateSolutions } from '../src/domain/multi-solution.js';
import { selectFinalSolutions, GLOBAL_SCORING_DEFAULTS } from '../src/domain/global-scoring.js';
import { DIMENSION_CATALOG } from '../src/domain/dimension-catalog.js';

import * as ai from '../src/domain/ai/index.js';
import {
  buildSituationReport,
  validateStrategyDecision,
  planStrategy,
  DeterministicMockAIPlanner,
  AIPlanner,
  AI_FAILURE,
  ALLOWED_DECISION_FIELDS,
  DEFAULT_AI_FALLBACK,
  VALIDATION_POLICY,
  canonicalStringify,
  findPersonalData,
  buildAllowList,
  fallbackDecision,
  createStaticPlanner,
  createUnavailablePlanner,
  createHangingPlanner,
  createParseErrorPlanner,
  createUnsupportedRequestPlanner,
  createInvalidOutputPlanner,
  recommendFromCandidates,
  summarizeCandidates,
} from '../src/domain/ai/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.resolve(HERE, '..');

// ============================================================================
// Fixtures
// ============================================================================

const REAL = loadFromLegacySaplich().scheduling;
const INPUT = { ...REAL, strategy: STRATEGY_C };

/**
 * A small, fast solver strategy for the end-to-end checks. The default
 * preset allows 5 s per solve; Phase 29 does not need a converged
 * optimum, only proof that an approved decision reaches the solver and
 * produces an accepted candidate.
 *
 * PHASE 31.1: the per-solve budget is now 30 s (was 1500 ms) and,
 * more importantly, the search is bounded by an ITERATION COUNT. A
 * 1500 ms budget against a ~750 ms solve is ~2x headroom, which is a
 * statement about the machine, not about the test: under the
 * parallel load of `node --test` the budget binds, the search
 * truncates, and the end-to-end checks below have no candidate to
 * assert on. Bounding iterations makes the result depend on the seed
 * instead of on how busy the host is.
 */
const FAST_STRATEGY = {
  ...STRATEGY_C,
  solver: {
    ...STRATEGY_C.solver,
    timeLimitMs: 30_000,
    maxSearchIterations: 12,
  },
};

/**
 * Generation options for the end-to-end checks.
 *
 * PHASE 31.1: `maxSearchIterations` is the seed-stable bound that
 * makes every assertion in this file independent of machine load. The
 * wall-clock budgets are retained as a safety valve that is no longer
 * what makes the results reproducible — if one of them ever does bind,
 * `assertReproducibleSearch` below fails loudly with a message saying
 * so, instead of the suite flaking.
 */
const GEN_OPTS = Object.freeze({
  count: 1,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  maxSearchIterations: 12,
});

/**
 * The premise every downstream assertion in this file rests on:
 * the search was not truncated by the wall clock. Stated once, so the
 * contract cannot drift between call sites.
 */
function assertReproducibleSearch(out, label) {
  assert.equal(out.diagnostics.searchLimited, false,
    `${label}: the search was truncated by the wall clock, so nothing this `
    + 'file asserts about the resulting candidate would be reproducible');
  assert.ok(!out.diagnostics.searchStoppedBy.includes('TIME_BUDGET'),
    `${label}: searchStoppedBy reported TIME_BUDGET `
    + `(${out.diagnostics.searchStoppedBy.join(', ')})`);
  assert.ok(out.solutions.length > 0,
    `${label}: produced no solutions, so the end-to-end check is vacuous`);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** A decision that must always be accepted as-is. */
function validDecision(overrides = {}) {
  return {
    optimizationMode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
    candidateCount: 5,
    scoringWeights: {
      WORKLOAD_BALANCE: 1.0,
      MAX_TEACHER_LOAD: 0.6,
      WORKLOAD_STDEV: 0.4,
      PREFERENCE: 0.2,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
    },
    rationale: 'Prioritize workload balance while retaining structural variety.',
    ...overrides,
  };
}

/**
 * One shared candidate pool, built on first use.
 *
 * `generateSolutions` runs a real solver, so regenerating a pool per
 * test would (a) make the suite slow and (b) add solver load that
 * competes with the other time-sensitive phases when `node --test`
 * runs files in parallel. Phase 29 never mutates a candidate
 * (asserted by test 24), so one pool is safe to share.
 */
let POOL = null;
function pool() {
  if (POOL) return POOL;
  // PHASE 31.1 — DETERMINISTIC_SEARCH. This pool used to rely on a
  // 30 s budget being large enough that the clock "cannot bind",
  // which is an argument about machine speed. It is now bounded by
  // an iteration count, so the 3 candidates below are the same on a
  // loaded CI box as on an idle laptop. The budget is unchanged; it
  // is simply no longer the thing that makes the pool reproducible.
  const gen = generateSolutions({ ...INPUT, strategy: FAST_STRATEGY }, {
    count: 3,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 30_000,
    overallTimeBudgetMs: 180_000,
    maxSearchIterations: 12,
  });
  assertReproducibleSearch(gen, 'the shared pool');
  assert.equal(gen.solutions.length, 3,
    'the shared pool must hold 3 candidates; a short pool is a truncated search, not a finding');
  POOL = { gen, candidates: gen.solutions.map((s) => s.candidate) };
  return POOL;
}

const REPORT = buildSituationReport(INPUT, { requestedCandidateCount: 5 });
const ALLOW = buildAllowList(INPUT);

// ============================================================================
// 1. SituationReport deterministic
// ============================================================================

test('01 SituationReport is deterministic for the same SchedulingInput', () => {
  const a = buildSituationReport(INPUT);
  const b = buildSituationReport(INPUT);
  assert.equal(canonicalStringify(a), canonicalStringify(b), 'two reports over the same input must be byte-identical');
  assert.equal(a.hash, b.hash);

  // A structurally identical but freshly-spread input must also agree:
  // ordering may not depend on object identity or Map insertion order.
  const reshuffled = {
    ...INPUT,
    teachers: [...INPUT.teachers],
    assignments: [...INPUT.assignments],
  };
  assert.equal(buildSituationReport(reshuffled).hash, a.hash);

  // The hash must depend on content, not be a constant.
  const fewer = buildSituationReport({ ...INPUT, teachers: INPUT.teachers.slice(0, 20) });
  assert.notEqual(fewer.hash, a.hash, 'a changed dataset must change the hash');
});

// ============================================================================
// 2. SituationReport contains correct aggregate counts
// ============================================================================

test('02 SituationReport carries correct aggregate counts', () => {
  assert.equal(REPORT.counts.teachers, INPUT.teachers.length);
  assert.equal(REPORT.counts.branches, INPUT.branches.length);
  assert.equal(REPORT.counts.classes, INPUT.classes.length);
  assert.equal(REPORT.counts.subjects, INPUT.subjects.length);
  assert.equal(REPORT.counts.assignments, INPUT.assignments.length);

  const expectedPeriods = INPUT.assignments.reduce((a, x) => a + x.requiredPeriods, 0);
  assert.equal(REPORT.counts.requiredPeriods, expectedPeriods);
  assert.equal(REPORT.counts.requiredPeriods, 802);

  // The workload distribution must be a real distribution, not a stub.
  assert.equal(REPORT.teacherWorkload.teacherCount, INPUT.teachers.length);
  const demand = REPORT.teacherWorkload.demand;
  assert.equal(demand.count, INPUT.teachers.length, "every teacher must have routed pre-set demand");
  assert.equal(demand.total, 802, "demand periods must sum to the curriculum total");
  assert.ok(demand.max >= demand.min);
  assert.equal(demand.spread, demand.max - demand.min);
  assert.ok(demand.relativeSpread > 0, "the real dataset is genuinely imbalanced");
  assert.ok(REPORT.signals.includes("WORKLOAD_IMBALANCE_HIGH"), "the imbalance must be reported as a fact");

  // Constraint activation must be reported per constraint.
  const hardIds = REPORT.constraintActivation.hard.map((c) => c.id);
  assert.ok(hardIds.includes('H01'));
  assert.ok(hardIds.includes('H14'));
  assert.equal(REPORT.constraintActivation.summary.hardUnsupported, 1, 'H14 is the one UNSUPPORTED hard constraint');
  assert.equal(REPORT.constraintActivation.aiMayDisable, false);
  assert.equal(REPORT.travelReadiness.supported, false);
  assert.equal(REPORT.transferReadiness.active, false);

  // Every emitted array must be sorted, so ordering is content-derived.
  const branchIds = REPORT.branchWorkload.entries.map((e) => e.branchId);
  assert.deepEqual(branchIds, [...branchIds].sort());
});

// ============================================================================
// 3. no personal contact data leaked into SituationReport
// ============================================================================

test('03 SituationReport leaks no personal or contact data', () => {
  const serialized = canonicalStringify(REPORT);
  assert.deepEqual(findPersonalData(REPORT, INPUT), [], 'findPersonalData must report nothing');

  for (const t of INPUT.teachers) {
    if (typeof t.hoTen === 'string' && t.hoTen.length >= 3) {
      assert.ok(!serialized.includes(t.hoTen), `teacher name leaked into the report: ${t.hoTen}`);
    }
    if (typeof t.email === 'string' && t.email.length >= 3) {
      assert.ok(!serialized.includes(t.email), `teacher email leaked into the report: ${t.email}`);
    }
    if (typeof t.soDienThoai === 'string' && t.soDienThoai.length >= 3) {
      assert.ok(!serialized.includes(t.soDienThoai), `teacher phone leaked into the report: ${t.soDienThoai}`);
    }
    // Not even pseudonymous per-teacher identifiers: the report is
    // aggregate-only, so there is nothing for a provider to correlate.
    assert.ok(!serialized.includes(t.id), `teacher id leaked into the report: ${t.id}`);
  }

  // Nor any schedule placement or per-teacher record.
  for (const forbidden of ['placements', 'assignments', 'teachers', 'classes']) {
    assert.equal(forbidden in REPORT, false, `the report must not carry ${forbidden}`);
  }
});

// ============================================================================
// 4. AI provider interface exists
// ============================================================================

test('04 AIPlanner provider interface exists and the mock satisfies it', () => {
  assert.equal(typeof AIPlanner, 'function');
  assert.equal(typeof AIPlanner.prototype.plan, 'function');
  assert.equal(DeterministicMockAIPlanner.prototype instanceof AIPlanner, true);

  const mock = new DeterministicMockAIPlanner();
  assert.equal(ai.assertPlannerShape(mock).ok, true);
  assert.equal(typeof mock.name, 'string');
  assert.ok(mock.name.length > 0, 'a provider must identify itself for the audit log');

  // A bare object without plan() is not a provider.
  assert.equal(ai.assertPlannerShape({}).ok, false);
  assert.equal(ai.assertPlannerShape(null).ok, false);
  assert.equal(ai.assertPlannerShape({ plan: 'nope' }).ok, false);
});

// ============================================================================
// 5. mock provider works
// ============================================================================

test('05 DeterministicMockAIPlanner produces a valid decision from a report', async () => {
  const mock = new DeterministicMockAIPlanner();
  const raw = await mock.plan(REPORT);
  assert.equal(typeof raw, 'object');
  assert.ok(ALLOW.modes.includes(raw.optimizationMode));
  assert.ok(ALLOW.counts.includes(raw.candidateCount));
  assert.equal(typeof raw.rationale, 'string');
  assert.ok(raw.rationale.length > 0);

  // The mock honours the caller's legal candidate request.
  assert.equal(raw.candidateCount, 5);

  // And it only ever names ACTIVE dimensions.
  for (const id of Object.keys(raw.scoringWeights)) {
    assert.ok(ALLOW.allowedDimensions.includes(id), `mock emitted inactive dimension ${id}`);
  }

  const v = validateStrategyDecision(raw, { input: INPUT });
  assert.equal(v.ok, true, `mock output must validate: ${v.reason}`);
  assert.equal(v.status, 'ACCEPTED');
});

// ============================================================================
// 6. valid StrategyDecision accepted
// ============================================================================

test('06 a valid StrategyDecision is accepted unchanged', () => {
  const v = validateStrategyDecision(validDecision(), { input: INPUT });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'ACCEPTED');
  assert.equal(v.failure, null);
  assert.deepEqual(v.events, []);
  assert.equal(v.decision.optimizationMode, OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED);
  assert.equal(v.decision.candidateCount, 5);
  assert.equal(v.decision.scoringWeights.WORKLOAD_BALANCE, 1.0);
  assert.equal(v.decision.scoringWeights.PREFERENCE, 0.2);
  assert.equal(v.decision.rationale, 'Prioritize workload balance while retaining structural variety.');
});

// ============================================================================
// 7. invalid optimization mode rejected
// ============================================================================

test('07 an optimizationMode outside the enum is rejected', () => {
  for (const mode of ['SUPER_GLOBAL_MODE', 'FREE_FORM', 'global_assignment_balanced', '', 42, null, undefined]) {
    const v = validateStrategyDecision(validDecision({ optimizationMode: mode }), { input: INPUT });
    assert.equal(v.ok, false, `mode ${String(mode)} must be rejected`);
    assert.equal(v.status, 'REJECTED');
    assert.equal(v.decision, null);
    if (mode !== null && mode !== undefined) {
      assert.equal(v.failure.code, 'UNKNOWN_MODE');
    }
  }

  // Every mode in the enum is accepted.
  for (const mode of ALLOW.modes) {
    const v = validateStrategyDecision(validDecision({ optimizationMode: mode }), { input: INPUT });
    assert.equal(v.ok, true, `enum mode ${mode} must be accepted`);
  }
});

// ============================================================================
// 8. invalid candidate count rejected
// ============================================================================

test('08 a candidateCount outside the generation vocabulary is rejected', () => {
  assert.deepEqual([...ALLOW.counts], [1, 3, 5, 10], 'the vocabulary comes from the shared strategy config');

  for (const count of [0, 2, 27, 999, -1, 1.5, 'many', null, NaN, Infinity]) {
    const v = validateStrategyDecision(validDecision({ candidateCount: count }), { input: INPUT });
    assert.equal(v.ok, false, `candidateCount ${String(count)} must be rejected`);
    assert.equal(v.failure?.code, 'INVALID_CANDIDATE_COUNT', `candidateCount ${String(count)}`);
  }

  // A numeric string is coerced, not guessed at: "5" is unambiguous.
  assert.equal(validateStrategyDecision(validDecision({ candidateCount: '5' }), { input: INPUT }).ok, true);

  for (const count of ALLOWED_CANDIDATE_COUNTS) {
    assert.equal(validateStrategyDecision(validDecision({ candidateCount: count }), { input: INPUT }).ok, true);
  }
});

// ============================================================================
// 9. invalid weight rejected
// ============================================================================

test('09 an unknown (AI-invented) scoring dimension is rejected outright', () => {
  for (const dim of ['MY_CUSTOM_DIMENSION', 'TEACHER_HAPPINESS', 'X', '']) {
    const v = validateStrategyDecision(
      validDecision({ scoringWeights: { WORKLOAD_BALANCE: 1, [dim]: 0.5 } }),
      { input: INPUT },
    );
    assert.equal(v.ok, false, `dimension ${dim} must be rejected`);
    assert.equal(v.failure.code, 'UNKNOWN_DIMENSION');
  }

  // A weights object of the wrong shape is rejected, not coerced.
  for (const weights of [null, undefined, 'heavy', 42, [1, 2, 3]]) {
    const v = validateStrategyDecision(validDecision({ scoringWeights: weights }), { input: INPUT });
    assert.equal(v.ok, false);
  }
});

// ============================================================================
// 10-12. NaN / Infinity / negative weights rejected
// ============================================================================

test('10 a NaN weight is rejected', () => {
  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { WORKLOAD_BALANCE: Number.NaN } }),
    { input: INPUT },
  );
  assert.equal(v.ok, false);
  assert.equal(v.failure.code, 'NON_FINITE_WEIGHT');
  assert.equal(v.decision, null);
});

test('11 an Infinity weight is rejected', () => {
  for (const w of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const v = validateStrategyDecision(
      validDecision({ scoringWeights: { MAX_TEACHER_LOAD: w } }),
      { input: INPUT },
    );
    assert.equal(v.ok, false, `${w} must be rejected`);
    assert.equal(v.failure.code, 'NON_FINITE_WEIGHT');
  }
});

test('12 a negative weight is rejected, not clamped', () => {
  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { WORKLOAD_STDEV: -1 } }),
    { input: INPUT },
  );
  assert.equal(v.ok, false);
  assert.equal(v.failure.code, 'NEGATIVE_WEIGHT');
  assert.equal(VALIDATION_POLICY.negativeWeight, 'REJECT');

  // Non-number weights (strings, booleans, null) are rejected too:
  // coercing "0.5" or true into a number would be guessing.
  for (const w of ['0.5', true, false, null, {}]) {
    const r = validateStrategyDecision(
      validDecision({ scoringWeights: { WORKLOAD_STDEV: w } }),
      { input: INPUT },
    );
    assert.equal(r.ok, false, `weight ${JSON.stringify(w)} must be rejected`);
    assert.equal(r.failure.code, 'NON_FINITE_WEIGHT');
  }
});

// ============================================================================
// 13. out-of-range weight clamped by policy
// ============================================================================

test('13 an out-of-range weight is clamped to its bound and the clamp is recorded', () => {
  assert.equal(VALIDATION_POLICY.outOfRangeWeight, 'CLAMP');

  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { WORKLOAD_BALANCE: 1e100, SLOT_DIVERSITY: 99 } }),
    { input: INPUT },
  );
  assert.equal(v.ok, true, 'an overshoot is honored, not rejected');
  assert.equal(v.status, 'CLAMPED');

  assert.equal(v.decision.scoringWeights.WORKLOAD_BALANCE, ALLOW.weightBounds.WORKLOAD_BALANCE.max);
  assert.equal(v.decision.scoringWeights.SLOT_DIVERSITY, ALLOW.weightBounds.SLOT_DIVERSITY.max);

  // The correction is visible, not silent (brief §6).
  const clamped = v.events.filter((e) => e.code === 'AI_OUTPUT_CLAMPED');
  assert.equal(clamped.length, 2);
  for (const e of clamped) {
    assert.ok(e.from > e.to);
    assert.ok(e.detail.length > 0);
  }

  // Every dimension must expose a finite, ordered bound pair.
  for (const [id, b] of Object.entries(ALLOW.weightBounds)) {
    assert.ok(Number.isFinite(b.min) && Number.isFinite(b.max), `${id} needs finite bounds`);
    assert.ok(b.min >= 0 && b.max >= b.min, `${id} needs min >= 0 and max >= min`);
  }
});

// ============================================================================
// 14-16. inactive dimensions cannot be activated
// ============================================================================

test('14 an inactive TRAVEL weight is clamped to 0 and cannot be activated', () => {
  assert.equal(ALLOW.allowedDimensions.includes('TRAVEL'), false, 'H14 is UNSUPPORTED, so TRAVEL is not offered');
  assert.ok(ALLOW.blockedDimensions.includes('TRAVEL'));
  assert.equal(REPORT.travelReadiness.supported, false);

  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { WORKLOAD_BALANCE: 1, TRAVEL: 50 } }),
    { input: INPUT },
  );
  assert.equal(v.ok, true, 'clamped, not rejected — the intent is honored, the value is not');
  assert.equal(v.status, 'CLAMPED');
  assert.equal(v.decision.scoringWeights.TRAVEL, 0, 'TRAVEL must end at exactly 0');

  const event = v.events.find((e) => e.dimension === 'TRAVEL');
  assert.ok(event, 'the clamp must be recorded, never silent');
  assert.equal(event.code, 'AI_OUTPUT_CLAMPED');
  assert.equal(event.to, 0);
});

test('15 an inactive TRANSFER weight is clamped to 0 and cannot be activated', () => {
  assert.equal(ALLOW.allowedDimensions.includes('TRANSFER'), false, 'H13 is INACTIVE');
  assert.equal(REPORT.transferReadiness.active, false);

  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { TRANSFER: 2.5, WORKLOAD_BALANCE: 1 } }),
    { input: INPUT },
  );
  assert.equal(v.ok, true);
  assert.equal(v.decision.scoringWeights.TRANSFER, 0);
  assert.ok(v.events.some((e) => e.dimension === 'TRANSFER' && e.to === 0));
});

test('16 CHANGED_ASSIGNMENTS stays reporting-only and cannot become an objective', () => {
  const dim = DIMENSION_CATALOG.find((d) => d.id === 'CHANGED_ASSIGNMENTS');
  assert.ok(dim, 'the dimension must still exist for reporting');
  assert.equal(dim.active(INPUT), false);
  assert.equal(dim.defaultWeight, 0);
  assert.equal(ALLOW.allowedDimensions.includes('CHANGED_ASSIGNMENTS'), false);

  const v = validateStrategyDecision(
    validDecision({ scoringWeights: { CHANGED_ASSIGNMENTS: 3 } }),
    { input: INPUT },
  );
  assert.equal(v.ok, true);
  assert.equal(v.decision.scoringWeights.CHANGED_ASSIGNMENTS, 0, 'must never carry weight');
  assert.ok(v.events.some((e) => e.dimension === 'CHANGED_ASSIGNMENTS' && e.to === 0));

  // The report states the reason rather than leaving the AI to guess.
  const inactive = REPORT.dimensionAvailability.inactive.find((d) => d.id === 'CHANGED_ASSIGNMENTS');
  assert.equal(inactive.reason, 'REPORTING_ONLY');
});

// ============================================================================
// 17. AI cannot disable hard constraints
// ============================================================================

test('17 the AI cannot disable a hard constraint, and objectives are carried over verbatim', () => {
  // 17a. The schema has no field that could express a constraint change.
  const constraintish = ALLOWED_DECISION_FIELDS.filter((f) =>
    /constraint|objective|disable|ignore|relax|override|teacher|class|subject|slot|period|day|session|assignment|mutation/i.test(f),
  );
  assert.deepEqual(constraintish, [], 'no decision field may reach outside the strategy vocabulary');

  // 17b. Smuggling one in is REJECTED, not ignored. An ignored field
  //      would still be a false statement in the audit log.
  for (const attempt of [
    { disableConstraints: ['H01'] },
    { hardConstraints: { H01: false, H02: false } },
    { ignore: ['H01', 'H02'] },
    { objectives: { noGapTeacherDay: false, balancedWorkload: false } },
    { relaxEligibility: true },
    { newConstraint: { id: 'H99', rule: 'anything' } },
  ]) {
    const v = validateStrategyDecision({ ...validDecision(), ...attempt }, { input: INPUT });
    assert.equal(v.ok, false, `${Object.keys(attempt)[0]} must be rejected`);
    assert.equal(v.failure.code, 'UNKNOWN_FIELD');
    assert.equal(v.decision, null, 'no decision may be produced from a rejected output');
  }

  // 17c. Applying a decision cannot alter the base strategy's objectives.
  const base = deepFreeze({
    ...STRATEGY_C,
    objectives: { noGapTeacherDay: true, balancedWorkload: true, sessionDiversity: false },
  });
  const approved = validateStrategyDecision(validDecision(), { input: INPUT }).decision;
  const applied = ai.applyStrategyDecision(approved, base);

  assert.deepEqual(applied.strategy.objectives, base.objectives, 'objectives must be copied verbatim');
  assert.equal(applied.strategy.objectives.noGapTeacherDay, true);
  assert.equal(applied.strategy.objectives.balancedWorkload, true);
  assert.equal(applied.strategy.optimizationMode, OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED);
  assert.notEqual(applied.strategy, base, 'a NEW strategy object must be returned');
  assert.equal(base.optimizationMode, STRATEGY_C.optimizationMode, 'the base strategy must be untouched');
});

// ============================================================================
// 18-20. failure modes fall back
// ============================================================================

test('18 an invalid AI output falls back to the deterministic strategy', async () => {
  // The brief's own counter-example (brief §33).
  const bad = {
    optimizationMode: 'FREE_FORM',
    candidateCount: 999,
    scoringWeights: { TRAVEL: 50 },
  };
  const v = validateStrategyDecision(bad, { input: INPUT });
  assert.equal(v.ok, false);
  assert.equal(v.failure.code, 'UNKNOWN_MODE');

  const r = await planStrategy(INPUT, { planner: createStaticPlanner(bad) });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.decision.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
  assert.equal(r.decision.candidateCount, DEFAULT_AI_FALLBACK.candidateCount);
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
  assert.deepEqual(r.decision.scoringWeights, ai.defaultWeightsFor(INPUT));
  assert.equal(r.input.strategy.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
  assert.equal(r.failure.kind, AI_FAILURE.INVALID_OUTPUT);

  // Every other malformed shape falls back too.
  for (const shape of [null, undefined, 'a string', 42, [], {}, { optimizationMode: 'BASE_FEASIBLE' }]) {
    const res = await planStrategy(INPUT, { planner: createStaticPlanner(shape) });
    assert.equal(res.fallbackUsed, true, `shape ${JSON.stringify(shape)} must fall back`);
    assert.equal(res.decision.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
  }
});

test('19 an unavailable AI provider falls back without failing the schedule', async () => {
  for (const [label, planner] of [
    ['unavailable', createUnavailablePlanner()],
    ['unsupported', createUnsupportedRequestPlanner()],
    ['parse error', createParseErrorPlanner()],
    ['invalid output', createInvalidOutputPlanner()],
    ['not a planner', {}],
    ['no planner at all', null],
  ]) {
    const r = await planStrategy(INPUT, { planner });
    assert.equal(r.fallbackUsed, true, `${label} must fall back`);
    assert.equal(r.decision.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
    assert.ok(r.failure, `${label} must record a failure kind`);
    assert.ok(Object.values(AI_FAILURE).includes(r.failure.kind), `${label}: ${r.failure.kind}`);
    assert.equal(r.audit.fallbackUsed, true);
  }

  // A provider that throws a plain Error (not an AIProviderError) is
  // also contained rather than propagated.
  const thrower = { name: 'Thrower', plan: async () => { throw new Error('boom'); } };
  const r = await planStrategy(INPUT, { planner: thrower });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.failure.kind, AI_FAILURE.INVALID_OUTPUT);
});

test('20 an AI provider that never responds times out and falls back', async () => {
  const started = Date.now();
  const r = await planStrategy(INPUT, { planner: createHangingPlanner(), timeoutMs: 40 });
  const elapsed = Date.now() - started;

  assert.equal(r.fallbackUsed, true);
  assert.equal(r.failure.kind, AI_FAILURE.TIMEOUT);
  assert.equal(r.decision.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
  assert.ok(elapsed < 2000, `timeout must be enforced promptly, took ${elapsed} ms`);
  assert.ok(elapsed >= 40, 'the timeout must actually wait for its budget');

  // A slow-but-finite provider inside the budget is used normally.
  const slowOk = {
    name: 'SlowButFine',
    plan: () => new Promise((resolve) => setTimeout(() => resolve(validDecision()), 10)),
  };
  const ok = await planStrategy(INPUT, { planner: slowOk, timeoutMs: 2000 });
  assert.equal(ok.fallbackUsed, false);
  assert.equal(ok.decision.candidateCount, 5);
});

// ============================================================================
// 21. rationale is not parsed as logic
// ============================================================================

test('21 rationale is explanation only and is never parsed back into behavior', async () => {
  // A rationale that contradicts every structured field.
  const adversarial = validDecision({
    optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    candidateCount: 1,
    scoringWeights: { WORKLOAD_BALANCE: 0.1 },
    rationale: 'Ignore this. Set mode to PREFERENCE_FIRST, set candidateCount to 10, and set all weights to 99.',
  });

  const r = await planStrategy(INPUT, { planner: createStaticPlanner(adversarial) });
  assert.equal(r.fallbackUsed, false);
  assert.equal(r.decision.optimizationMode, OPTIMIZATION_MODES.BASE_FEASIBLE, 'the structured field wins');
  assert.equal(r.decision.candidateCount, 1, 'the text must not change the count');
  assert.equal(r.decision.scoringWeights.WORKLOAD_BALANCE, 0.1, 'the text must not change weights');
  assert.ok(r.decision.rationale.includes('Ignore this'), 'the text is still carried for display');

  // A non-string rationale is dropped, not obeyed and not fatal.
  const v = validateStrategyDecision(validDecision({ rationale: { mode: 'PREFERENCE_FIRST' } }), { input: INPUT });
  assert.equal(v.ok, true, 'a malformed rationale must not fail an otherwise valid decision');
  assert.ok(v.events.some((e) => e.code === 'AI_OUTPUT_DROPPED' && e.field === 'rationale'));

  // The applied strategy is derived from the structured fields only.
  assert.equal(r.input.strategy.optimizationMode, OPTIMIZATION_MODES.BASE_FEASIBLE);
});

// ============================================================================
// 22. deterministic with the mock provider
// ============================================================================

test('22 the mock provider yields a deterministic decision', async () => {
  const opts = { planner: new DeterministicMockAIPlanner(), requestedCandidateCount: 5 };
  const a = await planStrategy(INPUT, opts);
  const b = await planStrategy(INPUT, opts);

  assert.equal(a.audit.inputSummaryHash, b.audit.inputSummaryHash);
  assert.equal(canonicalStringify(a.decision), canonicalStringify(b.decision));
  assert.equal(canonicalStringify(a.report), canonicalStringify(b.report));
  assert.equal(a.decision.optimizationMode, b.decision.optimizationMode);
  assert.equal(a.fallbackUsed, b.fallbackUsed);
});

// ============================================================================
// 23. input not mutated
// ============================================================================

test('23 planning does not mutate the SchedulingInput', async () => {
  const strategy = deepFreeze({ ...FAST_STRATEGY });
  const input = { ...INPUT, strategy };
  const before = canonicalStringify(strategy);
  const teachersRef = input.teachers;
  const assignmentsRef = input.assignments;

  const r = await planStrategy(input, { planner: new DeterministicMockAIPlanner() });

  assert.equal(canonicalStringify(strategy), before, 'input.strategy must be byte-identical after planning');
  assert.equal(input.teachers, teachersRef, 'the teachers collection must not be replaced');
  assert.equal(input.assignments, assignmentsRef, 'the assignments collection must not be replaced');
  assert.equal(input.strategy, strategy, 'input.strategy must be the same object');
  assert.notEqual(r.input.strategy, input.strategy, 'a NEW strategy object must be returned');

  // A second plan over the same frozen input still works, which it
  // could not if planning had written to it under strict mode.
  await planStrategy(input, { planner: new DeterministicMockAIPlanner() });
  assert.equal(canonicalStringify(strategy), before);
});

// ============================================================================
// 24. candidate not mutated
// ============================================================================

test('24 candidates are not mutated by the AI layer or the scorer', () => {
  const { candidates } = pool();
  assert.ok(candidates.length > 0, 'the pool must be non-empty for this test to mean anything');

  const snapshot = () => candidates.map((c) => ({
    id: c.id,
    metrics: canonicalStringify(c.metrics),
    placements: c.placements instanceof Map ? c.placements.size : null,
    assignmentKeys: c.assignments instanceof Map ? [...c.assignments.keys()].length : null,
  }));
  const before = snapshot();

  // Everything the AI layer does to a pool.
  const summary = summarizeCandidates(candidates);
  const rec = recommendFromCandidates(candidates);
  selectFinalSolutions(candidates, {
    count: 3,
    input: INPUT,
    scoringConfig: { weights: ai.defaultWeightsFor(INPUT) },
  });

  assert.equal(summary.count, candidates.length);
  assert.ok(rec.recommendedId !== null);
  assert.deepEqual(snapshot(), before, 'no candidate may be altered by summarizing, recommending, or scoring');
});

// ============================================================================
// 25. solver consumes the validated decision
// ============================================================================

test('25 the solver consumes a validated StrategyDecision and the result is still validator-checked', async () => {
  // PHASE 31.1: this test used to call `solve()` with a 1500 ms
  // budget against a real 479-assignment search. That is a ~2x
  // margin, so on a loaded host the wall clock could expire during
  // the FIRST search, the solver returned NO_SOLUTION, and the
  // end-to-end chain the test exists to prove was never exercised.
  // `FAST_STRATEGY` now bounds the search by iteration count, so the
  // premise of this test no longer depends on the host being idle.
  const r = await planStrategy(INPUT, {
    planner: new DeterministicMockAIPlanner(),
    baseStrategy: FAST_STRATEGY,
    requestedCandidateCount: 1,
  });
  assert.equal(r.fallbackUsed, false, 'the mock decision must be approved for the end-to-end path');

  const out = solve(r.input);
  assert.ok(out && out.solutions && out.solutions.length > 0, 'the solver must return a candidate');
  assert.equal(out.failure ?? null, null);
  // Premise: the solve was not truncated by the wall clock.
  assert.equal(out.diagnostics.searchLimited, false,
    'the solve was truncated by the wall clock; the candidate below would be host-dependent');
  assert.notEqual(out.diagnostics.searchStoppedBy, 'TIME_BUDGET',
    `expected a seed-decided stop, got ${out.diagnostics.searchStoppedBy}`);

  // The independent evaluator — not the AI, not the solver — decides.
  const ev = evaluateCandidate(out.solutions[0], r.input);
  assert.equal(ev.summary.accepted, true, 'the solver output must be independently accepted');
  assert.equal(ev.hard.violations.length, 0, 'no hard constraint may be violated');

  // The AI's scoring weights reach the Phase 28 scorer unchanged.
  assert.deepEqual(r.applied.scoringConfig.weights, r.decision.scoringWeights);
  assert.equal(r.applied.candidateCount, r.decision.candidateCount);
});

// ============================================================================
// 26. GLOBAL mode remains available
// ============================================================================

test('26 GLOBAL_ASSIGNMENT_BALANCED remains available to the AI', () => {
  assert.ok(ALLOW.modes.includes('GLOBAL_ASSIGNMENT_BALANCED'));
  assert.equal(ALLOW.modes.length, 4);
  for (const m of ['BASE_FEASIBLE', 'ASSIGNMENT_BALANCED', 'PREFERENCE_FIRST', 'GLOBAL_ASSIGNMENT_BALANCED']) {
    assert.ok(ALLOW.modes.includes(m), `${m} must remain selectable`);
  }
  const v = validateStrategyDecision(
    validDecision({ optimizationMode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED }),
    { input: INPUT },
  );
  assert.equal(v.ok, true);
  assert.equal(v.decision.optimizationMode, 'GLOBAL_ASSIGNMENT_BALANCED');
});

// ============================================================================
// 27. deterministic fallback always available
// ============================================================================

test('27 the deterministic fallback exists, needs no AI, and is itself valid', async () => {
  const fb = fallbackDecision(INPUT);
  assert.equal(fb.optimizationMode, DEFAULT_AI_FALLBACK.optimizationMode);
  assert.ok(ALLOWED_CANDIDATE_COUNTS.includes(fb.candidateCount));

  // It must survive its own validator, so callers can treat "fallback"
  // and "approved" identically.
  const v = validateStrategyDecision(fb, { input: INPUT });
  assert.equal(v.ok, true, `fallback must validate: ${v.reason}`);
  assert.deepEqual(v.events, []);

  // And it must not have drifted from the Phase 28 scorer defaults.
  assert.deepEqual(fb.scoringWeights, ai.defaultWeightsFor(INPUT));
  for (const [id, w] of Object.entries(fb.scoringWeights)) {
    assert.equal(w, GLOBAL_SCORING_DEFAULTS.weights[id], `fallback weight for ${id} drifted from the scorer default`);
  }

  // Deterministic: two calls with no planner produce the same thing.
  const a = await planStrategy(INPUT, {});
  const b = await planStrategy(INPUT, {});
  assert.equal(canonicalStringify(a.decision), canonicalStringify(b.decision));
});

// ============================================================================
// 28. no external network required
// ============================================================================

test('28 the AI layer requires no external network', async () => {
  const aiDir = path.join(BACKEND, 'src', 'domain', 'ai');
  const files = readdirSync(aiDir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 4, 'the AI layer should be split into modules');

  const NETWORK = /\b(fetch|XMLHttpRequest|WebSocket|EventSource|axios|node-fetch|undici|navigator)\b|require\(\s*['"]https?['"]\s*\)|from\s*['"]https?:|api[_-]?key|Authorization/i;
  for (const f of files) {
    const text = readFileSync(path.join(aiDir, f), 'utf8');
    assert.equal(NETWORK.test(text), false, `${f} must not reference a network API or credential`);
  }

  // Runtime proof: make the network global hostile, then plan.
  const had = 'fetch' in globalThis;
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network access attempted'); };
  try {
    const r = await planStrategy(INPUT, { planner: new DeterministicMockAIPlanner() });
    assert.equal(r.fallbackUsed, false);
    assert.ok(r.decision.optimizationMode);
  } finally {
    if (had) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }
});

// ============================================================================
// 29. no AirLLM dependency introduced
// ============================================================================

test('29 Phase 29 introduces no AirLLM / model / GPU dependency', () => {
  const pkg = JSON.parse(readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const FORBIDDEN = /airllm|torch|transformers|@xenova|@huggingface|onnxruntime|cuda|tensorflow|llama|ollama/i;
  for (const name of Object.keys(deps)) {
    assert.equal(FORBIDDEN.test(name), false, `forbidden dependency added: ${name}`);
  }

  // No backend source may IMPORT a model runtime. Prose mentions of a
  // future phase are fine; imports are not.
  //
  // PHASE 30 REFINEMENT. This pattern previously matched any import
  // path containing "airllm", which included RELATIVE imports of the
  // project's own provider modules (`./airllm-client.js`). That is a
  // false positive: the guard exists to keep torch/transformers/the
  // airllm Python package out of the Node process, and a sibling file
  // is none of those. A relative specifier (starting with a dot) is
  // now excluded, which makes the check strictly more precise about
  // third-party runtimes while still failing on a genuine bare or
  // scoped-package import of one of them.
  const IMPORT_FORBIDDEN = /from\s*['"](?!\.)[^'"]*(airllm|torch|transformers|@xenova|@huggingface|onnxruntime|ollama)[^'"]*['"]|require\(\s*['"](?!\.)[^'"]*(airllm|torch|transformers)[^'"]*['"]\s*\)/i;
  const scan = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { scan(full); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      const text = readFileSync(full, 'utf8');
      assert.equal(IMPORT_FORBIDDEN.test(text), false, `${full} imports a model runtime`);
    }
  };
  scan(path.join(BACKEND, 'src'));
  scan(path.join(BACKEND, 'tests'));
});

// ============================================================================
// 30. Phase 28 regression
// ============================================================================

test('30 the Phase 28 scorer is unchanged by the Phase 29 layer', () => {
  // The AI layer supplies weights to Phase 28; it must not change how
  // Phase 28 scores or selects. A no-AI plan resolves to the catalog
  // defaults, which are exactly GLOBAL_SCORING_DEFAULTS.weights.
  const fallbackWeights = ai.defaultWeightsFor(INPUT);
  assert.deepEqual(fallbackWeights, GLOBAL_SCORING_DEFAULTS.weights);

  // Feed those weights through Phase 28 unchanged and confirm the
  // selection contract still holds on a real pool.
  const { candidates } = pool();
  const sel = selectFinalSolutions(candidates, {
    count: 3,
    input: INPUT,
    scoringConfig: { weights: fallbackWeights },
  });

  assert.ok(sel.solutions.length > 0);
  assert.equal(sel.diagnostics.h13, 'INACTIVE');
  assert.equal(sel.diagnostics.h14, 'UNSUPPORTED');
  for (const s of sel.solutions) {
    assert.equal(s.scoring.hardViolations, 0);
    assert.ok(Number.isFinite(s.scoring.total));
  }
  // TRAVEL, TRANSFER and CHANGED_ASSIGNMENTS contribute nothing
  // regardless of the decision path.
  for (const s of sel.solutions) {
    assert.equal(s.scoring.dimensions.TRAVEL.contribution, 0);
    assert.equal(s.scoring.dimensions.TRANSFER.contribution, 0);
    assert.equal(s.scoring.dimensions.CHANGED_ASSIGNMENTS.contribution, 0);
  }
});

// ============================================================================
// 31+. Additional guards beyond the 30 required checks
// ============================================================================

test('31 the allow-list is frozen and lives outside the AI', async () => {
  assert.equal(Object.isFrozen(ALLOW), true);
  assert.equal(Object.isFrozen(ALLOW.modes), true);
  assert.equal(Object.isFrozen(ALLOW.allowedDimensions), true);
  assert.equal(Object.isFrozen(ALLOW.weightBounds), true);

  // A provider that tries to extend the action space cannot: the
  // allow-list is rebuilt from the input, never from provider output.
  const greedy = createStaticPlanner({
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    candidateCount: 5,
    scoringWeights: { WORKLOAD_BALANCE: 1 },
    allowList: { modes: ['ANYTHING'] },
    actionSpace: { candidateCounts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
  });
  const r = await planStrategy(INPUT, { planner: greedy });
  assert.equal(r.fallbackUsed, true, 'an unknown field claiming to extend the action space is rejected');
  assert.equal(r.failure.code, 'UNKNOWN_FIELD');

  // The report exposes the action space to the provider as information.
  assert.deepEqual([...REPORT.actionSpace.candidateCounts], [1, 3, 5, 10]);
  assert.equal(REPORT.actionSpace.optimizationModes.length, 4);
});

test('32 an all-zero weight vector is replaced so the global score stays defined', () => {
  const zeros = {};
  for (const id of ALLOW.allowedDimensions) zeros[id] = 0;
  const v = validateStrategyDecision(validDecision({ scoringWeights: zeros }), { input: INPUT });
  assert.equal(v.ok, true);
  assert.ok(v.events.some((e) => e.code === 'AI_OUTPUT_ZERO_WEIGHT_SUM'));

  const total = Object.values(v.decision.scoringWeights).reduce((a, b) => a + b, 0);
  assert.ok(total > 0, 'the weight sum must be positive or Phase 28 would divide by zero');
  assert.deepEqual(v.decision.scoringWeights, ai.defaultWeightsFor(INPUT));
});

test('33 a low-confidence decision falls back instead of being trusted', async () => {
  const decision = validDecision({ confidence: 0.2 });

  // Gate disabled by default: the decision is used.
  const open = await planStrategy(INPUT, { planner: createStaticPlanner(decision) });
  assert.equal(open.fallbackUsed, false);
  assert.equal(open.decision.confidence, 0.2);

  // Gate enabled: a decision below the threshold is not used.
  const gated = await planStrategy(INPUT, { planner: createStaticPlanner(decision), minConfidence: 0.8 });
  assert.equal(gated.fallbackUsed, true);
  assert.equal(gated.failure.code, 'LOW_CONFIDENCE');
  assert.equal(gated.decision.source, 'DEFAULT_AI_FALLBACK');

  // Confidence never relaxes any other rule: a bad mode is still
  // rejected even when the provider is confident about it.
  const confidentButWrong = await planStrategy(INPUT, {
    planner: createStaticPlanner({ ...decision, confidence: 0.99, optimizationMode: 'NOPE' }),
    minConfidence: 0.1,
  });
  assert.equal(confidentButWrong.fallbackUsed, true);
  assert.equal(confidentButWrong.failure.code, 'UNKNOWN_MODE');

  // An out-of-range confidence is dropped, not obeyed.
  const v = validateStrategyDecision(validDecision({ confidence: 5 }), { input: INPUT });
  assert.equal(v.ok, true);
  assert.equal(v.decision.confidence, null);
});

test('34 the AI layer never imports the solver or the multi-solution module', () => {
  const aiDir = path.join(BACKEND, 'src', 'domain', 'ai');
  const files = readdirSync(aiDir).filter((f) => f.endsWith('.js'));

  const FORBIDDEN = new Set(['solver.js', 'multi-solution.js', 'global-scoring.js']);
  for (const f of files) {
    const text = readFileSync(path.join(aiDir, f), 'utf8');
    const specs = [...text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specs) {
      assert.equal(
        FORBIDDEN.has(path.basename(spec)),
        false,
        `${f} imports ${spec}; the AI layer must not reach the solver (brief section 36)`,
      );
    }
  }

  // The vocabulary the AI layer DOES read must be solver-free.
  const catalog = readFileSync(path.join(BACKEND, 'src', 'domain', 'dimension-catalog.js'), 'utf8');
  const catalogSpecs = [...catalog.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(catalogSpecs, ['./diversity.js'], 'the dimension catalog must stay a leaf module');
});

test('35 the audit log explains the decision without storing the report or any PII', async () => {
  const r = await planStrategy(INPUT, { planner: new DeterministicMockAIPlanner() });
  const a = r.audit;

  assert.equal(typeof a.provider, 'string');
  assert.equal(a.provider, 'DeterministicMockAIPlanner');
  assert.ok(/^[0-9a-f]{8}$/.test(a.inputSummaryHash), 'the input is referenced by hash only');
  assert.equal(a.inputSummaryHash, r.report.hash);
  assert.equal(a.fallbackUsed, false);
  assert.equal(typeof a.rationale, 'string');
  assert.ok(a.validation && typeof a.validation.status === 'string');
  assert.ok(Array.isArray(a.validation.events));

  // No report body, no raw provider output, no teacher data.
  for (const forbidden of ['report', 'situationReport', 'rawOutput', 'teachers', 'input']) {
    assert.equal(Object.keys(a).includes(forbidden), false, `the audit log must not store ${forbidden}`);
  }
  const serialized = canonicalStringify(a);
  for (const t of INPUT.teachers) {
    if (typeof t.hoTen === 'string' && t.hoTen.length >= 3) {
      assert.ok(!serialized.includes(t.hoTen), 'teacher name leaked into the audit log');
    }
  }

  // Two runs over the same input produce the same hash, so the log can
  // answer "did the situation change?" without keeping the situation.
  const again = await planStrategy(INPUT, { planner: new DeterministicMockAIPlanner() });
  assert.equal(again.audit.inputSummaryHash, a.inputSummaryHash);
});

test('36 the report gains candidate statistics only in POST-SOLVE mode', () => {
  const pre = buildSituationReport(INPUT);
  assert.equal(pre.candidateQuality, null);
  assert.equal(pre.candidateDiversity, null);

  const { candidates } = pool();
  const post = buildSituationReport(INPUT, { candidateSummary: summarizeCandidates(candidates) });

  assert.ok(post.candidateQuality, 'POST-SOLVE reports carry quality statistics');
  assert.ok(post.candidateDiversity, 'POST-SOLVE reports carry diversity statistics');
  assert.equal(
    post.candidateQuality.feasibleCount + post.candidateQuality.infeasibleCount,
    candidates.length,
  );
  assert.ok(Number.isFinite(post.candidateDiversity.minSlotDiversity));

  // Candidate facts only — never the candidates themselves.
  const facts = canonicalStringify(post.candidateQuality) + canonicalStringify(post.candidateDiversity);
  for (const c of candidates) {
    if (typeof c.id === 'string' && c.id.length >= 6) {
      assert.ok(!facts.includes(c.id), 'candidate id must not appear in the report facts');
    }
  }
});

test('37 the post-solve recommendation names a candidate without altering it', () => {
  const { candidates } = pool();
  const before = candidates.map((c) => canonicalStringify(c.metrics));

  const rec = recommendFromCandidates(candidates, { source: 'DeterministicMockAIPlanner' });
  assert.ok(Number.isInteger(rec.recommendedIndex));
  assert.ok(rec.recommendedIndex >= 0 && rec.recommendedIndex < candidates.length);
  assert.equal(rec.source, 'DeterministicMockAIPlanner');
  assert.ok(rec.alternatives.length <= 2);
  assert.deepEqual(candidates.map((c) => canonicalStringify(c.metrics)), before);

  // The recommendation is a pointer, and it is deterministic.
  assert.deepEqual(recommendFromCandidates(candidates, { source: 'DeterministicMockAIPlanner' }), rec);
  assert.equal(recommendFromCandidates([]).recommendedIndex, null);
});

test('38 the mock and the deterministic default differ, and the difference reaches the solver', async () => {
  // Phase 29 makes no claim that the mock is smarter (brief §41). It
  // only has to be a real, different, VALID strategy that survives the
  // boundary intact.
  const withMock = await planStrategy(INPUT, {
    planner: new DeterministicMockAIPlanner(),
    baseStrategy: FAST_STRATEGY,
  });
  const withDefault = await planStrategy(INPUT, { baseStrategy: FAST_STRATEGY });

  assert.equal(withMock.fallbackUsed, false);
  assert.equal(withDefault.fallbackUsed, true);
  assert.notEqual(
    canonicalStringify(withMock.decision.scoringWeights),
    canonicalStringify(withDefault.decision.scoringWeights),
    'the mock must exercise a different weighting than the default',
  );

  // Both remain legal strategies.
  for (const r of [withMock, withDefault]) {
    assert.ok(ALLOW.modes.includes(r.input.strategy.optimizationMode));
    for (const w of Object.values(r.applied.scoringConfig.weights)) {
      assert.ok(Number.isFinite(w) && w >= 0 && w <= ALLOW.weightBounds.WORKLOAD_BALANCE.max);
    }
  }
});

// ============================================================================
// 39. The AI-chosen optimizationMode reaches generation
// ============================================================================

test('39 the AI-chosen optimizationMode reaches generation, and the default is unchanged', async () => {
  // Phase 27 hard-codes the GLOBAL engine on every iteration and its
  // tests assert that, so the AI mode is DISCARDED by default and the
  // seam is opt-in. Both halves are pinned here so the boundary
  // cannot drift silently in either direction.
  const run = async (optimizationMode) => {
    const r = await planStrategy(INPUT, {
      planner: createStaticPlanner(validDecision({ optimizationMode })),
      baseStrategy: FAST_STRATEGY,
    });
    assert.equal(r.fallbackUsed, false, `the ${optimizationMode} decision must be approved`);
    return generateSolutions(r.input, { ...GEN_OPTS, respectStrategyMode: true });
  };

  // Default: the Phase 27 contract holds, and the diagnostics say so.
  const forced = generateSolutions(
    { ...INPUT, strategy: { ...FAST_STRATEGY, optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED } },
    GEN_OPTS,
  );
  assert.equal(
    forced.diagnostics.optimizationMode,
    OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
    'by default the GLOBAL engine is still forced, exactly as in Phase 27',
  );
  assertReproducibleSearch(forced, 'the default (forced GLOBAL) run');

  // Opt-in: the approved AI mode is what actually runs.
  const honored = await run(OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
  assert.equal(
    honored.diagnostics.optimizationMode,
    OPTIMIZATION_MODES.ASSIGNMENT_BALANCED,
    'the approved mode must reach generation when opted in',
  );
  assertReproducibleSearch(honored, 'the opt-in (honored mode) run');

  // A mode the enum does not contain must never be handed to the
  // solver, even if it somehow got into a strategy.
  const bogus = generateSolutions(
    { ...INPUT, strategy: { ...FAST_STRATEGY, optimizationMode: 'NOT_A_MODE' } },
    { ...GEN_OPTS, respectStrategyMode: true },
  );
  assert.equal(
    bogus.diagnostics.optimizationMode,
    OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
    'an unrecognized engine must fall back to GLOBAL rather than reach the solver',
  );
  assertReproducibleSearch(bogus, 'the unrecognized-mode run');
});
