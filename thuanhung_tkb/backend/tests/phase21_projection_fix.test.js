// Phase 21 — projection-fix regression tests.
//
// SCOPE
// -----
// Phase 21 fixes two known projection bugs in
// `scheduling-model.js`:
//   - BUG #1: `curriculum[].classId` was a BLOCK id (one of 5
//     grade groups) instead of a real CLASS id. Fix: each
//     effective (block, subject) blocksubject is expanded to one
//     row per active class in the block. `classId` is now a real
//     class id; `blockId` is preserved alongside.
//   - BUG #2: `teacher.chuyenMon[].tenChuyenMon` was a SUBJECT
//     NAME (e.g. "Mỹ thuật") while `assignment.subjectId` is a
//     SUBJECT ID (24-char hex). The orchestrator's eligibility
//     check (`tenChuyenMon === subjectId`) never matched, so
//     every assignment was reported as unresolvable_demand. Fix:
//     `tenChuyenMon` is now the subject id; an explicit
//     `eligibleSubjectIds[]` is also surfaced.
//
// These tests are READ-ONLY. They do not modify raw data, the
// normalized layer, the solver, the orchestrator, the validator,
// the AI strategy, or any fixture. They walk the layer-4
// scheduling model and assert the contract.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { runPhase20Audit } from '../src/loader/legacy-saplich/verify.js';
import { validateInput } from '../src/domain/validate.js';

const result = loadFromLegacySaplich();
const { normalized, scheduling } = result;

// ============================================================================
// Pre-computed reference data
// ============================================================================

const classIdSet = new Set(scheduling.classes.map((c) => c.id));
const subjectIdSet = new Set(scheduling.subjects.map((s) => s.id));
const branchIdSet = new Set(scheduling.branches.map((b) => b.id));
const teacherById = new Map(scheduling.teachers.map((t) => [t.id, t]));
const blockIdSet = new Set(normalized.blocks.map((b) => b.id));

const effectiveBlockLevelCurriculumIds = new Set(
  normalized.curriculum
    .filter((cs) => cs.subject == null || subjectIdSet.has(cs.subject))
    .filter((cs) => {
      const subj = normalized.subjects.find((s) => s.id === cs.subject);
      return !subj || subj.isActive;
    })
    .map((cs) => cs.id)
);

// ============================================================================
// Tests
// ============================================================================

// ---- BUG #1 — curriculum.classId is a real class id ------------------------

test('PHASE 21 / P1 — curriculum.classId is a real class id (not a block id)', () => {
  for (const cs of scheduling.curriculum) {
    assert.ok(
      classIdSet.has(cs.classId),
      `curriculum[${cs.id}].classId=${cs.classId} is not a real class id`
    );
    assert.ok(
      !blockIdSet.has(cs.classId),
      `curriculum[${cs.id}].classId=${cs.classId} is a block id (Bug #1 regression)`
    );
  }
});

test('PHASE 21 / P2 — curriculum.blockId is preserved (block-level semantics not lost)', () => {
  let withBlockId = 0;
  for (const cs of scheduling.curriculum) {
    assert.ok(cs.blockId, `curriculum[${cs.id}] missing blockId`);
    assert.ok(
      blockIdSet.has(cs.blockId),
      `curriculum[${cs.id}].blockId=${cs.blockId} is not a real block id`
    );
    withBlockId += 1;
  }
  assert.ok(withBlockId > 0);
});

test('PHASE 21 / P3 — curriculum.subjectId is a real subject id', () => {
  for (const cs of scheduling.curriculum) {
    assert.ok(
      subjectIdSet.has(cs.subjectId),
      `curriculum[${cs.id}].subjectId=${cs.subjectId} is not a real subject id`
    );
  }
});

test('PHASE 21 / P4 — every effective curriculum classId exists in scheduling.classes[]', () => {
  // Combined with P1: every classId in curriculum is in classes[].
  const orphan = scheduling.curriculum.filter((cs) => !classIdSet.has(cs.classId));
  assert.equal(orphan.length, 0, `${orphan.length} curriculum rows reference unknown classes`);
});

test('PHASE 21 / P5 — every effective curriculum subjectId exists in scheduling.subjects[]', () => {
  const orphan = scheduling.curriculum.filter((cs) => !subjectIdSet.has(cs.subjectId));
  assert.equal(orphan.length, 0, `${orphan.length} curriculum rows reference unknown subjects`);
});

// ---- BUG #2 — subject identity resolution ----------------------------------

test('PHASE 21 / P6 — teacher.chuyenMon[].tenChuyenMon holds subject NAME (semantic integrity, Phase 22 §29)', () => {
  // Phase 22 §29: `tenChuyenMon` is Vietnamese for
  // "specialization name". The field carries a NAME, not a
  // hex id. Eligibility resolution happens via
  // `eligibleSubjectIds[]` (the explicit, solver-friendly
  // id-side projection).
  //
  // Every scheduling teacher's chuyenMon entry has a name that
  // resolves to a real subject in the catalog. The id-side
  // projection is exposed as `eligibleSubjectIds[]`.
  for (const t of scheduling.teachers) {
    for (const s of t.chuyenMon) {
      const isName = normalized.subjects.some(
        (sub) => sub.name === s.tenChuyenMon
      );
      assert.ok(
        isName,
        `teacher ${t.id} chuyenMon.tenChuyenMon="${s.tenChuyenMon}" is not a subject name (semantic integrity)`
      );
      assert.ok(
        Array.isArray(t.eligibleSubjectIds),
        `teacher ${t.id} missing eligibleSubjectIds[] (the solver-friendly field)`
      );
    }
  }
});

test('PHASE 21 / P7 — every assignment subjectId resolves to a real subject', () => {
  const orphan = scheduling.assignments.filter((a) => !subjectIdSet.has(a.subjectId));
  assert.equal(orphan.length, 0, `${orphan.length} assignments reference unknown subjects`);
});

test('PHASE 21 / P8 — every assignment teacher is eligible for the assignment subject', () => {
  const ineligible = [];
  for (const a of scheduling.assignments) {
    const teacher = teacherById.get(a.teacherId);
    if (!teacher) continue;
    const eligibleIds = teacher.eligibleSubjectIds ?? [];
    if (!eligibleIds.includes(a.subjectId)) {
      ineligible.push({ assignmentId: a.id, teacherId: a.teacherId, subjectId: a.subjectId });
    }
  }
  assert.equal(
    ineligible.length,
    0,
    `${ineligible.length} assignments have ineligible teachers: ${JSON.stringify(ineligible.slice(0, 3))}`
  );
});

test('PHASE 21 / P9 — every assignment branch matches class branch', () => {
  const classById = new Map(normalized.classes.map((c) => [c.id, c]));
  const mismatch = [];
  for (const a of scheduling.assignments) {
    const cls = classById.get(a.classId);
    if (cls && cls.branch !== a.branchId) {
      mismatch.push({ assignmentId: a.id, classBranch: cls.branch, assignmentBranch: a.branchId });
    }
  }
  assert.equal(mismatch.length, 0, `${mismatch.length} assignment branch mismatches`);
});

// ---- Operational counts ----------------------------------------------------

test('PHASE 21 / P10 — invalid_reference (curriculum) = 0', () => {
  const audit = runPhase20Audit(result);
  assert.equal(audit.orchestratorDryRun.issuesByCode.invalid_reference ?? 0, 0);
});

test('PHASE 21 / P11 — unresolvable_demand = 0', () => {
  const audit = runPhase20Audit(result);
  assert.equal(audit.orchestratorDryRun.issuesByCode.unresolvable_demand ?? 0, 0);
});

test('PHASE 21 / P12 — active teacher count = 40', () => {
  assert.equal(scheduling.teachers.length, 40);
});

test('PHASE 21 / P13 — active subject count = 5 (catalog has 6, demand has 5)', () => {
  // Catalog keeps CN-TH (per the source-of-truth invariant).
  assert.equal(scheduling.subjects.length, 6);
  // Curriculum demand never references CN-TH.
  const usedSubjectIds = new Set(
    [...scheduling.curriculum.map((cs) => cs.subjectId),
     ...scheduling.assignments.map((a) => a.subjectId)]
  );
  usedSubjectIds.delete(null);
  usedSubjectIds.delete(undefined);
  assert.equal(usedSubjectIds.size, 5);
  // CN-TH is in the catalog but not in the demand set.
  const cnth = normalized.subjects.find((s) => s.code === 'CN-TH');
  assert.ok(cnth);
  assert.equal(cnth.isActive, false);
  assert.equal(usedSubjectIds.has(cnth.id), false);
});

test('PHASE 21 / P14 — effective curriculum count = 21 (block-level)', () => {
  // effectiveCurriculumBlockLevel is the source-side metric.
  assert.equal(scheduling._meta.effectiveCurriculumBlockLevel, 21);
});

test('PHASE 21 / P15 — class-level curriculum count = 479 (matches assignments)', () => {
  assert.equal(scheduling.curriculum.length, 479);
  assert.equal(scheduling.assignments.length, 479);
});

test('PHASE 21 / P16 — requiredPeriods = 802 (sum of assignment.requiredPeriods)', () => {
  const total = scheduling.assignments.reduce(
    (acc, a) => acc + (a.requiredPeriods ?? 0),
    0
  );
  assert.equal(total, 802);
});

test('PHASE 21 / P17 — assignedPeriods = 802 (from legacy baseline)', () => {
  // assignedPeriods is not on the scheduling assignment shape,
  // but the legacy baseline (legacyBaseline) carries the truth.
  const total = normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.assignedPeriods ?? 0),
    0
  );
  assert.equal(total, 802);
});

test('PHASE 21 / P18 — baseline assignment count = 802 (from legacy slots)', () => {
  // Baseline slot count is the # of scheduleslots, not
  // assignment count. Each assignment has assignedPeriods slots.
  const slotCount = normalized.historicalScheduleSlots.length;
  assert.equal(slotCount, 802);
});

// ---- Baseline distinction --------------------------------------------------

test('PHASE 21 / P19 — every assignment is baselineAssignment=true, never a fixed assignment', () => {
  for (const a of scheduling.assignments) {
    assert.equal(a.baselineAssignment, true, `assignment ${a.id} is not a baseline assignment`);
    // The scheduling model must NOT introduce a `fixedAssignment`
    // field; legacy assignments are baseline, not fixed.
    assert.equal(a.fixedAssignment, undefined, `assignment ${a.id} unexpectedly marked as fixed`);
  }
  // Count check.
  const baselineCount = scheduling.assignments.filter((a) => a.baselineAssignment === true).length;
  assert.equal(baselineCount, 479);
});

// ---- Travel untouched ------------------------------------------------------

test('PHASE 21 / P20 — travel remains MISSING; no travel data fabricated', () => {
  assert.equal(scheduling.travelTime, null);
  assert.equal(scheduling.travelStatus, 'MISSING_CONFIGURATION');
  // No synthetic travel entries.
  assert.equal(scheduling.travelMatrix, undefined);
  assert.equal(scheduling.travelProvider, undefined);
});

// ---- Real SchedulingInput reaches the orchestrator -------------------------

test('PHASE 21 / P21 — real SchedulingInput reaches orchestrator without INVALID_INPUT', () => {
  const v = validateInput(scheduling);
  assert.equal(v.issues.length, 0, `validator issues: ${JSON.stringify(v.issues)}`);
  // Travel remains MISSING_DATA (the only legitimate missing).
  assert.equal(v.missing.length, 1);
  assert.equal(v.missing[0].entity, 'Travel');
  // And the orchestrator is reachable (no exception).
  const audit = runPhase20Audit(result);
  assert.equal(audit.orchestratorDryRun.threw, null);
  assert.notEqual(audit.orchestratorDryRun.status, 'INVALID_INPUT');
});

// ---- Traceability / round-trip --------------------------------------------

test('PHASE 21 / P22 — every projected curriculum row traces back to a source blocksubject', () => {
  for (const cs of scheduling.curriculum) {
    // Composite id = `${sourceBlockSubjectId}::${classId}`.
    const sepIdx = cs.id.indexOf('::');
    assert.ok(sepIdx > 0, `curriculum[${cs.id}] has no composite separator`);
    const sourceId = cs.id.slice(0, sepIdx);
    const classId = cs.id.slice(sepIdx + 2);
    assert.ok(
      effectiveBlockLevelCurriculumIds.has(sourceId),
      `curriculum[${cs.id}].sourceId=${sourceId} not in source blocksubjects`
    );
    assert.equal(classId, cs.classId, `curriculum[${cs.id}] class id mismatch in composite id`);
  }
});

test('PHASE 21 / P23 — every projected subject traces back to a source subject (no invented subjects)', () => {
  for (const s of scheduling.subjects) {
    const src = normalized.subjects.find((x) => x.id === s.id);
    assert.ok(src, `subject ${s.id} is not in source`);
    assert.equal(s.name, src.name);
    assert.equal(s.isActive, src.isActive);
  }
});

test('PHASE 21 / P24 — every teacher eligibleSubjectIds traces back to source specializations', () => {
  for (const t of scheduling.teachers) {
    const src = normalized.teachers.find((x) => x.id === t.id);
    assert.ok(src, `teacher ${t.id} not in source`);
    const srcSet = new Set(src.specializations);
    for (const sid of t.eligibleSubjectIds ?? []) {
      assert.ok(srcSet.has(sid), `teacher ${t.id}.eligibleSubjectIds contains ${sid} not in source`);
    }
  }
});

// ---- Determinism -----------------------------------------------------------

test('PHASE 21 / P25 — SchedulingInput is deterministic: load A == load B', () => {
  const a = loadFromLegacySaplich();
  const b = loadFromLegacySaplich();
  // Curriculum must be in the same order (block-sorted, then class-sorted).
  const aIds = a.scheduling.curriculum.map((c) => c.id);
  const bIds = b.scheduling.curriculum.map((c) => c.id);
  assert.deepEqual(aIds, bIds);
  // Teachers must be in the same order.
  const aT = a.scheduling.teachers.map((t) => t.id);
  const bT = b.scheduling.teachers.map((t) => t.id);
  assert.deepEqual(aT, bT);
  // Assignments too.
  const aA = a.scheduling.assignments.map((x) => x.id);
  const bA = b.scheduling.assignments.map((x) => x.id);
  assert.deepEqual(aA, bA);
});

// ---- Validator semantic checks ---------------------------------------------

test('PHASE 21 / P26 — every teacher.chuyenMon[].tenChuyenMon is a real subject name; eligibleSubjectIds[] carries the ids (Phase 22 §29)', () => {
  // Phase 22 §29: the field NAME carries the semantic.
  //   - `tenChuyenMon`  → NAME (Vietnamese "specialization name")
  //   - `eligibleSubjectIds[]` → ID (solver-friendly list)
  //
  // Iterate every teacher, every chuyenMon entry. The name must
  // match a real subject. The id list must be present and every
  // id must be in the subject catalog.
  let bad = 0;
  for (const t of scheduling.teachers) {
    for (const s of t.chuyenMon) {
      const isName = normalized.subjects.some((sub) => sub.name === s.tenChuyenMon);
      if (!isName) bad += 1;
    }
    if (!Array.isArray(t.eligibleSubjectIds)) bad += 1;
    for (const sid of t.eligibleSubjectIds ?? []) {
      if (!subjectIdSet.has(sid)) bad += 1;
    }
  }
  assert.equal(bad, 0);
});

test('PHASE 21 / P27 — every assignment has requiredPeriods > 0', () => {
  const bad = scheduling.assignments.filter((a) => !(a.requiredPeriods > 0));
  assert.equal(bad.length, 0);
});

test('PHASE 21 / P28 — every assignment teacher exists in scheduling.teachers[]', () => {
  const bad = scheduling.assignments.filter((a) => !teacherById.has(a.teacherId));
  assert.equal(bad.length, 0);
});

test('PHASE 21 / P29 — every assignment branch exists in scheduling.branches[]', () => {
  const bad = scheduling.assignments.filter((a) => !branchIdSet.has(a.branchId));
  assert.equal(bad.length, 0);
});

test('PHASE 21 / P30 — every class has a branchId that exists in branches[]', () => {
  const bad = scheduling.classes.filter((c) => !branchIdSet.has(c.branchId));
  assert.equal(bad.length, 0);
});
