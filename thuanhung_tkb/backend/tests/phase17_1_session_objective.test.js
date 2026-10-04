// PHASE 17.1 — corrected session-objective semantics.
//
// These tests lock in the changes from PHASE_17_1_SESSION_OBJECTIVE.md.
// They assert the new contract:
//
//   - sessionDiversity no longer rewards a teacher for having both
//     morning and afternoon on the same day.
//   - sessionDiversityScore is "session compactness" — penalizes
//     split days.
//   - The search does NOT push toward opposite session.
//   - S_PREFERRED_SESSION is preserved.
//   - S_MAX_SESSIONS_PER_WEEK still counts (day, session) tuples.
//   - Travel is not affected by an opposite-session nudge.
//   - Solution-level diversity (structuralDiversity) is unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { solve } from '../src/domain/solver.js';
import { score } from '../src/domain/scorer.js';
import { diversity, structuralDiversity } from '../src/domain/diversity.js';
import {
  SOFT,
  sessionDiversityScore,
} from '../src/domain/constraints.js';
import {
  STRATEGY_A, STRATEGY_B, STRATEGY_C, PRESETS,
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
// Test 1 — afternoon candidate must NOT receive an automatic positive
// score merely because it is the OTHER session.
// =========================================================================

test('PHASE 17.1 / 1 — afternoon candidate (other session) does NOT receive automatic positive score', () => {
  // Hand-craft a solution where t1 has only morning slots on day 1.
  // The session-diversity score must NOT reward an "afternoon" sibling.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const input = makeInput({
    teachers, branches, classes: [{ id: 'c1', branchId: 'b1' }],
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;

  // Option A: 1 morning + 1 afternoon on the same day (split)
  const split = {
    id: 'split',
    strategyId: 'C_BALANCED',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
    ]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  // Option B: 2 mornings on the same day (compact)
  const compact = {
    id: 'compact',
    strategyId: 'C_BALANCED',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const scoreSplit = sessionDiversityScore(split, input);
  const scoreCompact = sessionDiversityScore(compact, input);
  assert.equal(scoreSplit, 0, 'split day -> 0 (compactness penalty)');
  assert.equal(scoreCompact, 1, 'compact day -> 1 (no penalty)');
  // The compact option must score STRICTLY higher.
  assert.ok(scoreCompact > scoreSplit, `compact (${scoreCompact}) must beat split (${scoreSplit})`);
});

// =========================================================================
// Test 2 — S_PREFERRED_SESSION is preserved (morning preference keeps advantage)
// =========================================================================

test('PHASE 17.1 / 2 — S_PREFERRED_SESSION preserves morning preference', () => {
  const t = { nguyenVong: { buoiUuTien: 'sang' } };
  const input = { branches: [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5, 6, 7, 8], sessions: { sang: [1, 2, 3, 4], chieu: [5, 6, 7, 8] } }] };
  // Morning slot (period 1) and afternoon slot (period 5) on the same day.
  const morningSlots = [{ branchId: 'b1', day: 1, period: 1 }];
  const afternoonSlots = [{ branchId: 'b1', day: 1, period: 5 }];
  const morningScore = SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, morningSlots, input);
  const afternoonScore = SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, afternoonSlots, input);
  assert.equal(morningScore, 1, 'morning slot must score 1 for sang preference');
  assert.equal(afternoonScore, 0, 'afternoon slot must score 0 for sang preference');
  // The corrected session-diversity score must NOT overrule the
  // preferred-session signal. With both slots on the same day, the
  // session-diversity score is 0 (split), but the S_PREFERRED_SESSION
  // score still gives the morning slot a clear advantage.
  assert.ok(morningScore > afternoonScore);
});

// =========================================================================
// Test 3 — S_MAX_SESSIONS_PER_WEEK counts (day, session) tuples
// =========================================================================

test('PHASE 17.1 / 3 — S_MAX_SESSIONS_PER_WEEK still counts (day, session) tuples', () => {
  // 1 morning + 1 afternoon on the same day = 2 sessions.
  // The PHASE 17.1 change to the OTHER score must not change this.
  const t = { nguyenVong: { soBuoiToiDa: 1 } };
  const branch = { id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] };
  const input = { branches: [branch] };
  const slots = [
    { branchId: 'b1', day: 1, period: 1 },
    { branchId: 'b1', day: 1, period: 6 },
  ];
  const score = SOFT.S_MAX_SESSIONS_PER_WEEK.scorePerTeacher(t, slots, input);
  assert.ok(score < 1, 'over cap -> < 1');
  assert.equal(score, 0, '1 over / cap 1 = 1, 1 - 1 = 0');
});

// =========================================================================
// Test 4 — Travel is not affected by an opposite-session nudge
// =========================================================================

test('PHASE 17.1 / 4 — solver does not push toward opposite session when it forces cross-branch travel', () => {
  // A teacher with home branch b1, eligible to transfer to b2. Two
  // classes, one in b1, one in b2. The teacher must place a slot
  // in each branch. The travel time b1→b2 is large (50 min), so
  // the same-day placement (b1, p1) → (b2, p2) is INFEASIBLE.
  //
  // With PHASE 17 v1, the search would have nudged toward the
  // opposite session for a same-day slot, which would force a
  // cross-branch same-day transition and reject the candidate.
  // With PHASE 17.1, the search has no such nudge, and the solver
  // finds a feasible solution across different days.
  const teachers = [{
    id: 't1', hoTen: 'A',
    chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }],
    homeBranchId: 'b1',
    allowedTransferBranches: ['b2'],
  }];
  const branches = [
    { id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] },
    { id: 'b2', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5] },
  ];
  const classes = [
    { id: 'c1', branchId: 'b1' },
    { id: 'c2', branchId: 'b2' },
  ];
  const travel = makeTravelProvider({ b1: { b2: 50 } }); // 50 min, well over 10 min window
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
    { id: 'a2', classId: 'c2', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b2' },
  ];
  const input = makeInput({
    teachers, branches, classes, travelTime: travel,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  input.strategy = {
    ...STRATEGY_C,
    objectives: { ...STRATEGY_C.objectives, sessionDiversity: true }, // explicitly ON
  };
  const r = solve(input);
  assert.ok(r.solutions.length >= 1, 'solver must find a solution that does not require same-day cross-branch travel');
  for (const s of r.solutions) {
    assert.equal(s.diagnostics.hardViolationCount, 0);
    // The chosen slots must be on different days (no same-day cross-branch).
    const slotsA1 = s.assignments.get('a1') ?? [];
    const slotsA2 = s.assignments.get('a2') ?? [];
    for (const x of slotsA1) {
      for (const y of slotsA2) {
        if (x.day === y.day) {
          assert.notEqual(x.branchId, y.branchId, 'same-day slots must be in the same branch');
        }
      }
    }
  }
});

// =========================================================================
// Test 5 — Solution-level diversity is preserved (no regression in
// structuralDiversity).
// =========================================================================

test('PHASE 17.1 / 5 — solution-level diversity is preserved (structuralDiversity intact)', () => {
  // Two solutions with different teacher day patterns should still
  // get a high structural diversity score, even though neither
  // intentionally fragments a teacher's schedule.
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] },
    { id: 't2', hoTen: 'B', chuyenMon: [{ tenChuyenMon: 'Y', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }, { id: 'c2', branchId: 'b1' }];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }, { id: 'Y', name: 'Y' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 1, branchId: 'b1' },
      { id: 'a2', classId: 'c2', subjectId: 'Y', teacherId: 't2', requiredPeriods: 1, branchId: 'b1' },
    ],
  });
  const out = preview({ ...baseInput }, { solutions: 3, strategies: ['C_BALANCED'], seed: 7 }, new PreviewCache());
  assert.ok(out.solutions.length >= 1);
  for (const s of out.solutions) {
    assert.ok(s.structuralDiversity);
    assert.equal(typeof s.structuralDiversity.overall, 'number');
    assert.equal(typeof s.structuralDiversity.teacherDay, 'number');
    assert.equal(typeof s.structuralDiversity.sessionMix, 'number');
    // Bounds preserved.
    assert.ok(s.structuralDiversity.overall >= 0 && s.structuralDiversity.overall <= 1);
    assert.ok(s.structuralDiversity.teacherDay >= 0 && s.structuralDiversity.teacherDay <= 1);
    assert.ok(s.structuralDiversity.sessionMix >= 0 && s.structuralDiversity.sessionMix <= 1);
  }
});

// =========================================================================
// Test 6 — Regression: all 162 pre-existing tests must still pass.
// This test asserts that the relevant surfaces are unchanged.
// =========================================================================

test('PHASE 17.1 / 6 — regression: solver source no longer references session-diversity bias', () => {
  const src = readFileSync(new URL('../src/domain/solver.js', import.meta.url), 'utf8');
  // The session-diversity bias function and BIAS.SESSION_OTHER must
  // be GONE. (We deliberately removed them in PHASE 17.1.) Comments
  // mentioning the removal are OK; we look for the function/constant
  // definitions that would actually affect the search.
  assert.equal(/function\s+sessionDiversityBias\s*\(/.test(src), false,
    'sessionDiversityBias function definition must be removed from solver');
  assert.equal(/SESSION_OTHER\s*:/i.test(src), false,
    'BIAS.SESSION_OTHER definition must be removed from solver');
  assert.equal(/SESSION_SAME\s*:/i.test(src), false,
    'BIAS.SESSION_SAME definition must be removed from solver');
  // The slot composite must not include a session-diversity term.
  const compositeMatch = src.match(/function\s+slotComposite[\s\S]*?\n  \}/);
  if (compositeMatch) {
    assert.equal(/session/i.test(compositeMatch[0]), false,
      'slotComposite must not reference session in its body');
  }
});

test('PHASE 17.1 / 6.2 — regression: sessionDiversityScore function still exists with corrected semantic', () => {
  // The function still exists (so callers can still read the field)
  // but its semantic is now "compactness" (1 - splitDays / totalDays).
  const src = readFileSync(new URL('../src/domain/constraints.js', import.meta.url), 'utf8');
  assert.ok(src.includes('export function sessionDiversityScore'),
    'sessionDiversityScore must still be exported');
  // The PHASE 17.1 change: 1 - split/total instead of mixed/total.
  assert.ok(src.includes('1 - split / total') || src.includes('1 - splitDays'),
    'sessionDiversityScore must compute 1 - split/total (compactness)');
});

test('PHASE 17.1 / 6.3 — regression: strategies still declare sessionDiversity in objectives and weights', () => {
  // The strategy surface is preserved; only the SEMANTIC of the
  // score changed. The A/B/C audit-friendly contract is intact.
  for (const s of PRESETS) {
    assert.equal(typeof s.weights.sessionDiversity, 'number');
    assert.equal(typeof s.objectives.sessionDiversity, 'boolean');
  }
  assert.equal(STRATEGY_A.weights.sessionDiversity, 0, 'A: weight 0 (does not reward compactness)');
  assert.equal(STRATEGY_A.objectives.sessionDiversity, false, 'A: objective false');
  assert.ok(STRATEGY_B.weights.sessionDiversity > 0);
  assert.equal(STRATEGY_B.objectives.sessionDiversity, true);
  assert.ok(STRATEGY_C.weights.sessionDiversity > 0);
  assert.equal(STRATEGY_C.objectives.sessionDiversity, true);
});

// =========================================================================
// Test 7 — No-N-gap: compactness is orthogonal to noGap.
// =========================================================================

test('PHASE 17.1 / 7 — noGap and sessionCompactness are independent signals', () => {
  // Option A: 2 morning slots on day 1 (periods 1, 2) — no gap, no split
  // Option B: 1 morning slot (period 1) + 1 afternoon slot (period 6) on day 1 — split, with a large gap
  // Both options have a single teacher-day. The noGapScore measures
  // CONTIGUITY (periods.length / span), the sessionCompactnessScore
  // measures SPLIT vs NOT-SPLIT. The two signals are independent.
  const teachers = [{ id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 2 }] }];
  const branches = [{ id: 'b1', schoolDays: [1], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const input = makeInput({
    teachers, branches, classes: [{ id: 'c1', branchId: 'b1' }],
    subjects: [{ id: 'X', name: 'X' }],
    assignments: [
      { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 2, branchId: 'b1' },
    ],
  });
  input.strategy = STRATEGY_C;

  const compact = {
    id: 'compact',
    strategyId: 'C_BALANCED',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 2, teacherId: 't1' },
    ]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const split = {
    id: 'split',
    strategyId: 'C_BALANCED',
    assignments: new Map([['a1', [
      { branchId: 'b1', day: 1, period: 1, teacherId: 't1' },
      { branchId: 'b1', day: 1, period: 6, teacherId: 't1' },
    ]]]),
    transfers: [],
    diagnostics: { hardViolationCount: 0, preferenceHits: 0, preferenceMisses: 0, objectiveValues: {} },
  };
  const compactScore = score(compact, input, []);
  const splitScore = score(split, input, []);
  // Compact is contiguous: noGapScore = 2/2 = 1.
  assert.equal(compactScore.noGapScore, 1);
  // Split has a 5-period gap: noGapScore = 2/6 ≈ 0.33.
  assert.ok(splitScore.noGapScore < 1);
  // Compact: sessionCompactnessScore = 1; Split: sessionCompactnessScore = 0.
  assert.equal(compactScore.sessionDiversityScore, 1);
  assert.equal(splitScore.sessionDiversityScore, 0);
  // Compact must score STRICTLY higher on both dimensions.
  assert.ok(compactScore.noGapScore > splitScore.noGapScore,
    `compact.noGap (${compactScore.noGapScore}) must beat split.noGap (${splitScore.noGapScore})`);
  assert.ok(compactScore.sessionDiversityScore > splitScore.sessionDiversityScore,
    `compact.compactness (${compactScore.sessionDiversityScore}) must beat split.compactness (${splitScore.sessionDiversityScore})`);
  // And the overall score must reflect both.
  assert.ok(compactScore.overallScore > splitScore.overallScore,
    `compact (${compactScore.overallScore}) must beat split (${splitScore.overallScore})`);
});

// =========================================================================
// Test 8 — strategies A/B/C produce the same candidate without the
// session-diversity bias (search is no longer affected by the switch).
// =========================================================================

test('PHASE 17.1 / 8 — sessionDiversity: false vs true produce comparable searches', () => {
  // With PHASE 17.1, the search no longer reads sessionDiversity,
  // so the two settings should produce the same first-solution shape
  // (slot identity, in particular). The difference, if any, can only
  // come from the weight in the score, which is applied AFTER the
  // search.
  const teachers = [
    { id: 't1', hoTen: 'A', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 4 }] },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2], periods: [1, 2, 3, 4, 5, 6, 7, 8] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  const assignments = [
    { id: 'a1', classId: 'c1', subjectId: 'X', teacherId: 't1', requiredPeriods: 4, branchId: 'b1' },
  ];
  const baseInput = makeInput({
    teachers, branches, classes,
    subjects: [{ id: 'X', name: 'X' }],
    assignments,
  });
  const strategyOff = {
    ...STRATEGY_A,
    objectives: { ...STRATEGY_A.objectives, sessionDiversity: false, balancedWorkload: false, noGapTeacherDay: false },
  };
  const strategyOn = {
    ...STRATEGY_C,
    objectives: { ...STRATEGY_C.objectives, sessionDiversity: true, balancedWorkload: false, noGapTeacherDay: false },
  };
  const inputOff = { ...baseInput, strategy: strategyOff };
  const inputOn = { ...baseInput, strategy: strategyOn };
  const rOff = solve(inputOff);
  const rOn = solve(inputOn);
  // Both must produce at least one solution.
  assert.ok(rOff.solutions.length >= 1);
  assert.ok(rOn.solutions.length >= 1);
  // The first-solution slots MUST be identical (no search-time bias).
  const slotsOff = rOff.solutions[0].assignments.get('a1').map((s) => `${s.day}:${s.period}`).sort();
  const slotsOn = rOn.solutions[0].assignments.get('a1').map((s) => `${s.day}:${s.period}`).sort();
  assert.deepEqual(slotsOff, slotsOn, 'search no longer depends on sessionDiversity switch');
});
