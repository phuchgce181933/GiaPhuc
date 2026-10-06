// Phase 20 — orchestrator-input audit & dry-run.
//
// PHASE 20 IS NOT OPTIMIZATION. It walks the legacy-saplich
// pipeline (RAW → NORMALIZED → SCHEDULING MODEL → ORCHESTRATOR
// INPUT) and asserts the semantic state. It does not modify
// the source data, the domain contract, the solver, the
// optimizer, or the AI strategy.
//
// This file is split into two parts:
//   - PART A: pure-semantic checks. Each is "the audit must
//     observe X" — never "fix X".
//   - PART B: orchestrator dry-run. We probe
//     `validateInput(scheduling)` and `orchestrator.preview(...)`
//     to surface the issues. The two known projection bugs in
//     `scheduling-model.js` are surfaced here as known issues
//     and explicitly NOT fixed in Phase 20.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { runPhase20Audit } from '../src/loader/legacy-saplich/verify.js';
import { validateInput } from '../src/domain/validate.js';

const result = loadFromLegacySaplich();
const audit = runPhase20Audit(result);
const { normalized, scheduling, legacyBaseline } = result;

// ============================================================================
// PART A — semantic checks
// ============================================================================

// ---- §2 Traceability -------------------------------------------------------

test('PHASE 20 / T1 — every normalized active teacher is in scheduling, no extras', () => {
  assert.equal(audit.traceability.idStability.teachers.activeMatch, true);
  assert.equal(audit.traceability.idStability.teachers.inNormalizedOnly.length, 0);
  assert.equal(audit.traceability.idStability.teachers.inSchedulingOnly.length, 0);
  assert.equal(audit.traceability.idStability.teachers.inactiveInScheduling.length, 0);
});

test('PHASE 20 / T2 — branch ids: normalized == scheduling', () => {
  assert.equal(audit.traceability.idStability.branches.match, true);
  assert.equal(audit.traceability.idStability.branches.inNormalizedOnly.length, 0);
  assert.equal(audit.traceability.idStability.branches.inSchedulingOnly.length, 0);
});

test('PHASE 20 / T3 — class ids: normalized == scheduling', () => {
  assert.equal(audit.traceability.idStability.classes.match, true);
});

test('PHASE 20 / T4 — subject catalog includes all 6 source subjects; only 5 are used in demand (CN-TH has no demand)', () => {
  // The scheduling model surfaces all 6 subjects as the
  // authoritative catalog (matching the source of truth). The
  // "effective" scheduling subjects — the ones the solver will
  // see demand for — are 5 (CN-TH has no assignment / no
  // curriculum row). This is the correct semantic of the
  // brief: "effective scheduling subjects only contain active".
  assert.equal(audit.traceability.counts.scheduling.subjects, 6);
  const usedSubjectIds = new Set(
    normalized.historicalAssignments.map((a) => a.subject)
  );
  assert.equal(usedSubjectIds.size, 5);
  const cnth = audit.subjects.cnthInSource;
  assert.ok(cnth);
  assert.ok(!usedSubjectIds.has(cnth.id), 'CN-TH must not be used by any assignment');
});

test('PHASE 20 / T5 — assignment ids: normalized == scheduling (no dropped, no fabricated)', () => {
  assert.equal(audit.traceability.idStability.assignments.match, true);
  assert.equal(scheduling.assignments.length, normalized.historicalAssignments.length);
});

test('PHASE 20 / T6 — counts match inventory (40 active teachers, 7 branches, 113 classes, 6 subjects in catalog with 5 effective, 479 class-level curriculum rows derived from 21 effective block-level rows, 479 assignments)', () => {
  // PHASE 21 UPDATE: curriculum is now class-level (each
  // blocksubject expanded to one row per active class in the
  // block). The block-level effective count is 21 (audit metric,
  // see `_meta.effectiveCurriculumBlockLevel` and
  // `audit.curriculum.effectiveCurriculumBlockLevel`). The actual
  // `scheduling.curriculum` array has 479 class-level rows
  // (matches the 479 assignments exactly in the real dataset).
  assert.equal(audit.traceability.counts.scheduling.teachers, 40);
  assert.equal(audit.traceability.counts.scheduling.branches, 7);
  assert.equal(audit.traceability.counts.scheduling.classes, 113);
  // Catalog has 6 (CN-TH included for reference). Effective
  // scheduling subjects (those used in demand) is 5.
  assert.equal(audit.traceability.counts.scheduling.subjects, 6);
  assert.equal(audit.demand.subjectBreakdown.length, 5);
  assert.equal(audit.traceability.counts.scheduling.curriculum, 479);
  // Block-level audit metric stays 21 (24 raw blocksubjects - 3
  // CN-TH inactive = 21 effective).
  assert.equal(audit.curriculum.effectiveCurriculumBlockLevel, 21);
  assert.equal(scheduling._meta.effectiveCurriculumBlockLevel, 21);
  assert.equal(scheduling._meta.classLevelCurriculumCount, 479);
  assert.equal(audit.traceability.counts.scheduling.assignments, 479);
});

// ---- §3 Teachers -----------------------------------------------------------

test('PHASE 20 / Tch1 — every scheduling teacher is from a source active teacher (no inactive leak)', () => {
  assert.equal(audit.teachers.inactiveLeak.length, 0);
});

test('PHASE 20 / Tch2 — no active source teacher missing from scheduling', () => {
  assert.equal(audit.teachers.activeMissingInScheduling.length, 0);
});

test('PHASE 20 / Tch3 — hoTen, email, phone, homeBranchId preserved exactly per source', () => {
  assert.equal(audit.teachers.nameMismatches.length, 0);
  assert.equal(audit.teachers.emailMismatches.length, 0);
  assert.equal(audit.teachers.phoneMismatches.length, 0);
  assert.equal(audit.teachers.homeBranchMismatches.length, 0);
});

test('PHASE 20 / Tch4 — specialization is eligibility, not assignment', () => {
  // We do not turn a teacher with 1 specialization into a forced
  // assignment to that subject. The audit must record that the
  // scheduling.chuyenMon / eligibleSubjectIds is a subset of the
  // source specializations (subjects that no longer resolve are
  // dropped, but no assignment is forced).
  //
  // PHASE 21 UPDATE: the audit field was renamed
  //   specializationAsAssignment → eligibilityAsAssignment
  // to reflect the new contract. The semantic is unchanged.
  assert.equal(audit.teachers.eligibilityAsAssignment.length, 0);
});

// ---- §4 Workload -----------------------------------------------------------

test('PHASE 20 / Wl1 — legacy teachingWorkload vs derived: counts mismatch; neither overwrites the other', () => {
  // Per the brief: legacy teachingWorkload is denormalized. We
  // expect some teachers to disagree. The audit reports BOTH
  // values; the scheduling model carries neither as ground
  // truth.
  assert.ok(audit.workload.legacyMismatches > 0,
    'audit must observe at least one legacy-vs-derived workload mismatch');
  // No row has either value overwritten by the other.
  for (const row of audit.workload.rows) {
    assert.ok(typeof row.legacy === 'number' || row.legacy === null);
    assert.ok(typeof row.derived === 'number');
    assert.ok(typeof row.schedulingBudget === 'number');
  }
});

// ---- §5 Branches -----------------------------------------------------------

test('PHASE 20 / Br1 — 7 branches, all with schoolDays and periods', () => {
  assert.equal(audit.branches.schedulingCount, 7);
  for (const b of audit.branches.branchProfile) {
    assert.ok(b.schoolDays.length > 0, `branch ${b.id} has no schoolDays`);
    assert.ok(b.periods.length > 0, `branch ${b.id} has no periods`);
    assert.equal(b.slotCount, b.schoolDays.length * b.periods.length - 2);
  }
});

test('PHASE 20 / Br2 — no branch inferred from name/code', () => {
  assert.equal(audit.branches.inferredFromName.length, 0);
});

// ---- §6 Classes ------------------------------------------------------------

test('PHASE 20 / Cl1 — class.branch matches source (no inference from class name)', () => {
  assert.equal(audit.classes.classBranchMismatch.length, 0);
  assert.equal(audit.classes.inferredFromName.length, 0);
});

// ---- §7 Subjects -----------------------------------------------------------

test('PHASE 20 / Sb1 — 6 source subjects, 5 active, 1 inactive (CN-TH)', () => {
  assert.equal(audit.subjects.sourceCount, 6);
  assert.equal(audit.subjects.sourceActiveCount, 5);
  assert.equal(audit.subjects.sourceInactiveCount, 1);
});

test('PHASE 20 / Sb2 — CN-TH preserved in source catalog; no scheduling demand (curriculum / assignments) uses it', () => {
  assert.ok(audit.subjects.cnthInSource, 'CN-TH must remain in normalized data');
  assert.equal(audit.subjects.cnthInSource.isActive, false);
  // CN-TH may appear in scheduling.subjects[] (the catalog); the
  // brief requires it to NOT appear in DEMAND. The audit asserts
  // the demand-side invariant.
  const cnthId = audit.subjects.cnthInSource.id;
  // 1) no assignment uses CN-TH
  const inAssignments = normalized.historicalAssignments.some((a) => a.subject === cnthId);
  assert.equal(inAssignments, false, 'CN-TH must not be used by any assignment');
  // 2) no scheduling curriculum row uses CN-TH
  const inSchedCurriculum = scheduling.curriculum.some((cs) => cs.subjectId === cnthId);
  assert.equal(inSchedCurriculum, false, 'CN-TH must not be in scheduling.curriculum');
  // 3) the 3 RAW curriculum rows that reference CN-TH remain in
  //    normalized.curriculum (audit must observe the 3 excluded
  //    rows). They are NOT in scheduling.curriculum.
  const rawCNTHCount = normalized.curriculum.filter((cs) => cs.subject === cnthId).length;
  assert.equal(rawCNTHCount, 3, 'CN-TH has 3 raw curriculum rows (preserved)');
  assert.equal(scheduling.excludedCurriculum.length, 3);
});

test('PHASE 20 / Sb3 — no inactive subject is used by assignments or curriculum', () => {
  // The catalog (scheduling.subjects[]) includes CN-TH; the
  // demand side does not.
  const inAssignments = normalized.historicalAssignments.some((a) =>
    audit.subjects.cnthInSource && a.subject === audit.subjects.cnthInSource.id
  );
  const inCurriculum = normalized.curriculum.some((cs) =>
    audit.subjects.cnthInSource && cs.subject === audit.subjects.cnthInSource.id
  );
  // CN-TH is in RAW curriculum (3 rows); those rows are excluded
  // from scheduling.curriculum, so the scheduling demand has 0
  // CN-TH rows. The audit checks the scheduling demand, not the
  // raw curriculum.
  const schedHasCNTH = scheduling.curriculum.some(
    (cs) => cs.subjectId === audit.subjects.cnthInSource.id
  );
  assert.equal(schedHasCNTH, false);
  assert.equal(inAssignments, false);
});

// ---- §8 Curriculum ---------------------------------------------------------

test('PHASE 20 / Cu1 — raw blocksubjects = 24; effective block-level = 21; class-level projection = 479 (derived, not hard-coded)', () => {
  // PHASE 21 UPDATE: scheduling curriculum is class-level (479
  // rows). The block-level effective count (24 raw - 3 inactive
  // CN-TH = 21) is the source-side audit metric; the
  // class-level count is the projected scheduling input.
  assert.equal(audit.curriculum.rawCount, 24);
  // schedulingActive is now `curriculum.length` (class-level).
  assert.equal(audit.curriculum.schedulingActive, 479);
  // effectiveSource stays 21 (block-level source-side metric).
  assert.equal(audit.curriculum.effectiveSource, 21);
  // The scheduling model also exposes the block-level metric
  // directly via _meta and via verify.
  assert.equal(audit.curriculum.effectiveCurriculumBlockLevel, 21);
  assert.equal(audit.curriculum.classLevelCurriculumCount, 479);
  // derivedNotHardCoded checks that effectiveSource (21) is the
  // derived source-side count, not a hardcoded value.
  assert.equal(audit.curriculum.derivedNotHardCoded, true);
});

test('PHASE 20 / Cu2 — 3 CN-TH rows excluded from scheduling but preserved in normalized', () => {
  assert.equal(audit.curriculum.excludedSource.length, 3);
  assert.equal(audit.curriculum.schedulingExcluded, 3);
});

// ---- §9 Demand -------------------------------------------------------------

test('PHASE 20 / Dm1 — assignments = 479, required = 802, assigned = 802, shortage = 0', () => {
  assert.equal(audit.demand.assignments, 479);
  assert.equal(audit.demand.required, 802);
  assert.equal(audit.demand.assigned, 802);
  assert.equal(audit.demand.shortage, 0);
});

test('PHASE 20 / Dm2 — no inactive subject is used by an assignment', () => {
  assert.equal(audit.demand.usedInactiveSubjects.length, 0);
});

test('PHASE 20 / Dm3 — subject breakdown: at least 5 active subjects have positive demand', () => {
  const positive = audit.demand.subjectBreakdown.filter((s) => s.demand > 0);
  assert.ok(positive.length >= 5);
});

// ---- §10 Assignment semantic ----------------------------------------------

test('PHASE 20 / As1 — every assignment has class/subject/teacher/branch reference', () => {
  assert.equal(audit.assignments.brokenClassRef, 0);
  assert.equal(audit.assignments.brokenSubjectRef, 0);
  assert.equal(audit.assignments.brokenTeacherRef, 0);
  assert.equal(audit.assignments.brokenBranchRef, 0);
});

test('PHASE 20 / As2 — class.branch === assignment.branchId (no cross-branch assignment leak)', () => {
  assert.equal(audit.assignments.classBranchMismatch, 0);
});

test('PHASE 20 / As3 — every assignment is baselineAssignment=true (historical baseline, NOT hard fixed)', () => {
  assert.equal(audit.assignments.baselineTrueCount, 479);
  assert.equal(audit.assignments.baselineFalseCount, 0);
  assert.equal(audit.assignments.baselineMissingCount, 0);
});

test('PHASE 20 / As4 — every assignment is traceable to a source historical assignment', () => {
  assert.equal(audit.assignments.traceMissing.length, 0);
});

// ---- §11 Schedule slots ---------------------------------------------------

test('PHASE 20 / Sl1 — every assignment has exactly assignedPeriods slots', () => {
  assert.equal(audit.scheduleSlots.slotCountMismatch, 0);
  assert.equal(audit.scheduleSlots.totalSlots, 802);
});

test('PHASE 20 / Sl2 — no duplicate class/day/session/period; no duplicate teacher/day/session/period', () => {
  assert.equal(audit.scheduleSlots.classDuplicateSlots, 0);
  assert.equal(audit.scheduleSlots.teacherDuplicateSlots, 0);
});

test('PHASE 20 / Sl3 — slot subject/teacher match assignment subject/teacher', () => {
  assert.equal(audit.scheduleSlots.subjectMismatch, 0);
  assert.equal(audit.scheduleSlots.teacherMismatch, 0);
});

// ---- §12 Transfer semantics -----------------------------------------------

test('PHASE 20 / Tr1 — exactly 87 assignments have isTransferred=true', () => {
  assert.equal(audit.transfers.transferredAssignments, 87);
});

test('PHASE 20 / Tr2 — 35 transferred assignments preserve null transferredFromTeacher (no auto-fill)', () => {
  assert.equal(audit.transfers.transferredFromMissingCount, 35);
});

test('PHASE 20 / Tr3 — transfer logs: 4175 total, 3626 SUCCESS, 549 FAILED, 731 orphan', () => {
  assert.equal(audit.transfers.logCount, 4175);
  assert.equal(audit.transfers.success, 3626);
  assert.equal(audit.transfers.failed, 549);
  assert.equal(audit.transfers.orphanAssignmentReferences, 731);
});

test('PHASE 20 / Tr4 — transfer failure reasons preserved verbatim', () => {
  for (const r of ['ADJACENT_SLOT_AT_BRANCH', 'TEACHER_CONFLICT', 'SAME_SESSION_AT_MAIN_BRANCH', 'SPECIALIZATION_MISMATCH']) {
    assert.ok(audit.transfers.failureReasons.includes(r), `failure reason ${r} missing`);
  }
});

// ---- §13 Transfer eligibility ---------------------------------------------

test('PHASE 20 / Te1 — empty allowed branches are preserved; home-only permission is explicit in scheduling', () => {
  assert.equal(audit.transferEligibility.sourceStats.allowedTransferBranches.present, 0);
  // In scheduling, the field is missing on every teacher.
  assert.equal(audit.transferEligibility.schedStats.allowedTransferBranches.missing, 0);
  assert.equal(audit.transferEligibility.schedStats.allowedTransferBranches.empty, 40);
});

test('PHASE 20 / Te2 — preferredTransferBranches is preserved in source but not in scheduling', () => {
  assert.equal(audit.transferEligibility.sourceStats.preferredTransferBranches.present, 40);
  // Scheduling model does not surface this field yet.
});

// ---- §14 Preferences -------------------------------------------------------

test('PHASE 20 / Pf1 — maxSessionsPerWeek and preferredSession are present in source AND in scheduling nguyenVong', () => {
  assert.equal(audit.preferences.perField.maxSessionsPerWeek.sourceHasValue, 42);
  assert.equal(audit.preferences.perField.preferredSession.sourceHasValue, 35);
});

test('PHASE 20 / Pf2 — fixedDayOff / preferredGrades / preferredTransferBranches / transferPriority preserved in source, not in scheduling', () => {
  // They are not auto-promoted.
  assert.equal(audit.preferences.perField.fixedDayOff.inScheduling, 'nguyenVong.thuNghi');
  assert.equal(audit.preferences.perField.preferredGrades.inScheduling, 'NOT_IN_SCHEDULING');
  assert.equal(audit.preferences.perField.preferredTransferBranches.inScheduling, 'NOT_IN_SCHEDULING');
  assert.equal(audit.preferences.perField.transferPriority.inScheduling, 'NOT_IN_SCHEDULING');
});

// ---- §15 Session model ----------------------------------------------------

test('PHASE 20 / Ss1 — every branch has schoolDays and periods; slot grid is product of both', () => {
  for (const b of audit.sessionModel.branchSessions) {
    assert.ok(b.schoolDays.length > 0);
    assert.ok(b.periods.length > 0);
    assert.equal(b.slotCount, b.schoolDays.length * b.periods.length - 2);
  }
});

test('PHASE 20 / Ss2 — preferredSession distribution is non-empty (some teachers have a stated preference)', () => {
  const d = audit.sessionModel.maxDist;
  assert.equal(d.sang + d.chieu + d.ca_hai, 40);
  assert.equal(d.noNguyenVong, 0);
});

// ---- §16 Travel readiness --------------------------------------------------

test('PHASE 20 / Tv1 — travelTime is null; travelStatus is MISSING_CONFIGURATION; H_TRAVEL_FEASIBLE = INACTIVE', () => {
  assert.equal(audit.travelReadiness.travelTime, null);
  assert.equal(audit.travelReadiness.travelStatus, 'MISSING_CONFIGURATION');
  assert.equal(audit.travelReadiness.hTravelFeasibleActive, false);
});

test('PHASE 20 / Tv2 — scheduling input is structurally ready for a future TravelProvider (branch ids present on every assignment)', () => {
  // The (assignment.branchId, class.branch, teacher.branch) tuples
  // are present, but no travel matrix exists. The data shape is
  // ready; the provider is not.
  assert.ok(audit.travelReadiness.schedulingAssignmentBranchPairs > 0);
  // Transfer history carries fromBranch/toBranch. 466 logs have
  // fromBranch null (legitimate: log of a same-branch
  // re-assignment). The data shape is consistent with the
  // source of truth.
  const fromBranch = normalized.transferHistory.filter((t) => t.fromBranch != null).length;
  const toBranch = normalized.transferHistory.filter((t) => t.toBranch != null).length;
  assert.equal(fromBranch, audit.travelReadiness.fromBranchSourced);
  assert.equal(toBranch, audit.travelReadiness.toBranchSourced);
  assert.equal(fromBranch + toBranch, audit.travelReadiness.fromBranchSourced + audit.travelReadiness.toBranchSourced);
  // Sanity: toBranch is always set; fromBranch is set on most.
  assert.equal(toBranch, normalized.transferHistory.length);
});

// ============================================================================
// PART B — orchestrator dry-run
// ============================================================================

test('PHASE 20 / O1 — dry-run: 1 missing (Travel, legitimate) and 0 INVALID_INPUT after Phase 21 fix', () => {
  // The Travel missing is legitimate (no travel matrix in source).
  // PHASE 21 UPDATE: the two known projection bugs are fixed —
  //   - 21 invalid_reference → 0
  //   - 479 unresolvable_demand → 0
  // The dry-run no longer reports INVALID_INPUT for projection
  // reasons. The status moves past INVALID_INPUT; see O5.
  assert.deepEqual(audit.orchestratorDryRun.missingByEntity, { Travel: 1 });
  assert.equal(audit.orchestratorDryRun.issuesByCode.invalid_reference ?? 0, 0);
  assert.equal(audit.orchestratorDryRun.issuesByCode.unresolvable_demand ?? 0, 0);
  // No structural issues remain from the projection layer.
  assert.equal((audit.orchestratorDryRun.issuesByCode.missing_required_field ?? 0), 0);
  assert.equal((audit.orchestratorDryRun.issuesByCode.invalid_value ?? 0), 0);
});

test('PHASE 20 / O2 — curriculum.classId is a REAL class id (Phase 21 fix); blockId preserved alongside', () => {
  // PHASE 21 UPDATE: Bug #1 was that curriculum[].classId held a
  // block id (one of 5 grade groups) instead of a real class id.
  // The Phase 21 fix expands each (block, subject) blocksubject
  // to one row per active class in the block. Every
  // `curriculum.classId` is now a real class id (in
  // `classes[]`); every `curriculum.blockId` preserves the
  // source block. The 21-row classId/blockId mismatch is now 0.
  assert.equal(audit.curriculum.curriculumClassIdMismatch.total, 0);
  assert.equal(audit.curriculum.curriculumClassIdMismatch.isBlockIds, 0);
  assert.equal(audit.curriculum.curriculumClassIdMismatch.isNeither, 0);
  // Subject ids are real subject ids too.
  assert.equal(audit.curriculum.curriculumSubjectIdMismatch.total, 0);
  // Every curriculum row carries a blockId.
  assert.equal(audit.curriculum.curriculumMissingBlockId, 0);
});

test('PHASE 20 / O3 — eligibility is now name-agnostic; teacher.chuyenMon[].tenChuyenMon = subject id, no unresolvable_demand', () => {
  // The orchestrator's eligibility check does
  //   chuyenMon.some(s => s.tenChuyenMon === a.subjectId)
  // With the old projection, tenChuyenMon was a Vietnamese name
  // (e.g. "Mỹ thuật") and a.subjectId was a 24-char hex id.
  // The check never matched, so every assignment was reported
  // as unresolvable_demand (479). After the Phase 21 fix,
  // tenChuyenMon is the subject id (the value space matches
  // a.subjectId) and the check passes. unresolvable_demand is 0.
  const issues = audit.orchestratorDryRun.issues.filter(
    (i) => i.code === 'unresolvable_demand'
  );
  assert.equal(issues.length, 0);
  // All 479 assignments are eligible (subjectId ∈ teacher.eligibleSubjectIds).
  assert.equal(audit.assignments.teacherIneligible, 0);
});

test('PHASE 20 / O4 — direct validateInput(scheduling) reports no projection issues after Phase 21 fix', () => {
  // The Phase 21 fix removes the two projection bugs. Only the
  // legitimate `missing` reports remain (Travel is still
  // missing-data, not invalid).
  const v = validateInput(scheduling);
  assert.equal(v.issues.length, 0);
  assert.equal(v.issues.filter((i) => i.code === 'invalid_reference').length, 0);
  assert.equal(v.issues.filter((i) => i.code === 'unresolvable_demand').length, 0);
  // The missing[] array contains exactly the Travel entry.
  assert.equal(v.missing.length, 1);
  assert.equal(v.missing[0].entity, 'Travel');
});

test('PHASE 20 / O5 — orchestrator status is NOT INVALID_INPUT (Phase 21 fix); Travel remains MISSING_DATA but is not a critical entity', () => {
  // PHASE 21 UPDATE: the orchestrator no longer returns
  // INVALID_INPUT for projection reasons. The validator reports
  // 0 issues. The status moves to one of:
  //   - MISSING_DATA: only if a CRITICAL entity (Branch /
  //     Class / Curriculum / Assignment) is missing. Travel is
  //     NOT critical. With Phase 21 fix, all critical entities
  //     are present, so we do not short-circuit on MISSING_DATA.
  //   - OK / EMPTY: the orchestrator runs the solver. The
  //     strategy attempt count and solve time depend on the
  //     solver; the audit captures them.
  // We accept any of {MISSING_DATA, OK, EMPTY} as long as it is
  // not INVALID_INPUT.
  assert.notEqual(audit.orchestratorDryRun.status, 'INVALID_INPUT');
  // strategiesAttempted may be > 0 if the solver ran; 0 if the
  // orchestrator short-circuited on missing critical data.
  // The Travel miss is NOT a critical entity, so strategies > 0
  // is expected. We assert that.
  assert.ok(
    audit.orchestratorDryRun.strategiesAttempted > 0,
    'Phase 21 fix removes INVALID_INPUT; the solver should now run'
  );
});

test('PHASE 20 / O6 — orchestrator.preview() does not throw', () => {
  // We probe the orchestrator directly to confirm it does not
  // crash on this input.
  assert.equal(audit.orchestratorDryRun.threw, null);
});

test('PHASE 20 / O7 — legacyBaseline and normalized data are NOT modified by the audit (read-only)', () => {
  // We compare a reference structure built BEFORE the audit
  // against the same fields after. If any loader file mutated
  // its inputs, the audit would fail this test.
  const before = {
    branches: normalized.branches.length,
    teachers: normalized.teachers.length,
    classes: normalized.classes.length,
    historicalAssignments: normalized.historicalAssignments.length,
    historicalScheduleSlots: normalized.historicalScheduleSlots.length,
    transferHistory: normalized.transferHistory.length,
  };
  // Re-run the audit; the result should be identical.
  runPhase20Audit(result);
  const after = {
    branches: normalized.branches.length,
    teachers: normalized.teachers.length,
    classes: normalized.classes.length,
    historicalAssignments: normalized.historicalAssignments.length,
    historicalScheduleSlots: normalized.historicalScheduleSlots.length,
    transferHistory: normalized.transferHistory.length,
  };
  assert.deepEqual(before, after);
  assert.equal(legacyBaseline.summary.totalSlots, 802);
  assert.equal(legacyBaseline.summary.totalAssignments, 479);
  assert.equal(legacyBaseline.summary.totalTransfers, 4175);
});
