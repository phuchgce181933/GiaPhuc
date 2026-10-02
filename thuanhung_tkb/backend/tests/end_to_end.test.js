// End-to-end pipeline test with a complete synthetic input.
// Marked clearly as TEST MOCK DATA. Uses the 5 fixture teachers
// plus a synthetic branch, class, and curriculum.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { preview, PreviewCache } from '../src/orchestrator/index.js';
import { verify } from '../src/domain/validator.js';
import { score } from '../src/domain/scorer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');
const fixtureTeachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);

function makeSyntheticInput() {
  const branch = { id: 'branch-A', name: 'Branch A', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] };
  const branches = [branch];
  const classes = [
    { id: 'class-4A', branchId: 'branch-A', name: '4A', gradeLevel: 4 },
    { id: 'class-5A', branchId: 'branch-A', name: '5A', gradeLevel: 5 },
  ];

  // Build a per-teacher home branch assignment for synthetic test.
  const teachers = fixtureTeachers.map((t) => ({ ...t, homeBranchId: 'branch-A' }));

  // Curriculum: class 4A needs Tin học 2 periods; class 5A needs Mỹ thuật 1 period.
  const curriculum = [
    { classId: 'class-4A', subjectId: 'Tin học', requiredPeriods: 2 },
    { classId: 'class-5A', subjectId: 'Mỹ thuật', requiredPeriods: 1 },
  ];

  // Subjects: derived from teacher specializations (the union).
  const subjectNames = new Set();
  for (const t of teachers) for (const s of t.chuyenMon) subjectNames.add(s.tenChuyenMon);
  const subjects = [...subjectNames].map((name) => ({ id: name, name }));

  // Assignments: derived from curriculum + teacher eligibility.
  // tin-hoc: kim only. my-thuat: trinh only.
  const assignments = [
    { id: 'a-4a-tin', classId: 'class-4A', subjectId: 'Tin học', teacherId: teachers.find((t) => t.hoTen === 'kim').id, requiredPeriods: 2, branchId: 'branch-A' },
    { id: 'a-5a-my', classId: 'class-5A', subjectId: 'Mỹ thuật', teacherId: teachers.find((t) => t.hoTen === 'trinh').id, requiredPeriods: 1, branchId: 'branch-A' },
  ];

  // Time slots for the branch.
  const branchSlots = [];
  for (const day of branch.schoolDays) for (const period of branch.periods) branchSlots.push({ branchId: branch.id, day, period });
  const timeSlotsByBranch = new Map([[branch.id, branchSlots]]);

  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));

  return {
    teachers, branches, classes, subjects, curriculum, assignments,
    timeSlotsByBranch, travelTime: null, transitionMinutes: 10,
    teacherIndex, assignmentIndex,
    missingData: [],
    warnings: ['TEST MOCK DATA: synthetic branch + classes + curriculum'],
  };
}

test('synthetic input: preview returns solutions, validator accepts, scorer assigns score', () => {
  const model = makeSyntheticInput();
  const cache = new PreviewCache();
  const out = preview(model, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, cache);
  assert.ok(out.solutions.length >= 1, 'expected at least 1 solution');
  for (const sol of out.solutions) {
    assert.equal(sol.validation.accepted, true, `solution ${sol.id} should be accepted`);
    assert.equal(sol.validation.hardViolations.length, 0);
    assert.equal(sol.score.hardViolationCount, 0);
    assert.ok(sol.score.overallScore > 0, 'overall score should be positive');
  }
});

test('synthetic input: solutions are diverse (different slot sets)', () => {
  const model = makeSyntheticInput();
  const out = preview(model, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, new PreviewCache());
  if (out.solutions.length >= 2) {
    const a = out.solutions[0].assignments;
    const b = out.solutions[1].assignments;
    let sameSlotCount = 0, total = 0;
    const setA = new Set();
    for (const slots of a.values()) for (const s of slots) setA.add(`${s.branchId}:${s.day}:${s.period}`);
    for (const slots of b.values()) for (const s of slots) {
      total += 1;
      if (setA.has(`${s.branchId}:${s.day}:${s.period}`)) sameSlotCount += 1;
    }
    // At least one slot should differ between the first two solutions.
    assert.ok(sameSlotCount < total, 'expected the two solutions to differ in at least one slot');
  }
});

test('validator on a hand-crafted valid solution accepts it', () => {
  const model = makeSyntheticInput();
  // Build a single valid solution manually.
  const slots = new Map([
    ['a-4a-tin', [
      { branchId: 'branch-A', day: 1, period: 1 },
      { branchId: 'branch-A', day: 2, period: 1 },
    ]],
    ['a-5a-my', [
      { branchId: 'branch-A', day: 1, period: 2 },
    ]],
  ]);
  const sol = {
    id: 'manual',
    strategyId: 'X',
    assignments: slots,
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, model);
  assert.equal(r.accepted, true);
  assert.equal(r.coverage.fullyScheduled, 2);
});
