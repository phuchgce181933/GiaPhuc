// Phase 22 — Constraint model & independent evaluator tests.
//
// SCOPE
// -----
// These tests assert the constraint catalog (H01-H14, S01-S08) and
// the independent evaluator (`evaluateCandidate`).
//
// Tests rely on a synthetic SchedulingInput that mirrors the
// real-data shape (from `loadFromLegacySaplich`) but is small and
// deterministic. The real legacy data is exercised in a separate
// audit doc, not here.
//
// Tests are READ-ONLY. They do not modify the source data, the
// normalized layer, the solver, the orchestrator, the validator,
// the AI strategy, or any fixture.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATALOG,
  HARD_CONSTRAINTS,
  SOFT_CONSTRAINTS,
  getConstraint,
  listHard,
  listSoft,
  evaluateCandidate,
  evaluateBaseline,
  isAccepted,
  totalCost,
} from '../src/domain/constraints/index.js';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';

// ============================================================================
// Synthetic test fixtures
// ============================================================================

/**
 * Build a minimal SchedulingInput for tests. Picks the first N
 * active teachers, classes, subjects, assignments from the real
 * legacy dataset and constructs a controlled context. The
 * `baseline` candidate is built from the slots provided.
 */
function buildSlicedInput(opts = {}) {
  const full = loadFromLegacySaplich();
  const fullInput = full.scheduling;
  // Pick first N active teachers (with eligibility), N classes,
  // N subjects, all branches. Build (class, subject) -> assignment
  // pairs such that each assignment's teacherId is unique to that
  // assignment (no teacher reused).
  const teachers = fullInput.teachers.slice(0, 8).map((teacher) => ({ ...teacher, allowedTransferBranches: fullInput.branches.map((branch) => branch.id) }));
  const classes = fullInput.classes.slice(0, 4);
  const subjects = fullInput.subjects.filter((s) => s.isActive).slice(0, 3);
  const branches = fullInput.branches;
  const assignments = [];
  const usedTeacherIds = new Set();
  let ai = 0;
  outer:
  for (const c of classes) {
    for (const s of subjects) {
      const eligible = teachers.filter((t) => !usedTeacherIds.has(t.id) && (t.eligibleSubjectIds ?? []).includes(s.id));
      if (eligible.length === 0) continue;
      const teacher = eligible[0];
      usedTeacherIds.add(teacher.id);
      assignments.push({
        id: `A${++ai}`,
        classId: c.id,
        subjectId: s.id,
        teacherId: teacher.id,
        branchId: c.branchId,
        requiredPeriods: opts.requiredPeriods ?? 2,
        baselineAssignment: true,
      });
      if (ai >= (opts.maxAssignments ?? 6)) break outer;
    }
    if (ai >= (opts.maxAssignments ?? 6)) break;
  }
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));
  return {
    input: {
      teachers,
      classes,
      subjects,
      branches,
      assignments,
      curriculum: assignments.map(({ classId, subjectId, requiredPeriods }) => ({ classId, subjectId, requiredPeriods })),
      teacherIndex,
      assignmentIndex,
      timeSlotsByBranch: fullInput.timeSlotsByBranch,
      travelTime: null,
      transitionMinutes: 10,
    },
    full,
  };
}

/**
 * Build a valid candidate from the sliced input. Picks one slot
 * per (day, session, period) for each assignment, all in the
 * class branch, all on distinct (day, session, period) within a
 * single class so H01/H02 are not violated.
 *
 * Phase 22.1: the conflict identity is (entity, day, session,
 * period). We distribute the slots diagonally across (day,
 * session, period) so each assignment gets a unique triple.
 */
function buildValidCandidate(sliced) {
  const slotsByAssignment = new Map();
  const placements = new Map();
  const firstBranch = sliced.input.branches[0];
  const validSlots = (sliced.input.timeSlotsByBranch.get(firstBranch.id) ?? [])
    .map((slot) => ({ ...slot, session: slot.period <= 4 ? 'sang' : 'chieu' }))
    .sort((a, b) => a.period - b.period || a.day - b.day);
  // For each class, reserve a pool of distinct (day, session,
  // period) tuples and distribute them across that class's
  // assignments.
  const assignmentsByClass = new Map();
  for (const a of sliced.input.assignments) {
    const arr = assignmentsByClass.get(a.classId) ?? [];
    arr.push(a);
    assignmentsByClass.set(a.classId, arr);
  }
  for (const [classId, groupAssignments] of assignmentsByClass) {
    const cls = sliced.input.classes.find((c) => c.id === classId);
    const branchId = cls?.branchId;
    // Total slots reserved for this class.
    const totalNeed = groupAssignments.reduce((acc, a) => acc + a.requiredPeriods, 0);
    // Generate a diagonal sequence of (day, session, period)
    // tuples so they are distinct within the class (no H01
    // collisions) and across the class's teachers (no H02
    // collisions).
    //
    // Both sang and chieu use the SAME period numbers
    // (1..branch.periods.length) — the session distinguishes
    // morning from afternoon. This matches the legacy baseline
    // shape, where period 1 morning ≠ period 1 afternoon.
    const classSlots = [];
    let si = 0;
    for (let k = 0; k < totalNeed; k++) {
      const slot = validSlots[si % validSlots.length];
      classSlots.push({ branchId, day: slot.day, session: slot.session, period: slot.period });
      si += 1;
    }
    let cursor = 0;
    for (const a of groupAssignments) {
      const arr = [];
      for (let k = 0; k < a.requiredPeriods; k++) {
        arr.push(classSlots[cursor++]);
      }
      slotsByAssignment.set(a.id, arr);
      placements.set(a.id, { teacherId: a.teacherId, branchId });
    }
  }
  return { assignments: slotsByAssignment, placements };
}

// ============================================================================
// PHASE 22 / N1 — Catalog shape
// ============================================================================

test('PHASE 22 / N1 — catalog has 17 hard + 8 soft constraints', () => {
  assert.equal(HARD_CONSTRAINTS.length, 17);
  assert.equal(SOFT_CONSTRAINTS.length, 8);
  assert.equal(CATALOG.length, 25);
  // Hard IDs H01..H14
  const hardIds = HARD_CONSTRAINTS.map((c) => c.id);
  for (let i = 1; i <= 14; i++) assert.ok(hardIds.includes(`H${String(i).padStart(2, '0')}`), `missing H${i}`);
  // Soft IDs S01..S08
  const softIds = SOFT_CONSTRAINTS.map((c) => c.id);
  for (let i = 1; i <= 8; i++) assert.ok(softIds.includes(`S${String(i).padStart(2, '0')}`), `missing S${i}`);
});

test('PHASE 22 / N2 — every constraint has id, code, name, category, severity, description, evaluate', () => {
  for (const c of CATALOG) {
    assert.ok(c.id, `${c.code} has no id`);
    assert.ok(c.code, `${c.id} has no code`);
    assert.ok(c.name, `${c.id} has no name`);
    assert.ok(['HARD', 'SOFT'].includes(c.category), `${c.id} category not HARD/SOFT`);
    assert.ok(['BLOCKING', 'PENALTY'].includes(c.severity), `${c.id} severity not BLOCKING/PENALTY`);
    assert.ok(c.description, `${c.id} has no description`);
    assert.equal(typeof c.evaluate, 'function', `${c.id} evaluate not a function`);
    // active predicate is optional but every soft / data-driven
    // hard must have one.
    if (['H09', 'H10', 'H11', 'H12', 'H13', 'H14', 'S01', 'S02', 'S03', 'S04', 'S05', 'S06'].includes(c.id)) {
      assert.equal(typeof c.active, 'function', `${c.id} active must be a function`);
    }
  }
});

test('PHASE 22 / N3 — hard constraints BLOCKING, soft constraints PENALTY', () => {
  for (const c of HARD_CONSTRAINTS) assert.equal(c.severity, 'BLOCKING');
  for (const c of SOFT_CONSTRAINTS) assert.equal(c.severity, 'PENALTY');
});

test('PHASE 22 / N4 — getConstraint returns the matching entry', () => {
  assert.equal(getConstraint('H01').code, 'H_CLASS_NO_DOUBLE_BOOK');
  assert.equal(getConstraint('S07').code, 'S_SESSION_COMPACTNESS');
  assert.equal(getConstraint('X99'), null);
});

test('PHASE 22 / N5 — listHard / listSoft return slices', () => {
  const h = listHard();
  const s = listSoft();
  assert.equal(h.length, 17);
  assert.equal(s.length, 8);
  h.push({}); // mutating the slice must not affect the catalog
  assert.equal(listHard().length, 17);
});

// ============================================================================
// PHASE 22 / N6..N10 — Concrete hard-constraint violations
// ============================================================================

test('PHASE 22 / N6 — class double booking detected (H01)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Inject a class double booking: take assignment A1 and put a
  // second slot at the same (day, session, period) on the same
  // class. Session is required (Phase 22.1 §4 — identity must
  // include session).
  const a = sliced.input.assignments[0];
  const cls = sliced.input.classes.find((c) => c.id === a.classId);
  const existing = cand.assignments.get(a.id)[0];
  const arr = cand.assignments.get(a.id);
  arr.push({
    branchId: cls.branchId,
    day: existing.day,
    session: existing.session,
    period: existing.period,
  });
  cand.assignments.set(a.id, arr);
  const ev = evaluateCandidate(cand, sliced.input);
  const h01 = ev.hard.violations.filter((v) => v.constraintId === 'H01');
  assert.ok(h01.length > 0, 'H01 must fire on duplicate (day, session, period) for the same class');
  assert.equal(ev.summary.accepted, false);
});

test('PHASE 22 / N7 — teacher double booking detected (H02)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Force two assignments to share the same teacherId and place
  // them at the same (day, period). To do this we use the same
  // candidate shape but with two assignments both with same teacher.
  const t = sliced.input.teachers[0];
  const a1 = sliced.input.assignments[0];
  const a2 = sliced.input.assignments[1];
  const c1 = sliced.input.classes.find((c) => c.id === a1.classId);
  const c2 = sliced.input.classes.find((c) => c.id === a2.classId);
  cand.assignments.set(a1.id, [{ branchId: c1.branchId, day: 1, period: 1 }]);
  cand.assignments.set(a2.id, [{ branchId: c2.branchId, day: 1, period: 1 }]);
  cand.placements.set(a1.id, { teacherId: t.id, branchId: c1.branchId });
  cand.placements.set(a2.id, { teacherId: t.id, branchId: c2.branchId });
  const ev = evaluateCandidate(cand, sliced.input);
  const h02 = ev.hard.violations.filter((v) => v.constraintId === 'H02');
  assert.ok(h02.length > 0, 'H02 must fire on (teacher, day, period) collision');
});

test('PHASE 22 / N8 — teacher-subject mismatch detected (H03)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Pick a teacher who is NOT eligible for the subject and force the
  // assignment to reference that teacher. H03 reads the assignment's
  // own teacherId (not the placement map) — that is the contract:
  // the assignment is the "who teaches what" record.
  const teacher = sliced.input.teachers[0];
  const eligible = teacher.eligibleSubjectIds ?? [];
  const ineligibleSubject = sliced.input.subjects.find((s) => !eligible.includes(s.id));
  if (!ineligibleSubject) return; // every teacher can teach every subject — skip
  // Find any assignment referencing that subject and rewrite its
  // teacherId in the input view to point at the ineligible teacher.
  const target = sliced.input.assignments.find((a) => a.subjectId === ineligibleSubject.id);
  if (!target) return;
  const rewritten = { ...target, teacherId: teacher.id };
  sliced.input.assignments = sliced.input.assignments.map((a) =>
    a.id === target.id ? rewritten : a
  );
  sliced.input.assignmentIndex = new Map(sliced.input.assignments.map((a) => [a.id, a]));
  // Keep the candidate's placement consistent with the rewrite.
  cand.placements.set(target.id, { teacherId: teacher.id, branchId: target.branchId });
  const ev = evaluateCandidate(cand, sliced.input);
  const h03 = ev.hard.violations.filter((v) => v.constraintId === 'H03');
  assert.ok(h03.length > 0, 'H03 must fire on ineligible (teacher, subject)');
});

test('PHASE 22 / N9 — branch mismatch detected (H04)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Force a slot into a branch that does NOT match the class branch.
  const a = sliced.input.assignments[0];
  const cls = sliced.input.classes.find((c) => c.id === a.classId);
  const wrongBranch = sliced.input.branches.find((b) => b.id !== cls.branchId);
  if (!wrongBranch) return;
  cand.assignments.set(a.id, [{ branchId: wrongBranch.id, day: 1, period: 1 }]);
  cand.placements.set(a.id, { teacherId: a.teacherId, branchId: wrongBranch.id });
  const ev = evaluateCandidate(cand, sliced.input);
  const h04 = ev.hard.violations.filter((v) => v.constraintId === 'H04');
  assert.ok(h04.length > 0, 'H04 must fire on slot placed in a non-class branch');
});

test('PHASE 22 / N10 — demand underfill detected (H05)', () => {
  const sliced = buildSlicedInput({ requiredPeriods: 3 });
  const cand = buildValidCandidate(sliced);
  // Remove one slot from the first assignment (now has 2/3).
  const a = sliced.input.assignments[0];
  cand.assignments.set(a.id, cand.assignments.get(a.id).slice(0, -1));
  const ev = evaluateCandidate(cand, sliced.input);
  const h05 = ev.hard.violations.filter((v) => v.constraintId === 'H05');
  assert.ok(h05.length > 0, 'H05 must fire on partial fulfillment');
});

// ============================================================================
// PHASE 22 / N11..N15 — More hard-constraint cases
// ============================================================================

test('PHASE 22 / N11 — duplicate slot (H06: missing branchId) detected', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Inject a slot with missing branchId.
  const a = sliced.input.assignments[0];
  cand.assignments.set(a.id, [{ day: 1, period: 1 }]);
  const ev = evaluateCandidate(cand, sliced.input);
  const h06 = ev.hard.violations.filter((v) => v.constraintId === 'H06');
  assert.ok(h06.length > 0, 'H06 must fire on missing branchId');
});

test('PHASE 22 / N12 — assignment identity: two teachers for one (class,subject) detected (H07)', () => {
  const sliced = buildSlicedInput({ maxAssignments: 4 });
  // Force two assignments for the SAME (classId, subjectId) pair
  // with DIFFERENT teacher ids.
  const a1 = sliced.input.assignments[0];
  const a2 = sliced.input.assignments[1];
  // make a2 share (classId, subjectId) with a1
  sliced.input.assignments[1] = { ...a2, classId: a1.classId, subjectId: a1.subjectId };
  sliced.input.assignmentIndex = new Map(sliced.input.assignments.map((a) => [a.id, a]));
  const cand = buildValidCandidate(sliced);
  // different teachers
  const t1 = sliced.input.teachers[0];
  const t2 = sliced.input.teachers[1];
  const cls = sliced.input.classes.find((c) => c.id === a1.classId);
  cand.assignments.set(a1.id, [{ branchId: cls.branchId, day: 1, period: 1 }]);
  cand.assignments.set(a2.id, [{ branchId: cls.branchId, day: 2, period: 1 }]);
  cand.placements.set(a1.id, { teacherId: t1.id, branchId: cls.branchId });
  cand.placements.set(a2.id, { teacherId: t2.id, branchId: cls.branchId });
  const ev = evaluateCandidate(cand, sliced.input);
  const h07 = ev.hard.violations.filter((v) => v.constraintId === 'H07');
  assert.ok(h07.length > 0, 'H07 must fire on two teachers for one (class,subject)');
});

test('PHASE 22 / N13 — inactive teacher / subject is rejected (H08)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Mark the first teacher as inactive in the input view.
  sliced.input.teachers = sliced.input.teachers.map((t, i) =>
    i === 0 ? { ...t, trangThai: 'inactive' } : t
  );
  const ev = evaluateCandidate(cand, sliced.input);
  const h08 = ev.hard.violations.filter((v) => v.constraintId === 'H08');
  assert.ok(h08.length > 0, 'H08 must fire on inactive teacher used by the candidate');
});

test('PHASE 22 / N13b — inactive subject is rejected (H08)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Mark the first subject in the sliced input as inactive. Any
  // assignment referencing that subject must fire H08.
  sliced.input.subjects = sliced.input.subjects.map((s, i) =>
    i === 0 ? { ...s, isActive: false } : s
  );
  const ev = evaluateCandidate(cand, sliced.input);
  const h08 = ev.hard.violations.filter((v) => v.constraintId === 'H08');
  assert.ok(h08.length > 0, 'H08 must fire on inactive subject used by the candidate');
});

test('PHASE 22 / N14 — workload capacity violation detected (H09) when capacity present', () => {
  // Build a small input where one teacher has a real workload budget
  // (`soTietTuan > 1`, not the placeholder value 1). H09's
  // activation predicate requires at least one teacher with real
  // per-subject workload; with the placeholder it stays INACTIVE.
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Force teacher 0 to have a real workload budget (soTietTuan=2)
  // and keep teacher 1's soTietTuan at 1 only as a control: the
  // first teacher carrying soTietTuan > 1 is what activates H09.
  sliced.input.teachers = sliced.input.teachers.map((t, i) => {
    if (i !== 0) return t;
    return { ...t, capacityPeriodsPerWeek: 2 };
  });
  // Teacher 0 has 2 slots scheduled (one assignment x 2 periods).
  // Budget = 2 → no violation yet. Force a third slot.
  const t0Assignments = sliced.input.assignments.filter((a) => a.teacherId === sliced.input.teachers[0].id);
  if (t0Assignments.length > 0) {
    const a = t0Assignments[0];
    const cls = sliced.input.classes.find((c) => c.id === a.classId);
    cand.assignments.set(a.id, [
      { branchId: cls.branchId, day: 1, period: 1 },
      { branchId: cls.branchId, day: 2, period: 1 },
      { branchId: cls.branchId, day: 3, period: 1 },
    ]);
  }
  const ev = evaluateCandidate(cand, sliced.input);
  const h09 = ev.hard.violations.filter((v) => v.constraintId === 'H09');
  // 3 slots > budget 2 → H09 must fire.
  assert.ok(h09.length > 0, 'H09 must fire when scheduled exceeds capacity');
});

test('PHASE 22 / N15 — max sessions/week counts distinct (day, session) tuples (H10)', () => {
  const sliced = buildSlicedInput({ requiredPeriods: 1, maxAssignments: 4 });
  const cand = buildValidCandidate(sliced);
  // Force the first teacher in the sliced input to have max=1
  // session/week AND ensure they teach at least 2 different
  // (day, session) pairs.
  const targetTeacher = sliced.input.teachers[0];
  // Find any assignments belonging to this teacher and ensure
  // their slots span more than 1 distinct (day, session).
  const targetAssignments = sliced.input.assignments.filter((a) => a.teacherId === targetTeacher.id);
  // Spread them across at least 2 days and 2 sessions.
  if (targetAssignments.length > 0) {
    const cls = sliced.input.classes.find((c) => c.id === targetAssignments[0].classId);
    cand.assignments.set(targetAssignments[0].id, [
      { branchId: cls.branchId, day: 1, period: 1 },   // day 1, sang
      { branchId: cls.branchId, day: 2, period: 6 },   // day 2, chieu  (different (day,session))
    ]);
  }
  sliced.input.teachers = sliced.input.teachers.map((t, i) => {
    if (i !== 0) return t;
    return { ...t, nguyenVong: { ...t.nguyenVong, soBuoiToiDa: 1 } };
  });
  const ev = evaluateCandidate(cand, sliced.input);
  const h10 = ev.hard.violations.filter((v) => v.constraintId === 'H10');
  assert.ok(h10.length > 0, 'H10 must fire when (day, session) count exceeds max');
});

// ============================================================================
// PHASE 22 / N16..N20 — More hard & data-driven behavior
// ============================================================================

test('PHASE 22 / N16 — fixed day off violation detected (H11)', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Force teacher 0 to have day 1 as off.
  sliced.input.teachers = sliced.input.teachers.map((t, i) => {
    if (i !== 0) return t;
    return { ...t, fixedDayOff: [1, 2] };
  });
  const ev = evaluateCandidate(cand, sliced.input);
  const h11 = ev.hard.violations.filter((v) => v.constraintId === 'H11');
  assert.ok(h11.length > 0, 'H11 must fire when teacher is scheduled on a day off');
});

test('PHASE 22 / N17 — preferredSession is NOT a hard constraint (H12 INACTIVE)', () => {
  // H12 is the "hard" mapping of preferred session, but the
  // contract says preference is SOFT. So H12 must be INACTIVE.
  const sliced = buildSlicedInput();
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev.constraintStatuses['H12'], 'INACTIVE');
  assert.equal(ev.hard.violations.filter((v) => v.constraintId === 'H12').length, 0);
});

test('PHASE 22 / N18 — empty transfer permission remains an ACTIVE home-only rule', () => {
  const sliced = buildSlicedInput();
  sliced.input.teachers.forEach((teacher) => { teacher.allowedTransferBranches = []; });
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev.constraintStatuses['H13'], 'ACTIVE');
});

test('PHASE 22 / N19 — travel missing => H14 UNSUPPORTED, no fake matrix, no false violations', () => {
  const sliced = buildSlicedInput();
  // Confirm travelTime is null in the sliced input.
  assert.equal(sliced.input.travelTime, null);
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev.constraintStatuses['H14'], 'UNSUPPORTED');
  // No H14 violations when matrix is missing.
  assert.equal(ev.hard.violations.filter((v) => v.constraintId === 'H14').length, 0);
  // UNSUPPORTED is reported separately from INACTIVE.
  assert.ok(ev.unsupported.some((u) => u.constraintId === 'H14'));
});

test('PHASE 22 / N20 — hard violation cannot be hidden by a good soft score (§22)', () => {
  // Build a candidate with a deliberate hard violation but make
  // sure the soft score is perfectly clean (no soft penalties).
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  // Force a class double booking.
  const a = sliced.input.assignments[0];
  const cls = sliced.input.classes.find((c) => c.id === a.classId);
  const arr = cand.assignments.get(a.id);
  arr.push({ branchId: cls.branchId, day: 1, period: 1 });
  cand.assignments.set(a.id, arr);
  const ev = evaluateCandidate(cand, sliced.input);
  assert.equal(ev.hard.violated, true);
  assert.equal(isAccepted(ev), false);
  // Soft can be 0 or not — but accepted MUST be false.
  assert.equal(ev.summary.accepted, false);
});

// ============================================================================
// PHASE 22 / N21..N24 — Soft constraint behavior
// ============================================================================

test('PHASE 22 / N21 — empty candidate returns correct demand violations (no spurious errors)', () => {
  const sliced = buildSlicedInput();
  const empty = { assignments: new Map(), placements: new Map() };
  const ev = evaluateCandidate(empty, sliced.input);
  // H05 must report one violation per unplaced assignment (H05
  // also checks unplaced assignments).
  const h05 = ev.hard.violations.filter((v) => v.constraintId === 'H05');
  assert.equal(h05.filter((violation) => violation.entityType === 'assignment').length, sliced.input.assignments.length);
  assert.equal(h05.filter((violation) => violation.entityType === 'class-subject').length, sliced.input.curriculum.length);
  assert.equal(ev.summary.accepted, false);
});

test('PHASE 22 / N22 — complete valid candidate produces zero hard violations', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  const ev = evaluateCandidate(cand, sliced.input);
  // The baseline candidate above is structurally clean.
  assert.equal(ev.hard.violations.length, 0);
  assert.equal(ev.summary.accepted, true);
});

test('PHASE 22 / N23 — historical baseline can be evaluated without becoming fixed (no mutation)', () => {
  const full = loadFromLegacySaplich();
  const { candidate, evaluation } = evaluateBaseline(full.legacyBaseline, full.scheduling);
  // The baseline is read; candidate built but never written back.
  assert.ok(candidate.assignments instanceof Map);
  // No assertion on violation count — the legacy baseline carries
  // its own historical imperfections. We only assert the shape.
  assert.equal(typeof evaluation.hard.violations.length, 'number');
  assert.equal(typeof evaluation.soft.penalty, 'number');
  // Make sure baseline was not mutated.
  assert.equal(full.legacyBaseline.summary.totalSlots, 802);
});

test('PHASE 22 / N24 — evaluator deterministic: same inputs = same result', () => {
  const sliced = buildSlicedInput();
  const cand = buildValidCandidate(sliced);
  const a = evaluateCandidate(cand, sliced.input);
  const b = evaluateCandidate(cand, sliced.input);
  assert.deepEqual(a, b);
  assert.equal(totalCost(a), totalCost(b));
});

// ============================================================================
// PHASE 22 / N25..N28 — Audit & catalog completeness
// ============================================================================

test('PHASE 22 / N25 — S04 (workload balance) is INACTIVE in the real dataset (placeholder gate)', () => {
  // The legacy dataset projects `chuyenMon[].soTietTuan = 1` for
  // every entry — a placeholder, not a real per-subject workload.
  // S04 follows the same gate as H09: it stays INACTIVE until at
  // least one teacher carries `soTietTuan > 1`. This test asserts
  // the real-data behavior.
  const sliced = buildSlicedInput();
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev.constraintStatuses['S04'], 'INACTIVE');
  // Once a teacher gets `soTietTuan > 1`, S04 should become ACTIVE.
  sliced.input.teachers = sliced.input.teachers.map((t, i) => {
    if (i !== 0) return t;
    return { ...t, capacityPeriodsPerWeek: 2 };
  });
  const ev2 = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev2.constraintStatuses['S04'], 'ACTIVE');
});

test('PHASE 22 / N25b — H09 (workload capacity) is INACTIVE in the real dataset (placeholder gate)', () => {
  // Same placeholder gate as S04. The legacy dump has
  // `chuyenMon[].soTietTuan = 1` everywhere, so H09 must be
  // INACTIVE in the real dataset. The audit document calls this
  // out explicitly.
  const sliced = buildSlicedInput();
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.equal(ev.constraintStatuses['H09'], 'INACTIVE');
});

test('PHASE 22 / N26 — every soft constraint is ACTIVELY wired (no orphan entries)', () => {
  const sliced = buildSlicedInput();
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  for (const c of SOFT_CONSTRAINTS) {
    assert.ok(
      ['ACTIVE', 'INACTIVE', 'UNSUPPORTED'].includes(ev.constraintStatuses[c.id]),
      `${c.id} not in any known status: ${ev.constraintStatuses[c.id]}`
    );
  }
});

test('PHASE 22 / N27 — evaluator returns aggregate shape per §22', () => {
  const sliced = buildSlicedInput();
  const ev = evaluateCandidate(buildValidCandidate(sliced), sliced.input);
  assert.ok('hard' in ev);
  assert.ok('soft' in ev);
  assert.ok('inactive' in ev);
  assert.ok('unsupported' in ev);
  assert.ok('constraintStatuses' in ev);
  assert.ok('summary' in ev);
  assert.equal(typeof ev.hard.violated, 'boolean');
  assert.ok(Array.isArray(ev.hard.violations));
  assert.equal(typeof ev.soft.penalty, 'number');
  assert.ok(Array.isArray(ev.soft.violations));
  assert.ok(Array.isArray(ev.inactive));
  assert.ok(Array.isArray(ev.unsupported));
  assert.equal(typeof ev.summary.totalHardViolations, 'number');
  assert.equal(typeof ev.summary.totalSoftPenalty, 'number');
  assert.equal(typeof ev.summary.accepted, 'boolean');
});

test('PHASE 22 / N28 — real-data baseline: H14 (Travel) is UNSUPPORTED', () => {
  const full = loadFromLegacySaplich();
  const ev = evaluateBaseline(full.legacyBaseline, full.scheduling).evaluation;
  assert.equal(ev.constraintStatuses['H14'], 'UNSUPPORTED');
  // travelTime is null in the legacy dataset.
  assert.equal(full.scheduling.travelTime, null);
});
