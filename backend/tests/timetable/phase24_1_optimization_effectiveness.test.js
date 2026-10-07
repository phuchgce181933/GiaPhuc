import { canWorkAtBranch } from '../../src/modules/timetable/engine/domain/transfer/transfer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { STRATEGY_C } from '../../src/modules/timetable/engine/domain/strategies.js';
import { verify } from './helpers/legacy-validator.js';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { deriveMetrics, teacherLoads, workloadAggregate, sessionPreferencePenalty } from '../../src/modules/timetable/engine/domain/metrics.js';
import { isEligibleFor } from '../../src/modules/timetable/engine/domain/eligibility.js';
function solveReal(mode, seed = 0xC0FFEE, timeLimitMs = 10_000) {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: {
      ...STRATEGY_C.diversification,
      seed
    },
    solver: {
      timeLimitMs,
      maxSolutions: 1
    }
  };
  const out = solve(input);
  return {
    out,
    input,
    full,
    solution: out.solutions[0] ?? null
  };
}
function buildLowerLoadWinsFixture({
  requiredPeriods = 5
} = {}) {
  function buildSlots(b) {
    const out = [];
    for (const day of b.schoolDays ?? [1, 2, 3, 4, 5]) {
      for (const period of b.periods ?? [1, 2, 3, 4, 5]) {
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
    id: 'A',
    hoTen: 'A',
    chuyenMon: [{
      tenChuyenMon: 'X',
      soTietTuan: 20
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'B',
    hoTen: 'B',
    chuyenMon: [{
      tenChuyenMon: 'X',
      soTietTuan: 20
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }];
  const branches = [{
    id: 'b1',
    schoolDays: [1, 2, 3, 4, 5],
    periods: [1, 2, 3, 4, 5]
  }];
  const classes = [{
    id: 'c1',
    branchId: 'b1'
  }, {
    id: 'c2',
    branchId: 'b1'
  }];
  const assignments = [{
    id: 'A1',
    classId: 'c1',
    subjectId: 'X',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods
  }, {
    id: 'A2',
    classId: 'c2',
    subjectId: 'X',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods
  }];
  return {
    teachers,
    branches,
    classes,
    subjects: [{
      id: 'X',
      name: 'X'
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
    missingData: []
  };
}
function buildGreedyLocalFixture() {
  function buildSlots(b) {
    const out = [];
    for (const day of b.schoolDays ?? [1, 2, 3, 4, 5]) {
      for (const period of b.periods ?? [1, 2, 3, 4, 5]) {
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
    id: 'A',
    hoTen: 'A',
    chuyenMon: [{
      tenChuyenMon: 'X',
      soTietTuan: 20
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'B',
    hoTen: 'B',
    chuyenMon: [{
      tenChuyenMon: 'X',
      soTietTuan: 20
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }];
  const branches = [{
    id: 'b1',
    schoolDays: [1, 2, 3, 4, 5],
    periods: [1, 2, 3, 4, 5]
  }];
  const classes = [{
    id: 'c1',
    branchId: 'b1'
  }, {
    id: 'c2',
    branchId: 'b1'
  }, {
    id: 'c3',
    branchId: 'b1'
  }];
  const assignments = [{
    id: 'A1',
    classId: 'c1',
    subjectId: 'X',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods: 5
  }, {
    id: 'A2',
    classId: 'c2',
    subjectId: 'X',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods: 5
  }, {
    id: 'A3',
    classId: 'c3',
    subjectId: 'X',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods: 5
  }];
  return {
    teachers,
    branches,
    classes,
    subjects: [{
      id: 'X',
      name: 'X'
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
    missingData: []
  };
}
function runFixture(input, mode, seed = 0xC0FFEE) {
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: {
      ...STRATEGY_C.diversification,
      seed
    },
    solver: {
      timeLimitMs: 5_000,
      maxSolutions: 1
    }
  };
  return solve(input);
}
function loadsOf(sol) {
  return teacherLoads(sol);
}
test('PHASE 24.1 / 1 — comparator direction: lower projected load wins (controlled fixture)', () => {
  const input = buildLowerLoadWinsFixture({
    requiredPeriods: 5
  });
  const out = runFixture(input, 'ASSIGNMENT_BALANCED');
  const sol = out.solutions[0];
  const loads = loadsOf(sol);
  assert.equal(loads.get('A') ?? 0, 5, 'A picks the second assignment (lower projected load wins)');
  assert.equal(loads.get('B') ?? 0, 5, 'B picks the first assignment (tiebreak i DESC)');
  const a1 = sol.placements.get('A1');
  const a2 = sol.placements.get('A2');
  assert.equal(a1.teacherId, 'B', 'A1 goes to B (tiebreak i DESC)');
  assert.equal(a2.teacherId, 'A', 'A2 goes to A (lower projected load)');
});
test('PHASE 24.1 / 2 — workloadSpread reporting is correct (metric is derived, not optimized)', () => {
  const input = buildLowerLoadWinsFixture({
    requiredPeriods: 2
  });
  const out = runFixture(input, 'ASSIGNMENT_BALANCED');
  const sol = out.solutions[0];
  const loads = loadsOf(sol);
  const agg = workloadAggregate(loads);
  assert.equal(loads.get('A') ?? 0, 2, 'A picks A2 (lower projected load)');
  assert.equal(loads.get('B') ?? 0, 2, 'B picks A1 (tiebreak i DESC)');
  assert.equal(agg.workloadSpread, 0);
});
test('PHASE 24.1 / 3 — comparator prefers teacher with lower projected load', () => {
  function buildAsymmetric() {
    function buildSlots(b) {
      const out = [];
      for (const day of b.schoolDays ?? [1, 2, 3, 4, 5]) {
        for (const period of b.periods ?? [1, 2, 3, 4, 5]) {
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
      id: 'A',
      hoTen: 'A',
      chuyenMon: [{
        tenChuyenMon: 'X',
        soTietTuan: 20
      }],
      homeBranchId: 'b1',
      trangThai: 'active'
    }, {
      id: 'B',
      hoTen: 'B',
      chuyenMon: [{
        tenChuyenMon: 'X',
        soTietTuan: 20
      }],
      homeBranchId: 'b1',
      trangThai: 'active'
    }];
    const branches = [{
      id: 'b1',
      schoolDays: [1, 2, 3, 4, 5],
      periods: [1, 2, 3, 4, 5]
    }];
    const classes = [{
      id: 'c1',
      branchId: 'b1'
    }, {
      id: 'c2',
      branchId: 'b1'
    }];
    const assignments = [{
      id: 'A1',
      classId: 'c1',
      subjectId: 'X',
      teacherId: 'A',
      branchId: 'b1',
      requiredPeriods: 5
    }, {
      id: 'A2',
      classId: 'c2',
      subjectId: 'X',
      teacherId: 'B',
      branchId: 'b1',
      requiredPeriods: 5
    }];
    return {
      teachers,
      branches,
      classes,
      subjects: [{
        id: 'X',
        name: 'X'
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
      missingData: []
    };
  }
  const input = buildAsymmetric();
  const out = runFixture(input, 'ASSIGNMENT_BALANCED');
  const sol = out.solutions[0];
  const loads = loadsOf(sol);
  assert.equal(loads.get('A') ?? 0, 5);
  assert.equal(loads.get('B') ?? 0, 5);
});
test('PHASE 24.1 / 4 — comparator tiebreak (i DESC) is intentional and documented', () => {
  const input = buildLowerLoadWinsFixture({
    requiredPeriods: 5
  });
  const out = runFixture(input, 'ASSIGNMENT_BALANCED');
  const sol = out.solutions[0];
  const loads = loadsOf(sol);
  assert.equal(loads.get('A') ?? 0, 5, 'A picks A2 (lower projected load after A1)');
  assert.equal(loads.get('B') ?? 0, 5, 'B picks A1 (tiebreak i DESC)');
  const a1 = sol.placements.get('A1');
  const a2 = sol.placements.get('A2');
  assert.equal(a1.teacherId, 'B', 'A1: tiebreak favors B (later variant)');
  assert.equal(a2.teacherId, 'A', 'A2: lower projectedLoad favors A');
});
test('PHASE 24.1 / 5 — metrics and objective are distinct (solver does not read metrics for ranking)', () => {
  const {
    solution
  } = solveReal('ASSIGNMENT_BALANCED');
  assert.ok('workloadSpread' in solution.metrics);
  assert.ok('totalSoftCost' in solution.metrics);
  assert.ok('preferencePenalty' in solution.metrics);
  const loads = loadsOf(solution);
  const metrics = solution.metrics;
  const agg = workloadAggregate(loads);
  assert.equal(metrics.workloadSpread, agg.workloadSpread);
  assert.equal(metrics.maxTeacherLoad, agg.maxLoad);
  assert.equal(metrics.minTeacherLoad, agg.minLoad);
});
test('PHASE 24.1 / 6 — totalSoftCost = workloadSpread/avg + preferencePenalty', () => {
  const {
    solution
  } = solveReal('ASSIGNMENT_BALANCED');
  const m = solution.metrics;
  const loads = loadsOf(solution);
  const agg = workloadAggregate(loads);
  const expected = (agg.averageLoad > 0 ? agg.workloadSpread / agg.averageLoad : 0) + m.preferencePenalty;
  assert.ok(Math.abs(m.totalSoftCost - expected) < 1e-6, `totalSoftCost mismatch: ${m.totalSoftCost} vs expected ${expected}`);
});
test('PHASE 24.1 / 7 — preferencePenalty semantics: REPORTED metric, NOT optimization target', () => {
  const {
    solution,
    input
  } = solveReal('ASSIGNMENT_BALANCED');
  const m = solution.metrics;
  const recomputed = sessionPreferencePenalty(solution, input);
  assert.equal(m.preferencePenalty, recomputed);
  const base = solveReal('BASE_FEASIBLE');
  assert.equal(base.solution.metrics.preferencePenalty, sessionPreferencePenalty(base.solution, base.input));
});
test('PHASE 24.1 / 8 — deterministic comparator (same seed → same placements, all modes)', () => {
  const base1 = solveReal('BASE_FEASIBLE');
  const base2 = solveReal('BASE_FEASIBLE');
  const bal1 = solveReal('ASSIGNMENT_BALANCED');
  const bal2 = solveReal('ASSIGNMENT_BALANCED');
  for (const aId of base1.solution.assignments.keys()) {
    const s1 = base1.solution.assignments.get(aId);
    const s2 = base2.solution.assignments.get(aId);
    assert.equal(s1.length, s2.length);
    const set1 = new Set(s1.map(s => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
    for (const s of s2) assert.ok(set1.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
  }
  for (const aId of bal1.solution.assignments.keys()) {
    const s1 = bal1.solution.assignments.get(aId);
    const s2 = bal2.solution.assignments.get(aId);
    assert.equal(s1.length, s2.length);
    const set1 = new Set(s1.map(s => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
    for (const s of s2) assert.ok(set1.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
  }
});
test('PHASE 24.1 / 9 — BASE_FEASIBLE preserves complete, permitted coverage after teacher optimization', () => {
  const {
    solution,
    input,
    out
  } = solveReal('BASE_FEASIBLE');
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
  const m = solution.metrics;
  assert.equal(m.totalPeriods, 802);
  assert.equal(solution.diagnostics.hardViolationCount, 0);
  const values = [...teacherLoads(solution, input).values()];
  assert.equal(m.maxTeacherLoad, Math.max(...values));
  assert.equal(m.minTeacherLoad, Math.min(...values));
  assert.equal(m.workloadSpread, Math.max(...values) - Math.min(...values));
  const transferNeeded = new Set(out.diagnostics.branchScheduling.pendingAssignments.map(assignment => assignment.assignmentId));
  for (const [id, placement] of solution.placements) if (!transferNeeded.has(id)) {
    assert.notEqual(canWorkAtBranch(input.teacherIndex.get(placement.teacherId), placement.branchId, input.transferPolicy).status, 'NOT_ALLOWED');
  }
});
test('PHASE 24.1 / 10 — balancing changes transfer decisions after preserving the common home stage', () => {
  const {
    solution: base,
    out
  } = solveReal('BASE_FEASIBLE');
  const {
    solution: balan
  } = solveReal('ASSIGNMENT_BALANCED');
  const transferNeeded = new Set(out.diagnostics.branchScheduling.pendingAssignments.map(assignment => assignment.assignmentId));
  let changes = 0;
  for (const [aId, p] of base.placements) {
    const bp = balan.placements.get(aId);
    if (p.teacherId !== bp?.teacherId) {
      changes++;
      assert.ok(transferNeeded.has(aId), 'mode changes are confined to the demand needing transfer');
    }
  }
  assert.ok(changes > 0);
  assert.equal(balan.metrics.hardViolations, 0);
});
test('PHASE 24.1 / 11 — real candidate remains hard-feasible (BASE & BALANCED)', () => {
  for (const mode of ['BASE_FEASIBLE', 'ASSIGNMENT_BALANCED']) {
    const {
      solution,
      input
    } = solveReal(mode);
    const ev = evaluateCandidate(solution, input);
    assert.equal(ev.hard.violations.length, 0, `${mode} must be hard-feasible`);
    assert.equal(ev.summary.accepted, true);
    const v = verify(solution, input);
    assert.equal(v.accepted, true);
  }
});
test('PHASE 24.1 / 12 — real candidate deterministic across repeated runs (all modes)', () => {
  const base1 = solveReal('BASE_FEASIBLE');
  const base2 = solveReal('BASE_FEASIBLE');
  const bal1 = solveReal('ASSIGNMENT_BALANCED');
  const bal2 = solveReal('ASSIGNMENT_BALANCED');
  for (const k of ['hardViolations', 'teacherCount', 'totalPeriods', 'maxTeacherLoad', 'minTeacherLoad', 'averageTeacherLoad', 'workloadSpread', 'workloadStdev', 'preferencePenalty', 'changedAssignments', 'changedFraction', 'totalSoftCost']) {
    assert.equal(base1.solution.metrics[k], base2.solution.metrics[k], `BASE metric ${k} not deterministic`);
    assert.equal(bal1.solution.metrics[k], bal2.solution.metrics[k], `BALANCED metric ${k} not deterministic`);
  }
});
test('PHASE 24.1 / 13 — LIMITED_SEARCH: greedy local comparator does not reach global optimum', () => {
  const input = buildGreedyLocalFixture();
  const baseOut = runFixture(input, 'BASE_FEASIBLE');
  const baseLoads = loadsOf(baseOut.solutions[0]);
  assert.equal(baseLoads.get('A'), 15);
  assert.equal(baseLoads.get('B') ?? 0, 0);
  const balanOut = runFixture(input, 'ASSIGNMENT_BALANCED');
  const balanLoads = loadsOf(balanOut.solutions[0]);
  assert.ok(balanLoads.get('A') < 15, 'BALANCED must reduce A load vs BASE');
  assert.ok((balanLoads.get('B') ?? 0) > 0, 'BALANCED must give B at least 1 assignment');
  const balanAgg = workloadAggregate(balanLoads);
  assert.ok(balanAgg.workloadSpread <= 15, 'BALANCED must not exceed BASE spread');
});
test('PHASE 24.1 / 14 — deriveMetrics is pure and deterministic', () => {
  const {
    solution,
    input
  } = solveReal('ASSIGNMENT_BALANCED');
  const m1 = deriveMetrics(solution, input, null, null);
  const m2 = deriveMetrics(solution, input, null, null);
  assert.deepEqual(m1, m2);
  for (const k of ['hardViolations', 'softPenalty', 'accepted', 'teacherCount', 'totalPeriods', 'maxTeacherLoad', 'minTeacherLoad', 'averageTeacherLoad', 'workloadSpread', 'workloadStdev', 'preferencePenalty', 'changedAssignments', 'changedFraction', 'totalSoftCost']) {
    assert.ok(k in m1, `metric ${k} missing`);
  }
});
test('PHASE 24.1 / 15 — metric (workloadSpread) and objective (projectedLoad) are distinct', () => {
  const {
    solution
  } = solveReal('ASSIGNMENT_BALANCED');
  const m = solution.metrics;
  assert.equal(m.workloadSpread, m.maxTeacherLoad - m.minTeacherLoad);
  for (const k of Object.keys(m)) {
    assert.ok(!k.toLowerCase().includes('projected'), 'metrics object must not expose projectedLoad (it is per-step, internal)');
  }
});
test('PHASE 24.1 / 16 — summary: metrics match actual loads under explicit transfer permission', () => {
  const {
    solution: base
  } = solveReal('BASE_FEASIBLE');
  const {
    solution: balan
  } = solveReal('ASSIGNMENT_BALANCED');
  for (const solution of [base, balan]) {
    const values = [...teacherLoads(solution).values()];
    assert.equal(solution.metrics.maxTeacherLoad, Math.max(...values));
    assert.equal(solution.metrics.minTeacherLoad, Math.min(...values));
    assert.equal(solution.metrics.workloadSpread, Math.max(...values) - Math.min(...values));
    assert.equal(solution.metrics.totalPeriods, 802);
    assert.equal(solution.metrics.hardViolations, 0);
  }
  assert.ok(true, 'Audit verdict: LIMITED_SEARCH (comparator correct, search greedy-local)');
});
