// Tests for the solver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/domain/solver.js';
import { STRATEGY_C } from '../src/domain/strategies.js';

function input(assignments, timeSlotsByBranch, extra = {}) {
  const teacherIndex = new Map((extra.teachers ?? []).map((t) => [t.id, t]));
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));
  return {
    teachers: extra.teachers ?? [],
    branches: extra.branches ?? [],
    classes: extra.classes ?? [],
    subjects: extra.subjects ?? [],
    curriculum: [],
    assignments,
    timeSlotsByBranch: new Map(timeSlotsByBranch.map((slots, i) => [`b${i + 1}`, slots])),
    travelTime: extra.travelTime ?? null,
    transitionMinutes: 10,
    teacherIndex,
    assignmentIndex,
    strategy: STRATEGY_C,
  };
}

test('empty assignments: solver returns INFEASIBLE_DEMAND, no solutions', () => {
  const r = solve(input([], [[{ branchId: 'b1', day: 1, period: 1 }]]));
  assert.equal(r.solutions.length, 0);
  assert.equal(r.failure, 'INFEASIBLE_DEMAND');
});

test('UNRESOLVABLE_ASSIGNMENT when an assignment has no candidate slots', () => {
  const r = solve(input(
    [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' }],
    [[]],
  ));
  assert.equal(r.solutions.length, 0);
  assert.equal(r.failure, 'UNRESOLVABLE_ASSIGNMENT');
});

test('solver finds at least one solution for a simple feasible case', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const r = solve(input(
    [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' }],
    [[{ branchId: 'b1', day: 2, period: 1 }]],
    { teachers, branches: [{ id: 'b1', schoolDays: [2], periods: [1] }] },
  ));
  assert.equal(r.solutions.length, 1);
  const slots = r.solutions[0].assignments.get('a1');
  assert.equal(slots.length, 1);
  assert.equal(slots[0].branchId, 'b1');
});

test('multi-solution: solver can return multiple distinct solutions for 1 teacher + 2 classes + 2 periods', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
  ];
  const slots = [
    { branchId: 'b1', day: 2, period: 1 },
    { branchId: 'b1', day: 2, period: 2 },
    { branchId: 'b1', day: 3, period: 1 },
    { branchId: 'b1', day: 3, period: 2 },
  ];
  const r = solve(input(assignments, [slots], { teachers, branches: [{ id: 'b1', schoolDays: [2, 3], periods: [1, 2] }] }));
  assert.equal(r.solutions.length >= 2, true);
  for (const s of r.solutions) {
    const a1 = s.assignments.get('a1');
    const a2 = s.assignments.get('a2');
    assert.equal(a1.length, 1);
    assert.equal(a2.length, 1);
    assert.notEqual(`${a1[0].day}:${a1[0].period}`, `${a2[0].day}:${a2[0].period}`);
  }
});
