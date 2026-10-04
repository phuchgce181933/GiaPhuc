// PHASE 26 — orphan analysis (read-only).
//
// Classifies the records in the historical transfer / assignment
// data that REFERENCE entities which are not in the current
// SchedulingInput. The classification is PURE: it does not delete,
// repair, or fabricate anything. The orphan rows are PRESERVED so
// downstream analytics can still see them.
//
// Three kinds of orphans are tracked:
//
//   1. ORPHAN_FROM_TEACHER     — transfer log's fromTeacher is not
//                                in the current teacher set.
//   2. ORPHAN_TO_TEACHER       — transfer log's toTeacher is not
//                                in the current teacher set.
//   3. ORPHAN_TRANSFERRED_ASSIGNMENT
//                             — baseline assignment is
//                                isTransferred=true and
//                                transferredFromTeacher is null.
//   4. ORPHAN_TRANSFER_ASSIGNMENT_REF
//                             — transfer log's assignment id is
//                                not in the current assignment set.
//
// The four counts are reported separately AND summed. The summed
// number is the "orphan transfer references" figure the audit
// surfaces to the user.

/**
 * Build a Set<teacherId> from a list of teacher records. The
 * helper handles missing data:
 *   - null / non-array → empty Set
 *   - records with id == null are silently skipped
 */
function teacherIdSetOf(teachers) {
  const out = new Set();
  if (!Array.isArray(teachers)) return out;
  for (const t of teachers) {
    if (t && t.id != null) out.add(t.id);
  }
  return out;
}

/**
 * Build a Set<assignmentId> from a list of assignment records.
 */
function assignmentIdSetOf(assignments) {
  const out = new Set();
  if (!Array.isArray(assignments)) return out;
  for (const a of assignments) {
    if (a && a.id != null) out.add(a.id);
  }
  return out;
}

/**
 * Analyse orphan transfer references. Returns a structured
 * report:
 *
 *   {
 *     orphanFromTeacher: number,        // log records with orphan fromTeacher
 *     orphanToTeacher: number,          // log records with orphan toTeacher
 *     orphanTransferLogIds: Set,        // unique log ids with ANY orphan teacher
 *     orphanTransferredAssignments: number,
 *     orphanTransferAssignmentRefs: number,  // log records with orphan assignment id
 *     orphanBranchFrom: number,         // log records with orphan fromBranch
 *     orphanBranchTo: number,           // log records with orphan toBranch
 *     totalOrphanReferences: number,    // sum of all categories
 *   }
 *
 * The classification is read-only. The orphan rows are NOT
 * removed from the input.
 */
export function analyzeOrphanReferences({ transferHistory, baselineAssignments, currentTeachers, currentBranches, currentAssignments }) {
  const teacherIds = teacherIdSetOf(currentTeachers);
  const branchIds = new Set(Array.isArray(currentBranches) ? currentBranches.filter((b) => b?.id != null).map((b) => b.id) : []);
  const assignmentIds = assignmentIdSetOf(currentAssignments);

  const orphanTransferLogIds = new Set();
  let orphanFromTeacher = 0;
  let orphanToTeacher = 0;
  let orphanBranchFrom = 0;
  let orphanBranchTo = 0;
  let orphanTransferAssignmentRefs = 0;

  if (Array.isArray(transferHistory)) {
    for (const t of transferHistory) {
      if (!t) continue;
      let any = false;
      if (t.fromTeacher != null && !teacherIds.has(t.fromTeacher)) {
        orphanFromTeacher++;
        any = true;
      }
      if (t.toTeacher != null && !teacherIds.has(t.toTeacher)) {
        orphanToTeacher++;
        any = true;
      }
      if (t.fromBranch != null && branchIds.size > 0 && !branchIds.has(t.fromBranch)) {
        orphanBranchFrom++;
        any = true;
      }
      if (t.toBranch != null && branchIds.size > 0 && !branchIds.has(t.toBranch)) {
        orphanBranchTo++;
        any = true;
      }
      if (t.assignment != null && assignmentIds.size > 0 && !assignmentIds.has(t.assignment)) {
        orphanTransferAssignmentRefs++;
        any = true;
      }
      if (any) orphanTransferLogIds.add(t.id);
    }
  }

  // Orphan transferred assignments: isTransferred=true AND
  // transferredFromTeacher is null.
  let orphanTransferredAssignments = 0;
  if (Array.isArray(baselineAssignments)) {
    for (const a of baselineAssignments) {
      if (!a || a.isTransferred !== true) continue;
      if (a.transferredFromTeacher == null) orphanTransferredAssignments++;
    }
  }

  const totalOrphanReferences =
    orphanFromTeacher
    + orphanToTeacher
    + orphanTransferredAssignments
    + orphanTransferAssignmentRefs
    + orphanBranchFrom
    + orphanBranchTo;

  return {
    orphanFromTeacher,
    orphanToTeacher,
    orphanTransferLogIds,
    orphanTransferredAssignments,
    orphanTransferAssignmentRefs,
    orphanBranchFrom,
    orphanBranchTo,
    totalOrphanReferences,
  };
}
