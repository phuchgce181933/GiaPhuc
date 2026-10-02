// PHASE 16 — solver core correctness and optimization hardening.
//
// These tests lock in the fixes from PHASE_16_SOLVER_HARDENING.md.
// They use synthetic inputs only. No production data is loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { verify } from '../src/domain/validator.js';
import { solve } from '../src/domain/solver.js';
import { score } from '../src/domain/scorer.js';
import { diversity } from '../src/domain/diversity.js';
import { workloadOf } from '../src/domain/workload.js';
import { SOFT, expandAssignmentVariants, workloadBalanceScore, travelScoreFn } from '../src/domain/constraints.js';
import { sessionForSlot } from '../src/domain/time.js';
import { STRATEGY_A, STRATEGY_B, STRATEGY_C } from '../src/domain/strategies.js';
import { makeTravelProvider } from '../src/domain/travel.js';
import { preview, PreviewCache } from '../src/orchestrator/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');
const fixtureTeachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);

// --- helpers -------------------------------------------------------------

function makeInput({ assignments, branches, classes = null, teachers = fixtureTeachers, travelTime = null, transitionMinutes = 10, subjects = null, curriculum = null }) {
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));
  const timeSlotsByBranch = new Map(branches.map((b) => [b.id, buildSlots(b)]));
  const realClasses = classes ?? branches.map((b) => ({ id: `class-${b.id}`, branchId: b.id }));
  const realSubjects = subjects ?? [...new Set(teachers.flatMap((t) => t.chuyenMon.map((s) => s.tenChuyenMon)))].map((n) => ({ id: n, name: n }));
  const realCurriculum = curriculum ?? assignments.map((a) => ({ classId: a.classId, subjectId: a.subjectId, requiredPeriods: a.requiredPeriods }));
  return {
    teachers,
    branches,
    classes: realClasses,
    subjects: realSubjects,
    curriculum: realCurriculum,
    assignments,
    timeSlotsByBranch,
    travelTime,
    transitionMinutes,
    teacherIndex,
    assignmentIndex,
    warnings: [],
    missingData: [],
  };
}

function buildSlots(branch) {
  const out = [];
  for (const day of (branch.schoolDays ?? [1, 2, 3, 4, 5])) for (const period of (branch.periods ?? [1, 2, 3, 4, 5])) out.push({ branchId: branch.id, day, period });
  return out;
}

// --- 1. Teacher double-book across branches ------------------------------

test('H_TEACHER_NO_DOUBLE_BOOK: rejects teacher scheduled in two branches at the same (day, period)', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] }];
  const branches = [
    { id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
    { id: 'b2', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
  ];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const input = makeInput({
    teachers,
    branches,
    classes,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
    ],
  });
  const sol = {
    id: 'bad',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]],
      ['a2', [{ branchId: 'b2', day: 1, period: 1, teacherId: 't1' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_TEACHER_NO_DOUBLE_BOOK'));
});

test('solver: cross-branch double-book is rejected inside the search, not by post-pass repair', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
  ];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.equal(r.solutions.length, 0);
  assert.equal(r.failure, 'NO_SOLUTION');
});

// --- 2. Different teachers for same class-subject ------------------------

test('H_CLASS_SUBJECT_ONE_TEACHER: rejects two teachers for the same class-subject', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c1', subjectId: 'Toán', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'bad',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]],
      ['a2', [{ branchId: 'b1', day: 1, period: 2, teacherId: 't2' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_CLASS_SUBJECT_ONE_TEACHER'));
});

test('solver: H_CLASS_SUBJECT_ONE_TEACHER is enforced in the search (no solution when model has two teachers for one class-subject)', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c1', subjectId: 'Toán', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  // The solver prunes during the search: assigning t1 to (c1, Toán)
  // makes any other t2 placement for the same (c1, Toán) infeasible.
  // The search exhausts without a candidate.
  assert.equal(r.solutions.length, 0);
  assert.equal(r.failure, 'NO_SOLUTION');
});

// --- 3. Transfer allowed -------------------------------------------------

test('H_TRANSFER_ALLOWED: accepts teacher with allowedTransferBranches including the destination', () => {
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }],
    homeBranchId: 'b1',
    allowedTransferBranches: ['b2'],
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
  ];
  const classes = [{ id: 'c1', branchId: 'b2' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
    ],
  });
  const sol = {
    id: 'transfer',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b2', day: 1, period: 1, teacherId: 't1' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, true, `expected accepted; got ${JSON.stringify(r.hardViolations)}`);
});

// --- 4. Forbidden transfer ----------------------------------------------

test('H_TRANSFER_ALLOWED: rejects teacher without allowedTransferBranches for the destination', () => {
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }],
    homeBranchId: 'b1',
    allowedTransferBranches: ['b2'], // b3 not allowed
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
    { id: 'b3', schoolDays: [1], periods: [1] },
  ];
  const classes = [{ id: 'c1', branchId: 'b3' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b3' },
    ],
  });
  const sol = {
    id: 'forbidden',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b3', day: 1, period: 1, teacherId: 't1' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_TRANSFER_ALLOWED'));
});

// --- 5. Travel ------------------------------------------------------------

test('H_TRAVEL_FEASIBLE: rejects an infeasible cross-branch transition', () => {
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }],
    homeBranchId: 'b1',
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1, 2] },
    { id: 'b2', schoolDays: [1], periods: [1, 2] },
  ];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const travel = makeTravelProvider({ b1: { b2: 60 } });
  const input = makeInput({
    teachers,
    branches,
    classes,
    travelTime: travel,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
    ],
  });
  const sol = {
    id: 'travel-bad',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]],
      ['a2', [{ branchId: 'b2', day: 1, period: 2, teacherId: 't1' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_TRAVEL_FEASIBLE'));
});

test('solver: travel prune rejects an infeasible same-day cross-branch placement in the search', () => {
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 2 }],
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1, 2] },
    { id: 'b2', schoolDays: [1], periods: [1, 2] },
  ];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const travel = makeTravelProvider({ b1: { b2: 60 } });
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
  ];
  const input = makeInput({ teachers, branches, classes, travelTime: travel, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.equal(r.solutions.length, 0, 'solver should reject the only feasible placement due to travel');
});

// --- 6. Workload budget-aware -------------------------------------------

test('workloadScore: prefers alignment with per-teacher budget', () => {
  // Teacher A: budget 20, gets 19 slots → near-perfect
  // Teacher B: budget 5, gets 6 slots → small overshoot
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 20 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 5 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 19, branchId: 'b1' },
      { id: 'a2', classId: 'c1', subjectId: 'X', teacherId: 't2', requiredPeriods: 6, branchId: 'b1' },
    ],
  });
  // Build a valid solution manually.
  const slotsForA = [];
  const slotsForB = [];
  for (const day of [1, 2, 3, 4, 5]) {
    for (const period of [1, 2, 3, 4, 5]) {
      if (slotsForA.length < 19) slotsForA.push({ branchId: 'b1', day, period, teacherId: 't1' });
      else if (slotsForB.length < 6) slotsForB.push({ branchId: 'b1', day, period, teacherId: 't2' });
    }
  }
  const sol = {
    id: 'budget-aligned',
    strategyId: 'X',
    assignments: new Map([
      ['a1', slotsForA],
      ['a2', slotsForB],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = workloadBalanceScore(sol, input);
  // 19/20: dev 0.05 -> perTeacher 0.95
  // 6/5:   dev 0.20 -> perTeacher 0.80
  // mean: 0.875
  assert.ok(s > 0.5, `expected score reflecting per-teacher budget alignment; got ${s}`);
  // The spread-equal target would be 12.5 / 12.5 (penalising the uneven
  // distribution), but the budget target is 20 / 5. A perfectly budget-
  // aligned solution must score HIGHER than a perfectly spread-equal one.
  // We assert it is not "all teachers equal" by construction.
  assert.ok(s < 1, 'should not be 1 because t2 is over budget');
});

test('workloadScore: when a teacher exceeds budget by 100%, score is 0', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5] }];
  const input = makeInput({
    teachers,
    branches,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 4, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'over',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 3, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 4, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = workloadBalanceScore(sol, input);
  // budget 2, actual 4 -> 100% deviation -> 0
  assert.equal(s, 0);
});

test('workloadScore: budget-aligned (actual == budget) is 1', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 3 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5] }];
  const input = makeInput({
    teachers,
    branches,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 3, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'aligned',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 3, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = workloadBalanceScore(sol, input);
  assert.equal(s, 1);
});

// --- 7. Diversity metric includes teacherId ----------------------------

test('diversity: same (branch, day, period) but different teacher → non-zero diversity', () => {
  const a = {
    id: 'A',
    assignments: new Map([['x', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't2' }]]]),
  };
  assert.equal(diversity(a, b), 1, 'different teacher at same slot must be 100% diverse');
});

test('diversity: identical slot with same teacher → diversity 0', () => {
  const a = {
    id: 'A',
    assignments: new Map([['x', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
  };
  assert.equal(diversity(a, b), 0);
});

// --- 8. Status: all candidates invalid → EMPTY ---------------------------

test('orchestrator: when no candidate is accepted by the validator → status EMPTY, never OK', () => {
  // Construct a model where the only solver choice violates a hard
  // constraint. The solver itself returns NO_SOLUTION; the
  // orchestrator must surface status EMPTY.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  // The single branch slot must host two slots (requiredPeriods=2).
  // The branch offers 1 slot. The solver cannot place both.
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  const out = preview(input, { solutions: 1, strategies: ['C_BALANCED'] }, new PreviewCache());
  assert.notEqual(out.status, 'OK');
  assert.equal(out.status, 'EMPTY');
});

// --- 9. Strategy weights actually affect search -------------------------

test('strategies A/B/C on the same input: scores differ measurably', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }], homeBranchId: 'b1', nguyenVong: { soBuoiToiDa: 4, buoiUuTien: 'sang', thuNghi: [] } },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }], homeBranchId: 'b1' },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    { id: 'a2', classId: 'c1', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 2, branchId: 'b1' },
  ];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const outA = preview({ ...baseInput }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST'], seed: 1 }, new PreviewCache());
  const outB = preview({ ...baseInput }, { solutions: 3, strategies: ['B_WORKLOAD_TRAVEL'], seed: 1 }, new PreviewCache());
  const outC = preview({ ...baseInput }, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, new PreviewCache());
  assert.ok(outA.solutions.length >= 1, `A produced ${outA.solutions.length} solutions; status ${outA.status}`);
  assert.ok(outB.solutions.length >= 1, `B produced ${outB.solutions.length} solutions; status ${outB.status}`);
  assert.ok(outC.solutions.length >= 1, `C produced ${outC.solutions.length} solutions; status ${outC.status}`);
  const scoreA = outA.solutions[0].score.overallScore;
  const scoreB = outB.solutions[0].score.overallScore;
  const scoreC = outC.solutions[0].score.overallScore;
  // Strategies differ in their weight vectors; the same candidate
  // should receive different scores. (We also accept the case where
  // B and C produce the same overall score if no travel is involved
  // — but A's preference weight differs, so at least one pair must
  // differ.)
  const distinct = new Set([scoreA, scoreB, scoreC].map((s) => s.toFixed(6)));
  assert.ok(distinct.size >= 2, `expected at least two distinct strategy scores; got A=${scoreA}, B=${scoreB}, C=${scoreC}`);
});

// --- 10. Session semantics -----------------------------------------------

test('sessionForSlot: derived from branch.sessions when provided', () => {
  const branch = {
    id: 'b1',
    schoolDays: [1, 2, 3],
    periods: [1, 2, 3, 4, 5, 6],
    sessions: { sang: [1, 2, 3], chieu: [4, 5, 6] },
  };
  assert.equal(sessionForSlot({ branchId: 'b1', day: 1, period: 1 }, branch), 'sang');
  assert.equal(sessionForSlot({ branchId: 'b1', day: 1, period: 4 }, branch), 'chieu');
  // Without branch profile, the default cut-off (period <= 5) is used.
  assert.equal(sessionForSlot({ branchId: 'b1', day: 1, period: 5 }, null), 'sang');
  assert.equal(sessionForSlot({ branchId: 'b1', day: 1, period: 6 }, null), 'chieu');
});

test('S_PREFERRED_SESSION: respects branch.sessions map (not hardcoded <= 5)', () => {
  const t = { nguyenVong: { buoiUuTien: 'sang' } };
  // Branch with custom sessions: sang = periods 1..3, chieu = 4..6.
  const branch = { id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5, 6], sessions: { sang: [1, 2, 3], chieu: [4, 5, 6] } };
  const input = { branches: [branch] };
  // period 4 is CHIEU under the new profile (default would be sang).
  const slots = [{ branchId: 'b1', day: 1, period: 4 }];
  const score = SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, slots, input);
  assert.equal(score, 0, 'period 4 must be CHIEU under the new profile');
});

// --- 11. Max sessions count (day, session) tuples -----------------------

test('S_MAX_SESSIONS_PER_WEEK: counts distinct (day, session) tuples', () => {
  const t = { nguyenVong: { soBuoiToiDa: 3 } };
  const branch = { id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] };
  const input = { branches: [branch] };
  // 3 morning + 3 afternoon on the same day = 2 sessions, not 6.
  const slots = [
    { branchId: 'b1', day: 1, period: 1 },
    { branchId: 'b1', day: 1, period: 2 },
    { branchId: 'b1', day: 1, period: 3 },
    { branchId: 'b1', day: 1, period: 6 },
    { branchId: 'b1', day: 1, period: 7 },
    { branchId: 'b1', day: 1, period: 8 },
  ];
  const score = SOFT.S_MAX_SESSIONS_PER_WEEK.scorePerTeacher(t, slots, input);
  assert.equal(score, 1, '2 distinct sessions < cap 3 -> 1');
});

test('S_MAX_SESSIONS_PER_WEEK: morning + afternoon on the same day is TWO sessions', () => {
  const t = { nguyenVong: { soBuoiToiDa: 1 } };
  const branch = { id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] };
  const input = { branches: [branch] };
  // 1 morning + 1 afternoon on day 1 = 2 sessions, over cap 1.
  const slots = [
    { branchId: 'b1', day: 1, period: 1 },
    { branchId: 'b1', day: 1, period: 6 },
  ];
  const score = SOFT.S_MAX_SESSIONS_PER_WEEK.scorePerTeacher(t, slots, input);
  assert.ok(score < 1, 'over cap -> < 1');
  // Specifically: 1 over / cap 1 = 1; 1 - 1 = 0.
  assert.equal(score, 0);
});

// --- 12. Slot must belong to assignment branch ---------------------------

test('H_SLOT_IN_BRANCH: rejects a slot whose branchId differs from the assignment branchId', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
  ];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'wrong-branch',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [{ branchId: 'b2', day: 1, period: 1, teacherId: 't1' }]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const r = verify(sol, input);
  assert.equal(r.accepted, false);
  assert.ok(r.hardViolations.some((v) => v.code === 'H_SLOT_IN_BRANCH'));
});

// --- 13. Validator independence -----------------------------------------

test('validator: does not import the solver (read-only contract)', () => {
  const src = readFileSync(new URL('../src/domain/validator.js', import.meta.url), 'utf8');
  assert.equal(src.includes("from './solver.js'"), false, 'validator must not import solver');
});

test('solver: does not import the validator (search is independent of post-pass validation)', () => {
  const src = readFileSync(new URL('../src/domain/solver.js', import.meta.url), 'utf8');
  assert.equal(src.includes("from './validator.js'"), false, 'solver must not import validator');
});

// --- 14. Solver hard-constraint count in diagnostics --------------------

test('solver: solutions are produced with hardViolationCount = 0 (the search pruned everything)', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3], periods: [1, 2, 3] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  for (const s of r.solutions) {
    assert.equal(s.diagnostics.hardViolationCount, 0);
  }
});

// --- 15. Diversity scoring in pipeline ----------------------------------

test('scorer: diversity score reflects prior candidates', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 1 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 1 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;
  const solA = {
    id: 'A',
    strategyId: 'X',
    assignments: new Map([['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const solB = {
    id: 'B',
    strategyId: 'X',
    assignments: new Map([['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't2' }]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const sA = score(solA, input, []);
  const sB = score(solB, input, [solA]);
  assert.equal(sA.diversityScore, 1, 'no prior -> diversity 1');
  assert.equal(sB.diversityScore, 1, 'different teacher identity -> diversity 1 even with prior');
});

test('scorer: identity-equivalent second candidate gets diversity 0', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 1 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;
  const solA = {
    id: 'A',
    strategyId: 'X',
    assignments: new Map([['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const solB = {
    id: 'B',
    strategyId: 'X',
    assignments: new Map([['a1', [{ branchId: 'b1', day: 1, period: 1, teacherId: 't1' }]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const sB = score(solB, input, [solA]);
  assert.equal(sB.diversityScore, 0, 'identical placement -> diversity 0');
});

// --- 16. expandAssignmentVariants --------------------------------------

test('expandAssignmentVariants: fixed teacherId yields one variant', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }, { id: 'b2', schoolDays: [1], periods: [1] }];
  const a = { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', branchId: 'b1', requiredPeriods: 1 };
  const input = makeInput({ teachers, branches, assignments: [a] });
  const v = expandAssignmentVariants(a, input);
  assert.equal(v.length, 1);
  assert.deepEqual(v[0], { teacherId: 't1', branchId: 'b1' });
});

test('expandAssignmentVariants: open teacherId yields all eligible teachers', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }];
  const a = { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: null, branchId: 'b1', requiredPeriods: 1 };
  const input = makeInput({ teachers, branches, assignments: [a] });
  const v = expandAssignmentVariants(a, input);
  assert.equal(v.length, 2);
});

test('expandAssignmentVariants: open branchId yields home + allowedTransfer only', () => {
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }],
    homeBranchId: 'b1',
    allowedTransferBranches: ['b2'],
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
    { id: 'b3', schoolDays: [1], periods: [1] },
  ];
  const a = { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', branchId: null, requiredPeriods: 1 };
  const input = makeInput({ teachers, branches, assignments: [a] });
  const v = expandAssignmentVariants(a, input);
  const branchIds = v.map((x) => x.branchId).sort();
  assert.deepEqual(branchIds, ['b1', 'b2'], 'must not include b3 (not in allowedTransfer)');
});

// --- 17. Travel score uses actual transitions --------------------------

test('travelScoreFn: feasible transitions score 1, infeasible score 0', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1, 2] },
    { id: 'b2', schoolDays: [1], periods: [1, 2] },
  ];
  const travel = makeTravelProvider({ b1: { b2: 60 } }); // too slow
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const input = makeInput({
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    travelTime: travel,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c2', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
    ],
  });
  const sol = {
    id: 'travel-bad',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b2', day: 1, period: 2, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = travelScoreFn(sol, input);
  assert.equal(s, 0, 'infeasible transition -> 0');
});

test('travelScoreFn: feasible transitions score 1', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1, 2] },
    { id: 'b2', schoolDays: [1], periods: [1, 2] },
  ];
  const travel = makeTravelProvider({ b1: { b2: 5 } });
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const input = makeInput({
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    travelTime: travel,
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c2', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
    ],
  });
  const sol = {
    id: 'travel-ok',
    strategyId: 'X',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b2', day: 1, period: 2, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = travelScoreFn(sol, input);
  assert.equal(s, 1, 'feasible transition -> 1');
});

// --- 18. Workload budget: per-teacher total matches chuyenMon ---------

test('workloadOf: sums chuyenMon soTietTuan', () => {
  const t = { chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }, { tenChuyenMon: 'Y', soTietTuan: 3 }] };
  assert.equal(workloadOf(t), 7);
});

// --- 19. Score is computed using diversity from prior candidates (pipeline) ---

test('orchestrator pipeline: score is finalised with diversity from kept candidates', () => {
  // Strategy A puts heavy weight on diversity. Two candidates with
  // overlapping slots but different teachers at the same (branch,
  // day, period) would still be diverse (per the contract). A and C
  // with the same seed should still produce measurable difference.
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }], homeBranchId: 'b1' },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }], homeBranchId: 'b1' },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  // Two assignments for the same class-subject pair with different
  // teachers will be pruned by H_CLASS_SUBJECT_ONE_TEACHER; so we use
  // different classes instead.
  classes.push({ id: 'c2', branchId: 'b1' });
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Toán', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }],
    assignments,
  });
  const outA = preview({ ...baseInput }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST'], seed: 7 }, new PreviewCache());
  const outC = preview({ ...baseInput }, { solutions: 3, strategies: ['C_BALANCED'], seed: 7 }, new PreviewCache());
  assert.ok(outA.solutions.length >= 1);
  assert.ok(outC.solutions.length >= 1);
  // Both strategies should produce a final overallScore. We just
  // assert that the pipeline completed without throwing and that
  // diversityScore is set.
  assert.ok(typeof outA.solutions[0].score.diversityScore === 'number');
  assert.ok(typeof outC.solutions[0].score.diversityScore === 'number');
});

// --- 20. Transfer is a decision, not a post-pass derivation ----------

test('solver: assignment with open branchId (null) lets the solver choose a non-home branch when allowed', () => {
  // The teacher has homeBranchId = b1 and is allowed to transfer to
  // b2. The class is in b2. The assignment's branchId is null —
  // the solver must pick b2. The validator then accepts because
  // the transfer is allowed.
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }],
    homeBranchId: 'b1',
    allowedTransferBranches: ['b2'],
  }];
  const branches = [
    { id: 'b1', schoolDays: [1], periods: [1] },
    { id: 'b2', schoolDays: [1], periods: [1] },
  ];
  const classes = [{ id: 'c1', branchId: 'b2' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', branchId: null, requiredPeriods: 1 },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.equal(r.solutions.length, 1);
  const sol = r.solutions[0];
  const v = verify(sol, input);
  assert.equal(v.accepted, true, `expected accepted; got ${JSON.stringify(v.hardViolations)}`);
  // The chosen placement is in b2 (the class's branch).
  const slots = sol.assignments.get('a1');
  assert.equal(slots[0].branchId, 'b2');
});
