import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFromLegacySaplich } from '../../src/modules/timetable/engine/loader/legacy-saplich/index.js';
import { evaluateCandidate, evaluateBaseline } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { normalizeSession, classConflictKey, teacherConflictKey } from '../../src/modules/timetable/engine/domain/time.js';
function rawDuplicateCounts(rawSlots) {
  const withSessClass = new Map();
  let dupClassWith = 0;
  const withSessTeacher = new Map();
  let dupTeacherWith = 0;
  const noSessClass = new Map();
  let dupClassNo = 0;
  const noSessTeacher = new Map();
  let dupTeacherNo = 0;
  for (const s of rawSlots) {
    const ck1 = `${s.class}|${s.day}|${s.session}|${s.period}`;
    if (withSessClass.has(ck1)) dupClassWith++;else withSessClass.set(ck1, s.id);
    const tk1 = `${s.teacher}|${s.day}|${s.session}|${s.period}`;
    if (withSessTeacher.has(tk1)) dupTeacherWith++;else withSessTeacher.set(tk1, s.id);
    const ck2 = `${s.class}|${s.day}|${s.period}`;
    if (noSessClass.has(ck2)) dupClassNo++;else noSessClass.set(ck2, s.id);
    const tk2 = `${s.teacher}|${s.day}|${s.period}`;
    if (noSessTeacher.has(tk2)) dupTeacherNo++;else noSessTeacher.set(tk2, s.id);
  }
  return {
    rawClassDuplicatesWithSession: dupClassWith,
    rawTeacherDuplicatesWithSession: dupTeacherWith,
    rawClassDuplicatesNoSession: dupClassNo,
    rawTeacherDuplicatesNoSession: dupTeacherNo
  };
}
const full = loadFromLegacySaplich();
const raw = full.legacyBaseline.scheduleSlots;
const rawCounts = rawDuplicateCounts(raw);
const {
  candidate,
  evaluation
} = evaluateBaseline(full.legacyBaseline, full.scheduling);
test('PHASE 22.1 / R1 — raw class duplicate count (with session) = 0', () => {
  assert.equal(rawCounts.rawClassDuplicatesWithSession, 0);
});
test('PHASE 22.1 / R2 — raw teacher duplicate count (with session) = 0', () => {
  assert.equal(rawCounts.rawTeacherDuplicatesWithSession, 0);
});
test('PHASE 22.1 / R3 — baseline adapter preserves all 802 slots', () => {
  let totalCandidateSlots = 0;
  for (const arr of candidate.assignments.values()) {
    totalCandidateSlots += arr.length;
  }
  assert.equal(totalCandidateSlots, raw.length);
  assert.equal(raw.length, 802);
});
test('PHASE 22.1 / R4 — baseline preserves classId (classId match)', () => {
  const rawBySlot = new Map(raw.map(s => [s.id, s]));
  let matched = 0;
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      const rs = rawBySlot.get(cs._sourceSlotId);
      assert.ok(rs, `candidate slot ${cs._sourceSlotId} has no raw counterpart`);
      assert.equal(rs.class, cs._sourceClass);
      matched++;
    }
  }
  assert.equal(matched, raw.length);
});
test('PHASE 22.1 / R5 — baseline preserves teacherId', () => {
  const rawBySlot = new Map(raw.map(s => [s.id, s]));
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      const rs = rawBySlot.get(cs._sourceSlotId);
      assert.ok(rs);
      assert.equal(rs.teacher, cs._sourceTeacher);
    }
  }
});
test('PHASE 22.1 / R6 — baseline preserves subjectId', () => {
  const rawBySlot = new Map(raw.map(s => [s.id, s]));
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      const rs = rawBySlot.get(cs._sourceSlotId);
      assert.ok(rs);
      assert.equal(rs.subject, cs._sourceSubject);
    }
  }
});
test('PHASE 22.1 / R7 — baseline preserves session (canonical form)', () => {
  const rawBySlot = new Map(raw.map(s => [s.id, s]));
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      const rs = rawBySlot.get(cs._sourceSlotId);
      assert.ok(rs);
      assert.equal(cs.session, normalizeSession(rs.session));
    }
  }
});
test('PHASE 22.1 / R8 — baseline preserves period', () => {
  const rawBySlot = new Map(raw.map(s => [s.id, s]));
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      const rs = rawBySlot.get(cs._sourceSlotId);
      assert.ok(rs);
      assert.equal(rs.period, cs.period);
    }
  }
});
test('PHASE 22.1 / R9 — no baseline placement has missing day/session/period', () => {
  for (const arr of candidate.assignments.values()) {
    for (const cs of arr) {
      assert.notEqual(cs.day, null, 'candidate slot day is null');
      assert.notEqual(cs.day, undefined, 'candidate slot day is undefined');
      assert.notEqual(cs.period, null);
      assert.notEqual(cs.period, undefined);
      assert.notEqual(cs.session, null);
      assert.notEqual(cs.session, undefined);
      assert.ok(['sang', 'chieu', 'ca_hai'].includes(cs.session), `unexpected session: ${cs.session}`);
    }
  }
});
test('PHASE 22.1 / R10 — baseline H01 result matches raw duplicate count (with session)', () => {
  const h01 = evaluation.hard.violations.filter(v => v.constraintId === 'H01');
  assert.equal(h01.length, rawCounts.rawClassDuplicatesWithSession);
  assert.equal(h01.length, 0);
});
test('PHASE 22.1 / R11 — baseline H02 result matches raw duplicate count (with session)', () => {
  const h02 = evaluation.hard.violations.filter(v => v.constraintId === 'H02');
  assert.equal(h02.length, rawCounts.rawTeacherDuplicatesWithSession);
  assert.equal(h02.length, 0);
});
test('PHASE 22.1 / R12 — evaluateBaseline() does not mutate baseline', () => {
  const before = JSON.stringify(full.legacyBaseline.scheduleSlots);
  evaluateBaseline(full.legacyBaseline, full.scheduling);
  const after = JSON.stringify(full.legacyBaseline.scheduleSlots);
  assert.equal(before, after);
  assert.equal(full.legacyBaseline.summary.totalSlots, 802);
});
test('PHASE 22.1 / R13 — evaluateBaseline() deterministic (1st vs 2nd call)', () => {
  const a = evaluateBaseline(full.legacyBaseline, full.scheduling);
  const b = evaluateBaseline(full.legacyBaseline, full.scheduling);
  assert.deepEqual(a.evaluation.hard.violations.map(v => v.constraintId + '|' + v.message), b.evaluation.hard.violations.map(v => v.constraintId + '|' + v.message));
  assert.equal(a.evaluation.soft.penalty, b.evaluation.soft.penalty);
});
test('PHASE 22.1 / R14 — repeated evaluation gives identical result (10x)', () => {
  const baseline = evaluateBaseline(full.legacyBaseline, full.scheduling);
  for (let i = 0; i < 10; i++) {
    const next = evaluateBaseline(full.legacyBaseline, full.scheduling);
    assert.deepEqual(next.evaluation.hard.violations.map(v => v.constraintId + '|' + v.message), baseline.evaluation.hard.violations.map(v => v.constraintId + '|' + v.message));
    assert.equal(next.evaluation.soft.penalty, baseline.evaluation.soft.penalty);
  }
});
test('PHASE 22.1 / R15 — cross-session slots are NOT counted as H01 violations', () => {
  const sliced = full.scheduling;
  const byClassDP = new Map();
  for (const s of raw) {
    const k = `${s.class}|${s.day}|${s.period}`;
    if (!byClassDP.has(k)) byClassDP.set(k, new Set());
    byClassDP.get(k).add(s.session);
  }
  const crossSessionKeys = [...byClassDP.entries()].filter(([, sessions]) => sessions.size > 1).map(([k]) => k);
  assert.ok(crossSessionKeys.length > 0, 'expected some cross-session pairs in raw baseline');
  const h01 = evaluation.hard.violations.filter(v => v.constraintId === 'H01');
  assert.equal(h01.length, 0, 'H01 must NOT fire on cross-session pairs');
});
test('PHASE 22.1 / R16 — classConflictKey / teacherConflictKey discriminate by session', () => {
  const slotMorning = {
    day: 1,
    session: 'sang',
    period: 1
  };
  const slotAfternoon = {
    day: 1,
    session: 'chieu',
    period: 1
  };
  assert.notEqual(classConflictKey(slotMorning), classConflictKey(slotAfternoon), 'morning and afternoon at the same (day, period) must collide in conflict identity');
  assert.notEqual(teacherConflictKey(slotMorning), teacherConflictKey(slotAfternoon));
});
test('PHASE 22.1 / R17 — session aliases (morning/afternoon) normalize to sang/chieu', () => {
  assert.equal(normalizeSession('morning'), 'sang');
  assert.equal(normalizeSession('afternoon'), 'chieu');
  assert.equal(normalizeSession('sang'), 'sang');
  assert.equal(normalizeSession('chieu'), 'chieu');
  assert.equal(normalizeSession('ca_hai'), 'ca_hai');
  assert.equal(normalizeSession('foo'), null);
  assert.equal(normalizeSession(undefined), null);
  assert.equal(normalizeSession(null), null);
});
test('PHASE 22.1 / R18 — explicit raw-vs-no-session comparison: same dataset, different identity', () => {
  assert.equal(rawCounts.rawClassDuplicatesNoSession, 83);
  assert.equal(rawCounts.rawTeacherDuplicatesNoSession, 252);
  assert.equal(rawCounts.rawClassDuplicatesWithSession, 0);
  assert.equal(rawCounts.rawTeacherDuplicatesWithSession, 0);
});
