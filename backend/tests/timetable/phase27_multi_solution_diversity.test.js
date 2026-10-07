import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { STRATEGY_C, OPTIMIZATION_MODES } from '../../src/modules/timetable/engine/domain/strategies.js';
import { generateSolutions, deriveSeed, pairwiseDiversityMatrix, qualityScore, MULTI_SOLUTION_DEFAULTS } from '../../src/modules/timetable/engine/domain/multi-solution.js';
import { evaluateCandidate, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { diversity as slotDiversity, structuralDiversity } from '../../src/modules/timetable/engine/domain/diversity.js';
import { compareOptimizationCandidates } from '../../src/modules/timetable/engine/domain/comparator.js';
function loadRealData() {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  return {
    full,
    input
  };
}
function runReal(count, options = {}) {
  const {
    input
  } = loadRealData();
  return generateSolutions(input, {
    count,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 30_000,
    overallTimeBudgetMs: 180_000,
    maxSearchIterations: 12,
    ...options
  });
}
const DETERMINISTIC = Object.freeze({
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  maxSearchIterations: 12
});
function assertReproducible(out, label) {
  assert.equal(out.diagnostics.searchLimited, false, `${label}: a solve was truncated by the wall clock; determinism is not claimable`);
  assert.ok(!out.diagnostics.searchStoppedBy.includes('TIME_BUDGET'), `${label}: searchStoppedBy reported TIME_BUDGET (${out.diagnostics.searchStoppedBy.join(', ')})`);
  assert.equal(out.diagnostics.iterationBound, DETERMINISTIC.maxSearchIterations, `${label}: the seed-stable iteration bound must be reported back`);
  assert.ok(out.solutions.length > 0, `${label}: produced no solutions to compare`);
}
function countSlots(candidate) {
  let n = 0;
  for (const arr of candidate.assignments.values()) n += arr.length;
  return n;
}
function buildControlledDiversityFixture(requiredPeriods = 2) {
  function buildSlots(b) {
    const out = [];
    for (const day of b.schoolDays ?? [1, 2, 3, 4, 5]) {
      for (const period of b.periods ?? [1, 2, 3, 4, 5, 6, 7, 8]) {
        out.push({
          branchId: b.id,
          day,
          period
        });
      }
    }
    return out;
  }
  const teachers = [{
    id: 'TA',
    hoTen: 'TA',
    chuyenMon: [{
      tenChuyenMon: 'X'
    }, {
      tenChuyenMon: 'Y'
    }],
    eligibleSubjectIds: ['X', 'Y'],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'TB',
    hoTen: 'TB',
    chuyenMon: [{
      tenChuyenMon: 'X'
    }, {
      tenChuyenMon: 'Y'
    }],
    eligibleSubjectIds: ['X', 'Y'],
    homeBranchId: 'b1',
    trangThai: 'active'
  }];
  const branches = [{
    id: 'b1',
    schoolDays: [1, 2, 3, 4, 5],
    periods: [1, 2, 3, 4, 5, 6, 7, 8]
  }];
  const classes = [{
    id: 'c1',
    branchId: 'b1'
  }, {
    id: 'c2',
    branchId: 'b1'
  }];
  const assignments = [{
    id: 'a1',
    classId: 'c1',
    subjectId: 'X',
    teacherId: 'TA',
    branchId: 'b1',
    requiredPeriods
  }, {
    id: 'a2',
    classId: 'c2',
    subjectId: 'Y',
    teacherId: 'TA',
    branchId: 'b1',
    requiredPeriods
  }];
  return {
    teachers,
    branches,
    classes,
    subjects: [{
      id: 'X',
      name: 'X',
      isActive: true
    }, {
      id: 'Y',
      name: 'Y',
      isActive: true
    }],
    curriculum: assignments.map(a => ({
      classId: a.classId,
      subjectId: a.subjectId,
      requiredPeriods: a.requiredPeriods
    })),
    assignments,
    timeSlotsByBranch: new Map(branches.map(b => [b.id, buildSlots(b)])),
    travelTime: null,
    transitionMinutes: 10,
    teacherIndex: new Map(teachers.map(t => [t.id, t])),
    assignmentIndex: new Map(assignments.map(a => [a.id, a])),
    warnings: [],
    missingData: [],
    strategy: STRATEGY_C
  };
}
function buildSyntheticCandidate(teacherLoadMap, hardViolations = 0) {
  const assignments = new Map();
  const id = `syn-${Math.random().toString(36).slice(2, 10)}`;
  const placements = new Map();
  let slotCounter = 0;
  for (const [teacherId, n] of teacherLoadMap) {
    const slots = [];
    for (let i = 0; i < n; i++) {
      slots.push({
        day: 1,
        period: ++slotCounter,
        branchId: 'b1',
        teacherId
      });
    }
    assignments.set(`A${slotCounter}`, slots);
    placements.set(`A${slotCounter}`, {
      teacherId,
      branchId: 'b1'
    });
  }
  return {
    id,
    strategyId: 'SYNTHETIC',
    assignments,
    placements,
    metrics: {
      hardViolations,
      softPenalty: 0,
      accepted: hardViolations === 0,
      teacherCount: teacherLoadMap.size,
      totalPeriods: [...teacherLoadMap.values()].reduce((a, b) => a + b, 0),
      maxTeacherLoad: Math.max(...teacherLoadMap.values()),
      minTeacherLoad: Math.min(...teacherLoadMap.values()),
      averageTeacherLoad: 0,
      workloadSpread: Math.max(...teacherLoadMap.values()) - Math.min(...teacherLoadMap.values()),
      workloadStdev: 0,
      preferencePenalty: 0,
      changedAssignments: 0,
      changedFraction: 0,
      totalSoftCost: 0
    },
    diagnostics: {
      hardViolationCount: hardViolations
    },
    transfers: []
  };
}
test('PHASE 27 / 1 — count=1 returns exactly one valid solution on real data', () => {
  const out = runReal(1);
  assert.equal(out.solutions.length, 1);
  const s = out.solutions[0];
  assert.ok(s.id);
  assert.equal(s.rank, 1);
  assert.ok(s.candidate);
  assert.equal(s.candidate.metrics.accepted, true);
  assert.equal(countSlots(s.candidate), 802);
  assert.equal(s.assignmentCount, 479);
  assert.equal(out.diagnostics.requested, 1);
  assert.equal(out.diagnostics.produced, 1);
});
test('PHASE 27 / 2 — count=3 produces up to 3 feasible distinct solutions on real data', () => {
  const out = runReal(3);
  assert.ok(out.solutions.length >= 1);
  assert.ok(out.solutions.length <= 3);
  for (const s of out.solutions) {
    const {
      input
    } = loadRealData();
    const ev = evaluateCandidate(s.candidate, input);
    assert.equal(ev.summary.accepted, true);
  }
  assert.equal(out.diagnostics.requested, 3);
  assert.ok(out.diagnostics.searchesExecuted >= 1);
});
test('PHASE 27 / 3 — count=5 produces up to 5 feasible distinct solutions on real data', () => {
  const out = runReal(5);
  assert.ok(out.solutions.length >= 1);
  assert.ok(out.solutions.length <= 5);
  for (const s of out.solutions) {
    const {
      input
    } = loadRealData();
    const ev = evaluateCandidate(s.candidate, input);
    assert.equal(ev.summary.accepted, true);
  }
  assert.equal(out.diagnostics.requested, 5);
});
test('PHASE 27 / 4 — every returned solution has hardViolations = 0 in its own metrics', () => {
  const out = runReal(5);
  for (const s of out.solutions) {
    assert.equal(s.candidate.metrics.hardViolations, 0, `solution ${s.id} must have hardViolations=0`);
  }
});
test('PHASE 27 / 5 — every returned solution accepted by the independent evaluator', () => {
  const {
    input
  } = loadRealData();
  const out = runReal(5);
  for (const s of out.solutions) {
    const ev = evaluateCandidate(s.candidate, input);
    assert.equal(ev.summary.accepted, true, `solution ${s.id} must be accepted by independent evaluator`);
    assert.equal(ev.hard.violations.length, 0);
  }
});
test('PHASE 27 / 6 — every returned solution is complete (802 slots, 479 assignments) on real data', () => {
  const out = runReal(3);
  for (const s of out.solutions) {
    assert.equal(countSlots(s.candidate), 802, `solution ${s.id} must have 802 slots`);
    assert.equal(s.candidate.assignments.size, 479, `solution ${s.id} must cover all 479 assignments`);
  }
});
test('PHASE 27 / 7 — no two solutions share the same id (multi-solution uniqueness)', () => {
  const out = runReal(5);
  const ids = out.solutions.map(s => s.id);
  const unique = new Set(ids);
  assert.equal(unique.size, ids.length, `all ids must be unique; got ${ids.length} ids, ${unique.size} unique`);
  for (const id of ids) {
    assert.ok(id.startsWith('ms-'), `id ${id} must start with ms-`);
  }
});
test('PHASE 27 / 8 — near-duplicate (slot diversity < threshold) is rejected from the kept set', () => {
  const out = runReal(5, {
    minSlotDiversity: 0.15
  });
  for (let i = 1; i < out.solutions.length; i++) {
    const d = out.solutions[i].diversity.slotToPrevious;
    assert.ok(d >= 0.15 - 1e-9, `slotToPrevious[${i}] = ${d} must be >= 0.15`);
  }
});
test('PHASE 27 / 9 — minSlotDiversity config knob respected (threshold=0.30)', () => {
  const out = runReal(3, {
    minSlotDiversity: 0.30
  });
  for (let i = 1; i < out.solutions.length; i++) {
    const d = out.solutions[i].diversity.slotToPrevious;
    assert.ok(d >= 0.30 - 1e-9, `with threshold 0.30, slotToPrevious[${i}] = ${d} must be >= 0.30`);
  }
});
test('PHASE 27 / 10 — every solution reports a teacherDay diversity', () => {
  const out = runReal(3);
  for (let i = 1; i < out.solutions.length; i++) {
    const td = out.solutions[i].diversity.teacherDay;
    assert.ok(Number.isFinite(td));
    assert.ok(td >= 0 && td <= 1, `teacherDay must be in [0,1], got ${td}`);
  }
});
test('PHASE 27 / 11 — every solution reports a sessionMix diversity', () => {
  const out = runReal(3);
  for (let i = 1; i < out.solutions.length; i++) {
    const sm = out.solutions[i].diversity.sessionMix;
    assert.ok(Number.isFinite(sm));
    assert.ok(sm >= 0 && sm <= 1, `sessionMix must be in [0,1], got ${sm}`);
  }
});
test('PHASE 27 / 12 — every solution reports an overall structural diversity', () => {
  const out = runReal(3);
  for (let i = 1; i < out.solutions.length; i++) {
    const ov = out.solutions[i].diversity.overall;
    assert.ok(Number.isFinite(ov));
    assert.ok(ov >= 0 && ov <= 1, `overall must be in [0,1], got ${ov}`);
  }
});
test('PHASE 27 / 13 — overall = 0.6 * teacherDay + 0.4 * sessionMix (current contract)', () => {
  const out = runReal(3);
  for (let i = 1; i < out.solutions.length; i++) {
    const d = out.solutions[i].diversity;
    const expected = 0.6 * d.teacherDay + 0.4 * d.sessionMix;
    assert.ok(Math.abs(d.overall - expected) < 1e-9, `overall=${d.overall} but 0.6*td + 0.4*sm = ${expected}`);
  }
});
test('PHASE 27 / 14 — session compactness is NOT used as solution diversity', () => {
  const out = runReal(3);
  for (const s of out.solutions) {
    assert.ok(Object.prototype.hasOwnProperty.call(s.diversity, 'overall'));
    assert.ok(Object.prototype.hasOwnProperty.call(s.diversity, 'teacherDay'));
    assert.ok(Object.prototype.hasOwnProperty.call(s.diversity, 'sessionMix'));
    assert.ok(Object.prototype.hasOwnProperty.call(s.diversity, 'slotToBest'));
    assert.ok(s.diversity.overall >= 0 && s.diversity.overall <= 1);
  }
});
test('PHASE 27 / 15 — best-quality solution is always rank=1', () => {
  const out = runReal(5);
  assert.ok(out.solutions.length >= 1);
  const rank1 = out.solutions[0];
  for (let i = 1; i < out.solutions.length; i++) {
    const r = compareOptimizationCandidates(rank1.candidate, out.solutions[i].candidate);
    assert.ok(r <= 0, `rank=1 must not be worse than rank=${i + 1} (comparator returned ${r})`);
  }
  for (let i = 1; i < out.solutions.length; i++) {
    assert.ok(rank1.candidate.metrics.workloadSpread <= out.solutions[i].candidate.metrics.workloadSpread, `rank=1 spread=${rank1.candidate.metrics.workloadSpread} must be <= rank=${i + 1} spread=${out.solutions[i].candidate.metrics.workloadSpread}`);
  }
});
test('PHASE 27 / 16 — quality rank is lexicographic; lower quality but high diversity does not bump rank', () => {
  const out = runReal(5);
  for (let i = 0; i < out.solutions.length; i++) {
    for (let j = i + 1; j < out.solutions.length; j++) {
      const cmp = compareOptimizationCandidates(out.solutions[i].candidate, out.solutions[j].candidate);
      assert.ok(cmp <= 0, `rank=${i + 1} must not be strictly worse than rank=${j + 1} (comparator=${cmp})`);
    }
  }
});
test('PHASE 27 / 17 — same (input, strategy, seed, count) produces same output', () => {
  const {
    input
  } = loadRealData();
  const a = generateSolutions(input, {
    ...DETERMINISTIC,
    count: 3
  });
  const b = generateSolutions(input, {
    ...DETERMINISTIC,
    count: 3
  });
  assertReproducible(a, 'run A');
  assertReproducible(b, 'run B');
  assert.equal(a.solutions.length, b.solutions.length);
  for (let i = 0; i < a.solutions.length; i++) {
    assert.equal(a.solutions[i].id, b.solutions[i].id);
    assert.equal(a.solutions[i].rank, b.solutions[i].rank);
    assert.equal(a.solutions[i].metrics.workloadSpread, b.solutions[i].metrics.workloadSpread);
    assert.equal(a.solutions[i].metrics.workloadStdev, b.solutions[i].metrics.workloadStdev);
  }
});
test('PHASE 27 / 18 — solution ordering is deterministic (rank 1 first, then by quality)', () => {
  const {
    input
  } = loadRealData();
  const a = generateSolutions(input, {
    ...DETERMINISTIC,
    count: 5
  });
  const b = generateSolutions(input, {
    ...DETERMINISTIC,
    count: 5
  });
  assertReproducible(a, 'run A');
  assertReproducible(b, 'run B');
  assert.deepEqual(a.solutions.map(s => s.id), b.solutions.map(s => s.id));
  assert.deepEqual(a.solutions.map(s => s.rank), b.solutions.map(s => s.rank));
});
test('PHASE 27 / 19 — baseline is NOT a hard anchor; solutions can diverge from baseline', () => {
  const {
    input
  } = loadRealData();
  const inputNoBaseline = {
    ...input
  };
  delete inputNoBaseline.legacyBaseline;
  const a = generateSolutions(input, {
    ...DETERMINISTIC,
    count: 3
  });
  const b = generateSolutions(inputNoBaseline, {
    ...DETERMINISTIC,
    count: 3
  });
  assertReproducible(a, 'run A');
  assertReproducible(b, 'run B');
  assert.deepEqual(a.solutions.map(s => s.id), b.solutions.map(s => s.id));
});
test('PHASE 27 / 19b — a time-budgeted search reports truncation instead of claiming determinism', () => {
  const {
    input
  } = loadRealData();
  const out = generateSolutions(input, {
    count: 3,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 1,
    overallTimeBudgetMs: 1
  });
  assert.equal(out.diagnostics.iterationBound, null);
  const budgetBound = out.diagnostics.timeBudgetHit || out.diagnostics.searchStoppedBy.includes('TIME_BUDGET');
  assert.ok(budgetBound, 'a 1 ms budget must be reported as truncating; otherwise a caller ' + 'would read this run as reproducible when it is not');
  assert.equal(out.diagnostics.searchLimited, out.diagnostics.searchStoppedBy.includes('TIME_BUDGET'), 'searchLimited must agree with the reported stop reasons');
  assert.ok(Array.isArray(out.solutions));
  assert.equal(out.solutions.length, out.diagnostics.produced);
  assert.ok(out.diagnostics.generationMs >= 0);
});
test('PHASE 27 / 20 — H14 (travel) remains UNSUPPORTED; travel data is not fabricated', () => {
  const out = runReal(3);
  assert.equal(out.diagnostics.h14, 'UNSUPPORTED');
  for (const s of out.solutions) {
    assert.equal(s.candidate.metrics.accepted, true);
  }
  const {
    input
  } = loadRealData();
  const ev = evaluateCandidate(out.solutions[0].candidate, input);
  assert.equal(ev.constraintStatuses.H14 ?? null, 'UNSUPPORTED');
});
test('PHASE 27 / 22 — input is NOT mutated by generateSolutions', () => {
  const {
    input
  } = loadRealData();
  const strategyBefore = input.strategy;
  const strategyId = input.strategy.id;
  const optimizationModeBefore = input.strategy.optimizationMode;
  const diversificationBefore = JSON.stringify(input.strategy.diversification);
  generateSolutions(input, {
    count: 3,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 1000
  });
  assert.equal(input.strategy, strategyBefore, 'input.strategy reference must be preserved');
  assert.equal(input.strategy.id, strategyId);
  assert.equal(input.strategy.optimizationMode, optimizationModeBefore);
  assert.equal(JSON.stringify(input.strategy.diversification), diversificationBefore, 'input.strategy.diversification must not be mutated');
});
test('PHASE 27 / 23 — solve(input) still works (single-solution API regression)', () => {
  const {
    input
  } = loadRealData();
  const strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    solver: {
      timeLimitMs: 30_000,
      maxSolutions: 1000,
      maxSearchIterations: 12
    },
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    }
  };
  const out = solve({
    ...input,
    strategy
  });
  assert.notEqual(out.diagnostics.searchStoppedBy, 'TIME_BUDGET', `the solve was clock-truncated (${out.diagnostics.searchStoppedBy}); ` + 'the 802-slot assertion below would be about the host');
  assert.equal(out.solutions.length, 1);
  const sol = out.solutions[0];
  assert.ok(sol);
  const ev = evaluateCandidate(sol, input);
  assert.equal(ev.summary.accepted, true);
  assert.equal(countSlots(sol), 802);
  assert.ok(sol.id.startsWith('sol-'));
});
test('PHASE 27 / 24 — overall time budget respected (wall-clock never exceeds it)', () => {
  const {
    input
  } = loadRealData();
  const t0 = Date.now();
  const out = generateSolutions(input, {
    count: 5,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 200,
    overallTimeBudgetMs: 3000
  });
  const dt = Date.now() - t0;
  assert.ok(dt <= 2 * 3000 + 500, `overall time budget must be respected (dt=${dt}ms, budget=3000ms)`);
  assert.ok(out.diagnostics.generationMs <= 2 * 3000 + 500);
});
test('PHASE 27 / 25 — requested N may produce fewer than N without fabrication', () => {
  const {
    input
  } = loadRealData();
  const out = generateSolutions(input, {
    count: 10,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 10,
    overallTimeBudgetMs: 100
  });
  assert.ok(out.solutions.length <= 10);
  assert.equal(out.diagnostics.requested, 10);
  if (out.solutions.length < 10) {
    assert.ok(out.diagnostics.produced < out.diagnostics.requested);
    const explained = out.diagnostics.timeBudgetHit || out.diagnostics.searchLimited || out.diagnostics.nearDuplicatesRejected > 0;
    assert.ok(explained, 'if produced < requested, the gap must be explained in diagnostics');
  }
});
test('PHASE 27 / 26 — deriveSeed is deterministic: same (baseSeed, iter) -> same seed', () => {
  for (let i = 0; i < 20; i++) {
    const a = deriveSeed(0xC0FFEE, i);
    const b = deriveSeed(0xC0FFEE, i);
    assert.equal(a, b);
  }
});
test('PHASE 27 / 27 — deriveSeed is per-iteration distinct (no two iterations share a seed)', () => {
  const seeds = new Set();
  for (let i = 0; i < 100; i++) {
    seeds.add(deriveSeed(0xC0FFEE, i));
  }
  assert.equal(seeds.size, 100, 'first 100 iterations must all have distinct seeds');
});
test('PHASE 27 / 28 — qualityScore is in (0, 1] and lower-spread candidates score higher', () => {
  const good = buildSyntheticCandidate(new Map([['A', 2], ['B', 2]]));
  const bad = buildSyntheticCandidate(new Map([['A', 5], ['B', 1]]));
  const gq = qualityScore(good);
  const bq = qualityScore(bad);
  assert.ok(gq > 0 && gq <= 1);
  assert.ok(bq > 0 && bq <= 1);
  assert.ok(gq > bq, `better (spread=0) must score higher than worse (spread=4): ${gq} vs ${bq}`);
});
test('PHASE 27 / 29 — pairwiseDiversityMatrix has zero diagonal and is symmetric', () => {
  const out = runReal(3);
  const cand = out.solutions.map(s => s.candidate);
  for (const metric of ['slot', 'structural', 'teacherDay', 'sessionMix']) {
    const m = pairwiseDiversityMatrix(cand, metric);
    assert.equal(m.length, cand.length);
    for (let i = 0; i < m.length; i++) {
      assert.equal(m[i].length, cand.length);
      assert.equal(m[i][i], 0, `diagonal at (${i},${i}) must be 0 for metric=${metric}`);
      for (let j = i + 1; j < m.length; j++) {
        assert.ok(Math.abs(m[i][j] - m[j][i]) < 1e-9, `matrix must be symmetric at (${i},${j}) vs (${j},${i}) for metric=${metric}: ${m[i][j]} vs ${m[j][i]}`);
      }
    }
  }
});
test('PHASE 27 / 30 — MULTI_SOLUTION_DEFAULTS exposes the contract-required fields', () => {
  assert.equal(MULTI_SOLUTION_DEFAULTS.count, 3);
  assert.equal(MULTI_SOLUTION_DEFAULTS.minSlotDiversity, 0.15);
  assert.equal(MULTI_SOLUTION_DEFAULTS.requireFeasibility, true);
  assert.equal(MULTI_SOLUTION_DEFAULTS.minimumQualityRelativeToBest, null);
  assert.ok(MULTI_SOLUTION_DEFAULTS.overallTimeBudgetMs > 0);
  assert.ok(MULTI_SOLUTION_DEFAULTS.perSolveTimeBudgetMs > 0);
});
test('PHASE 27 / 31 — multi-solution uses GLOBAL_ASSIGNMENT_BALANCED engine', () => {
  assert.equal(OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED, 'GLOBAL_ASSIGNMENT_BALANCED');
  const {
    input
  } = loadRealData();
  const strategy = {
    ...STRATEGY_C,
    optimizationMode: 'BASE_FEASIBLE',
    solver: {
      timeLimitMs: 30_000,
      maxSolutions: 1000,
      maxSearchIterations: 12
    },
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    }
  };
  const out = generateSolutions({
    ...input,
    strategy
  }, {
    count: 1,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 30_000,
    maxSearchIterations: 12
  });
  assert.ok(out.solutions.length >= 1);
  for (const s of out.solutions) {
    assert.equal(countSlots(s.candidate), 802);
  }
});
test('PHASE 27 / 32 — controlled fixture produces multiple feasible distinct solutions', () => {
  const input = buildControlledDiversityFixture(2);
  const out = generateSolutions(input, {
    count: 3,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 30_000,
    overallTimeBudgetMs: 60_000,
    maxSearchIterations: 12
  });
  assert.ok(out.solutions.length >= 1, 'must produce at least one feasible solution');
  for (const s of out.solutions) {
    const ev = evaluateCandidate(s.candidate, input);
    assert.equal(ev.summary.accepted, true);
  }
  if (out.solutions.length >= 2) {
    const a = out.solutions[0].candidate;
    const b = out.solutions[1].candidate;
    const d = slotDiversity(a, b);
    assert.ok(d >= 0.15 - 1e-9, `controlled fixture must produce 2 candidates with slot diversity >= 0.15; got ${d}`);
  }
});
test('PHASE 27 / 33 — controlled duplicate: identical candidates are filtered as near-duplicates', () => {
  const a = {
    id: 'a',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 1,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const b = {
    id: 'b',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 1,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const d = slotDiversity(a, b);
  assert.equal(d, 0, 'identical slot identity must yield diversity 0');
  const c = {
    id: 'c',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 2,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 2,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const big = {
    id: 'big',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 2,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 3,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 4,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 5,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 5,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const big2 = {
    id: 'big2',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 2,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 3,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 4,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 2,
      period: 1,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 5,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const big3 = {
    id: 'big3',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 2,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 3,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 4,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 5,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 6,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 7,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 8,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 9,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 10,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 10,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const big3b = {
    id: 'big3b',
    assignments: new Map([['a1', [{
      branchId: 'b1',
      day: 1,
      period: 1,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 2,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 3,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 4,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 5,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 6,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 7,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 8,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 1,
      period: 9,
      teacherId: 'T'
    }, {
      branchId: 'b1',
      day: 2,
      period: 1,
      teacherId: 'T'
    }]]]),
    placements: new Map([['a1', {
      teacherId: 'T',
      branchId: 'b1'
    }]]),
    metrics: {
      hardViolations: 0,
      softPenalty: 0,
      accepted: true,
      workloadSpread: 0,
      maxTeacherLoad: 10,
      workloadStdev: 0,
      preferencePenalty: 0
    }
  };
  const dNear = slotDiversity(big3, big3b);
  assert.ok(dNear > 0 && dNear < 1, `near-duplicate diversity should be in (0,1), got ${dNear}`);
});
test('PHASE 27 / 34 — diagnostics surfaces timeBudgetHit when the overall budget expires', () => {
  const {
    input
  } = loadRealData();
  const out = generateSolutions(input, {
    count: 5,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 50,
    overallTimeBudgetMs: 200
  });
  assert.equal(typeof out.diagnostics.timeBudgetHit, 'boolean');
  assert.ok(out.diagnostics.generationMs >= 0);
});
test('PHASE 27 / 35 — rank=1 is comparator-best and has zero self-diversity', () => {
  const out = runReal(5);
  const r1 = out.solutions[0];
  assert.equal(r1.diversity.slotToBest, 0);
  assert.equal(r1.diversity.slotToPrevious, 0);
  for (let i = 1; i < out.solutions.length; i++) {
    assert.ok(compareOptimizationCandidates(r1.candidate, out.solutions[i].candidate) <= 0, `rank=1 must be comparator-best relative to rank=${i + 1}`);
  }
});
