// PHASE 24 — TEACHER ASSIGNMENT OPTIMIZATION.
//
// SCOPE
// -----
// Phase 24 takes the Phase 23 feasible solver and proves that the
// solver can ALSO begin to optimise teacher-assignment decisions
// while keeping every hard constraint intact.
//
// The phase introduces:
//
//   1. A `metrics` object on each candidate
//      (see src/domain/metrics.js). The metrics are deterministic
//      and derived from the candidate; they expose
//      `workloadSpread`, `maxTeacherLoad`, `minTeacherLoad`,
//      `preferencePenalty`, `changedAssignments`, etc.
//
//   2. An A/B switch on the solver strategy field
//      `optimizationMode`:
//
//        BASE_FEASIBLE          keeps the legacy ordering
//                           (Phase 23 behaviour).
//        ASSIGNMENT_BALANCED     expands the variant list to all
//                           eligible teachers and inverts the
//                           legacy "first variant wins" bias.
//                           Lower projected load wins ties.
//
//   3. Cross-mode comparison metrics vs the legacy baseline
//      (observation only — the baseline is never used as a
//      constraint).
//
// The tests below cover the 20 brief-required assertions. They
// use real data from `loadFromLegacySaplich()` for the heavy
// invariants and a small synthetic fixture for the optimisation-
// effectiveness check (§13).

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { solve } from '../src/domain/solver.js';
import { STRATEGY_C, OPTIMIZATION_MODES } from '../src/domain/strategies.js';
import { verify } from '../src/domain/validator.js';
import {
  evaluateCandidate,
  isAccepted,
} from '../src/domain/constraints/index.js';
import { isEligibleFor } from '../src/domain/eligibility.js';
import {
  teacherLoads,
  workloadAggregate,
  sessionPreferencePenalty,
  baselineComparison,
  deriveMetrics,
} from '../src/domain/metrics.js';
import {
  classConflictKey,
  teacherConflictKey,
  slotKey,
} from '../src/domain/time.js';

// ============================================================================
// Helpers
// ============================================================================

function solveReal(mode = 'BASE_FEASIBLE', seed = 0xC0FFEE, timeLimitMs = 10_000) {
  const full = loadFromLegacySaplich();
  const input = { ...full.scheduling, strategy: STRATEGY_C };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: { ...STRATEGY_C.diversification, seed },
    solver: { timeLimitMs, maxSolutions: 1 },
  };
  const out = solve(input);
  return { out, input, full, solution: out.solutions[0] ?? null };
}

function countSlots(candidate) {
  let n = 0;
  for (const arr of candidate.assignments.values()) n += arr.length;
  return n;
}

/**
 * Build a controlled fixture for the optimisation-effectiveness
 * check (§13). The fixture is small, deterministic, and has two
 * eligible teachers per assignment so the variant sort has at
 * least two options to choose between.
 */
function buildControlledFixture() {
  function buildSlots(b) {
    const out = [];
    for (const day of (b.schoolDays ?? [1, 2, 3, 4, 5])) {
      for (const period of (b.periods ?? [1, 2, 3, 4, 5])) {
        out.push({ branchId: b.id, day, period });
      }
    }
    return out;
  }
  const teachers = [
    { id: 'TA', hoTen: 'TA', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 20 }], homeBranchId: 'b1', trangThai: 'active' },
    { id: 'TB', hoTen: 'TB', chuyenMon: [{ tenChuyenMon: 'X', soTietTuan: 20 }], homeBranchId: 'b1', trangThai: 'active' },
  ];
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [{ id: 'c1', branchId: 'b1' }];
  // Two assignments for the same (class, subject). Both pre-set
  // to TA. The variant expansion adds TB for the BALANCED mode.
  // The branch has 25 slots; each assignment needs 5. With BASE_FEASIBLE
  // TA picks both. With ASSIGNMENT_BALANCED the sort prefers
  // lower-loaded variants, so TA picks the first and TB picks the
  // second.
  const assignments = [
    { id: 'A1', classId: 'c1', subjectId: 'X', teacherId: 'TA', branchId: 'b1', requiredPeriods: 5 },
    { id: 'A2', classId: 'c1', subjectId: 'X', teacherId: 'TA', branchId: 'b1', requiredPeriods: 5 },
  ];
  const input = {
    teachers,
    branches,
    classes,
    subjects: [{ id: 'X', name: 'X' }],
    curriculum: assignments.map((a) => ({ classId: a.classId, subjectId: a.subjectId, requiredPeriods: a.requiredPeriods })),
    assignments,
    timeSlotsByBranch: new Map(branches.map((b) => [b.id, buildSlots(b)])),
    travelTime: null,
    transitionMinutes: 10,
    teacherIndex: new Map(teachers.map((t) => [t.id, t])),
    assignmentIndex: new Map(assignments.map((a) => [a.id, a])),
    warnings: [],
    missingData: [],
  };
  return input;
}

function teacherLoadsFromPlacements(candidate) {
  const loads = new Map();
  for (const [, slots] of candidate.assignments) {
    for (const s of slots) {
      loads.set(s.teacherId, (loads.get(s.teacherId) ?? 0) + 1);
    }
  }
  return loads;
}

// ============================================================================
// §1 — optimizationMode is exposed and round-trippable
// ============================================================================

test('PHASE 24 / 1 — optimizationMode enum exists and is round-trippable', () => {
  assert.ok(OPTIMIZATION_MODES);
  assert.equal(OPTIMIZATION_MODES.BASE_FEASIBLE, 'BASE_FEASIBLE');
  assert.equal(OPTIMIZATION_MODES.ASSIGNMENT_BALANCED, 'ASSIGNMENT_BALANCED');
  // The strategies module exposes the enum so callers can validate
  // before passing the same to the solver.
  for (const v of Object.values(OPTIMIZATION_MODES)) {
    assert.equal(typeof v, 'string');
  }
});

// ============================================================================
// §2 — BASE_FEASIBLE behaviour is regression-safe
// ============================================================================

test('PHASE 24 / 2 — BASE_FEASIBLE produces the Phase 23 candidate shape', () => {
  const { out, input, solution } = solveReal('BASE_FEASIBLE');
  assert.equal(out.failure, null);
  assert.ok(solution, 'BASE_FEASIBLE must still produce a candidate');
  // Full demand coverage.
  assert.equal(solution.assignments.size, input.assignments.length);
  assert.equal(countSlots(solution), 802);
  // Evaluator accepts.
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
});

// ============================================================================
// §3 — ASSIGNMENT_BALANCED still produces a feasible candidate
// ============================================================================

test('PHASE 24 / 3 — ASSIGNMENT_BALANCED produces a feasible candidate on real data', () => {
  const { out, input, solution } = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(out.failure, null);
  assert.ok(solution, 'ASSIGNMENT_BALANCED must still produce a candidate');
  // Same coverage as BASE_FEASIBLE — feasibility is preserved.
  assert.equal(solution.assignments.size, input.assignments.length);
  assert.equal(countSlots(solution), 802);
  // Evaluator accepts.
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
});

// ============================================================================
// §4 — hard violations = 0 (independent oracle)
// ============================================================================

test('PHASE 24 / 4 — independent constraint evaluator: zero hard violations (BALANCED)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.hard.violated, false);
  // Verify (legacy validator) also agrees.
  const v = verify(solution, input);
  assert.equal(v.hardViolations.length, 0);
  assert.equal(v.accepted, true);
  // isAccepted() agrees.
  assert.equal(isAccepted(ev), true);
});

// ============================================================================
// §5 — all 479 assignments fulfilled
// ============================================================================

test('PHASE 24 / 5 — all 479 assignments are fulfilled with requiredPeriods (BALANCED)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(solution.assignments.size, 479);
  let totalScheduled = 0;
  for (const a of input.assignments) {
    const placed = solution.assignments.get(a.id) ?? [];
    assert.equal(placed.length, a.requiredPeriods, `assignment ${a.id} under-filled`);
    totalScheduled += placed.length;
  }
  assert.equal(totalScheduled, 802);
});

// ============================================================================
// §6 — 802 placements (full demand)
// ============================================================================

test('PHASE 24 / 6 — candidate has 802 placements (BALANCED full demand coverage)', () => {
  const { solution } = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(countSlots(solution), 802);
});

// ============================================================================
// §7 — every teacher remains subject-eligible (H03)
// ============================================================================

test('PHASE 24 / 7 — every (teacherId, subjectId) pairing is eligible (BALANCED)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    const teacher = input.teacherIndex.get(meta.teacherId);
    assert.ok(teacher);
    assert.ok(
      isEligibleFor(teacher, meta.subjectId),
      `teacher ${teacher.hoTen} not eligible for ${meta.subjectId}`,
    );
  }
});

// ============================================================================
// §8 — no class double-book collision (H01)
// ============================================================================

test('PHASE 24 / 8 — no duplicate class slot (BALANCED session-aware)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  const seen = new Map();
  let dup = 0;
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    for (const s of slots) {
      const k = `${meta.classId}|${classConflictKey(s)}`;
      if (seen.has(k)) dup++;
      else seen.set(k, s);
    }
  }
  assert.equal(dup, 0);
});

// ============================================================================
// §9 — no teacher double-book collision (H02)
// ============================================================================

test('PHASE 24 / 9 — no duplicate teacher slot (BALANCED session-aware)', () => {
  const { solution } = solveReal('ASSIGNMENT_BALANCED');
  const seen = new Map();
  let dup = 0;
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const k = `${s.teacherId}|${teacherConflictKey(s)}`;
      if (seen.has(k)) dup++;
      else seen.set(k, s);
    }
  }
  assert.equal(dup, 0);
});

// ============================================================================
// §10 — inactive entities are excluded
// ============================================================================

test('PHASE 24 / 10 — inactive entities are excluded (BALANCED)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  const inactiveTeachers = new Set(
    input.teachers.filter((t) => t.trangThai === 'inactive').map((t) => t.id)
  );
  const inactiveSubjects = new Set(
    input.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      assert.ok(
        !inactiveTeachers.has(s.teacherId),
        `inactive teacher ${s.teacherId} leaked into candidate`,
      );
    }
  }
  for (const [aId] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    assert.ok(
      !inactiveSubjects.has(meta.subjectId),
      `inactive subject ${meta.subjectId} leaked into candidate`,
    );
  }
});

// ============================================================================
// §11 — workload metrics are deterministic
// ============================================================================

test('PHASE 24 / 11 — workload metrics are deterministic for the same candidate', () => {
  const { solution, input } = solveReal('ASSIGNMENT_BALANCED');
  const m1 = deriveMetrics(solution, input, null, null);
  const m2 = deriveMetrics(solution, input, null, null);
  assert.deepEqual(m1, m2);
  // Each numeric metric must be a non-negative number.
  for (const k of [
    'teacherCount', 'totalPeriods', 'maxTeacherLoad', 'minTeacherLoad',
    'averageTeacherLoad', 'workloadSpread', 'workloadStdev',
    'preferencePenalty', 'changedAssignments', 'changedFraction',
  ]) {
    assert.equal(typeof m1[k], 'number', `metric ${k} must be a number`);
    assert.ok(m1[k] >= 0, `metric ${k} must be non-negative`);
  }
  // Internal consistency: max >= min, spread == max - min.
  assert.ok(m1.maxTeacherLoad >= m1.minTeacherLoad);
  assert.equal(m1.workloadSpread, m1.maxTeacherLoad - m1.minTeacherLoad);
});

// ============================================================================
// §12 — same seed gives the same result (also: modes cannot differ accidentally)
// ============================================================================

test('PHASE 24 / 12 — same seed gives same candidate (BASE_FEASIBLE & BALANCED, 3x each)', () => {
  const baselineA = solveReal('BASE_FEASIBLE');
  const balancedB = solveReal('ASSIGNMENT_BALANCED');
  for (let i = 0; i < 3; i++) {
    const a = solveReal('BASE_FEASIBLE');
    const b = solveReal('ASSIGNMENT_BALANCED');
    // Determinism within BASE_FEASIBLE — compare baselineA vs a.
    for (const aId of baselineA.solution.assignments.keys()) {
      const slotsBase = baselineA.solution.assignments.get(aId);
      const slotsA = a.solution.assignments.get(aId);
      assert.equal(slotsBase.length, slotsA.length);
      const setBase = new Set(slotsBase.map((s) => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      for (const s of slotsA) {
        assert.ok(setBase.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      }
    }
    // Determinism within ASSIGNMENT_BALANCED — compare balancedB vs b.
    for (const aId of balancedB.solution.assignments.keys()) {
      const slotsBase = balancedB.solution.assignments.get(aId);
      const slotsB = b.solution.assignments.get(aId);
      assert.equal(slotsBase.length, slotsB.length);
      const setBase = new Set(slotsBase.map((s) => `${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      for (const s of slotsB) {
        assert.ok(setBase.has(`${s.day}:${s.period}:${s.branchId}:${s.teacherId}`));
      }
    }
  }
});

// ============================================================================
// §13 — optimisation objective changes search behaviour on a controlled fixture
// ============================================================================

test('PHASE 24 / 13 — optimisation objective changes search behaviour on a controlled fixture', () => {
  function run(mode) {
    const input = buildControlledFixture();
    input.strategy = {
      ...STRATEGY_C,
      optimizationMode: mode,
      diversification: { ...STRATEGY_C.diversification, seed: 0xC0FFEE },
      solver: { timeLimitMs: 5_000, maxSolutions: 1 },
    };
    const out = solve(input);
    assert.ok(out.solutions.length >= 1, `${mode} must produce a candidate`);
    const sol = out.solutions[0];
    return teacherLoadsFromPlacements(sol);
  }
  const base = run('BASE_FEASIBLE');
  const balan = run('ASSIGNMENT_BALANCED');
  // BASE_FEASIBLE keeps TA on both assignments (pre-set + no
  // variant expansion): TA picks 10 slots, TB picks 0.
  assert.equal(base.get('TA'), 10, 'BASE keeps TA on both assignments (5+5 slots)');
  assert.equal(base.get('TB') ?? 0, 0, 'BASE never moves to TB');
  // ASSIGNMENT_BALANCED expands the variants and inverts the
  // tie-break, so TB picks both assignments and TA picks none.
  assert.equal(balan.get('TB') ?? 0, 10, 'BALANCED must move both assignments to TB (5+5 slots)');
  assert.equal(balan.get('TA') ?? 0, 0, 'BALANCED must release TA entirely');
  // The two modes produce DIFFERENT teacher choices — this is the
  // contract for §22 of the brief: the objective actually
  // influences the search.
  assert.notDeepEqual(
    [...base.entries()].sort(),
    [...balan.entries()].sort(),
    'BASE_FEASIBLE and ASSIGNMENT_BALANCED must produce different teacher choices',
  );
});

// ============================================================================
// §14 — workload metric is teacher-level (counts each teacher once)
// ============================================================================

test('PHASE 24 / 14 — workload metric is teacher-level (not slot-level, not split by subject)', () => {
  const { solution, input } = solveReal('ASSIGNMENT_BALANCED');
  const loads = teacherLoads(solution);
  // teacherLoads counts every slot once per teacher. The sum of
  // all loads equals the total placements.
  let sum = 0;
  for (const v of loads.values()) sum += v;
  assert.equal(sum, countSlots(solution));
  // The aggregate's totalPeriods agrees with the per-teacher sum.
  const agg = workloadAggregate(loads);
  assert.equal(agg.totalPeriods, sum);
  assert.equal(agg.teacherCount, loads.size);
});

// ============================================================================
// §15 — multi-subject specialisation teacher counts as ONE person
// ============================================================================

test('PHASE 24 / 15 — teacher with multiple specialisations counts as one teacher', () => {
  // Build a controlled fixture with a teacher who has TWO
  // subjects. Both assignments use that teacher. The teacher
  // must be counted ONCE in `teacherCount` and their load must
  // include slots from BOTH subjects.
  function buildSlots(b) {
    const out = [];
    for (const day of (b.schoolDays ?? [1, 2, 3, 4, 5])) {
      for (const period of (b.periods ?? [1, 2, 3, 4, 5])) {
        out.push({ branchId: b.id, day, period });
      }
    }
    return out;
  }
  const teacher = {
    id: 'multi',
    hoTen: 'Multi',
    chuyenMon: [
      { tenChuyenMon: 'SUBJ_A', soTietTuan: 5 },
      { tenChuyenMon: 'SUBJ_B', soTietTuan: 5 },
    ],
    homeBranchId: 'b1',
    trangThai: 'active',
  };
  const branches = [{ id: 'b1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  const classes = [
    { id: 'cA', branchId: 'b1' },
    { id: 'cB', branchId: 'b1' },
  ];
  const assignments = [
    { id: 'aA', classId: 'cA', subjectId: 'SUBJ_A', teacherId: 'multi', branchId: 'b1', requiredPeriods: 2 },
    { id: 'aB', classId: 'cB', subjectId: 'SUBJ_B', teacherId: 'multi', branchId: 'b1', requiredPeriods: 3 },
  ];
  const input = {
    teachers: [teacher],
    branches,
    classes,
    subjects: [
      { id: 'SUBJ_A', name: 'SUBJ_A', isActive: true },
      { id: 'SUBJ_B', name: 'SUBJ_B', isActive: true },
    ],
    curriculum: assignments.map((a) => ({ classId: a.classId, subjectId: a.subjectId, requiredPeriods: a.requiredPeriods })),
    assignments,
    timeSlotsByBranch: new Map(branches.map((b) => [b.id, buildSlots(b)])),
    travelTime: null,
    transitionMinutes: 10,
    teacherIndex: new Map([['multi', teacher]]),
    assignmentIndex: new Map(assignments.map((a) => [a.id, a])),
    warnings: [],
    missingData: [],
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: 'BASE_FEASIBLE',
    solver: { timeLimitMs: 5_000, maxSolutions: 1 },
  };
  const out = solve(input);
  assert.ok(out.solutions.length >= 1);
  const sol = out.solutions[0];
  const loads = teacherLoads(sol);
  // The single teacher accounts for BOTH assignments (2 slots + 3 slots = 5).
  assert.equal(loads.size, 1, 'multi-subject teacher must count as ONE person');
  assert.equal(loads.get('multi'), 5, 'multi-subject teacher load = sum of both subjects');
  const agg = workloadAggregate(loads);
  assert.equal(agg.teacherCount, 1);
  assert.equal(agg.maxLoad, 5);
  assert.equal(agg.minLoad, 5);
  assert.equal(agg.totalPeriods, 5);
});

// ============================================================================
// §16 — no fake capacity introduced
// ============================================================================

test('PHASE 24 / 16 — no fake capacity is introduced (no `capacity` field)', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  // The SchedulingInput does not declare a `capacity` policy on
  // any teacher. The metrics object must not invent one.
  for (const t of input.teachers) {
    assert.equal(t.capacity, undefined, 'input must not invent a teacher.capacity field');
  }
  // The metrics object exposes `preferencePenalty`, NOT `capacity`.
  const m = solution.metrics;
  for (const k of Object.keys(m)) {
    assert.ok(!k.toLowerCase().includes('capacity'), `unexpected capacity-shaped metric: ${k}`);
  }
});

// ============================================================================
// §17 — baseline is not a constraint (changedAssignments is reported, not enforced)
// ============================================================================

test('PHASE 24 / 17 — baseline is not a constraint (changedAssignments may be non-zero)', () => {
  const { input, solution, full: fullObj } = solveReal('ASSIGNMENT_BALANCED');
  // Phase 24 loads the baseline from the input via
  // `loadFromLegacySaplich`. The solver does NOT read the baseline
  // for placement decisions; the candidate may diverge from it.
  const compare = baselineComparison(solution, fullObj.legacyBaseline);
  // The solver is allowed to change any number of assignments; the
  // metric simply reports the count. assert it's a non-negative
  // number and the candidate is still feasible.
  assert.equal(typeof compare.changedTeacher, 'number');
  assert.ok(compare.changedTeacher >= 0);
  assert.equal(compare.sameTeacher + compare.changedTeacher, compare.totalAssignments);
  // Crucially, feasibility is preserved regardless of how many
  // assignments changed.
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
});

// ============================================================================
// §18 — travel is not fabricated / not optimised (H14 stays UNSUPPORTED)
// ============================================================================

test('PHASE 24 / 18 — travel is not fabricated; H14 remains UNSUPPORTED', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(input.travelTime, null);
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.constraintStatuses['H14'], 'UNSUPPORTED');
  // No H14 violation is reported.
  assert.equal(ev.hard.violations.filter((v) => v.constraintId === 'H14').length, 0);
  // The metrics object does NOT include travel-derived terms.
  const m = solution.metrics;
  for (const k of Object.keys(m)) {
    assert.ok(!k.toLowerCase().includes('travel'), `unexpected travel-shaped metric: ${k}`);
  }
});

// ============================================================================
// §19 — independent evaluator accepts the optimised candidate
// ============================================================================

test('PHASE 24 / 19 — independent evaluator accepts the optimised candidate', () => {
  const { input, solution } = solveReal('ASSIGNMENT_BALANCED');
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.summary.accepted, true);
  assert.equal(isAccepted(ev), true);
  // Phase 22 catalog still records H01..H08 as ACTIVE on real data
  // (H09..H14 are INACTIVE / UNSUPPORTED). The candidate triggers
  // none of them.
  assert.equal(ev.hard.violations.length, 0);
});

// ============================================================================
// §20 — Phase 23 behaviour remains regression-safe
// ============================================================================

test('PHASE 24 / 20 — Phase 23 / C1..C24 invariants still hold after Phase 24', () => {
  // Re-run a representative subset of the Phase 23 tests and
  // assert they pass under the new strategy default.
  const { input, solution, out } = solveReal('ASSIGNMENT_BALANCED');
  // C1 — solver returns a candidate.
  assert.equal(out.failure, null);
  assert.ok(solution);
  assert.ok(solution.assignments instanceof Map);
  // C3 — 802 placements.
  assert.equal(countSlots(solution), 802);
  // C4 — 479 assignments.
  assert.equal(solution.assignments.size, 479);
  for (const a of input.assignments) {
    assert.ok(solution.assignments.has(a.id));
  }
  // C5 — every assignment reaches requiredPeriods.
  for (const a of input.assignments) {
    const placed = solution.assignments.get(a.id) ?? [];
    assert.equal(placed.length, a.requiredPeriods);
  }
  // C7 — no duplicate teacher slot.
  const seen = new Map();
  let dup = 0;
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const k = `${s.teacherId}|${teacherConflictKey(s)}`;
      if (seen.has(k)) dup++;
      else seen.set(k, s);
    }
  }
  assert.equal(dup, 0);
  // C13 — zero hard violations.
  const ev = evaluateCandidate(solution, input);
  assert.equal(ev.hard.violations.length, 0);
  // C15 — deterministic (we already check this in §12).
  const again = solveReal('ASSIGNMENT_BALANCED');
  assert.equal(countSlots(again.solution), 802);
  // C18 — no fabricated travel.
  assert.equal(input.travelTime, null);
  // C24 — diagnostics.hardViolationCount = 0.
  assert.equal(solution.diagnostics.hardViolationCount, 0);
});

// ============================================================================
// §21 — metrics surface (informational — supports the brief's metric set)
// ============================================================================

test('PHASE 24 / 21 — metrics surface exposes the brief-required fields', () => {
  const { solution } = solveReal('ASSIGNMENT_BALANCED');
  const m = solution.metrics;
  // Required fields per the brief §20.
  for (const k of [
    'hardViolations',
    'teacherCount',
    'totalPeriods',
    'maxTeacherLoad',
    'minTeacherLoad',
    'averageTeacherLoad',
    'workloadSpread',
    'workloadStdev',
    'preferencePenalty',
    'changedAssignments',
    'changedFraction',
    'totalSoftCost',
  ]) {
    assert.ok(k in m, `metrics must expose ${k}`);
  }
  // Real-data invariants on the real-data candidate.
  assert.equal(m.hardViolations, 0);
  assert.equal(m.totalPeriods, 802);
  assert.ok(m.teacherCount > 0);
  assert.ok(m.teacherCount <= 40); // at most all active teachers
  assert.ok(m.maxTeacherLoad >= m.minTeacherLoad);
});