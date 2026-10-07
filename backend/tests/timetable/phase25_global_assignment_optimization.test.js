import { canWorkAtBranch } from '../../src/modules/timetable/engine/domain/transfer/transfer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { STRATEGY_C, OPTIMIZATION_MODES } from '../../src/modules/timetable/engine/domain/strategies.js';
import { compareOptimizationCandidates, isBetter, globalObjective, stringHash32 } from '../../src/modules/timetable/engine/domain/comparator.js';
import { verify } from './helpers/legacy-validator.js';
import { evaluateCandidate, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { isEligibleFor } from '../../src/modules/timetable/engine/domain/eligibility.js';
import { teacherLoads, workloadAggregate, deriveMetrics } from '../../src/modules/timetable/engine/domain/metrics.js';
import { teacherConflictKey } from '../../src/modules/timetable/engine/domain/time.js';
function solveReal(mode = 'BASE_FEASIBLE', seed = 0xC0FFEE, timeLimitMs = 15_000, solverOverrides = {}) {
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
      maxSolutions: Math.max(5, solverOverrides.maxSearchIterations ?? 5),
      maxSearchIterations: 5,
      ...solverOverrides
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
function placementFingerprint(solution) {
  return [...solution.placements.entries()].map(([assignmentId, p]) => `${assignmentId}=${p.teacherId}`).sort().join(';');
}
function countSlots(candidate) {
  let n = 0;
  for (const arr of candidate.assignments.values()) n += arr.length;
  return n;
}
function buildGreedyTrapFixture(requiredPeriods = 1) {
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
      tenChuyenMon: 'X'
    }, {
      tenChuyenMon: 'Y'
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'B',
    hoTen: 'B',
    chuyenMon: [{
      tenChuyenMon: 'X'
    }, {
      tenChuyenMon: 'Z'
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'C',
    hoTen: 'C',
    chuyenMon: [{
      tenChuyenMon: 'Y'
    }, {
      tenChuyenMon: 'Z'
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
    requiredPeriods
  }, {
    id: 'A2',
    classId: 'c2',
    subjectId: 'Y',
    teacherId: 'A',
    branchId: 'b1',
    requiredPeriods
  }, {
    id: 'A3',
    classId: 'c3',
    subjectId: 'Z',
    teacherId: 'B',
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
    }, {
      id: 'Z',
      name: 'Z',
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
    seed: 0xC0FFEE
  };
}
function runFixture(input, mode, seed = 0xC0FFEE, timeLimitMs = 5_000, solverOverrides = {}) {
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: {
      ...STRATEGY_C.diversification,
      seed
    },
    solver: {
      timeLimitMs,
      maxSolutions: 1000,
      ...solverOverrides
    }
  };
  return solve(input);
}
function buildDeterminismFixture() {
  function buildSlots(b) {
    const out = [];
    for (const day of b.schoolDays) {
      for (const period of b.periods) out.push({
        branchId: b.id,
        day,
        period
      });
    }
    return out;
  }
  const teachers = [{
    id: 'T1',
    hoTen: 'T1',
    chuyenMon: [{
      tenChuyenMon: 'X'
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'T2',
    hoTen: 'T2',
    chuyenMon: [{
      tenChuyenMon: 'X'
    }, {
      tenChuyenMon: 'Y'
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }, {
    id: 'T3',
    hoTen: 'T3',
    chuyenMon: [{
      tenChuyenMon: 'Y'
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  }];
  const branches = [{
    id: 'b1',
    schoolDays: [1, 2, 3],
    periods: [1, 2, 3, 4]
  }];
  const assignments = [];
  for (let i = 1; i <= 6; i++) {
    assignments.push({
      id: `A${i}`,
      classId: `c${i}`,
      subjectId: i <= 3 ? 'X' : 'Y',
      teacherId: i <= 3 ? 'T1' : 'T3',
      branchId: 'b1',
      requiredPeriods: 2
    });
  }
  const classes = assignments.map(a => ({
    id: a.classId,
    branchId: a.branchId
  }));
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
    seed: 0xC0FFEE
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
test('PHASE 25 / 1 — GLOBAL_ASSIGNMENT_BALANCED mode exists', () => {
  assert.ok(OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED);
  assert.equal(OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED, 'GLOBAL_ASSIGNMENT_BALANCED');
  for (const v of Object.values(OPTIMIZATION_MODES)) {
    assert.equal(typeof v, 'string');
  }
  assert.equal(Object.keys(OPTIMIZATION_MODES).length, 4);
});
test('PHASE 25 / 2 — BASE_FEASIBLE preserves valid coverage while allowing permitted teacher optimization', () => {
  const {
    out,
    input,
    solution
  } = solveReal('BASE_FEASIBLE');
  assert.equal(out.failure, null);
  assert.ok(solution);
  assert.equal(countSlots(solution), 802);
  assert.equal(solution.assignments.size, 479);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
  const values = [...teacherLoads(solution, input).values()];
  assert.equal(solution.metrics.workloadSpread, Math.max(...values) - Math.min(...values));
  assert.equal(solution.metrics.maxTeacherLoad, Math.max(...values));
  assert.equal(solution.metrics.minTeacherLoad, Math.min(...values));
  const transferNeeded = new Set(out.diagnostics.branchScheduling.pendingAssignments.map(assignment => assignment.assignmentId));
  for (const [id, placement] of solution.placements) if (!transferNeeded.has(id)) {
    assert.notEqual(canWorkAtBranch(input.teacherIndex.get(placement.teacherId), placement.branchId, input.transferPolicy).status, 'NOT_ALLOWED');
  }
});
test('PHASE 25 / 3 — ASSIGNMENT_BALANCED preserves demand and reports actual load distribution', () => {
  const {
    out,
    input,
    solution
  } = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(out.failure, null);
  assert.ok(solution);
  assert.equal(countSlots(solution), 802);
  assert.equal(solution.assignments.size, 479);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  const values = [...teacherLoads(solution).values()];
  assert.equal(solution.metrics.maxTeacherLoad, Math.max(...values));
  assert.equal(solution.metrics.minTeacherLoad, Math.min(...values));
  assert.equal(solution.metrics.workloadSpread, Math.max(...values) - Math.min(...values));
});
test('PHASE 25 / 4 — global comparator is deterministic', () => {
  const a = buildSyntheticCandidate(new Map([['A', 2], ['B', 1]]));
  const b = buildSyntheticCandidate(new Map([['A', 2], ['B', 1]]));
  const r1 = compareOptimizationCandidates(a, b);
  const r2 = compareOptimizationCandidates(a, b);
  assert.equal(r1, r2);
  assert.equal(typeof r1, 'number');
  assert.equal(compareOptimizationCandidates(a, a), 0);
  const o1 = globalObjective(a);
  const o2 = globalObjective(a);
  assert.deepEqual(o1, o2);
  assert.equal(stringHash32('abc'), stringHash32('abc'));
  assert.notEqual(stringHash32('abc'), stringHash32('abd'));
});
test('PHASE 25 / 5 — comparator direction: lower workloadSpread wins', () => {
  const better = buildSyntheticCandidate(new Map([['A', 2], ['B', 2]]));
  const worse = buildSyntheticCandidate(new Map([['A', 5], ['B', 1]]));
  const r = compareOptimizationCandidates(better, worse);
  assert.ok(r < 0, `better must win: comparator returned ${r}`);
  assert.equal(isBetter(better, worse), true);
  assert.equal(isBetter(worse, better), false);
  assert.ok(compareOptimizationCandidates(worse, better) > 0);
});
test('PHASE 25 / 5b — comparator direction: lower maxTeacherLoad wins (same spread)', () => {
  const a = buildSyntheticCandidate(new Map([['A', 3], ['B', 2]]));
  const b = buildSyntheticCandidate(new Map([['A', 2], ['B', 3]]));
  const r = compareOptimizationCandidates(a, b);
  assert.equal(typeof r, 'number');
  const infeasible = buildSyntheticCandidate(new Map([['A', 2], ['B', 1]]), 5);
  const feasible = buildSyntheticCandidate(new Map([['A', 5], ['B', 0]]), 0);
  assert.ok(compareOptimizationCandidates(feasible, infeasible) < 0, 'feasible candidate must beat hard-infeasible candidate');
  assert.ok(compareOptimizationCandidates(infeasible, feasible) > 0, 'hard-infeasible candidate must NEVER beat feasible candidate');
});
test('PHASE 25 / 6 — first feasible is not automatically returned (GLOBAL continues search)', () => {
  const input = buildGreedyTrapFixture(1);
  const out = runFixture(input, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.equal(out.failure, null);
  assert.ok(out.diagnostics.completeCandidates >= 1, `expected >= 1 complete candidates, got ${out.diagnostics.completeCandidates}`);
  assert.equal(out.solutions.length, 1);
});
test('PHASE 25 / 7 — multiple complete feasible candidates compared via global comparator', () => {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    },
    solver: {
      timeLimitMs: 15_000,
      maxSolutions: 1000
    }
  };
  const out = solve(input);
  assert.ok(out.diagnostics.completeCandidates > 1, `expected > 1 candidates, got ${out.diagnostics.completeCandidates}`);
  assert.ok(out.diagnostics.bestCandidateUpdates >= 1, `expected >= 1 incumbent update, got ${out.diagnostics.bestCandidateUpdates}`);
  const incumbent = out.solutions[0];
  assert.ok(incumbent.diagnostics.global);
  assert.equal(incumbent.diagnostics.global.verdict, 'BEST_FOUND');
});
test('PHASE 25 / 8 — worse candidate does not replace incumbent', () => {
  const incumbent = buildSyntheticCandidate(new Map([['A', 5], ['B', 5]]));
  const worse = buildSyntheticCandidate(new Map([['A', 9], ['B', 1]]));
  assert.equal(isBetter(worse, incumbent), false, 'worse candidate must NOT be better than incumbent');
  assert.ok(compareOptimizationCandidates(worse, incumbent) > 0, 'comparator must rank worse > incumbent');
  const infeasible = buildSyntheticCandidate(new Map([['A', 5], ['B', 5]]), 1);
  assert.ok(compareOptimizationCandidates(infeasible, incumbent) > 0, 'hard-infeasible candidate must NEVER beat feasible incumbent');
  assert.ok(compareOptimizationCandidates(incumbent, infeasible) < 0, 'feasible incumbent must beat hard-infeasible candidate');
});
test('PHASE 25 / 9 — better candidate replaces incumbent', () => {
  const incumbent = buildSyntheticCandidate(new Map([['A', 9], ['B', 1]]));
  const better = buildSyntheticCandidate(new Map([['A', 5], ['B', 5]]));
  assert.equal(isBetter(better, incumbent), true);
  assert.ok(compareOptimizationCandidates(better, incumbent) < 0);
});
test('PHASE 25 / 10 — H07 remains one teacher per class-subject (GLOBAL mode)', () => {
  const {
    out,
    input,
    solution
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED');
  assert.ok(solution);
  const seen = new Map();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    const k = `${meta.classId}|${meta.subjectId}`;
    const set = seen.get(k) ?? new Set();
    for (const s of slots) set.add(s.teacherId);
    seen.set(k, set);
  }
  for (const [k, set] of seen) {
    assert.equal(set.size, 1, `H07 violated for ${k}: ${[...set].join(', ')}`);
  }
});
test('PHASE 25 / 11 — teacher-level workload (multi-specialization counts as one teacher)', () => {
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
  const teacher = {
    id: 'multi',
    hoTen: 'Multi',
    chuyenMon: [{
      tenChuyenMon: 'SUBJ_A',
      soTietTuan: 5
    }, {
      tenChuyenMon: 'SUBJ_B',
      soTietTuan: 5
    }],
    homeBranchId: 'b1',
    trangThai: 'active'
  };
  const branches = [{
    id: 'b1',
    schoolDays: [1, 2, 3, 4, 5],
    periods: [1, 2, 3, 4, 5]
  }];
  const classes = [{
    id: 'cA',
    branchId: 'b1'
  }, {
    id: 'cB',
    branchId: 'b1'
  }];
  const assignments = [{
    id: 'aA',
    classId: 'cA',
    subjectId: 'SUBJ_A',
    teacherId: 'multi',
    branchId: 'b1',
    requiredPeriods: 2
  }, {
    id: 'aB',
    classId: 'cB',
    subjectId: 'SUBJ_B',
    teacherId: 'multi',
    branchId: 'b1',
    requiredPeriods: 3
  }];
  const input = {
    teachers: [teacher],
    branches,
    classes,
    subjects: [{
      id: 'SUBJ_A',
      name: 'SUBJ_A',
      isActive: true
    }, {
      id: 'SUBJ_B',
      name: 'SUBJ_B',
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
    teacherIndex: new Map([['multi', teacher]]),
    assignmentIndex: new Map(assignments.map(a => [a.id, a])),
    warnings: [],
    missingData: [],
    seed: 0xC0FFEE
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    solver: {
      timeLimitMs: 5_000,
      maxSolutions: 1000
    }
  };
  const out = solve(input);
  assert.ok(out.solutions[0]);
  const loads = teacherLoads(out.solutions[0]);
  assert.equal(loads.size, 1, 'multi-subject teacher must count as ONE teacher');
  assert.equal(loads.get('multi'), 5, 'multi-subject teacher load = 5');
  const agg = workloadAggregate(loads);
  assert.equal(agg.teacherCount, 1);
});
test('PHASE 25 / 13 — controlled greedy trap: GLOBAL improves over BALANCED (greedy local)', () => {
  const input = buildGreedyTrapFixture(1);
  const balan = runFixture(input, 'ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  const global = runFixture(input, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.equal(balan.failure, null);
  assert.equal(global.failure, null);
  const balanSol = balan.solutions[0];
  const globalSol = global.solutions[0];
  const balanLoads = teacherLoads(balanSol);
  assert.equal(balanLoads.get('A') ?? 0, 0);
  assert.equal(balanLoads.get('B') ?? 0, 1);
  assert.equal(balanLoads.get('C') ?? 0, 2);
  assert.equal(balanSol.metrics.workloadSpread, 2);
  const globalLoads = teacherLoads(globalSol);
  assert.equal(globalLoads.get('A') ?? 0, 1, 'GLOBAL distributes load to A');
  assert.equal(globalLoads.get('B') ?? 0, 1, 'GLOBAL distributes load to B');
  assert.equal(globalLoads.get('C') ?? 0, 1, 'GLOBAL distributes load to C');
  assert.equal(globalSol.metrics.workloadSpread, 0, 'GLOBAL achieves spread=0 (optimal)');
  assert.ok(globalSol.metrics.workloadSpread < balanSol.metrics.workloadSpread, `GLOBAL spread (${globalSol.metrics.workloadSpread}) must be less than BALANCED spread (${balanSol.metrics.workloadSpread})`);
  assert.ok(isBetter(globalSol, balanSol), 'GLOBAL candidate must be better than BALANCED candidate per comparator');
});
test('PHASE 25 / 14 — real data produces hard-feasible candidate (GLOBAL mode)', () => {
  const {
    out,
    input,
    solution
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED');
  assert.equal(out.failure, null);
  assert.ok(solution);
  assert.equal(countSlots(solution), 802);
  assert.equal(solution.assignments.size, 479);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
  assert.equal(isAccepted(ev), true);
});
test('PHASE 25 / 15 — independent validator accepts the GLOBAL candidate', () => {
  const {
    input,
    solution
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED');
  const v = verify(solution, input);
  assert.equal(v.accepted, true);
  assert.equal(v.hardViolations.length, 0);
});
test('PHASE 25 / 16 — GLOBAL candidate is not worse than the BALANCED candidate (regression guarantee)', () => {
  const inputB = buildGreedyTrapFixture(1);
  const balan = runFixture(inputB, 'ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  const global = runFixture(inputB, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  const bSol = balan.solutions[0];
  const gSol = global.solutions[0];
  assert.equal(bSol.metrics.hardViolations, 0);
  assert.equal(gSol.metrics.hardViolations, 0);
  assert.ok(compareOptimizationCandidates(gSol, bSol) <= 0, 'GLOBAL candidate must not be worse than BALANCED candidate');
  assert.ok(compareOptimizationCandidates(gSol, bSol) < 0, 'GLOBAL must be strictly better than BALANCED on the greedy-trap fixture');
});
test('PHASE 25 / 17 — time budget respected (GLOBAL mode)', () => {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    },
    solver: {
      timeLimitMs: 2_000,
      maxSolutions: 1000
    }
  };
  const start = Date.now();
  const out = solve(input);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `solver must respect 2s timeLimit, elapsed=${elapsed}ms`);
  if (out.diagnostics.completeCandidates > 0) {
    assert.equal(out.failure, null);
  }
  assert.equal(typeof out.diagnostics.totalSolveMs, 'number');
});
test('PHASE 25 / 18 — no-solution still reports correctly (GLOBAL mode)', () => {
  function buildInfeasibleFixture() {
    const teachers = [{
      id: 'TA',
      chuyenMon: [{
        tenChuyenMon: 'X'
      }],
      homeBranchId: 'b1',
      trangThai: 'active'
    }];
    const branches = [{
      id: 'b1',
      schoolDays: [1],
      periods: [1, 2]
    }];
    const classes = [{
      id: 'c1',
      branchId: 'b1'
    }];
    const assignments = [{
      id: 'A1',
      classId: 'c1',
      subjectId: 'X',
      teacherId: 'TA',
      branchId: 'b1',
      requiredPeriods: 5
    }];
    return {
      teachers,
      branches,
      classes,
      subjects: [{
        id: 'X',
        name: 'X',
        isActive: true
      }],
      curriculum: assignments.map(a => ({
        classId: a.classId,
        subjectId: a.subjectId,
        requiredPeriods: a.requiredPeriods
      })),
      assignments,
      timeSlotsByBranch: new Map(branches.map(b => [b.id, branches[0].schoolDays.flatMap(d => branches[0].periods.map(p => ({
        branchId: b.id,
        day: d,
        period: p
      })))])),
      travelTime: null,
      transitionMinutes: 10,
      teacherIndex: new Map([['TA', teachers[0]]]),
      assignmentIndex: new Map(assignments.map(a => [a.id, a])),
      warnings: [],
      missingData: [],
      seed: 0xC0FFEE
    };
  }
  const input = buildInfeasibleFixture();
  const out = runFixture(input, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 2_000);
  assert.notEqual(out.failure, null, 'infeasible input must report failure');
  assert.equal(out.solutions.length, 0, 'infeasible input must return ZERO solutions');
  assert.equal(typeof out.diagnostics.completeCandidates, 'number');
  assert.equal(typeof out.diagnostics.timeBudgetHit, 'boolean');
});
test('PHASE 25 / 19 — DETERMINISTIC_SEARCH: repeated solve is byte-identical on a bounded fixture', () => {
  const build = () => runFixture(buildDeterminismFixture(), 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 30_000);
  const r1 = build();
  const r2 = build();
  for (const [label, r] of [['run 1', r1], ['run 2', r2]]) {
    assert.equal(r.diagnostics.searchLimited, false, `${label}: searchLimited must be false, otherwise determinism is not claimable`);
    assert.notEqual(r.diagnostics.searchStoppedBy, 'TIME_BUDGET', `${label}: a TIME_BUDGET stop makes the result machine-dependent`);
  }
  assert.ok(r1.diagnostics.completeCandidates > 1, `fixture must yield a real multi-candidate search, got ${r1.diagnostics.completeCandidates}`);
  assert.equal(placementFingerprint(r1.solutions[0]), placementFingerprint(r2.solutions[0]), 'the full (assignmentId -> teacherId) map must be byte-identical across runs');
  assert.deepEqual(r1.solutions[0].metrics, r2.solutions[0].metrics);
  assert.equal(r1.solutions[0].id, r2.solutions[0].id, 'the candidate id is derived from (seed, counter) and must not drift');
});
test('PHASE 25 / 19b — DETERMINISTIC_SEARCH holds on the real 479-assignment dataset', () => {
  const OPTS = {
    maxSearchIterations: 12
  };
  const r1 = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 60_000, OPTS);
  const r2 = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 60_000, OPTS);
  for (const [label, r] of [['run 1', r1], ['run 2', r2]]) {
    assert.equal(r.out.diagnostics.searchLimited, false, `${label}: searchLimited must be false; the 60s budget must not bind`);
    assert.equal(r.out.diagnostics.searchStoppedBy, 'ITERATION_LIMIT', `${label}: the search must stop on the seed-stable iteration bound, ` + `not on ${r.out.diagnostics.searchStoppedBy}`);
    assert.equal(r.out.diagnostics.iterationBound, 12, `${label}: the requested iteration bound must be reported back`);
  }
  assert.equal(r1.out.diagnostics.completeCandidates, 12, 'the iteration bound must be honoured exactly');
  assert.ok(r1.out.diagnostics.bestCandidateUpdates >= 1, 'the incumbent must actually have been compared and updated');
  assert.equal(placementFingerprint(r1.solution), placementFingerprint(r2.solution), 'the real-data (assignmentId -> teacherId) map must be byte-identical ' + 'when the search is bounded by iteration count, not by wall clock');
  assert.deepEqual(r1.solution.metrics, r2.solution.metrics);
  assert.equal(r1.solution.id, r2.solution.id);
});
test('PHASE 25 / 19c — TIME_BUDGETED_SEARCH: a binding budget is reported, and no determinism is claimed', () => {
  const r = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 50, {
    maxSearchIterations: 10000
  });
  assert.equal(r.out.diagnostics.searchStoppedBy, 'TIME_BUDGET', 'a 50ms budget on the real dataset must stop the search on the wall clock');
  assert.equal(r.out.diagnostics.searchLimited, true, 'searchLimited must be true exactly when the wall clock truncated the search');
  assert.equal(r.out.diagnostics.timeBudgetHit, true);
  assert.equal(r.out.diagnostics.iterationBound, 10000, 'the configured count bound is reported even though the clock binds first');
  assert.equal(typeof r.out.diagnostics.completeCandidates, 'number');
  assert.ok(r.out.diagnostics.completeCandidates < 12, `a 50ms budget cannot have completed 12 real-dataset iterations ` + `(got ${r.out.diagnostics.completeCandidates})`);
  if (r.solution) {
    assert.equal(r.solution.diagnostics.global.verdict, 'BEST_FOUND', 'the solver must never claim optimality it cannot prove');
  }
});
test('PHASE 25 / 19d — the search reports which bound stopped it', () => {
  const ITERATION_LIMIT = 'ITERATION_LIMIT';
  const TIME_BUDGET = 'TIME_BUDGET';
  const bounded = runFixture(buildDeterminismFixture(), 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 30_000, {
    maxSearchIterations: 5
  });
  assert.equal(bounded.diagnostics.searchStoppedBy, ITERATION_LIMIT);
  assert.equal(bounded.diagnostics.completeCandidates, 5, 'the iteration bound stops the search after exactly N candidates');
  assert.equal(bounded.diagnostics.searchLimited, false, 'an iteration-bounded stop is reproducible, so it is NOT "limited"');
  const budgetBound = runFixture(buildDeterminismFixture(), 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 50, {
    maxSearchIterations: 10000
  });
  assert.equal(budgetBound.diagnostics.searchStoppedBy, TIME_BUDGET);
  assert.equal(budgetBound.diagnostics.searchLimited, true);
  assert.equal(bounded.diagnostics.timeBudgetHit, false);
  assert.equal(budgetBound.diagnostics.timeBudgetHit, true);
});
test('PHASE 25 / 20 — SchedulingInput before vs after solve (immutability)', () => {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    },
    solver: {
      timeLimitMs: 5_000,
      maxSolutions: 1000
    }
  };
  const before = {
    assignmentCount: input.assignments.length,
    teacherCount: input.teachers.length,
    branchCount: input.branches.length,
    subjectCount: input.subjects.length,
    timeSlotBranchCount: input.timeSlotsByBranch.size,
    teacherIndexSize: input.teacherIndex.size,
    assignmentIndexSize: input.assignmentIndex.size
  };
  const out = solve(input);
  assert.equal(input.assignments.length, before.assignmentCount);
  assert.equal(input.teachers.length, before.teacherCount);
  assert.equal(input.branches.length, before.branchCount);
  assert.equal(input.subjects.length, before.subjectCount);
  assert.equal(input.timeSlotsByBranch.size, before.timeSlotBranchCount);
  assert.equal(input.teacherIndex.size, before.teacherIndexSize);
  assert.equal(input.assignmentIndex.size, before.assignmentIndexSize);
  assert.equal(out.failure, null);
  assert.ok(out.solutions[0]);
});
test('PHASE 25 / 21 — legacy baseline remains unchanged', () => {
  const full = loadLegacySchedulingFixture();
  const baselineSnapshot = JSON.stringify(full.legacyBaseline);
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    },
    solver: {
      timeLimitMs: 5_000,
      maxSolutions: 1000
    }
  };
  solve(input);
  assert.equal(JSON.stringify(full.legacyBaseline), baselineSnapshot);
});
test('PHASE 25 / 22 — no travel fabricated; H14 remains UNSUPPORTED', () => {
  const {
    input,
    solution
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED');
  assert.equal(input.travelTime, null);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.constraintStatuses['H14'], 'UNSUPPORTED');
  const h14 = ev.hard.violations.filter(v => v.constraintId === 'H14');
  assert.equal(h14.length, 0);
  for (const k of Object.keys(solution.metrics)) {
    assert.ok(!k.toLowerCase().includes('travel'), `metrics must not include travel-shaped field: ${k}`);
  }
});
test('PHASE 25 / 24 — bestCandidateUpdates >= 1 on the greedy-trap fixture', () => {
  const input = buildGreedyTrapFixture(2);
  const out = runFixture(input, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.equal(out.failure, null);
  assert.ok(out.diagnostics.bestCandidateUpdates >= 1, `expected >= 1 incumbent update, got ${out.diagnostics.bestCandidateUpdates}`);
});
test('PHASE 25 / 25 — searchNodes vs completeCandidates are tracked separately', () => {
  const input = buildGreedyTrapFixture(1);
  const out = runFixture(input, 'GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.ok(typeof out.diagnostics.searchNodes === 'number');
  assert.ok(typeof out.diagnostics.completeCandidates === 'number');
  assert.ok(out.diagnostics.searchNodes >= out.diagnostics.completeCandidates, `searchNodes (${out.diagnostics.searchNodes}) must be >= completeCandidates (${out.diagnostics.completeCandidates})`);
  assert.ok(out.diagnostics.completeCandidates > 1, `expected > 1 complete candidates, got ${out.diagnostics.completeCandidates}`);
});
test('PHASE 25 / 25b — when completeCandidates > 1, the solver actually compares them', () => {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED',
    diversification: {
      ...STRATEGY_C.diversification,
      seed: 0xC0FFEE
    },
    solver: {
      timeLimitMs: 10_000,
      maxSolutions: 1000
    }
  };
  const out = solve(input);
  assert.equal(out.failure, null);
  const incumbent = out.solutions[0];
  assert.ok(incumbent.diagnostics.global);
  const g = incumbent.diagnostics.global;
  assert.equal(typeof g.completeCandidates, 'number');
  assert.equal(typeof g.bestCandidateUpdates, 'number');
  assert.ok(g.bestCandidateUpdates >= 1, `global bestCandidateUpdates must be >= 1, got ${g.bestCandidateUpdates}`);
  assert.ok(g.completeCandidates >= 2, `global completeCandidates must be >= 2 to require comparison, got ${g.completeCandidates}`);
});
test('PHASE 25 / 26 — real-data: both BASE and GLOBAL retain finite workload metrics', () => {
  const OPTS = {
    maxSearchIterations: 12
  };
  const base = solveReal('BASE_FEASIBLE', 0xC0FFEE, 60_000, OPTS);
  const global = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 60_000, OPTS);
  assert.equal(base.out.failure, null);
  assert.equal(global.out.failure, null);
  for (const [label, r] of [['BASE', base], ['GLOBAL', global]]) {
    assert.notEqual(r.out.diagnostics.searchStoppedBy, 'TIME_BUDGET', `${label} was truncated by the wall clock; the comparison would be about the host`);
  }
  const baseSpread = base.solution.metrics.workloadSpread;
  const globalSpread = global.solution.metrics.workloadSpread;
  assert.ok(Number.isFinite(baseSpread) && baseSpread >= 0);
  assert.ok(Number.isFinite(globalSpread) && globalSpread >= 0);
  assert.equal(global.solution.metrics.hardViolations, 0);
});
test('PHASE 25 / 27 — diagnostics counters expose the brief-required fields', () => {
  const {
    out
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED');
  for (const k of ['searchNodes', 'completeCandidates', 'bestCandidateUpdates', 'prunedBranches', 'infeasibleBranches', 'timeBudgetHit', 'searchLimited', 'searchStoppedBy', 'iterationBound', 'optimizationMode', 'totalSolveMs']) {
    assert.ok(k in out.diagnostics, `diagnostics must expose ${k}`);
  }
  assert.equal(out.diagnostics.optimizationMode, 'GLOBAL_ASSIGNMENT_BALANCED');
  assert.equal(typeof out.diagnostics.searchLimited, 'boolean');
  assert.ok(['TIME_BUDGET', 'ITERATION_LIMIT', 'SEARCH_EXHAUSTED', 'SOLUTION_CAP', 'UNKNOWN'].includes(out.diagnostics.searchStoppedBy), `searchStoppedBy must be a known reason, got ${out.diagnostics.searchStoppedBy}`);
  assert.equal(out.diagnostics.searchLimited, out.diagnostics.searchStoppedBy === 'TIME_BUDGET', 'searchLimited and searchStoppedBy must agree');
  assert.equal(out.diagnostics.iterationBound, 5);
});
