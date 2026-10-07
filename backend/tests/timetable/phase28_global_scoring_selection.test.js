import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { STRATEGY_C } from '../../src/modules/timetable/engine/domain/strategies.js';
import { generateSolutions, qualityScore as phase27QualityScore } from '../../src/modules/timetable/engine/domain/multi-solution.js';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { diversity as slotDiversity } from '../../src/modules/timetable/engine/domain/diversity.js';
import { GLOBAL_SCORING_DEFAULTS, DIMENSION_CATALOG, getDimension, listActiveDimensions, scoreCandidate, scorePool, selectFinalSolutions, validateWeights, qualityScore as gsQualityScore } from '../../src/modules/timetable/engine/domain/global-scoring.js';
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
const POOL_SEARCH_ITERATIONS = 5;
const REAL_POOL_3 = loadRealPool(3);
const REAL_POOL_5 = loadRealPool(5);
const REAL_POOL_10 = loadRealPool(10);
function loadRealPool(count) {
  const {
    input
  } = loadRealData();
  const generated = generateSolutions(input, {
    count,
    seed: 0xC0FFEE,
    perSolveTimeBudgetMs: 30_000,
    overallTimeBudgetMs: 300_000,
    maxSearchIterations: POOL_SEARCH_ITERATIONS
  });
  assert.notEqual(generated.diagnostics.searchStoppedBy.includes('TIME_BUDGET'), true, `the ${count}-solution pool was truncated by the wall clock ` + `(${generated.diagnostics.searchStoppedBy.join(', ')}); ` + 'every test in this file would be reading a short pool');
  assert.equal(generated.solutions.length, count, `the ${count}-solution pool must hold ${count} candidates, got ${generated.solutions.length}`);
  return {
    input,
    generated,
    candidates: generated.solutions.map(s => s.candidate)
  };
}
function buildSyntheticCandidate({
  id = `syn-${Math.random().toString(36).slice(2, 10)}`,
  workloadSpread = 12,
  maxTeacherLoad = 24,
  workloadStdev = 3.0,
  preferencePenalty = 0,
  changedAssignments = 0,
  hardViolations = 0,
  slots = [{
    day: 1,
    period: 1,
    branchId: 'b1',
    teacherId: 'TA'
  }]
} = {}) {
  const assignments = new Map();
  for (let i = 0; i < slots.length; i++) {
    assignments.set(`A${i}`, [slots[i]]);
  }
  const teacherCount = new Set(slots.map(s => s.teacherId)).size;
  const totalPeriods = slots.length;
  return {
    id,
    strategyId: 'SYNTHETIC',
    assignments,
    placements: new Map(),
    metrics: {
      hardViolations,
      softPenalty: 0,
      accepted: hardViolations === 0,
      teacherCount,
      totalPeriods,
      maxTeacherLoad,
      minTeacherLoad: totalPeriods,
      averageTeacherLoad: totalPeriods / Math.max(1, teacherCount),
      workloadSpread,
      workloadStdev,
      preferencePenalty,
      changedAssignments,
      changedFraction: 0,
      totalSoftCost: 0
    },
    diagnostics: {
      hardViolationCount: hardViolations
    },
    transfers: []
  };
}
test('PHASE 28 / 1 — scorer is deterministic (same input → same score)', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 16
  });
  const pool = [c1, c2];
  const s1 = scoreCandidate(c1, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: c1
  });
  const s2 = scoreCandidate(c1, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: c1
  });
  assert.equal(s1.total, s2.total);
  assert.equal(s1.feasibility, s2.feasibility);
  assert.equal(s1.qualityScore, s2.qualityScore);
  for (const id of Object.keys(s1.dimensions)) {
    assert.equal(s1.dimensions[id].raw, s2.dimensions[id].raw);
    assert.equal(s1.dimensions[id].normalized, s2.dimensions[id].normalized);
    assert.equal(s1.dimensions[id].contribution, s2.dimensions[id].contribution);
  }
});
test('PHASE 28 / 2 — scorer is pure (does not mutate candidate, input, or pool)', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 16
  });
  const pool = [c1, c2];
  const c1Snapshot = JSON.parse(JSON.stringify({
    ...c1,
    assignments: [...c1.assignments.entries()]
  }));
  const c2Snapshot = JSON.parse(JSON.stringify({
    ...c2,
    assignments: [...c2.assignments.entries()]
  }));
  const poolSnapshot = pool.slice();
  for (let i = 0; i < 5; i++) {
    scoreCandidate(c1, {
      input: null,
      pool,
      config: GLOBAL_SCORING_DEFAULTS,
      bestCandidate: c1
    });
    scorePool(pool, null, GLOBAL_SCORING_DEFAULTS);
  }
  assert.equal(c1.id, c1Snapshot.id);
  assert.equal(c1.metrics.workloadSpread, c1Snapshot.metrics.workloadSpread);
  assert.equal(c1.assignments.size, c1Snapshot.assignments.length);
  assert.equal(c2.id, c2Snapshot.id);
  assert.equal(c2.metrics.workloadSpread, c2Snapshot.metrics.workloadSpread);
  assert.equal(c2.assignments.size, c2Snapshot.assignments.length);
  assert.equal(pool.length, poolSnapshot.length);
});
test('PHASE 28 / 3 — infeasible candidate (hardViolations > 0) is never selected', () => {
  const good = buildSyntheticCandidate({
    id: 'good',
    workloadSpread: 12,
    hardViolations: 0
  });
  const bad = buildSyntheticCandidate({
    id: 'bad',
    workloadSpread: 4,
    hardViolations: 3
  });
  const sel = selectFinalSolutions([good, bad], {
    count: 5
  });
  for (const s of sel.solutions) {
    assert.notEqual(s.id, 'bad', `infeasible candidate must not be selected (got ${s.id})`);
    assert.equal(s.scoring.feasibility, 'FEASIBLE');
    assert.equal(s.scoring.hardViolations, 0);
  }
  assert.ok(sel.diagnostics.rejectedInfeasible >= 1);
});
test('PHASE 28 / 4 — every dimension has an explicit MINIMIZE or MAXIMIZE direction', () => {
  for (const d of DIMENSION_CATALOG) {
    assert.ok(d.direction === 'MINIMIZE' || d.direction === 'MAXIMIZE', `dimension ${d.id} must have direction MINIMIZE or MAXIMIZE, got ${d.direction}`);
    assert.ok(typeof d.id === 'string' && d.id.length > 0, 'dimension id must be a non-empty string');
    assert.ok(typeof d.source === 'function', `dimension ${d.id} must have a source function`);
    assert.ok(typeof d.active === 'function', `dimension ${d.id} must have an active predicate`);
    assert.ok(typeof d.defaultWeight === 'number', `dimension ${d.id} must have a numeric defaultWeight`);
  }
  for (const id of ['WORKLOAD_BALANCE', 'MAX_TEACHER_LOAD', 'WORKLOAD_STDEV', 'PREFERENCE', 'STRUCTURAL_DIVERSITY']) {
    const d = getDimension(id);
    assert.ok(d, `dimension ${id} must exist`);
  }
});
test('PHASE 28 / 5 — MINIMIZE normalization: best raw → highest normalized', () => {
  const a = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 8
  });
  const b = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 12
  });
  const c = buildSyntheticCandidate({
    id: 'C',
    workloadSpread: 20
  });
  const pool = [a, b, c];
  const sA = scoreCandidate(a, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: a
  });
  const sB = scoreCandidate(b, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: a
  });
  const sC = scoreCandidate(c, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: a
  });
  assert.equal(sA.dimensions.WORKLOAD_BALANCE.normalized, 1.0);
  assert.equal(sC.dimensions.WORKLOAD_BALANCE.normalized, 0.0);
  assert.ok(sB.dimensions.WORKLOAD_BALANCE.normalized > 0 && sB.dimensions.WORKLOAD_BALANCE.normalized < 1);
  assert.ok(Math.abs(sB.dimensions.WORKLOAD_BALANCE.normalized - (1 - (12 - 8) / (20 - 8))) < 1e-9);
});
test('PHASE 28 / 6 — MAXIMIZE normalization: best raw → highest normalized', () => {
  const aSlots = [{
    day: 1,
    period: 1,
    branchId: 'b1',
    teacherId: 'TA'
  }];
  const bSlots = [{
    day: 1,
    period: 1,
    branchId: 'b1',
    teacherId: 'TA'
  }, {
    day: 1,
    period: 2,
    branchId: 'b1',
    teacherId: 'TB'
  }];
  const cSlots = [{
    day: 1,
    period: 1,
    branchId: 'b1',
    teacherId: 'TA'
  }, {
    day: 1,
    period: 2,
    branchId: 'b1',
    teacherId: 'TB'
  }, {
    day: 1,
    period: 3,
    branchId: 'b1',
    teacherId: 'TC'
  }];
  const a = buildSyntheticCandidate({
    id: 'A',
    slots: aSlots
  });
  const b = buildSyntheticCandidate({
    id: 'B',
    slots: bSlots
  });
  const c = buildSyntheticCandidate({
    id: 'C',
    slots: cSlots
  });
  const pool = [a, b, c];
  const sA = scoreCandidate(a, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: a
  });
  const sC = scoreCandidate(c, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: a
  });
  assert.equal(sA.dimensions.STRUCTURAL_DIVERSITY.raw, 0);
  assert.ok(sC.dimensions.STRUCTURAL_DIVERSITY.raw >= sA.dimensions.STRUCTURAL_DIVERSITY.raw, `C's structural diversity (${sC.dimensions.STRUCTURAL_DIVERSITY.raw}) should be >= A's (${sA.dimensions.STRUCTURAL_DIVERSITY.raw})`);
});
test('PHASE 28 / 7 — zero-range (degenerate) normalization is safe (no NaN / Infinity)', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 12
  });
  const c3 = buildSyntheticCandidate({
    id: 'C',
    workloadSpread: 12
  });
  const pool = [c1, c2, c3];
  const scores = pool.map(c => scoreCandidate(c, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: c1
  }));
  for (const s of scores) {
    assert.ok(Number.isFinite(s.total), `total must be finite, got ${s.total}`);
    assert.ok(!Number.isNaN(s.total), `total must not be NaN, got ${s.total}`);
    assert.ok(s.total >= 0 && s.total <= 1, `total must be in [0, 1], got ${s.total}`);
    for (const id of Object.keys(s.dimensions)) {
      const d = s.dimensions[id];
      if (d.active) {
        assert.ok(Number.isFinite(d.normalized), `${id}.normalized must be finite, got ${d.normalized}`);
        assert.ok(!Number.isNaN(d.normalized), `${id}.normalized must not be NaN`);
      }
    }
    assert.equal(s.dimensions.WORKLOAD_BALANCE.normalized, 0.5);
  }
});
test('PHASE 28 / 8 — weight validation: valid weights accepted; invalid rejected', () => {
  const ok = validateWeights({
    WORKLOAD_BALANCE: 1.0,
    MAX_TEACHER_LOAD: 0.5,
    WORKLOAD_STDEV: 0.3,
    PREFERENCE: 0.0
  });
  assert.equal(ok.ok, true);
  const neg = validateWeights({
    WORKLOAD_BALANCE: -0.5
  });
  assert.equal(neg.ok, false);
  assert.equal(neg.dimension, 'WORKLOAD_BALANCE');
  const nan = validateWeights({
    WORKLOAD_BALANCE: Number.NaN
  });
  assert.equal(nan.ok, false);
  const inf = validateWeights({
    WORKLOAD_BALANCE: Number.POSITIVE_INFINITY
  });
  assert.equal(inf.ok, false);
  const str = validateWeights('not an object');
  assert.equal(str.ok, false);
  const nul = validateWeights(null);
  assert.equal(nul.ok, false);
});
test('PHASE 28 / 9 — all-zero weights produce a deterministic zero global score', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 16
  });
  const pool = [c1, c2];
  const cfg = {
    ...GLOBAL_SCORING_DEFAULTS,
    weights: {
      WORKLOAD_BALANCE: 0,
      MAX_TEACHER_LOAD: 0,
      WORKLOAD_STDEV: 0,
      PREFERENCE: 0,
      STRUCTURAL_DIVERSITY: 0,
      SLOT_DIVERSITY: 0
    }
  };
  const s1 = scoreCandidate(c1, {
    input: null,
    pool,
    config: cfg,
    bestCandidate: c1
  });
  const s2 = scoreCandidate(c2, {
    input: null,
    pool,
    config: cfg,
    bestCandidate: c1
  });
  assert.equal(s1.total, 0);
  assert.equal(s2.total, 0);
  for (const id of Object.keys(s1.dimensions)) {
    assert.equal(s1.dimensions[id].contribution, 0);
    assert.equal(s2.dimensions[id].contribution, 0);
  }
});
test('PHASE 28 / 10 — hard feasibility dominates: a hard-infeasible candidate has feasibility=INFEASIBLE', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12,
    hardViolations: 5
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 50,
    hardViolations: 0
  });
  const pool = [c1, c2];
  const s1 = scoreCandidate(c1, {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: c2
  });
  assert.equal(s1.feasibility, 'INFEASIBLE');
  assert.equal(s1.hardViolations, 5);
  assert.ok(s1.rankReason.includes('INFEASIBLE'), `rankReason must mention INFEASIBLE, got: ${s1.rankReason}`);
});
test('PHASE 28 / 11 — best-quality candidate is always rank=1 in selectFinalSolutions', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  assert.ok(sel.solutions.length >= 1);
  const rank1 = sel.solutions[0];
  for (let i = 1; i < sel.solutions.length; i++) {
    const cmp = compareOptimizationCandidates(rank1.candidate, sel.solutions[i].candidate);
    assert.ok(cmp <= 0, `rank=1 must not be worse than rank=${i + 1} (comparator returned ${cmp})`);
  }
});
test('PHASE 28 / 12 — diversity influences selection: higher diversity preferred when quality is similar', () => {
  const a = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12,
    slots: [{
      day: 1,
      period: 1,
      branchId: 'b1',
      teacherId: 'TA'
    }, {
      day: 1,
      period: 2,
      branchId: 'b1',
      teacherId: 'TA'
    }]
  });
  const b = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 12,
    slots: [{
      day: 2,
      period: 1,
      branchId: 'b1',
      teacherId: 'TB'
    }, {
      day: 2,
      period: 2,
      branchId: 'b1',
      teacherId: 'TB'
    }]
  });
  const sel = selectFinalSolutions([a, b], {
    count: 2
  });
  assert.equal(sel.solutions.length, 2);
  const slotDiv = slotDiversity(sel.solutions[0].candidate, sel.solutions[1].candidate);
  assert.ok(slotDiv > 0, `slot diversity must be > 0, got ${slotDiv}`);
});
test('PHASE 28 / 13 — slot diversity threshold (minSlotDiversity) defaults to 0.15 and is preserved', () => {
  assert.equal(GLOBAL_SCORING_DEFAULTS.minSlotDiversity, 0.15);
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  for (let i = 1; i < sel.solutions.length; i++) {
    const d = sel.solutions[i].diversity.slotToPrevious;
    assert.ok(d >= 0.15 - 1e-9, `slotToPrevious[${i}] = ${d} must be >= 0.15`);
  }
});
test('PHASE 28 / 14 — structural diversity is a different metric than slot diversity', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  for (const s of sel.solutions) {
    assert.ok('slotToBest' in s.diversity, 'slotToBest must be present');
    assert.ok('overall' in s.diversity, 'overall structural diversity must be present');
    assert.ok('teacherDay' in s.diversity, 'teacherDay must be present');
    assert.ok('sessionMix' in s.diversity, 'sessionMix must be present');
    if (s.rank > 1) {
      assert.ok(s.diversity.slotToBest >= 0 && s.diversity.slotToBest <= 1);
      assert.ok(s.diversity.overall >= 0 && s.diversity.overall <= 1);
    }
  }
});
test('PHASE 28 / 15 — TRAVEL dimension is INACTIVE when H14 = UNSUPPORTED (no travel matrix)', () => {
  const {
    input,
    candidates
  } = REAL_POOL_3;
  assert.equal(input.travelTime ?? null, null);
  const travelDim = getDimension('TRAVEL');
  assert.ok(travelDim, 'TRAVEL dimension must exist');
  assert.equal(travelDim.active(input), false, 'TRAVEL.active(input) must return false when no travel matrix is present');
  const cand = candidates[0];
  const s = scoreCandidate(cand, {
    input,
    pool: [cand],
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: cand
  });
  assert.equal(s.dimensions.TRAVEL.active, false);
  assert.equal(s.dimensions.TRAVEL.contribution, 0);
  assert.equal(s.dimensions.TRAVEL.reason.includes('H14'), true, `TRAVEL reason should mention H14, got: ${s.dimensions.TRAVEL.reason}`);
});
test('PHASE 28 / 16 — TRANSFER dimension is INACTIVE when H13 = INACTIVE (no allowedTransferBranches)', () => {
  const {
    input,
    candidates
  } = REAL_POOL_3;
  const transferDim = getDimension('TRANSFER');
  assert.ok(transferDim, 'TRANSFER dimension must exist');
  assert.equal(transferDim.active(input), false, 'TRANSFER.active(input) must return false when no teacher has allowedTransferBranches');
  const cand = candidates[0];
  const s = scoreCandidate(cand, {
    input,
    pool: [cand],
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: cand
  });
  assert.equal(s.dimensions.TRANSFER.active, false);
  assert.equal(s.dimensions.TRANSFER.contribution, 0);
  assert.equal(s.dimensions.TRANSFER.reason.includes('H13'), true, `TRANSFER reason should mention H13, got: ${s.dimensions.TRANSFER.reason}`);
});
test('PHASE 28 / 17 — CHANGED_ASSIGNMENTS dimension is REPORTING_ONLY (active=false)', () => {
  const changedDim = getDimension('CHANGED_ASSIGNMENTS');
  assert.ok(changedDim, 'CHANGED_ASSIGNMENTS dimension must exist');
  assert.equal(changedDim.active(), false);
  const c1 = buildSyntheticCandidate({
    id: 'A',
    changedAssignments: 100
  });
  const s = scoreCandidate(c1, {
    input: null,
    pool: [c1],
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: c1
  });
  assert.equal(s.dimensions.CHANGED_ASSIGNMENTS.active, false);
  assert.equal(s.dimensions.CHANGED_ASSIGNMENTS.raw, 100);
  assert.equal(s.dimensions.CHANGED_ASSIGNMENTS.contribution, 0);
  assert.ok(s.dimensions.CHANGED_ASSIGNMENTS.reason.includes('REPORTING'));
});
test('PHASE 28 / 18 — same (candidates, input, config) produce identical scores', () => {
  const c1 = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 12
  });
  const c2 = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 16
  });
  const c3 = buildSyntheticCandidate({
    id: 'C',
    workloadSpread: 20
  });
  const pool1 = [c1, c2, c3];
  const pool2 = [c1, c2, c3];
  const s1 = scorePool(pool1, null, GLOBAL_SCORING_DEFAULTS);
  const s2 = scorePool(pool2, null, GLOBAL_SCORING_DEFAULTS);
  assert.equal(s1.scores.length, s2.scores.length);
  for (let i = 0; i < s1.scores.length; i++) {
    assert.equal(s1.scores[i].total, s2.scores[i].total);
    assert.equal(s1.scores[i].qualityScore, s2.scores[i].qualityScore);
    assert.equal(s1.scores[i].feasibility, s2.scores[i].feasibility);
    for (const id of Object.keys(s1.scores[i].dimensions)) {
      assert.equal(s1.scores[i].dimensions[id].raw, s2.scores[i].dimensions[id].raw);
      assert.equal(s1.scores[i].dimensions[id].normalized, s2.scores[i].dimensions[id].normalized);
    }
  }
  assert.equal(s1.bestCandidate.id, s2.bestCandidate.id);
});
test('PHASE 28 / 19 — same candidates produce the same final selection order', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel1 = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  const sel2 = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  assert.equal(sel1.solutions.length, sel2.solutions.length);
  for (let i = 0; i < sel1.solutions.length; i++) {
    assert.equal(sel1.solutions[i].id, sel2.solutions[i].id);
    assert.equal(sel1.solutions[i].rank, sel2.solutions[i].rank);
  }
  assert.equal(sel1.diagnostics.selectedSize, sel2.diagnostics.selectedSize);
  assert.equal(sel1.diagnostics.feasibleSize, sel2.diagnostics.feasibleSize);
  assert.equal(sel1.diagnostics.rejectedInfeasible, sel2.diagnostics.rejectedInfeasible);
});
test('PHASE 28 / 20 — controlled quality/diversity fixture: selection follows documented policy', () => {
  const a = buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 4,
    slots: [{
      day: 1,
      period: 1,
      branchId: 'b1',
      teacherId: 'TA'
    }, {
      day: 1,
      period: 2,
      branchId: 'b1',
      teacherId: 'TA'
    }]
  });
  const b = buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 8,
    slots: [{
      day: 3,
      period: 5,
      branchId: 'b2',
      teacherId: 'TB'
    }, {
      day: 4,
      period: 6,
      branchId: 'b2',
      teacherId: 'TB'
    }]
  });
  const c = buildSyntheticCandidate({
    id: 'C',
    workloadSpread: 6,
    slots: [{
      day: 2,
      period: 3,
      branchId: 'b1',
      teacherId: 'TC'
    }, {
      day: 2,
      period: 4,
      branchId: 'b1',
      teacherId: 'TC'
    }]
  });
  const sel = selectFinalSolutions([a, b, c], {
    count: 3
  });
  assert.equal(sel.solutions[0].id, 'A');
  assert.equal(sel.solutions.length, 3);
  for (const s of sel.solutions) {
    assert.equal(s.scoring.feasibility, 'FEASIBLE');
  }
});
test('PHASE 28 / 21 — controlled normalization fixture: better raw metric → better normalized score', () => {
  const pool = [buildSyntheticCandidate({
    id: 'A',
    workloadSpread: 8,
    maxTeacherLoad: 20,
    workloadStdev: 2.0,
    preferencePenalty: 0.1
  }), buildSyntheticCandidate({
    id: 'B',
    workloadSpread: 12,
    maxTeacherLoad: 24,
    workloadStdev: 3.0,
    preferencePenalty: 0.2
  }), buildSyntheticCandidate({
    id: 'C',
    workloadSpread: 20,
    maxTeacherLoad: 30,
    workloadStdev: 4.0,
    preferencePenalty: 0.4
  })];
  for (const cand of pool) {
    const s = scoreCandidate(cand, {
      input: null,
      pool,
      config: GLOBAL_SCORING_DEFAULTS,
      bestCandidate: pool[0]
    });
    for (const dimId of ['WORKLOAD_BALANCE', 'MAX_TEACHER_LOAD', 'WORKLOAD_STDEV', 'PREFERENCE']) {
      const dim = s.dimensions[dimId];
      assert.ok(dim.direction === 'MINIMIZE', `${dimId} should be MINIMIZE`);
    }
  }
  const sA = scoreCandidate(pool[0], {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: pool[0]
  });
  assert.equal(sA.dimensions.WORKLOAD_BALANCE.normalized, 1.0);
  assert.equal(sA.dimensions.MAX_TEACHER_LOAD.normalized, 1.0);
  assert.equal(sA.dimensions.WORKLOAD_STDEV.normalized, 1.0);
  assert.equal(sA.dimensions.PREFERENCE.normalized, 1.0);
  const sC = scoreCandidate(pool[2], {
    input: null,
    pool,
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: pool[0]
  });
  assert.equal(sC.dimensions.WORKLOAD_BALANCE.normalized, 0.0);
  assert.equal(sC.dimensions.MAX_TEACHER_LOAD.normalized, 0.0);
  assert.equal(sC.dimensions.WORKLOAD_STDEV.normalized, 0.0);
  assert.equal(sC.dimensions.PREFERENCE.normalized, 0.0);
});
test('PHASE 28 / 22 — tie handling: identical candidates produce deterministic output', () => {
  const a = buildSyntheticCandidate({
    id: 'IDENTICAL',
    workloadSpread: 12,
    slots: [{
      day: 1,
      period: 1,
      branchId: 'b1',
      teacherId: 'TA'
    }]
  });
  const sel1 = selectFinalSolutions([a, a], {
    count: 2
  });
  const sel2 = selectFinalSolutions([a, a], {
    count: 2
  });
  assert.equal(sel1.solutions.length, sel2.solutions.length);
  for (let i = 0; i < sel1.solutions.length; i++) {
    assert.equal(sel1.solutions[i].id, sel2.solutions[i].id);
    assert.equal(sel1.solutions[i].rank, sel2.solutions[i].rank);
  }
});
test('PHASE 28 / 23 — real 10-solution pool scores successfully', () => {
  const {
    input,
    candidates,
    generated
  } = REAL_POOL_10;
  assert.ok(candidates.length >= 1, 'the pool must contain at least one candidate');
  assert.equal(candidates.length, generated.solutions.length);
  const sel = selectFinalSolutions(candidates, {
    count: 10,
    input
  });
  assert.equal(sel.solutions.length, candidates.length, 'every produced candidate must survive selection (the pool is already de-duplicated)');
  for (let i = 0; i < sel.solutions.length; i++) {
    const s = sel.solutions[i];
    assert.equal(s.rank, i + 1);
    assert.equal(s.scoring.feasibility, 'FEASIBLE');
    assert.equal(s.scoring.hardViolations, 0);
    assert.ok(s.qualityScore > 0);
    assert.ok(s.scoring.total >= 0 && s.scoring.total <= 1);
    assert.ok(s.diversity.slotToBest >= 0);
  }
  for (const s of sel.solutions) {
    for (const id of Object.keys(s.scoring.dimensions)) {
      const d = s.scoring.dimensions[id];
      if (d.active) {
        assert.ok(Number.isFinite(d.raw), `${id}.raw must be finite`);
        assert.ok(Number.isFinite(d.normalized), `${id}.normalized must be finite`);
        assert.ok(Number.isFinite(d.contribution), `${id}.contribution must be finite`);
      }
    }
  }
});
test('PHASE 28 / 24 — every final selected solution is hard-feasible (independent evaluator accepted)', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  for (const s of sel.solutions) {
    const ev = evaluateCandidate(s.candidate, input);
    assert.equal(ev.summary.accepted, true, `selected solution ${s.id} must be accepted by independent evaluator`);
    assert.equal(ev.hard.violations.length, 0);
  }
});
test('PHASE 28 / 25 — Phase 27 multi-solution generation is unchanged', () => {
  const {
    generated
  } = REAL_POOL_5;
  assert.ok(generated.solutions.length >= 1);
  for (let i = 0; i < generated.solutions.length; i++) {
    const s = generated.solutions[i];
    assert.equal(s.rank, i + 1, 'Phase 27 solutions must be rank 1..N in order');
    assert.ok(s.id.startsWith('ms-'), 'Phase 27 ids must carry the ms- prefix');
    assert.equal(s.candidate.metrics.hardViolations, 0);
  }
  const rank1 = generated.solutions[0];
  for (let i = 1; i < generated.solutions.length; i++) {
    const cmp = compareOptimizationCandidates(rank1.candidate, generated.solutions[i].candidate);
    assert.ok(cmp <= 0, `Phase 27 rank=1 must not be worse than rank=${i + 1}`);
  }
});
test('PHASE 28 / 26 — selectFinalSolutions does not mutate the input', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const inputBefore = JSON.stringify({
    ...input,
    assignments: [...(input.assignments?.entries?.() ?? [])]
  });
  const candidatesBefore = candidates.map(c => ({
    id: c.id,
    metricsKeys: Object.keys(c.metrics ?? {}).sort(),
    assignmentsSize: c.assignments?.size ?? 0
  }));
  for (let i = 0; i < 3; i++) {
    selectFinalSolutions(candidates, {
      count: 5,
      input
    });
  }
  const inputAfter = JSON.stringify({
    ...input,
    assignments: [...(input.assignments?.entries?.() ?? [])]
  });
  assert.equal(inputAfter, inputBefore);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    assert.equal(c.id, candidatesBefore[i].id);
    assert.deepEqual(Object.keys(c.metrics ?? {}).sort(), candidatesBefore[i].metricsKeys);
    assert.equal(c.assignments?.size ?? 0, candidatesBefore[i].assignmentsSize);
  }
});
test('PHASE 28 / extra / A — listActiveDimensions returns a subset of the catalog', () => {
  const {
    input
  } = loadRealData();
  const active = listActiveDimensions(input);
  assert.ok(active.length > 0);
  for (const d of active) {
    assert.ok(getDimension(d.id), `${d.id} must be in catalog`);
  }
  assert.equal(active.find(d => d.id === 'TRAVEL'), undefined);
  assert.equal(active.find(d => d.id === 'TRANSFER'), undefined);
  assert.equal(active.find(d => d.id === 'CHANGED_ASSIGNMENTS'), undefined);
});
test('PHASE 28 / extra / B — selectFinalSolutions accepts input as a top-level option', () => {
  const {
    input,
    candidates
  } = REAL_POOL_3;
  const sel = selectFinalSolutions(candidates, {
    count: 3,
    input
  });
  assert.ok(sel.solutions.length >= 1);
  for (const s of sel.solutions) {
    assert.equal(s.scoring.feasibility, 'FEASIBLE');
  }
});
test('PHASE 28 / extra / C — every dimension in the score vector has raw, normalized, weight, contribution', () => {
  const {
    input,
    candidates
  } = REAL_POOL_3;
  const cand = candidates[0];
  const s = scoreCandidate(cand, {
    input,
    pool: [cand],
    config: GLOBAL_SCORING_DEFAULTS,
    bestCandidate: cand
  });
  for (const id of Object.keys(s.dimensions)) {
    const d = s.dimensions[id];
    assert.ok('raw' in d, `${id} must have raw field`);
    assert.ok('normalized' in d, `${id} must have normalized field`);
    assert.ok('weight' in d, `${id} must have weight field`);
    assert.ok('contribution' in d, `${id} must have contribution field`);
    assert.ok('direction' in d, `${id} must have direction field`);
    assert.ok('active' in d, `${id} must have active flag`);
    assert.ok('reason' in d, `${id} must have reason field`);
  }
  let tw = 0,
    tc = 0;
  for (const id of Object.keys(s.dimensions)) {
    const d = s.dimensions[id];
    if (d.active) {
      tw += d.weight;
      tc += d.contribution;
    }
  }
  const expectedTotal = tw > 0 ? tc / tw : 0;
  assert.ok(Math.abs(s.total - expectedTotal) < 1e-9, `total=${s.total} but expected ${expectedTotal}`);
});
test('PHASE 28 / extra / D — diagnostics include h13/h14 flags and rejected list', () => {
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  assert.equal(sel.diagnostics.h14, 'UNSUPPORTED');
  assert.equal(sel.diagnostics.h13, 'ACTIVE');
  assert.ok(Array.isArray(sel.diagnostics.rejected));
  assert.ok(typeof sel.diagnostics.scoringTimeMs === 'number');
  assert.ok(typeof sel.diagnostics.totalTimeMs === 'number');
  assert.ok(sel.diagnostics.totalTimeMs >= 0);
  assert.equal(sel.diagnostics.inputSize, candidates.length);
  assert.equal(sel.diagnostics.feasibleSize, candidates.length);
  assert.equal(sel.diagnostics.selectedSize, candidates.length);
});
test('PHASE 28 / extra / E — backward-compat: __input on candidates is still read', () => {
  const {
    input,
    candidates
  } = REAL_POOL_3;
  const tagged = candidates.map(c => Object.assign(Object.create(Object.getPrototypeOf(c)), c, {
    __input: input
  }));
  const sel = selectFinalSolutions(tagged, {
    count: 3
  });
  assert.ok(sel.solutions.length >= 1);
  for (const s of sel.solutions) {
    assert.equal(s.scoring.feasibility, 'FEASIBLE');
  }
});
test('PHASE 28 / extra / F — qualityScore keeps its Phase 27 semantics; globalScore is a separate field', () => {
  for (const spread of [4, 8, 12, 16, 20, 30]) {
    const c = buildSyntheticCandidate({
      id: `spread-${spread}`,
      workloadSpread: spread,
      preferencePenalty: 0
    });
    const expected = 1 / (1 + spread);
    assert.equal(gsQualityScore(c), expected, `gsQualityScore must equal the Phase 27 formula for spread=${spread}`);
    assert.equal(phase27QualityScore(c), expected, `phase27QualityScore must be unchanged for spread=${spread}`);
    assert.equal(gsQualityScore(c), phase27QualityScore(c));
  }
  const {
    input,
    candidates
  } = REAL_POOL_5;
  const sel = selectFinalSolutions(candidates, {
    count: 5,
    input
  });
  for (const s of sel.solutions) {
    assert.ok(Number.isFinite(s.qualityScore), 'qualityScore must survive on the output');
    assert.ok(Number.isFinite(s.scoring.total), 'scoring.total must be present');
    assert.notEqual(s.qualityScore, s.scoring.total);
  }
});
