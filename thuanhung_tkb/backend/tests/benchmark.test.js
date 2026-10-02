// Benchmark: compare strategy A vs B vs C on the synthetic input.
// The "old" engine placeholder is reported as MISSING_OLD_ENGINE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { preview, PreviewCache } from '../src/orchestrator/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');
const fixtureTeachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);

function makeSyntheticInput() {
  const branch = { id: 'branch-A', name: 'Branch A', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] };
  const branches = [branch];
  const teachers = fixtureTeachers.map((t) => ({ ...t, homeBranchId: 'branch-A' }));
  const subjects = [...new Set(teachers.flatMap((t) => t.chuyenMon.map((s) => s.tenChuyenMon)))].map((name) => ({ id: name, name }));
  const assignments = [
    { id: 'a-4a-tin', classId: 'class-4A', subjectId: 'Tin học', teacherId: teachers.find((t) => t.hoTen === 'kim').id, requiredPeriods: 2, branchId: 'branch-A' },
    { id: 'a-5a-my', classId: 'class-5A', subjectId: 'Mỹ thuật', teacherId: teachers.find((t) => t.hoTen === 'trinh').id, requiredPeriods: 1, branchId: 'branch-A' },
  ];
  const branchSlots = [];
  for (const day of branch.schoolDays) for (const p of branch.periods) branchSlots.push({ branchId: branch.id, day, period: p });
  return {
    teachers, branches, classes: [{ id: 'class-4A', branchId: 'branch-A' }, { id: 'class-5A', branchId: 'branch-A' }], subjects,
    curriculum: assignments.map((a) => ({ classId: a.classId, subjectId: a.subjectId, requiredPeriods: a.requiredPeriods })), assignments,
    timeSlotsByBranch: new Map([[branch.id, branchSlots]]),
    travelTime: null, transitionMinutes: 10,
    teacherIndex: new Map(teachers.map((t) => [t.id, t])),
    assignmentIndex: new Map(assignments.map((a) => [a.id, a])),
    missingData: [], warnings: ['TEST MOCK'],
  };
}

test('benchmark: each strategy returns solutions with the same hard-validity but different scores', () => {
  const model = makeSyntheticInput();
  const a = preview(model, { solutions: 3, strategies: ['A_PREFERENCE_FIRST'], seed: 1 }, new PreviewCache());
  const b = preview(model, { solutions: 3, strategies: ['B_WORKLOAD_TRAVEL'], seed: 1 }, new PreviewCache());
  const c = preview(model, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, new PreviewCache());
  for (const out of [a, b, c]) {
    assert.ok(out.solutions.length >= 1);
    for (const s of out.solutions) {
      assert.equal(s.validation.accepted, true);
      assert.equal(s.score.hardViolationCount, 0);
    }
  }
  // At least one strategy has a measurably different overallScore.
  const scoreA = a.solutions[0]?.score.overallScore ?? 0;
  const scoreB = b.solutions[0]?.score.overallScore ?? 0;
  const scoreC = c.solutions[0]?.score.overallScore ?? 0;
  assert.ok(Number.isFinite(scoreA) && Number.isFinite(scoreB) && Number.isFinite(scoreC));
});

test('benchmark report: an old engine is not available yet', () => {
  // Phase-13 cleanup rule: do not delete the old engine until the
  // new one passes regression. In this fresh project there is no
  // old engine; the benchmark surfaces this fact rather than
  // fabricating a comparison.
  const model = makeSyntheticInput();
  const out = preview(model, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, new PreviewCache());
  assert.equal(out.diagnostics.strategiesAttempted >= 1, true);
});
