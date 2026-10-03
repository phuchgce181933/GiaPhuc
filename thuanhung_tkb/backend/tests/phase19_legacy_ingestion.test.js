// Phase 19 — legacy-saplich ingestion tests.
//
// The 24 integrity tests required by §24 are checked here. Plus
// a handful of structural tests covering each layer of the
// pipeline.
//
// Tests are read-only: they import the loader, run it once, and
// assert. They do not mutate any file in `data/source/legacy-saplich/`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';

const result = loadFromLegacySaplich();

// ===========================================================================
// SECTION 1 — Inventory counts (tests 1..11, 23, 24)
// ===========================================================================

test('PHASE 19 / 1 — branches count = 7', () => {
  assert.equal(result.normalized.branches.length, 7);
  assert.equal(result.integrity.counts.branches, 7);
});

test('PHASE 19 / 2 — blocks count = 5', () => {
  assert.equal(result.normalized.blocks.length, 5);
  assert.equal(result.integrity.counts.blocks, 5);
});

test('PHASE 19 / 3 — subjects count = 6', () => {
  assert.equal(result.normalized.subjects.length, 6);
  assert.equal(result.integrity.counts.subjects, 6);
});

test('PHASE 19 / 4 — teachers count = 42', () => {
  assert.equal(result.normalized.teachers.length, 42);
  assert.equal(result.integrity.counts.teachers, 42);
});

test('PHASE 19 / 5 — active teachers = 40', () => {
  assert.equal(result.integrity.activeTeachers, 40);
});

test('PHASE 19 / 6 — inactive teachers = 2', () => {
  assert.equal(result.integrity.inactiveTeachers, 2);
});

test('PHASE 19 / 7 — classes count = 113', () => {
  assert.equal(result.normalized.classes.length, 113);
  assert.equal(result.integrity.counts.classes, 113);
});

test('PHASE 19 / 8 — blocksubjects count = 24', () => {
  assert.equal(result.normalized.curriculum.length, 24);
  assert.equal(result.integrity.counts.curriculum, 24);
});

test('PHASE 19 / 9 — assignments count = 479', () => {
  assert.equal(result.normalized.historicalAssignments.length, 479);
  assert.equal(result.integrity.counts.historicalAssignments, 479);
});

test('PHASE 19 / 10 — assignments requiredPeriods sum = 802', () => {
  const total = result.normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.requiredPeriods || 0), 0
  );
  assert.equal(total, 802);
});

test('PHASE 19 / 11 — assignments assignedPeriods sum = 802', () => {
  const total = result.normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.assignedPeriods || 0), 0
  );
  assert.equal(total, 802);
});

test('PHASE 19 / 12 — assignments shortage sum = 0', () => {
  const total = result.normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.shortage || 0), 0
  );
  assert.equal(total, 0);
});

test('PHASE 19 / 13 — scheduleslots count = 802', () => {
  assert.equal(result.normalized.historicalScheduleSlots.length, 802);
  assert.equal(result.integrity.counts.historicalScheduleSlots, 802);
});

test('PHASE 19 / 23 — schedules count = 1', () => {
  assert.equal(result.normalized.historicalSchedule.length, 1);
});

test('PHASE 19 / 24 — parttimeassignments = 0', () => {
  assert.equal(result.normalized.partTimeAssignments.length, 0);
  assert.equal(result.integrity.counts.partTimeAssignments, 0);
});

// ===========================================================================
// SECTION 2 — Slot integrity (tests 14, 15, 16, 17, 18)
// ===========================================================================

test('PHASE 19 / 14 — every assignment slot count === assignedPeriods', () => {
  const byAssignment = new Map();
  for (const s of result.normalized.historicalScheduleSlots) {
    byAssignment.set(s.assignment, (byAssignment.get(s.assignment) || 0) + 1);
  }
  let mismatch = 0;
  for (const a of result.normalized.historicalAssignments) {
    const slots = byAssignment.get(a.id) || 0;
    if (slots !== a.assignedPeriods) mismatch += 1;
  }
  assert.equal(mismatch, 0, 'every assignment must have exactly assignedPeriods slots');
});

test('PHASE 19 / 15 — no duplicate class/day/session/period', () => {
  const seen = new Set();
  let dup = 0;
  for (const s of result.normalized.historicalScheduleSlots) {
    const k = `${s.class}|${s.day}|${s.session}|${s.period}`;
    if (seen.has(k)) dup += 1;
    seen.add(k);
  }
  assert.equal(dup, 0);
});

test('PHASE 19 / 16 — no duplicate teacher/day/session/period', () => {
  const seen = new Set();
  let dup = 0;
  for (const s of result.normalized.historicalScheduleSlots) {
    const k = `${s.teacher}|${s.day}|${s.session}|${s.period}`;
    if (seen.has(k)) dup += 1;
    seen.add(k);
  }
  assert.equal(dup, 0);
});

test('PHASE 19 / 17 — assignment branch === class branch', () => {
  const classById = new Map(result.normalized.classes.map((c) => [c.id, c]));
  let mismatch = 0;
  for (const a of result.normalized.historicalAssignments) {
    const klass = classById.get(a.class);
    if (!klass) { mismatch += 1; continue; }
    if (klass.branch !== a.branch) mismatch += 1;
  }
  assert.equal(mismatch, 0);
});

test('PHASE 19 / 18 — assigned teacher is eligible for assigned subject', () => {
  const teachersById = new Map(result.normalized.teachers.map((t) => [t.id, t]));
  const teacherSpecById = new Map(
    result.normalized.teachers.map((t) => [t.id, new Set(t.specializations)])
  );
  let ineligible = 0;
  for (const a of result.normalized.historicalAssignments) {
    const t = teachersById.get(a.teacher);
    if (!t) { ineligible += 1; continue; }
    const specs = teacherSpecById.get(a.teacher);
    if (!specs.has(a.subject)) ineligible += 1;
  }
  assert.equal(ineligible, 0);
});

// ===========================================================================
// SECTION 3 — CN-TH preservation (tests 19, 20)
// ===========================================================================

test('PHASE 19 / 19 — CN-TH remains in RAW (normalized) and remains inactive', () => {
  const cnth = result.normalized.subjects.find((s) => s.code === 'CN-TH' || s.name === 'Công nghệ, Tin học');
  assert.ok(cnth, 'CN-TH subject must be present in normalized data');
  assert.equal(cnth.isActive, false, 'CN-TH must remain isActive=false');
});

test('PHASE 19 / 20 — no assignment uses inactive CN-TH', () => {
  const inactiveSubjectIds = new Set(
    result.normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );
  let uses = 0;
  for (const a of result.normalized.historicalAssignments) {
    if (inactiveSubjectIds.has(a.subject)) uses += 1;
  }
  assert.equal(uses, 0);
});

// ===========================================================================
// SECTION 4 — Transfer / academic year (tests 21, 22)
// ===========================================================================

test('PHASE 19 / 21 — exactly 87 assignments have isTransferred=true', () => {
  const transferred = result.normalized.historicalAssignments.filter((a) => a.isTransferred);
  assert.equal(transferred.length, 87);
});

test('PHASE 19 / 22 — all 479 assignments belong to academicYear=2025-2026 semester=1', () => {
  for (const a of result.normalized.historicalAssignments) {
    assert.equal(a.academicYear, '2025-2026');
    assert.equal(a.semester, 1);
  }
});

// ===========================================================================
// SECTION 5 — Layer / pipeline structural tests
// ===========================================================================

test('PHASE 19 / L1 — raw reader preserves all 11 collections', () => {
  const expected = [
    'branches',
    'blocks',
    'subjects',
    'teachers',
    'classes',
    'blocksubjects',
    'assignments',
    'schedules',
    'scheduleslots',
    'transferlogs',
    'parttimeassignments',
  ];
  for (const name of expected) {
    assert.ok(result.raw.collections.has(name), `${name} must be present in raw dump`);
  }
});

test('PHASE 19 / L2 — raw document ObjectId is preserved as string in normalized layer', () => {
  const first = result.normalized.teachers[0];
  assert.equal(typeof first.id, 'string');
  assert.match(first.id, /^[a-f0-9]{24}$/);
});

test('PHASE 19 / L3 — scheduling model surfaces active teachers; inactive teachers excluded', () => {
  const teacherIds = new Set(result.normalized.teachers.map((t) => t.id));
  const schedulingIds = new Set(result.scheduling.teachers.map((t) => t.id));
  for (const t of result.normalized.teachers) {
    if (t.isActive) {
      assert.ok(schedulingIds.has(t.id), `active teacher ${t.id} must be in scheduling model`);
    } else {
      assert.ok(!schedulingIds.has(t.id), `inactive teacher ${t.id} must NOT be in scheduling model`);
    }
  }
  // Sanity check on counts
  assert.equal(result.scheduling.teachers.length, 40);
});

test('PHASE 19 / L4 — scheduling model excludes curriculum rows whose subject is inactive', () => {
  // CN-TH is inactive. The legacy curriculum contains some rows
  // that reference CN-TH. Those rows must be excluded from
  // scheduling.curriculum and surfaced in scheduling.excludedCurriculum.
  assert.ok(result.scheduling.excludedCurriculum.length > 0,
    'expected at least one curriculum row excluded due to inactive subject');
  const inactiveSubjectIds = new Set(
    result.normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );
  for (const cs of result.scheduling.curriculum) {
    assert.ok(!inactiveSubjectIds.has(cs.subjectId), 'cancelled row in scheduling.curriculum');
  }
});

test('PHASE 19 / L5 — scheduling travelTime is null; travelStatus is MISSING_CONFIGURATION', () => {
  assert.equal(result.scheduling.travelTime, null);
  assert.equal(result.scheduling.travelStatus, 'MISSING_CONFIGURATION');
});

test('PHASE 19 / L6 — all 24 curriculum rows remain in normalized layer (none silently deleted)', () => {
  assert.equal(result.normalized.curriculum.length, 24);
});

test('PHASE 19 / L7 — no fake teacher/homeroomField ties claimed from class names', () => {
  for (const c of result.normalized.classes) {
    assert.equal(c.homeroomTeacher, null, `class ${c.id} must keep homeroomTeacher=null as in source`);
  }
});

test('PHASE 19 / L8 — branch field on class is preserved from source', () => {
  // The brief says: do not infer branch from class name.
  const sample = result.normalized.classes.find((c) => c.name === '1C');
  assert.ok(sample, 'sample class 1C must exist');
  assert.equal(typeof sample.branch, 'string');
  assert.match(sample.branch, /^[a-f0-9]{24}$/);
});

test('PHASE 19 / L9 — teachingWorkload is preserved verbatim (legacy denormalized)', () => {
  const sample = result.normalized.teachers.find((t) => t.teachingWorkload != null);
  assert.ok(sample, 'at least one teacher must carry a teachingWorkload value');
  for (const t of result.normalized.teachers) {
    if (t.teachingWorkload != null) {
      assert.equal(typeof t.teachingWorkload, 'number');
    }
  }
});

test('PHASE 19 / L10 — legacy baseline exposes totalSlots = 802', () => {
  assert.equal(result.legacyBaseline.summary.totalSlots, 802);
  assert.equal(result.legacyBaseline.summary.totalAssignments, 479);
  assert.equal(result.legacyBaseline.summary.totalTransfers, 4175);
});

test('PHASE 19 / L11 — integrity totals separate operational vs orphan historical references', () => {
  // Orphan historical = transferlogs.assignment pointing to absent assignment ids.
  assert.ok(result.integrity.totals.orphanHistoricalReferences > 0,
    'transferlogs must report orphan historical references (per the brief, kept not deleted)');
});

test('PHASE 19 / L12 — operational references are valid', () => {
  assert.equal(result.integrity.totals.brokenOperationalReferences, 0,
    'no operational reference should be broken');
});

test('PHASE 19 / L13 — integrity anomalies include CN-TH row, schedule mismatch, teachingWorkload mismatch', () => {
  const joined = result.integrity.anomalies.join('\n');
  assert.match(joined, /CN-TH|inactive subject/);
  assert.match(joined, /historical metadata/);
  assert.match(joined, /teachingWorkload/);
  assert.match(joined, /travel matrix/);
});

test('PHASE 19 / L14 — normalized teacher name preserves diacritics & casing', () => {
  const names = result.normalized.teachers.map((t) => t.name);
  // Sample check on the known diacritic-heavy names observed in the source.
  const hasDien = names.some((n) => /[áàảãạăắằẳẵặâấầẩẫậéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵđ]/i.test(n));
  assert.ok(hasDien, 'at least one teacher name must contain diacritics');
});

test('PHASE 19 / L15 — transfer log scope is auto for all 4175 entries', () => {
  for (const tl of result.normalized.transferHistory) {
    assert.equal(tl.scope, 'auto');
  }
});

test('PHASE 19 / L16 — transfer log success vs failure counts', () => {
  const success = result.normalized.transferHistory.filter((t) => t.status === 'SUCCESS').length;
  const failed = result.normalized.transferHistory.filter((t) => t.status === 'FAILED').length;
  assert.equal(success, 3626);
  assert.equal(failed, 549);
  assert.equal(success + failed, 4175);
});

test('PHASE 19 / L17 — failure reasons preserved verbatim from source', () => {
  const expected = new Set([
    'ADJACENT_SLOT_AT_BRANCH',
    'TEACHER_CONFLICT',
    'SAME_SESSION_AT_MAIN_BRANCH',
    'SPECIALIZATION_MISMATCH',
  ]);
  const observed = new Set(
    result.normalized.transferHistory
      .filter((t) => t.status === 'FAILED')
      .map((t) => t.failureReason)
      .filter((r) => r != null)
  );
  for (const r of expected) {
    assert.ok(observed.has(r), `failure reason ${r} must be present`);
  }
});

test('PHASE 19 / L18 — CN-TH row in normalized.curriculum (raw preserved)', () => {
  const cnthIds = new Set(
    result.normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );
  const cnthCurriculum = result.normalized.curriculum.filter((c) => cnthIds.has(c.subject));
  assert.ok(cnthCurriculum.length > 0, 'CN-TH curriculum rows must remain in normalized data');
});

test('PHASE 19 / L19 — scheduling.curriculum is class-level (479 rows from 21 effective block-level)', () => {
  // PHASE 21 UPDATE: scheduling curriculum is now class-level
  // (each effective blocksubject expanded to one row per active
  // class in the block). The block-level effective count is
  // captured by the `_meta.effectiveCurriculumBlockLevel` audit
  // metric, NOT by `curriculum.length`.
  const activeSubjectIds = new Set(
    result.normalized.subjects.filter((s) => s.isActive).map((s) => s.id)
  );
  const blockLevelEffective = result.normalized.curriculum.filter((c) => activeSubjectIds.has(c.subject)).length;
  // The scheduling model reports 479 class-level rows.
  assert.equal(result.scheduling.curriculum.length, 479);
  // The block-level effective count is preserved on _meta.
  assert.equal(result.scheduling._meta.effectiveCurriculumBlockLevel, blockLevelEffective);
  assert.equal(blockLevelEffective, 21);
  // Every curriculum row carries classId, blockId, subjectId.
  for (const cs of result.scheduling.curriculum) {
    assert.ok(cs.classId, 'classId must be present');
    assert.ok(cs.blockId, 'blockId must be preserved');
    assert.ok(cs.subjectId, 'subjectId must be present');
  }
});

test('PHASE 19 / L20 — schedules[0] summary mismatch is preserved (not silently fixed)', () => {
  const s = result.normalized.historicalSchedule[0];
  assert.equal(s.completedAssignments, 403);
  assert.equal(s.totalAssignments, 479);
  assert.equal(s.statistics.totalSlots, 671);
});

test('PHASE 19 / L21 — schedules[0] is marked isHistoricalMetadata=true', () => {
  const s = result.normalized.historicalSchedule[0];
  assert.equal(s.isHistoricalMetadata, true);
});

test('PHASE 19 / L22 — source dirs match between result and DEFAULT_SOURCE_DIR', () => {
  // Sanity: the loader used the canonical path.
  assert.match(result.sourceDir, /data[\\/]source[\\/]legacy-saplich$/);
});

test('PHASE 19 / L23 — inventory matches normalized counts', () => {
  assert.equal(result.inventory.branches, 7);
  assert.equal(result.inventory.blocks, 5);
  assert.equal(result.inventory.subjects, 6);
  assert.equal(result.inventory.teachers, 42);
  assert.equal(result.inventory.classes, 113);
  assert.equal(result.inventory.blocksubjects, 24);
  assert.equal(result.inventory.assignments, 479);
  assert.equal(result.inventory.schedules, 1);
  assert.equal(result.inventory.scheduleslots, 802);
  assert.equal(result.inventory.transferlogs, 4175);
  assert.equal(result.inventory.parttimeassignments, 0);
});

test('PHASE 19 / L24 — scheduling model is itself a valid SchedulingInput shape', () => {
  // The orchestrator's `load()` returns this shape; we accept it.
  const required = [
    'teachers', 'branches', 'classes', 'subjects',
    'curriculum', 'assignments', 'timeSlotsByBranch',
    'travelTime', 'transitionMinutes',
    'teacherIndex', 'assignmentIndex',
    'missingData', 'warnings',
    'branchesStatus', 'curriculumStatus', 'travelStatus',
  ];
  for (const k of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(result.scheduling, k),
      `scheduling model must expose ${k}`);
  }
  assert.ok(result.scheduling.teacherIndex instanceof Map);
  assert.ok(result.scheduling.assignmentIndex instanceof Map);
  assert.ok(result.scheduling.timeSlotsByBranch instanceof Map);
});

test('PHASE 19 / L25 — transferredAssignmentsWithoutOrigin is positive', () => {
  // The brief mentions "35 transferred assignments thiếu
  // transferredFromTeacher". Verify the count is > 0 and
  // consistent with raw counts.
  const transferred = result.normalized.historicalAssignments.filter((a) => a.isTransferred);
  const withoutOrigin = transferred.filter((a) => a.transferredFromTeacher == null);
  assert.ok(withoutOrigin.length > 0,
    'at least one transferred assignment must have null transferredFromTeacher (per the brief)');
  assert.ok(withoutOrigin.length <= transferred.length);
});