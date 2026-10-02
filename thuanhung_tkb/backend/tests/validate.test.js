// Tests for the pre-scheduler input validator.
// Phase 14: ensures `validateInput` is the single source of truth
// for INVALID_INPUT vs MISSING_DATA and that structural problems
// never reach the solver.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/domain/validate.js';

function baseModel() {
  return {
    teachers: [
      { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] },
    ],
    branches: [
      { id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
    ],
    classes: [
      { id: 'c1', branchId: 'b1', name: '1A', gradeLevel: 1 },
    ],
    subjects: [
      { id: 'Toán', name: 'Toán' },
    ],
    curriculum: [
      { classId: 'c1', subjectId: 'Toán', requiredPeriods: 2 },
    ],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', branchId: 'b1', requiredPeriods: 2 },
    ],
    timeSlotsByBranch: new Map([['b1', [{ branchId: 'b1', day: 1, period: 1 }]]]),
    travelTime: null,
    missingData: [],
    warnings: [],
  };
}

test('validateInput: clean model produces no issues, no critical missing', () => {
  const m = baseModel();
  m.travelTime = { travelTime: () => 0 }; // present, to keep missing list clean
  const r = validateInput(m);
  assert.equal(r.issues.length, 0);
  assert.equal(r.missing.length, 0);
});

test('validateInput: assignment references unknown class → invalid_reference', () => {
  const m = baseModel();
  m.assignments[0].classId = 'no-such-class';
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_reference' && i.field === 'classId'));
});

test('validateInput: assignment references unknown subject → invalid_reference', () => {
  const m = baseModel();
  m.assignments[0].subjectId = 'Lý';
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_reference' && i.field === 'subjectId'));
});

test('validateInput: assignment references unknown teacher → invalid_reference', () => {
  const m = baseModel();
  m.assignments[0].teacherId = 'no-such-teacher';
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_reference' && i.field === 'teacherId'));
});

test('validateInput: assignment references unknown branch → invalid_reference', () => {
  const m = baseModel();
  m.assignments[0].branchId = 'no-such-branch';
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_reference' && i.field === 'branchId'));
});

test('validateInput: teacher ineligible for subject → unresolvable_demand', () => {
  const m = baseModel();
  m.assignments[0].subjectId = 'Lý'; // teacher only knows Toán
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'unresolvable_demand'));
});

test('validateInput: empty branches is MISSING_DATA, not INVALID_INPUT', () => {
  const m = baseModel();
  m.branches = [];
  m.assignments = []; // assignments reference the now-missing branch
  m.classes = [];
  m.curriculum = [];
  m.timeSlotsByBranch = new Map();
  const r = validateInput(m);
  assert.equal(r.issues.length, 0, `unexpected issues: ${JSON.stringify(r.issues)}`);
  assert.ok(r.missing.some((x) => x.entity === 'Branch'));
});

test('validateInput: empty classes is MISSING_DATA, not INVALID_INPUT', () => {
  const m = baseModel();
  m.classes = [];
  m.curriculum = [];
  m.assignments = [];
  const r = validateInput(m);
  assert.equal(r.issues.length, 0, `unexpected issues: ${JSON.stringify(r.issues)}`);
  assert.ok(r.missing.some((x) => x.entity === 'Class'));
});

test('validateInput: empty curriculum is MISSING_DATA, not INVALID_INPUT', () => {
  const m = baseModel();
  m.curriculum = [];
  m.assignments = [];
  const r = validateInput(m);
  assert.equal(r.issues.length, 0);
  assert.ok(r.missing.some((x) => x.entity === 'Curriculum'));
});

test('validateInput: empty assignments is MISSING_DATA, not INVALID_INPUT', () => {
  const m = baseModel();
  m.assignments = [];
  const r = validateInput(m);
  assert.equal(r.issues.length, 0);
  assert.ok(r.missing.some((x) => x.entity === 'Assignment'));
});

test('validateInput: missing travelTime is MISSING_DATA, not INVALID_INPUT', () => {
  const m = baseModel();
  m.travelTime = null;
  const r = validateInput(m);
  assert.equal(r.issues.length, 0);
  assert.ok(r.missing.some((x) => x.entity === 'Travel'));
});

test('validateInput: duplicate teacher id is invalid_value', () => {
  const m = baseModel();
  m.teachers.push({ id: 't1', hoTen: 'dup', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] });
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_value' && i.field === 'id' && i.entity === 'teacher'));
});

test('validateInput: teacher with no chuyenMon → missing_required_field', () => {
  const m = baseModel();
  m.teachers[0].chuyenMon = [];
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'missing_required_field' && i.field === 'chuyenMon'));
});

test('validateInput: branch with no schoolDays → missing_required_field', () => {
  const m = baseModel();
  m.branches[0].schoolDays = [];
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'missing_required_field' && i.field === 'schoolDays'));
});

test('validateInput: branch with no periods → missing_required_field', () => {
  const m = baseModel();
  m.branches[0].periods = [];
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'missing_required_field' && i.field === 'periods'));
});

test('validateInput: assignment with requiredPeriods=-1 → invalid_value', () => {
  const m = baseModel();
  m.assignments[0].requiredPeriods = -1;
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_value' && i.field === 'requiredPeriods'));
});

test('validateInput: curriculum references unknown class → invalid_reference', () => {
  const m = baseModel();
  m.curriculum[0].classId = 'no-such-class';
  const r = validateInput(m);
  assert.ok(r.issues.some((i) => i.code === 'invalid_reference' && i.entity === 'curriculum'));
});
