import test from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { slotsForBranch } from '../../src/modules/timetable/engine/domain/search-constraints.js';
import { STRATEGY_C } from '../../src/modules/timetable/engine/domain/strategies.js';
function witness(reverse = false) {
  const branch = {
    id: 'b',
    schoolDays: [2],
    periods: [2, 4],
    sessions: {
      sang: [2, 4],
      chieu: []
    }
  };
  const teachers = [{
    id: 'A',
    hoTen: 'A',
    homeBranchId: 'b',
    eligibleSubjectIds: ['sa', 'sb'],
    chuyenMon: [{
      tenChuyenMon: 'sa',
      soTietTuan: 1
    }, {
      tenChuyenMon: 'sb',
      soTietTuan: 1
    }],
    nguyenVong: {
      buoiUuTien: 'sang'
    }
  }, {
    id: 'B',
    hoTen: 'B',
    homeBranchId: 'b',
    eligibleSubjectIds: ['sa'],
    chuyenMon: [{
      tenChuyenMon: 'sa',
      soTietTuan: 1
    }],
    nguyenVong: {
      buoiUuTien: 'ca_hai'
    }
  }];
  const assignments = [{
    id: 'a',
    classId: 'c1',
    subjectId: 'sa',
    teacherId: 'A',
    branchId: 'b',
    requiredPeriods: 2
  }, {
    id: 'b',
    classId: 'c2',
    subjectId: 'sb',
    teacherId: 'A',
    branchId: 'b',
    requiredPeriods: 1
  }];
  if (reverse) assignments.reverse();
  return {
    teachers,
    teacherIndex: new Map(teachers.map(teacher => [teacher.id, teacher])),
    branches: [branch],
    classes: [{
      id: 'c1',
      branchId: 'b'
    }, {
      id: 'c2',
      branchId: 'b'
    }],
    subjects: [{
      id: 'sa'
    }, {
      id: 'sb'
    }],
    assignments,
    assignmentIndex: new Map(assignments.map(assignment => [assignment.id, assignment])),
    timeSlotsByBranch: new Map([['b', slotsForBranch(branch)]]),
    travelTime: null,
    strategy: {
      ...STRATEGY_C,
      optimizationMode: 'PREFERENCE_FIRST',
      diversification: {
        seed: 42
      },
      solver: {
        maxSolutions: 1,
        maxSearchIterations: 1,
        timeLimitMs: 1000
      }
    }
  };
}
test('search: audit witness backtracks to another teacher instead of false NO_SOLUTION', () => {
  const input = witness();
  const output = solve(input);
  assert.equal(output.failure, null);
  assert.equal(output.solutions.length, 1);
  assert.equal(output.solutions[0].placements.get('a').teacherId, 'B');
  assert.equal(evaluateCandidate(output.solutions[0], input).summary.accepted, true);
});
test('search: audit witness remains feasible in either assignment input order', () => {
  for (const reverse of [false, true]) assert.equal(solve(witness(reverse)).failure, null);
});
test('search: alternative slots respect fixed availability and roll back class and teacher state', () => {
  let backtracked = false;
  for (let seed = 1; seed <= 8; seed += 1) {
    const input = witness();
    input.branches[0] = {
      id: 'b',
      schoolDays: [2, 3],
      periods: [2]
    };
    input.timeSlotsByBranch = new Map([['b', slotsForBranch(input.branches[0])]]);
    input.teachers[0].eligibleSubjectIds = ['sa'];
    input.teachers[1].eligibleSubjectIds = ['sb'];
    input.teachers[1].fixedDayOff = [3];
    input.assignments[0].requiredPeriods = 1;
    input.assignments[1].teacherId = 'B';
    input.assignments[1].classId = 'c1';
    input.strategy = {
      ...input.strategy,
      optimizationMode: 'BASE_FEASIBLE',
      diversification: {
        seed
      },
      objectives: {}
    };
    const output = solve(input);
    assert.equal(output.failure, null, `seed ${seed}`);
    const candidate = output.solutions[0];
    assert.equal(candidate.assignments.get('a')[0].day, 3);
    assert.equal(candidate.assignments.get('b')[0].day, 2);
    assert.equal(evaluateCandidate(candidate, input).summary.accepted, true);
    backtracked ||= output.diagnostics.backtracks > 0;
  }
  assert.equal(backtracked, true);
});
test('search: every slot of a multi-period assignment belongs to one chosen teacher', () => {
  const input = witness();
  const output = solve(input);
  assert.equal(output.failure, null);
  for (const [id, slots] of output.solutions[0].assignments) {
    assert.equal(slots.length, input.assignmentIndex.get(id).requiredPeriods);
    assert.ok(slots.every(slot => slot.teacherId === output.solutions[0].placements.get(id).teacherId));
  }
});
test('search: the same input and seed produces the same decisions after rollback', () => {
  const first = solve(witness()).solutions[0];
  const second = solve(witness()).solutions[0];
  assert.ok(first && second);
  assert.deepEqual(first.assignments, second.assignments);
  assert.deepEqual(first.placements, second.placements);
});
function branchFirstFixture(mode = 'BASE_FEASIBLE') {
  const input = witness();
  input.strategy = {
    ...input.strategy,
    optimizationMode: mode
  };
  input.teachers[0].homeBranchId = 'other';
  input.teachers[0].allowedTransferBranches = ['b'];
  input.teachers[0].nguyenVong = {
    buoiUuTien: 'ca_hai'
  };
  input.assignments = [{
    ...input.assignments[0],
    requiredPeriods: 1,
    baselineAssignment: true
  }];
  input.assignmentIndex = new Map(input.assignments.map(assignment => [assignment.id, assignment]));
  input.curriculum = input.assignments.map(({
    classId,
    subjectId,
    requiredPeriods
  }) => ({
    classId,
    subjectId,
    requiredPeriods
  }));
  return input;
}
for (const mode of ['BASE_FEASIBLE', 'ASSIGNMENT_BALANCED', 'PREFERENCE_FIRST', 'GLOBAL_ASSIGNMENT_BALANCED']) {
  test(`branch first: ${mode} selects the home teacher before an imported external teacher`, () => {
    const input = branchFirstFixture(mode);
    const snapshot = JSON.stringify(input.teachers);
    const output = solve(input);
    assert.equal(output.failure, null);
    assert.equal(output.solutions[0].placements.get('a').teacherId, 'B');
    assert.equal(output.solutions[0].transfers.length, 0);
    assert.equal(output.diagnostics.branchScheduling.localAssignments, 1);
    assert.equal(output.diagnostics.branchScheduling.pendingAssignments.length, 0);
    assert.equal(evaluateCandidate(output.solutions[0], input).summary.accepted, true);
    assert.equal(JSON.stringify(input.teachers), snapshot);
  });
}
test('branch first: only unfinished demand uses an eligible and explicitly permitted external teacher', () => {
  const input = branchFirstFixture();
  input.teachers[1].capacityPeriodsPerWeek = 1;
  input.assignments.push({
    ...input.assignments[0],
    id: 'second',
    classId: 'c2'
  });
  input.assignmentIndex = new Map(input.assignments.map(assignment => [assignment.id, assignment]));
  input.curriculum = input.assignments.map(({
    classId,
    subjectId,
    requiredPeriods
  }) => ({
    classId,
    subjectId,
    requiredPeriods
  }));
  const output = solve(input);
  assert.equal(output.failure, null);
  assert.equal(output.diagnostics.branchScheduling.localAssignments, 1);
  assert.equal(output.diagnostics.branchScheduling.pendingAssignments.length, 1);
  const pendingId = output.diagnostics.branchScheduling.pendingAssignments[0].assignmentId;
  assert.equal(output.solutions[0].placements.get(pendingId).teacherId, 'A');
  assert.equal([...output.solutions[0].placements].find(([id]) => id !== pendingId)[1].teacherId, 'B');
  assert.equal(evaluateCandidate(output.solutions[0], input).summary.accepted, true);
  input.teachers[0].allowedTransferBranches = [];
  input.teachers[0].preferredTransferBranches = ['b'];
  const denied = solve(input);
  assert.equal(denied.solutions.length, 0);
  assert.equal(denied.diagnostics.branchScheduling.localAssignments, 1);
  assert.equal(denied.diagnostics.branchScheduling.transferStatus, 'UNRESOLVED');
  assert.equal(denied.diagnostics.unresolvable[0].reasonCode, 'LOCAL_CAPACITY_REQUIRES_TRANSFER');
});
test('branch first: transfers reserve future home teaching instead of selecting an already full source teacher', () => {
  const input = branchFirstFixture('GLOBAL_ASSIGNMENT_BALANCED');
  const other = {
    id: 'other',
    schoolDays: [2],
    periods: [2, 4],
    sessions: {
      sang: [2, 4],
      chieu: []
    }
  };
  input.branches.push(other);
  input.timeSlotsByBranch.set('other', slotsForBranch(other));
  input.teachers[0].capacityPeriodsPerWeek = 1;
  input.teachers[0].eligibleSubjectIds = ['sa', 'home-subject'];
  input.teachers[0].chuyenMon = [{
    tenChuyenMon: 'sa'
  }, {
    tenChuyenMon: 'home-subject'
  }];
  input.teachers[1].eligibleSubjectIds = ['sb'];
  input.teachers[1].chuyenMon = [{
    tenChuyenMon: 'sb'
  }];
  input.teachers[1].homeBranchId = 'b';
  input.teachers.push({
    ...input.teachers[0],
    id: 'C',
    hoTen: 'C',
    eligibleSubjectIds: ['sa'],
    chuyenMon: [{
      tenChuyenMon: 'sa'
    }],
    capacityPeriodsPerWeek: 3,
    homeBranchId: 'other',
    allowedTransferBranches: ['b']
  });
  input.teacherIndex = new Map(input.teachers.map(teacher => [teacher.id, teacher]));
  input.classes.push({
    id: 'home-class',
    branchId: 'other'
  });
  input.subjects.push({
    id: 'home-subject'
  });
  input.assignments.push({
    id: 'home',
    classId: 'home-class',
    subjectId: 'home-subject',
    teacherId: 'A',
    branchId: 'other',
    requiredPeriods: 1,
    baselineAssignment: true
  });
  input.assignmentIndex = new Map(input.assignments.map(assignment => [assignment.id, assignment]));
  input.curriculum = input.assignments.map(({
    classId,
    subjectId,
    requiredPeriods
  }) => ({
    classId,
    subjectId,
    requiredPeriods
  }));
  const output = solve(input);
  assert.equal(output.failure, null);
  assert.equal(output.solutions[0].placements.get('home').branchId, 'other');
  assert.equal(output.solutions[0].placements.get('a').teacherId, 'C');
  assert.equal(evaluateCandidate(output.solutions[0], input).summary.accepted, true);
});
