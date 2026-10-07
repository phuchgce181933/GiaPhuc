import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../../src/modules/timetable/engine/domain/validate.js';
import { capacityTeacher } from '../../src/modules/timetable/engine/domain/workload.js';
import { normalizeTeacher } from '../../src/modules/timetable/engine/domain/teacher.js';
import { loadFromLegacySaplich } from '../../src/modules/timetable/engine/loader/legacy-saplich/index.js';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
function coverage(required = 4, assigned = 4) {
  return {
    teachers: [{
      id: 't',
      hoTen: 'Teacher',
      chuyenMon: [{
        tenChuyenMon: 's',
        soTietTuan: 1
      }]
    }],
    branches: [{
      id: 'b',
      schoolDays: [2, 3, 4],
      periods: [2, 4, 5, 7]
    }],
    classes: [{
      id: 'c',
      branchId: 'b'
    }],
    subjects: [{
      id: 's'
    }],
    curriculum: [{
      classId: 'c',
      subjectId: 's',
      requiredPeriods: required
    }],
    assignments: [{
      id: 'a',
      classId: 'c',
      subjectId: 's',
      teacherId: 't',
      branchId: 'b',
      requiredPeriods: assigned
    }]
  };
}
for (const assigned of [0, 3, 5]) {
  test(`curriculum coverage: demand 4 versus assignment ${assigned} is invalid`, () => {
    assert.ok(validateInput(coverage(4, assigned)).issues.some(issue => issue.code === 'curriculum_coverage_mismatch'));
  });
}
test('curriculum coverage: exact demand and split assignment totals are valid', () => {
  const input = coverage();
  assert.equal(validateInput(input).issues.length, 0);
  input.assignments[0].requiredPeriods = 1;
  input.assignments.push({
    ...input.assignments[0],
    id: 'b',
    requiredPeriods: 3
  });
  assert.equal(validateInput(input).issues.length, 0);
});
test('curriculum coverage: a missing assignment is invalid even when all references are valid', () => {
  const input = coverage();
  input.assignments = [];
  assert.ok(validateInput(input).issues.some(issue => issue.code === 'curriculum_coverage_mismatch'));
});
test('curriculum coverage: wrong class or subject cannot substitute for the required pair', () => {
  for (const field of ['classId', 'subjectId']) {
    const input = coverage();
    if (field === 'classId') input.classes.push({
      id: 'other',
      branchId: 'b'
    });else {
      input.subjects.push({
        id: 'other'
      });
      input.teachers[0].chuyenMon.push({
        tenChuyenMon: 'other',
        soTietTuan: 1
      });
    }
    input.assignments[0][field] = 'other';
    assert.ok(validateInput(input).issues.some(issue => issue.code === 'curriculum_coverage_mismatch'));
  }
});
test('curriculum coverage: evaluator independently rejects full assignments that underfill curriculum', () => {
  const input = coverage(4, 3);
  input.teacherIndex = new Map(input.teachers.map(teacher => [teacher.id, teacher]));
  input.assignmentIndex = new Map(input.assignments.map(assignment => [assignment.id, assignment]));
  const candidate = {
    assignments: new Map([['a', [2, 3, 4].map(day => ({
      branchId: 'b',
      teacherId: 't',
      day,
      period: 2
    }))]])
  };
  assert.ok(evaluateCandidate(candidate, input).hard.violations.some(violation => violation.constraintId === 'H05'));
});
test('capacity: legacy source numbers remain evidence, not guessed capacity or specialization budgets', () => {
  const {
    normalized,
    scheduling
  } = loadFromLegacySaplich();
  for (const teacher of scheduling.teachers) {
    const original = normalized.teachers.find(row => row.id === teacher.id);
    assert.equal(capacityTeacher(teacher), null);
    assert.deepEqual(teacher.sourceWorkload, {
      standard: original.standardWorkload,
      partTime: original.partTimeWorkload,
      historicalTeaching: original.teachingWorkload
    });
    assert.ok(teacher.chuyenMon.every(subject => subject.soTietTuan === null));
  }
});
test('capacity: an explicit zero/positive weekly capacity survives teacher normalization', () => {
  for (const value of [0, 1, 23]) {
    const teacher = normalizeTeacher({
      id: 't',
      hoTen: 'Teacher',
      chuyenMon: [{
        tenChuyenMon: 's',
        soTietTuan: 2
      }],
      capacityPeriodsPerWeek: value
    });
    assert.equal(capacityTeacher(teacher), value);
  }
  assert.equal(capacityTeacher({
    standardWorkload: 23,
    teachingWorkload: 20,
    chuyenMon: [{
      soTietTuan: 30
    }]
  }), null);
});
test('capacity: malformed explicit capacity is invalid input', () => {
  for (const value of [-1, 1.5, '23', Infinity]) {
    const input = coverage();
    input.teachers[0].capacityPeriodsPerWeek = value;
    assert.ok(validateInput(input).issues.some(issue => issue.field === 'capacityPeriodsPerWeek'));
  }
});
