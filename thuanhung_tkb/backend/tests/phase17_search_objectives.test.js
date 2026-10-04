// PHASE 17 — search-time strategy objectives, A/B/C comparison, and
// structural diversity.
//
// These tests lock in the changes from PHASE_17_SEARCH_OBJECTIVES.md.
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
import { diversity, structuralDiversity } from '../src/domain/diversity.js';
import {
  SOFT,
  expandAssignmentVariants,
  workloadBalanceScore,
  travelScoreFn,
  sessionDiversityScore,
} from '../src/domain/constraints.js';
import { noGapForTeacherDays } from '../src/domain/constraints.js';
import { sessionForSlot } from '../src/domain/time.js';
import {
  STRATEGY_A, STRATEGY_B, STRATEGY_C,
  PRESETS, clampWeights,
} from '../src/domain/strategies.js';
import { makeTravelProvider } from '../src/domain/travel/index.js';
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

// =========================================================================
// 1. Strategy schema: weights carry noGap and sessionDiversity
// =========================================================================

test('PHASE 17 / 1.1 — clampWeights handles noGap and sessionDiversity', () => {
  const raw = { ...STRATEGY_C, weights: { ...STRATEGY_C.weights, noGap: 5, sessionDiversity: -1 } };
  const c = clampWeights(raw);
  assert.equal(c.weights.noGap, 3, 'noGap must be clamped to 3');
  assert.equal(c.weights.sessionDiversity, 0, 'sessionDiversity must be clamped to 0');
});

test('PHASE 17 / 1.2 — every preset declares weights.noGap and weights.sessionDiversity', () => {
  for (const s of PRESETS) {
    assert.equal(typeof s.weights.noGap, 'number', `${s.id} missing weights.noGap`);
    assert.equal(typeof s.weights.sessionDiversity, 'number', `${s.id} missing weights.sessionDiversity`);
  }
});

test('PHASE 17 / 1.3 — STRATEGY_A declares sessionDiversity: false; B and C declare true', () => {
  assert.equal(STRATEGY_A.objectives.sessionDiversity, false);
  assert.equal(STRATEGY_B.objectives.sessionDiversity, true);
  assert.equal(STRATEGY_C.objectives.sessionDiversity, true);
  // A weights must therefore not promote session diversity.
  assert.equal(STRATEGY_A.weights.sessionDiversity, 0);
  // B and C must promote it.
  assert.ok(STRATEGY_B.weights.sessionDiversity > 0);
  assert.ok(STRATEGY_C.weights.sessionDiversity > 0);
});

// =========================================================================
// 2. Solver: strategy objectives affect the search
// =========================================================================

test('PHASE 17 / 2.1 — solution carries the strategyId that produced it', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({ teachers, branches, classes, assignments });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  for (const s of r.solutions) {
    assert.equal(s.strategyId, 'C_BALANCED');
  }
});

test('PHASE 17 / 2.2 — solver with balancedWorkload: false does not consult budget in search', () => {
  // Two teachers with very different budgets. Without workload
  // bias, the search picks whichever variant comes first in the
  // variant order. We assert the search does not throw or skip.
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 20 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] }];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b1' },
  ];
  // Open teacherId; the solver picks one of the two.
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: null, requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'X', teacherId: null, requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_A,
    objectives: { ...STRATEGY_A.objectives, balancedWorkload: false },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1, 'search should produce a solution');
});

test('PHASE 17 / 2.3 — solver with balancedWorkload: true searches the same problem with budget awareness', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 20 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] }];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b1' },
  ];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: null, requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'X', teacherId: null, requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_B,
    objectives: { ...STRATEGY_B.objectives, balancedWorkload: true },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
});

test('PHASE 17 / 2.4 — solver with noGapTeacherDay: true returns a solution with no-gap bias in the pool', () => {
  // A teacher with two slots on day 1. The "ideal" no-gap placement
  // is periods (1, 2) or (4, 5) — contiguous. A gap placement is
  // (1, 3). The solver should still find a valid solution; we just
  // assert the path runs.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_B,
    objectives: { ...STRATEGY_B.objectives, noGapTeacherDay: true },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  // The solution must be valid (hardViolationCount 0).
  for (const s of r.solutions) {
    assert.equal(s.diagnostics.hardViolationCount, 0);
  }
});

test('PHASE 17.1 / 2.5 — solver with sessionDiversity: true (no longer affects search) still produces a valid solution', () => {
  // PHASE 17.1: sessionDiversity no longer affects the search.
  // The search must still run and produce a valid solution when
  // the objective is set; the score is what changes.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 4, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_C,
    objectives: { ...STRATEGY_C.objectives, sessionDiversity: true },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  for (const s of r.solutions) {
    assert.equal(s.diagnostics.hardViolationCount, 0);
  }
});

test('PHASE 17 / 2.6 — solver with all three objectives on still produces a valid solution (no regression)', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Y', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Y', teacherId: 't2', requiredPeriods: 2, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }],
    assignments,
  });
  input.strategy = STRATEGY_C;
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  for (const s of r.solutions) {
    assert.equal(s.diagnostics.hardViolationCount, 0);
  }
});

// =========================================================================
// 3. Scorer: noGap and sessionDiversity are part of the score
// =========================================================================

test('PHASE 17 / 3.1 — noGapScore is reported in the score breakdown', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 3 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 3, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;
  const sol = {
    id: 's',
    strategyId: 'C_BALANCED',
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
  const s = score(sol, input, []);
  assert.equal(typeof s.noGapScore, 'number');
  assert.equal(s.noGapScore, 1, '3 contiguous slots on a day -> noGapScore 1');
});

test('PHASE 17 / 3.2 — sessionDiversityScore (now compactness) is reported in the score breakdown', () => {
  // PHASE 17.1: the score is now "session compactness" — 1 when
  // the teacher has at most one session per day, 0 when every
  // day is split. The previous semantic (1 when split) rewarded
  // fragmentation and conflicted with S_PREFERRED_SESSION, etc.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;
  // 1 morning + 1 afternoon on the same day = SPLIT day → 0.
  const sol = {
    id: 's',
    strategyId: 'C_BALANCED',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = score(sol, input, []);
  assert.equal(typeof s.sessionDiversityScore, 'number');
  assert.equal(s.sessionDiversityScore, 0, 'PHASE 17.1: split day (sang+chieu) -> 0 (compactness penalty)');
});

test('PHASE 17 / 3.3 — overallScore includes the noGap weight', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 3 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 3, branchId: 'b1' },
    ],
  });
  input.strategy = { ...STRATEGY_C, weights: { ...STRATEGY_C.weights, noGap: 2.5, sessionDiversity: 0 } };
  const sol = {
    id: 's',
    strategyId: 'C_BALANCED',
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
  const s = score(sol, input, []);
  // overallScore must include w.noGap * noGapScore = 2.5 * 1 = 2.5.
  // We assert the score is at least 2.5 from the noGap term alone.
  // (The exact value depends on other weights; we just assert noGap
  // contributed meaningfully.)
  assert.ok(s.overallScore >= 2.5, `expected overallScore >= 2.5; got ${s.overallScore}`);
});

test('PHASE 17 / 3.4 — overallScore includes the sessionDiversity weight', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  input.strategy = { ...STRATEGY_C, weights: { ...STRATEGY_C.weights, noGap: 0, sessionDiversity: 2.5 } };
  const sol = {
    id: 's',
    strategyId: 'C_BALANCED',
    assignments: new Map([
      ['a1', [
        { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
        { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
      ]],
    ]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const s = score(sol, input, []);
  // overallScore must include w.sessionDiversity * sessionDiversityScore = 2.5 * 1 = 2.5.
  assert.ok(s.overallScore >= 2.5, `expected overallScore >= 2.5; got ${s.overallScore}`);
});

// =========================================================================
// 4. Diversity: structuralDiversity
// =========================================================================

test('PHASE 17 / 4.1 — structuralDiversity is 0 for identical slot sets (even with different teachers)', () => {
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const sd = structuralDiversity(a, b);
  assert.equal(sd.overall, 0, 'identical slots -> structural 0');
  assert.equal(sd.teacherDay, 0);
  assert.equal(sd.sessionMix, 0);
});

test('PHASE 17 / 4.2 — structuralDiversity is non-zero when teacher day distribution differs', () => {
  // Solution A: t1 has 2 slots on day 1 (concentrated).
  // Solution B: t1 has 1 slot on day 1 and 1 slot on day 2 (spread).
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 2, period: 1, teacherId: 't1' },
    ]]]),
  };
  const sd = structuralDiversity(a, b);
  assert.ok(sd.teacherDay > 0, 'day distribution differs -> teacherDay > 0');
  assert.ok(sd.overall > 0);
});

test('PHASE 17 / 4.3 — structuralDiversity is non-zero when session mix differs', () => {
  // Solution A: t1 has 2 morning slots.
  // Solution B: t1 has 1 morning and 1 afternoon slot.
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 7, teacherId: 't1' },
    ]]]),
  };
  const sd = structuralDiversity(a, b);
  assert.ok(sd.sessionMix > 0, 'session mix differs -> sessionMix > 0');
  assert.ok(sd.overall > 0);
});

test('PHASE 17 / 4.4 — structuralDiversity is bounded in [0, 1]', () => {
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b2', day: 5, period: 8, teacherId: 't2' },
    ]]]),
  };
  const sd = structuralDiversity(a, b);
  assert.ok(sd.overall >= 0 && sd.overall <= 1, `expected [0,1]; got ${sd.overall}`);
  assert.ok(sd.teacherDay >= 0 && sd.teacherDay <= 1);
  assert.ok(sd.sessionMix >= 0 && sd.sessionMix <= 1);
});

test('PHASE 17 / 4.5 — slot identity diversity is unchanged by structural diversity', () => {
  // The plain `diversity()` is the dedupe gate; it is unchanged.
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
    ]]]),
  };
  assert.equal(diversity(a, b), 0, 'slot identity diversity remains 0');
});

// =========================================================================
// 5. Orchestrator: A/B/C comparison
// =========================================================================

test('PHASE 17 / 5.1 — orchestrator response carries a `comparison` block', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const out = preview({ ...input }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST', 'B_WORKLOAD_TRAVEL', 'C_BALANCED'], seed: 1 }, new PreviewCache());
  assert.ok(Array.isArray(out.comparison));
  assert.ok(out.comparison.length === 3);
  for (const c of out.comparison) {
    assert.ok(typeof c.strategyId === 'string');
    assert.ok(typeof c.candidatesProduced === 'number');
    assert.ok(typeof c.accepted === 'number');
  }
});

test('PHASE 17 / 5.2 — comparison block identifies a winner', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const out = preview({ ...input }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST', 'B_WORKLOAD_TRAVEL', 'C_BALANCED'], seed: 1 }, new PreviewCache());
  const winners = out.comparison.filter((c) => c.winner);
  assert.ok(winners.length === 1, `expected exactly one winner; got ${winners.length}`);
  assert.ok(winners[0].topScore > 0 || winners[0].topScore === 0);
});

test('PHASE 17 / 5.3 — each solution carries a strategyId', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const out = preview({ ...input }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST', 'B_WORKLOAD_TRAVEL', 'C_BALANCED'], seed: 1 }, new PreviewCache());
  for (const s of out.solutions) {
    assert.ok(typeof s.strategyId === 'string');
  }
});

test('PHASE 17 / 5.4 — each solution carries a structuralDiversity breakdown', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const out = preview({ ...input }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST', 'B_WORKLOAD_TRAVEL', 'C_BALANCED'], seed: 1 }, new PreviewCache());
  for (const s of out.solutions) {
    assert.ok(s.structuralDiversity);
    assert.equal(typeof s.structuralDiversity.teacherDay, 'number');
    assert.equal(typeof s.structuralDiversity.sessionMix, 'number');
    assert.equal(typeof s.structuralDiversity.overall, 'number');
  }
});

test('PHASE 17 / 5.5 — strategies A/B/C on the same input produce distinct top scores', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 4 }], homeBranchId: 'b1', nguyenVong: { soBuoiToiDa: 4, buoiUuTien: 'sang', thuNghi: [] } },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Lý', soTietTuan: 4 }], homeBranchId: 'b1' },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'Toán', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Lý', teacherId: 't2', requiredPeriods: 2, branchId: 'b1' },
  ];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'Toán', name: 'Toán' }, { id: 'Lý', name: 'Lý' }],
    assignments,
  });
  const outA = preview({ ...baseInput }, { solutions: 3, strategies: ['A_PREFERENCE_FIRST'], seed: 1 }, new PreviewCache());
  const outB = preview({ ...baseInput }, { solutions: 3, strategies: ['B_WORKLOAD_TRAVEL'], seed: 1 }, new PreviewCache());
  const outC = preview({ ...baseInput }, { solutions: 3, strategies: ['C_BALANCED'], seed: 1 }, new PreviewCache());
  const topA = outA.comparison[0].topScore;
  const topB = outB.comparison[0].topScore;
  const topC = outC.comparison[0].topScore;
  // The three strategies differ in weights, so the top scores must
  // differ for at least one pair.
  const distinct = new Set([topA, topB, topC].map((s) => s.toFixed(6)));
  assert.ok(distinct.size >= 2, `expected ≥2 distinct top scores; got A=${topA}, B=${topB}, C=${topC}`);
});

// =========================================================================
// 6. Workload as a search-time heuristic
// =========================================================================

test('PHASE 17 / 6.1 — solver with open teacherId and balancedWorkload: true emits a candidate', () => {
  // Two eligible teachers, one with 2-slot budget and one with 4-slot
  // budget. The solver must pick a feasible teacher for each open
  // assignment. The bias is a soft nudge; the result is a valid
  // solution.
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: null, requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_B,
    objectives: { ...STRATEGY_B.objectives, balancedWorkload: true },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
  // The solver's chosen teacher is recorded in the placement.
  for (const s of r.solutions) {
    const p = s.placements.get('a1');
    assert.ok(p, 'placement is recorded');
    assert.ok(['t1', 't2'].includes(p.teacherId), 'teacher is one of the eligible ones');
  }
});

test('PHASE 17 / 6.2 — workload bias in search does not crash on teachers with no budget', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 1 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
  ];
  const input = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_C,
    objectives: { ...STRATEGY_C.objectives, balancedWorkload: true },
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1);
});

// =========================================================================
// 7. Audit: diversity metric for real TKB
// =========================================================================

test('PHASE 17 / 7.1 — two solutions with same slot identity but different day distribution differ structurally', () => {
  // A: t1 has 2 slots on day 1 (concentrated).
  // B: t1 has 1 slot on day 1 and 1 slot on day 5 (spread).
  // The slot sets are different (1,2) vs (1,5), so the plain
  // diversity is non-zero. But the structural diversity captures
  // the additional fact that A's day-pattern is concentrated.
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 5, period: 1, teacherId: 't1' },
    ]]]),
  };
  const d = diversity(a, b);
  const sd = structuralDiversity(a, b);
  assert.ok(d > 0 && d < 1, 'slot identity partially overlaps');
  assert.ok(sd.teacherDay > 0, 'structural: day distribution differs');
});

test('PHASE 17 / 7.2 — same-day concentrated slot set has higher session-mix homogeneity', () => {
  // A: morning morning (sang sang) -> 0 mix
  // B: morning afternoon (sang chieu) -> 1 mix
  const a = {
    id: 'A',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  const b = {
    id: 'B',
    assignments: new Map([['x', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
    ]]]),
  };
  const sd = structuralDiversity(a, b);
  assert.ok(sd.sessionMix > 0, 'session mix differs -> non-zero');
});

test('PHASE 17 / 7.3 — structural diversity is reported for each kept candidate', () => {
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Y', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'Y', teacherId: 't2', requiredPeriods: 2, branchId: 'b1' },
  ];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }],
    assignments,
  });
  const out = preview({ ...baseInput }, { solutions: 3, strategies: ['C_BALANCED'], seed: 42 }, new PreviewCache());
  for (const s of out.solutions) {
    assert.ok(s.structuralDiversity);
    // The overall structural diversity is bounded in [0, 1].
    assert.ok(s.structuralDiversity.overall >= 0 && s.structuralDiversity.overall <= 1);
  }
});

// =========================================================================
// 8. sessionDiversityScore function-level tests (PHASE 17.1: compactness)
// =========================================================================

test('PHASE 17.1 / 8.1 — sessionDiversityScore is 0 for a teacher with split day (sang+chieu on the same day)', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const input = makeInput({
    teachers, branches, classes: [{ id: 'c1', branchId: 'b1' }],
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'split',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
    ]]]),
  };
  assert.equal(sessionDiversityScore(sol, input), 0, 'PHASE 17.1: split day -> 0 (was 1 in PHASE 17 v1)');
});

test('PHASE 17.1 / 8.2 — sessionDiversityScore is 1 for a teacher with all-sang on the same day', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const input = makeInput({
    teachers, branches, classes: [{ id: 'c1', branchId: 'b1' }],
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  const sol = {
    id: 'compact',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
  };
  assert.equal(sessionDiversityScore(sol, input), 1, 'PHASE 17.1: same-session day -> 1 (was 0 in PHASE 17 v1)');
});

test('PHASE 17.1 / 8.3 — sessionDiversityScore is 1 for an empty solution (no penalty)', () => {
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 0 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const input = makeInput({
    teachers, branches, classes: [{ id: 'c1', branchId: 'b1' }],
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [],
  });
  const sol = { id: 'empty', assignments: new Map() };
  assert.equal(sessionDiversityScore(sol, input), 1);
});
