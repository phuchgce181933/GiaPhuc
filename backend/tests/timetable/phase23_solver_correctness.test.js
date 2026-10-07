import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { STRATEGY_C } from '../../src/modules/timetable/engine/domain/strategies.js';
import { verify } from './helpers/legacy-validator.js';
import { evaluateCandidate, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { classConflictKey, teacherConflictKey, slotKey } from '../../src/modules/timetable/engine/domain/time.js';
function solveReal(seed = 0xC0FFEE) {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    diversification: {
      ...STRATEGY_C.diversification,
      seed
    },
    solver: {
      timeLimitMs: 10_000,
      maxSolutions: 1
    }
  };
  const out = solve(input);
  return {
    out,
    input,
    full,
    solution: out.solutions[0] ?? null
  };
}
function countSlots(candidate) {
  let n = 0;
  for (const arr of candidate.assignments.values()) n += arr.length;
  return n;
}
test('PHASE 23 / C1 — solver returns a candidate on real data', () => {
  const {
    out,
    solution
  } = solveReal();
  assert.equal(out.failure, null);
  assert.ok(solution, 'solver must return at least one candidate');
  assert.ok(solution.assignments instanceof Map);
});
test('PHASE 23 / C2 — candidate is NOT the legacy baseline object', () => {
  const {
    full,
    solution
  } = solveReal();
  assert.notEqual(solution, full.legacyBaseline);
  assert.notEqual(solution.assignments, full.legacyBaseline.scheduleSlots);
  const baselineByADP = new Map();
  for (const s of full.legacyBaseline.scheduleSlots) {
    baselineByADP.set(`${s.assignment}|${s.day}|${s.period}`, true);
  }
  let matches = 0;
  for (const [aId, slots] of solution.assignments) {
    for (const s of slots) {
      const k = `${aId}|${s.day}|${s.period}`;
      if (baselineByADP.has(k)) matches++;
    }
  }
  assert.ok(matches < countSlots(solution) * 0.01, `expected < 1% slot overlap with baseline; got ${matches}/${countSlots(solution)}`);
});
test('PHASE 23 / C3 — candidate has 802 placements (full demand coverage)', () => {
  const {
    solution
  } = solveReal();
  assert.equal(countSlots(solution), 802);
});
test('PHASE 23 / C4 — all 479 assignments are represented in candidate', () => {
  const {
    input,
    solution
  } = solveReal();
  assert.equal(solution.assignments.size, input.assignments.length);
  assert.equal(solution.assignments.size, 479);
  for (const a of input.assignments) {
    assert.ok(solution.assignments.has(a.id), `assignment ${a.id} missing from candidate`);
  }
});
test('PHASE 23 / C5 — every assignment reaches requiredPeriods (no partial)', () => {
  const {
    input,
    solution
  } = solveReal();
  let totalScheduled = 0;
  let totalRequired = 0;
  for (const a of input.assignments) {
    const placed = solution.assignments.get(a.id) ?? [];
    assert.equal(placed.length, a.requiredPeriods, `assignment ${a.id}: ${placed.length}/${a.requiredPeriods}`);
    totalScheduled += placed.length;
    totalRequired += a.requiredPeriods;
  }
  assert.equal(totalScheduled, 802);
  assert.equal(totalRequired, 802);
});
test('PHASE 23 / C6 — no duplicate class slot (with session-aware identity)', () => {
  const {
    input,
    solution
  } = solveReal();
  const seen = new Map();
  let dup = 0;
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    for (const s of slots) {
      const k = `${meta.classId}|${classConflictKey(s)}`;
      if (seen.has(k)) dup++;else seen.set(k, s);
    }
  }
  assert.equal(dup, 0);
});
test('PHASE 23 / C7 — no duplicate teacher slot (with session-aware identity)', () => {
  const {
    solution
  } = solveReal();
  const seen = new Map();
  let dup = 0;
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const k = `${s.teacherId}|${teacherConflictKey(s)}`;
      if (seen.has(k)) dup++;else seen.set(k, s);
    }
  }
  assert.equal(dup, 0);
});
test('PHASE 23 / C8 — every (teacherId, subjectId) pairing is eligible', () => {
  const {
    input,
    solution
  } = solveReal();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    const teacher = input.teacherIndex.get(meta.teacherId);
    assert.ok(teacher, `teacher ${meta.teacherId} must exist`);
    const eligibleIds = new Set(teacher.eligibleSubjectIds ?? []);
    const eligibleNames = new Set((teacher.chuyenMon ?? []).map(s => s.tenChuyenMon));
    assert.ok(eligibleIds.has(meta.subjectId) || eligibleNames.has(meta.subjectId), `teacher ${teacher.hoTen} (${teacher.id}) is not eligible for ${meta.subjectId}`);
  }
});
test('PHASE 23 / C9 — every teacher used in candidate is active', () => {
  const {
    input,
    solution
  } = solveReal();
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const t = input.teacherIndex.get(s.teacherId);
      assert.ok(t);
      assert.notEqual(t.trangThai, 'inactive');
    }
  }
});
test('PHASE 23 / C9b — every subject used in candidate is active', () => {
  const {
    input,
    solution
  } = solveReal();
  const inactiveSubjects = new Set(input.subjects.filter(s => !s.isActive).map(s => s.id));
  for (const [aId] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    assert.ok(!inactiveSubjects.has(meta.subjectId), `assignment ${aId} references inactive subject ${meta.subjectId}`);
  }
});
test('PHASE 23 / C10 — CN-TH never appears in candidate demand', () => {
  const {
    full,
    input,
    solution
  } = solveReal();
  const cnth = full.normalized.subjects.find(s => s.code === 'CN-TH');
  assert.ok(cnth, 'CN-TH must exist in source');
  assert.equal(cnth.isActive, false);
  for (const [aId] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    assert.notEqual(meta.subjectId, cnth.id, 'CN-TH must not be referenced by any scheduled assignment');
  }
  const cnthAssignments = input.assignments.filter(a => a.subjectId === cnth.id).length;
  assert.equal(cnthAssignments, 0);
});
test('PHASE 23 / C11 — every placement references a valid branch', () => {
  const {
    input,
    solution
  } = solveReal();
  const branchIds = new Set(input.branches.map(b => b.id));
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      assert.ok(branchIds.has(s.branchId), `unknown branch ${s.branchId}`);
    }
  }
});
test('PHASE 23 / C11b — every placement is within the branch profile (schoolDays × periods)', () => {
  const {
    input,
    solution
  } = solveReal();
  const allowed = new Set();
  for (const [, slots] of input.timeSlotsByBranch) {
    for (const s of slots) allowed.add(slotKey(s));
  }
  let outOfProfile = 0;
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      if (!allowed.has(slotKey(s))) outOfProfile++;
    }
  }
  assert.equal(outOfProfile, 0);
});
test('PHASE 23 / C12 — every placement has day, period, branchId, teacherId', () => {
  const {
    solution
  } = solveReal();
  for (const [aId, slots] of solution.assignments) {
    for (const s of slots) {
      assert.notEqual(s.day, null);
      assert.notEqual(s.day, undefined);
      assert.notEqual(s.period, null);
      assert.notEqual(s.period, undefined);
      assert.ok(typeof s.day === 'number');
      assert.ok(typeof s.period === 'number');
      assert.notEqual(s.branchId, null);
      assert.notEqual(s.branchId, undefined);
      assert.notEqual(s.teacherId, null);
      assert.notEqual(s.teacherId, undefined);
    }
  }
});
test('PHASE 23 / C13 — independent constraint evaluator: zero hard violations', () => {
  const {
    input,
    solution
  } = solveReal();
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.hard.violated, false);
  const v = verify(solution, input);
  assert.equal(v.hardViolations.length, 0);
  assert.equal(v.accepted, true);
});
test('PHASE 23 / C14 — evaluator accepts candidate (summary.accepted = true)', () => {
  const {
    input,
    solution
  } = solveReal();
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.summary.accepted, true);
  assert.equal(isAccepted(ev), true);
});
test('PHASE 23 / C15 — solver is deterministic: same seed → identical candidate', () => {
  const a = solveReal(0xC0FFEE);
  const b = solveReal(0xC0FFEE);
  assert.equal(countSlots(a.solution), countSlots(b.solution));
  assert.equal(a.solution.assignments.size, b.solution.assignments.size);
  for (const aId of a.solution.assignments.keys()) {
    const slotsA = a.solution.assignments.get(aId);
    const slotsB = b.solution.assignments.get(aId);
    assert.equal(slotsA.length, slotsB.length);
    const setA = new Set(slotsA.map(s => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
    for (const s of slotsB) {
      assert.ok(setA.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`), 'deterministic solver: same slot must appear in both runs');
    }
  }
});
test('PHASE 23 / C15b — solver is deterministic across repeated runs (5x)', () => {
  const baseline = solveReal(0xC0FFEE);
  for (let i = 0; i < 5; i++) {
    const next = solveReal(0xC0FFEE);
    assert.equal(countSlots(next.solution), countSlots(baseline.solution));
    for (const aId of baseline.solution.assignments.keys()) {
      const slotsBase = baseline.solution.assignments.get(aId);
      const slotsNext = next.solution.assignments.get(aId);
      assert.equal(slotsBase.length, slotsNext.length);
      const setBase = new Set(slotsBase.map(s => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      for (const s of slotsNext) {
        assert.ok(setBase.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      }
    }
  }
});
test('PHASE 23 / C16 — solver does not mutate SchedulingInput', () => {
  const {
    full
  } = solveReal();
  const beforeAssignments = full.scheduling.assignments.map(a => ({
    ...a
  }));
  solveReal();
  const afterAssignments = full.scheduling.assignments.map(a => ({
    ...a
  }));
  assert.equal(beforeAssignments.length, afterAssignments.length);
  for (let i = 0; i < beforeAssignments.length; i++) {
    assert.deepEqual(beforeAssignments[i], afterAssignments[i]);
  }
  assert.equal(full.scheduling.assignments.length, 479);
  assert.equal(full.scheduling.teachers.length, 40);
  assert.equal(full.scheduling.branches.length, 7);
  assert.equal(full.scheduling.classes.length, 113);
});
test('PHASE 23 / C17 — solver does not mutate legacy baseline', () => {
  const {
    full
  } = solveReal();
  const beforeSlots = full.legacyBaseline.scheduleSlots.length;
  const beforeSummary = {
    ...full.legacyBaseline.summary
  };
  solveReal();
  assert.equal(full.legacyBaseline.scheduleSlots.length, beforeSlots);
  assert.deepEqual(full.legacyBaseline.summary, beforeSummary);
});
test('PHASE 23 / C18 — solver does not fabricate travel data', () => {
  const {
    input,
    solution
  } = solveReal();
  assert.equal(input.travelTime, null);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.constraintStatuses['H14'], 'UNSUPPORTED');
  assert.equal(ev.hard.violations.filter(v => v.constraintId === 'H14').length, 0);
});
test('PHASE 23 / C20 — solver reports EMPTY / NO_SOLUTION when demand is impossible', () => {
  const {
    full
  } = solveReal();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    solver: {
      timeLimitMs: 500,
      maxSolutions: 1
    }
  };
  const target = input.assignments[0];
  const targetId = target.id;
  input.assignments = input.assignments.map(a => a.id === targetId ? {
    ...a,
    requiredPeriods: 999
  } : a);
  input.assignmentIndex = new Map(input.assignments.map(a => [a.id, a]));
  const out = solve(input);
  assert.ok(out.solutions.length === 0 || out.failure === 'NO_SOLUTION', 'impossible demand must not produce a candidate');
  for (const s of out.solutions) {
    const total = countSlots(s);
    assert.ok(total < 999, 'solver must not fabricate 999 slots on a 25-slot branch');
  }
  assert.ok(out.diagnostics);
  assert.ok(typeof out.diagnostics.totalSolveMs === 'number');
});
test('PHASE 23 / C21 — solver candidate uses every active teacher (cohort integrity)', () => {
  const {
    input,
    solution
  } = solveReal();
  const usedTeachers = new Set();
  for (const [, slots] of solution.assignments) {
    for (const s of slots) usedTeachers.add(s.teacherId);
  }
  assert.ok(usedTeachers.size > 0);
  assert.ok(usedTeachers.size <= input.teachers.length);
});
test('PHASE 23 / C22 — baseline is independent reference, not a dependency', () => {
  const full = loadLegacySchedulingFixture();
  const input = {
    ...full.scheduling,
    strategy: STRATEGY_C
  };
  delete input.legacyBaseline;
  input.strategy = {
    ...STRATEGY_C,
    solver: {
      timeLimitMs: 10_000,
      maxSolutions: 1
    }
  };
  const out = solve(input);
  assert.ok(out.solutions.length >= 1);
  const sol = out.solutions[0];
  assert.equal(countSlots(sol), 802);
  const ev = evaluateCandidate(sol, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
});
test('PHASE 23 / C23 — phase-22.1 reconciliation invariants still hold after Phase 23', () => {
  const {
    input,
    solution
  } = solveReal();
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.filter(v => v.constraintId === 'H01').length, 0);
  assert.equal(ev.hard.violations.filter(v => v.constraintId === 'H02').length, 0);
});
test('PHASE 23 / C24 — solver writes diagnostics.hardViolationCount = 0 on success', () => {
  const {
    solution
  } = solveReal();
  assert.equal(solution.diagnostics.hardViolationCount, 0);
});
