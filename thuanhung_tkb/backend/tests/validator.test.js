// Tests for the independent validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/domain/validator.js';

function makeInput({ teachers = [], assignments = [], timeSlotsByBranch = [], travelTime = null, transitionMinutes = 10 } = {}) {
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));
  const tsMap = timeSlotsByBranch instanceof Map
    ? timeSlotsByBranch
    : new Map(timeSlotsByBranch.map((slots, i) => [`b${i + 1}`, slots]));
  return { teachers, assignments, timeSlotsByBranch: tsMap, travelTime, transitionMinutes, teacherIndex, assignmentIndex, strategy: { weights: { preference: 1, workload: 1, travel: 1, transfer: 1, diversity: 1 } } };
}

function solutionFrom(map) {
  return { id: 's1', strategyId: 'X', assignments: new Map(map), transfers: [], diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} } };
}

test('H_TEACHER_ELIGIBLE: rejects when teacher has no matching specialization', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }],
    assignments: [{ id: 'a1', classId: 'c1', subjectId: 'Lý', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' }],
  });
  const sol = solutionFrom([['a1', [{ branchId: 'b1', day: 1, period: 1 }]]]);
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_TEACHER_ELIGIBLE'));
});

test('H_ASSIGNMENT_COMPLETE: rejects when slot count differs from required', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }] }],
    assignments: [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 4, branchId: 'b1' }],
    timeSlotsByBranch: [[{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 1, period: 2 }, { branchId: 'b1', day: 1, period: 3 }]],
  });
  const sol = solutionFrom([['a1', [{ branchId: 'b1', day: 1, period: 1 }]]]);
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_ASSIGNMENT_COMPLETE'));
});

test('H_SLOT_IN_BRANCH: rejects when slot is not in any branch profile', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }],
    assignments: [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' }],
    timeSlotsByBranch: [[]],
  });
  const sol = solutionFrom([['a1', [{ branchId: 'b1', day: 1, period: 1 }]]]);
  const r = verify(sol, input);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_SLOT_IN_BRANCH'));
});

test('H_NO_DUPLICATE_SLOT: rejects duplicate slot in the same assignment', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] }],
    assignments: [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' }],
    timeSlotsByBranch: [[{ branchId: 'b1', day: 1, period: 1 }, { branchId: 'b1', day: 1, period: 2 }]],
  });
  const sol = solutionFrom([['a1', [
    { branchId: 'b1', day: 1, period: 1 },
    { branchId: 'b1', day: 1, period: 1 },
  ]]]);
  const r = verify(sol, input);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_NO_DUPLICATE_SLOT' || v.code === 'H_TEACHER_NO_DOUBLE_BOOK'));
});

test('H_TRAVEL_FEASIBLE: INACTIVE when no travelTime provider', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }],
    assignments: [],
  });
  const sol = solutionFrom([]);
  const r = verify(sol, input);
  assert.ok(r.inactiveConstraints.includes('H_TRAVEL_FEASIBLE'));
});

test('valid solution is accepted', () => {
  const input = makeInput({
    teachers: [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }],
    assignments: [{ id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' }],
    timeSlotsByBranch: [[{ branchId: 'b1', day: 1, period: 1 }]],
  });
  const sol = solutionFrom([['a1', [{ branchId: 'b1', day: 1, period: 1 }]]]);
  const r = verify(sol, input);
  assert.equal(r.accepted, true);
  assert.equal(r.coverage.fullyScheduled, 1);
});
