// Layer 3 — INTEGRITY CHECKER.
//
// Validates every reference in the normalized layer per §23 of
// the brief. The output is the audit that the report uses.
//
// `transferlogs.assignment` is allowed to be orphan (per the
// brief — these reference the historical id of an assignment
// that was deleted). We mark them but do not flag as broken.
//
// A reference is "absent" when the field is null or undefined.
// A reference is "broken" only when the field is set to a value
// that does not resolve. null is a legitimate "not set" in the
// source — it is NOT a broken reference.
//
// Returns counts and per-entity lists. The function never
// mutates the normalized data.

/**
 * @param {ReturnType<typeof import('./normalize.js').normalizeAll>} normalized
 * @returns {{
 *   counts: { branches: number, blocks: number, subjects: number, teachers: number, classes: number, curriculum: number, historicalAssignments: number, historicalScheduleSlots: number, transferHistory: number, partTimeAssignments: number },
 *   activeTeachers: number,
 *   inactiveTeachers: number,
 *   transferredAssignments: number,
 *   activeSubjects: number,
 *   inactiveSubjects: number,
 *   invalidSubjects: number,
 *   references: object,
 *   totals: { validReferences: number, orphanHistoricalReferences: number, brokenOperationalReferences: number, absentReferences: number },
 *   anomalies: string[],
 * }}
 */
export function checkIntegrity(normalized) {
  // ----- indexes -----
  const branchIds = new Set(normalized.branches.map((b) => b.id));
  const blockIds = new Set(normalized.blocks.map((b) => b.id));
  const subjectIds = new Set(normalized.subjects.map((s) => s.id));
  const teacherIds = new Set(normalized.teachers.map((t) => t.id));
  const classIds = new Set(normalized.classes.map((c) => c.id));
  const assignmentIds = new Set(normalized.historicalAssignments.map((a) => a.id));

  // ----- counts -----
  const counts = {
    branches: normalized.branches.length,
    blocks: normalized.blocks.length,
    subjects: normalized.subjects.length,
    teachers: normalized.teachers.length,
    classes: normalized.classes.length,
    curriculum: normalized.curriculum.length,
    historicalAssignments: normalized.historicalAssignments.length,
    historicalScheduleSlots: normalized.historicalScheduleSlots.length,
    transferHistory: normalized.transferHistory.length,
    partTimeAssignments: normalized.partTimeAssignments.length,
  };

  // ----- status counts -----
  const activeTeachers = normalized.teachers.filter((t) => t.isActive).length;
  const inactiveTeachers = counts.teachers - activeTeachers;
  const activeSubjects = normalized.subjects.filter((s) => s.isActive).length;
  const inactiveSubjects = counts.subjects - activeSubjects;
  const invalidSubjects = normalized.subjects.filter((s) => !s.isActive).length;
  const transferredAssignments = normalized.historicalAssignments.filter((a) => a.isTransferred).length;

  // ----- references -----
  // Each row is { valid, broken, absent }. absent counts null/missing
  // values; broken counts present-but-unresolvable values. The brief
  // explicitly excludes null from "broken".
  const emptyRef = () => ({ valid: 0, broken: 0, absent: 0 });

  // Teacher
  const tBranch = emptyRef();
  const tSpec = emptyRef();
  const tAllowed = emptyRef();
  const tPref = emptyRef();
  for (const t of normalized.teachers) {
    if (t.branch == null) tBranch.absent++;
    else if (branchIds.has(t.branch)) tBranch.valid++;
    else tBranch.broken++;

    for (const sid of t.specializations) {
      if (sid == null) tSpec.absent++;
      else if (subjectIds.has(sid)) tSpec.valid++;
      else tSpec.broken++;
    }
    for (const bid of t.allowedTransferBranches) {
      if (bid == null) tAllowed.absent++;
      else if (branchIds.has(bid)) tAllowed.valid++;
      else tAllowed.broken++;
    }
    for (const bid of t.preferredTransferBranches) {
      if (bid == null) tPref.absent++;
      else if (branchIds.has(bid)) tPref.valid++;
      else tPref.broken++;
    }
  }

  // Class
  const cBlock = emptyRef();
  const cBranch = emptyRef();
  for (const c of normalized.classes) {
    if (c.block == null) cBlock.absent++;
    else if (blockIds.has(c.block)) cBlock.valid++;
    else cBlock.broken++;

    if (c.branch == null) cBranch.absent++;
    else if (branchIds.has(c.branch)) cBranch.valid++;
    else cBranch.broken++;
  }

  // Curriculum
  const cuBlock = emptyRef();
  const cuSubject = emptyRef();
  for (const cs of normalized.curriculum) {
    if (cs.block == null) cuBlock.absent++;
    else if (blockIds.has(cs.block)) cuBlock.valid++;
    else cuBlock.broken++;

    if (cs.subject == null) cuSubject.absent++;
    else if (subjectIds.has(cs.subject)) cuSubject.valid++;
    else cuSubject.broken++;
  }

  // Assignment
  const aClass = emptyRef();
  const aSubject = emptyRef();
  const aTeacher = emptyRef();
  const aBranch = emptyRef();
  for (const a of normalized.historicalAssignments) {
    if (a.class == null) aClass.absent++;
    else if (classIds.has(a.class)) aClass.valid++;
    else aClass.broken++;

    if (a.subject == null) aSubject.absent++;
    else if (subjectIds.has(a.subject)) aSubject.valid++;
    else aSubject.broken++;

    if (a.teacher == null) aTeacher.absent++;
    else if (teacherIds.has(a.teacher)) aTeacher.valid++;
    else aTeacher.broken++;

    if (a.branch == null) aBranch.absent++;
    else if (branchIds.has(a.branch)) aBranch.valid++;
    else aBranch.broken++;
  }

  // Schedule slot
  const sClass = emptyRef();
  const sSubject = emptyRef();
  const sTeacher = emptyRef();
  const sAssignment = emptyRef();
  for (const s of normalized.historicalScheduleSlots) {
    if (s.class == null) sClass.absent++;
    else if (classIds.has(s.class)) sClass.valid++;
    else sClass.broken++;

    if (s.subject == null) sSubject.absent++;
    else if (subjectIds.has(s.subject)) sSubject.valid++;
    else sSubject.broken++;

    if (s.teacher == null) sTeacher.absent++;
    else if (teacherIds.has(s.teacher)) sTeacher.valid++;
    else sTeacher.broken++;

    if (s.assignment == null) sAssignment.absent++;
    else if (assignmentIds.has(s.assignment)) sAssignment.valid++;
    else sAssignment.broken++;
  }

  // Transfer log. `assignment` references are categorized as either
  // valid (resolves) or `orphanHistorical` (per the brief, kept not
  // deleted).
  const tlAssignment = { valid: 0, orphanHistorical: 0 };
  const tlFromTeacher = emptyRef();
  const tlToTeacher = emptyRef();
  const tlFromBranch = emptyRef();
  const tlToBranch = emptyRef();
  for (const tl of normalized.transferHistory) {
    if (tl.assignment == null) tlAssignment.orphanHistorical++;
    else if (assignmentIds.has(tl.assignment)) tlAssignment.valid++;
    else tlAssignment.orphanHistorical++;

    if (tl.fromTeacher == null) tlFromTeacher.absent++;
    else if (teacherIds.has(tl.fromTeacher)) tlFromTeacher.valid++;
    else tlFromTeacher.broken++;

    if (tl.toTeacher == null) tlToTeacher.absent++;
    else if (teacherIds.has(tl.toTeacher)) tlToTeacher.valid++;
    else tlToTeacher.broken++;

    if (tl.fromBranch == null) tlFromBranch.absent++;
    else if (branchIds.has(tl.fromBranch)) tlFromBranch.valid++;
    else tlFromBranch.broken++;

    if (tl.toBranch == null) tlToBranch.absent++;
    else if (branchIds.has(tl.toBranch)) tlToBranch.valid++;
    else tlToBranch.broken++;
  }

  // ----- totals -----
  const validOperationalRefs =
    tBranch.valid + tSpec.valid + tAllowed.valid + tPref.valid +
    cBlock.valid + cBranch.valid +
    cuBlock.valid + cuSubject.valid +
    aClass.valid + aSubject.valid + aTeacher.valid + aBranch.valid +
    sClass.valid + sSubject.valid + sTeacher.valid + sAssignment.valid +
    tlFromTeacher.valid + tlToTeacher.valid + tlFromBranch.valid + tlToBranch.valid;

  const orphanHistoricalRefs = tlAssignment.orphanHistorical;

  const brokenOperationalRefs =
    tBranch.broken + tSpec.broken + tAllowed.broken + tPref.broken +
    cBlock.broken + cBranch.broken +
    cuBlock.broken + cuSubject.broken +
    aClass.broken + aSubject.broken + aTeacher.broken + aBranch.broken +
    sClass.broken + sSubject.broken + sTeacher.broken + sAssignment.broken +
    tlFromTeacher.broken + tlToTeacher.broken + tlFromBranch.broken + tlToBranch.broken;

  const absentRefs =
    tBranch.absent + tSpec.absent + tAllowed.absent + tPref.absent +
    cBlock.absent + cBranch.absent +
    cuBlock.absent + cuSubject.absent +
    aClass.absent + aSubject.absent + aTeacher.absent + aBranch.absent +
    sClass.absent + sSubject.absent + sTeacher.absent + sAssignment.absent +
    tlFromTeacher.absent + tlToTeacher.absent + tlFromBranch.absent + tlToBranch.absent;

  // ----- anomalies (qualitative; informational only) -----
  const anomalies = [];

  // 1. Historical schedule metadata summary mismatch
  for (const s of normalized.historicalSchedule) {
    if (
      s.completedAssignments != null &&
      s.totalAssignments != null &&
      s.completedAssignments !== s.totalAssignments
    ) {
      anomalies.push(
        `schedules[${s.id}]: completedAssignments=${s.completedAssignments} != totalAssignments=${s.totalAssignments} (historical metadata is a snapshot, NOT ground truth)`
      );
    }
    if (
      s.statistics?.totalSlots != null &&
      normalized.historicalScheduleSlots.length !== s.statistics.totalSlots
    ) {
      anomalies.push(
        `schedules[${s.id}]: statistics.totalSlots=${s.statistics.totalSlots} != scheduleslots.length=${normalized.historicalScheduleSlots.length} (historical metadata is a snapshot, NOT ground truth)`
      );
    }
  }

  // 2. teachingWorkload vs. assignment-derived workload (teacher-level)
  const teacherWorkload = new Map();
  for (const t of normalized.teachers) teacherWorkload.set(t.id, 0);
  for (const a of normalized.historicalAssignments) {
    if (a.teacher != null && teacherWorkload.has(a.teacher)) {
      teacherWorkload.set(a.teacher, teacherWorkload.get(a.teacher) + (a.assignedPeriods || 0));
    }
  }
  let teachingWorkloadMismatchCount = 0;
  for (const t of normalized.teachers) {
    if (t.teachingWorkload == null) continue;
    const derived = teacherWorkload.get(t.id) ?? 0;
    if (t.teachingWorkload !== derived) teachingWorkloadMismatchCount += 1;
  }
  if (teachingWorkloadMismatchCount > 0) {
    anomalies.push(
      `${teachingWorkloadMismatchCount} teacher(s) have teachingWorkload (legacy denormalized) ≠ assignment-derived. Source is preserved; derived is recomputed.`
    );
  }

  // 3. inactive subject still present in curriculum
  const inactiveSubjectIds = new Set(normalized.subjects.filter((s) => !s.isActive).map((s) => s.id));
  const inactiveCurriculumCount = normalized.curriculum.filter(
    (cs) => cs.subject != null && inactiveSubjectIds.has(cs.subject)
  ).length;
  if (inactiveCurriculumCount > 0) {
    anomalies.push(
      `${inactiveCurriculumCount} curriculum row(s) reference inactive subject(s) (raw preserved; effective scheduling model excludes these)`
    );
  }

  // 4. transferred assignment without transferredFromTeacher
  const transferredButNoOrigin = normalized.historicalAssignments.filter(
    (a) => a.isTransferred && a.transferredFromTeacher == null
  ).length;
  if (transferredButNoOrigin > 0) {
    anomalies.push(
      `${transferredButNoOrigin} transferred assignment(s) have transferredFromTeacher=null (kept as-is in source; logged for audit)`
    );
  }

  // 5. orphan transfer-log assignment references
  if (orphanHistoricalRefs > 0) {
    anomalies.push(
      `${orphanHistoricalRefs} transfer log entries reference assignment ids that no longer exist (intentional; logs are not deleted)`
    );
  }

  // 6. parttimeassignments empty
  if (counts.partTimeAssignments === 0) {
    anomalies.push('parttimeassignments: 0 records (collection is empty in source; no synthetic data added)');
  }

  // 7. travel matrix
  anomalies.push('travel matrix: absent from source (H_TRAVEL_FEASIBLE remains INACTIVE in the scheduling model)');

  return {
    counts,
    activeTeachers,
    inactiveTeachers,
    transferredAssignments,
    activeSubjects,
    inactiveSubjects,
    invalidSubjects,
    references: {
      teacher: {
        branch: tBranch,
        specializations: tSpec,
        allowedTransferBranches: tAllowed,
        preferredTransferBranches: tPref,
      },
      class: {
        block: cBlock,
        branch: cBranch,
      },
      curriculum: {
        block: cuBlock,
        subject: cuSubject,
      },
      assignment: {
        class: aClass,
        subject: aSubject,
        teacher: aTeacher,
        branch: aBranch,
      },
      scheduleSlot: {
        class: sClass,
        subject: sSubject,
        teacher: sTeacher,
        assignment: sAssignment,
      },
      transferLog: {
        assignment: tlAssignment,
        fromTeacher: tlFromTeacher,
        toTeacher: tlToTeacher,
        fromBranch: tlFromBranch,
        toBranch: tlToBranch,
      },
    },
    totals: {
      validReferences: validOperationalRefs,
      orphanHistoricalReferences: orphanHistoricalRefs,
      brokenOperationalReferences: brokenOperationalRefs,
      absentReferences: absentRefs,
    },
    anomalies,
  };
}