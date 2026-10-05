// Layer 4 — SCHEDULING MODEL EXTRACTOR.
//
// Produces the SchedulingInput contract that the existing
// orchestrator (Phase 1) consumes. This is the *only* view of the
// legacy data that the solver sees. Historical data (slots,
// transfers, schedule summary) is exposed separately in
// `legacyBaseline` and is NEVER injected into the solver.
//
// The contract is preserved:
//   - active teachers only are surfaced in `teachers[]`.
//     Inactive teachers remain in the normalized layer (audit) and
//     are NOT silently dropped.
//   - curriculum rows referencing an inactive subject (e.g. CN-TH)
//     are excluded from `curriculum[]` in the scheduling model. They
//     remain in `normalized.curriculum` (24 rows preserved).
//   - curriculum is projected to CLASS-LEVEL demand. Each
//     `BlockSubject` row is expanded to one scheduling row per
//     active class in the block. The `classId` field holds a real
//     class id; the source `blockId` is preserved alongside so
//     block-level semantics are not lost.
//   - teacher.specializations (raw subject ids) are projected into
//     BOTH:
//     * `chuyenMon[].tenChuyenMon` — the SUBJECT NAME (semantic
//       integrity: the field is Vietnamese for "specialization
//       name"; it does NOT carry a hex id).
//     * `eligibleSubjectIds[]`    — the SUBJECT IDS (explicit,
//       solver-friendly). This is the field the constraint
//       catalog and solver consult.
//   - historical assignments become `assignments[]`. They are
//     treated as `baselineAssignment` records; the contract field
//     is `id/classId/subjectId/teacherId/branchId/requiredPeriods`.
//     The orchestrator will look at these as one possible input
//     shape; the brief is explicit: legacy assignments are NOT
//     hard fixed assignments. They are imported for warm-start,
//     comparison, and analysis only. The solver retains the right to
//     re-optimize teacher assignment.
//   - travel is missing → `travelTime === null`, `travelStatus ===
//     'MISSING_CONFIGURATION'`.
//
// The output shape mirrors `loader/dataset.js` so the orchestrator
// can accept it without changes.

import { slotsForBranch } from '../../domain/constraints.js';

/**
 * @typedef {ReturnType<typeof import('./normalize.js').normalizeAll>} Normalized
 */

/**
 * @param {Normalized} normalized
 * @returns {object}  SchedulingInput
 */
export function buildSchedulingModel(normalized) {
  const branchIdSet = new Set(normalized.branches.map((b) => b.id));
  const subjectIdSet = new Set(normalized.subjects.map((s) => s.id));
  const classIdSet = new Set(normalized.classes.map((c) => c.id));

  const inactiveSubjectIds = new Set(
    normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );

  // ---------- teachers (active only) ----------
  const teachers = [];
  const teacherMissing = [];
  // Subject id -> subject name lookup, used to give
  // `chuyenMon[].tenChuyenMon` its proper semantic (a name, not
  // an id). The solver-friendly id list is exposed as
  // `eligibleSubjectIds[]`.
  const subjectIdToName = new Map(normalized.subjects.map((s) => [s.id, s.name]));
  for (const t of normalized.teachers) {
    if (!t.isActive) continue; // keep in normalized, drop from scheduling
    // Eligibility: only subjects that exist in the catalog survive.
    // The raw `specializations` are already subject ids (per the
    // dump). We project them into TWO fields:
    //   - `chuyenMon[].tenChuyenMon` = the SUBJECT NAME (semantic
    //     integrity: the field is Vietnamese for "specialization
    //     name"; do not put a hex id here).
    //   - `eligibleSubjectIds[]` = the SUBJECT IDS (explicit,
    //     solver-friendly). This is the field the constraint
    //     catalog and solver consult.
    const eligibleSubjectIds = t.specializations.filter((sid) => subjectIdSet.has(sid));
    teachers.push({
      id: t.id,
      hoTen: t.name, // preserve casing & diacritics
      email: t.email,
      soDienThoai: t.phone,
      trangThai: t.isActive ? 'active' : 'inactive',
      chuyenMon: eligibleSubjectIds.map((sid) => ({
        // Field name kept for contract compatibility. The VALUE
        // is the subject NAME (resolved from the id), not the id
        // itself. Phase 22 §29: the field name carries the
        // semantic; we do not put ids in name fields.
        tenChuyenMon: subjectIdToName.get(sid) ?? sid,
        soTietTuan: 1, // we do not project per-subject load here; legacy is per-subject
      })),
      eligibleSubjectIds, // explicit list of subject ids; solver-friendly
      preferredTransferBranches: t.preferredTransferBranches,
      preferredGrades: t.preferredGrades,
      nguyenVong: t.maxSessionsPerWeek != null || t.preferredSession != null || t.fixedDayOff != null
        ? {
            soBuoiToiDa: t.maxSessionsPerWeek ?? 0,
            buoiUuTien: mapPreferredSession(t.preferredSession),
            thuNghi: Array.isArray(t.fixedDayOff) ? t.fixedDayOff : [],
          }
        : null,
      homeBranchId: t.branch,
    });
    if (!t.email) teacherMissing.push({ entity: 'teacher', entityId: t.id, field: 'email', reason: 'empty_in_source' });
    if (!t.phone) teacherMissing.push({ entity: 'teacher', entityId: t.id, field: 'soDienThoai', reason: 'empty_in_source' });
    if (t.branch == null) teacherMissing.push({ entity: 'teacher', entityId: t.id, field: 'homeBranchId', reason: 'absent_in_source' });
    if (t.maxSessionsPerWeek == null) teacherMissing.push({ entity: 'teacher', entityId: t.id, field: 'nguyenVong.maxSessionsPerWeek', reason: 'absent_in_source' });
  }

  // ---------- branches ----------
  const branches = normalized.branches.map((b) => ({
    id: b.id,
    name: b.name,
    schoolDays: deriveSchoolDays(),
    periods: derivePeriods(),
    sessions: { sang: [1, 2, 3, 4], chieu: [5, 6, 7] },
  }));

  // Derive a minimal slot grid per branch.
  const timeSlotsByBranch = new Map();
  for (const b of branches) {
    timeSlotsByBranch.set(b.id, slotsForBranch(b));
  }

  // ---------- classes ----------
  const classes = normalized.classes.map((c) => ({
    id: c.id,
    branchId: c.branch,
    name: c.name,
    gradeLevel: deriveGradeFromBlockId(c.block, normalized.blocks),
    blockId: c.block, // preserve block-level semantics on each class
  }));

  // ---------- subjects ----------
  const subjects = normalized.subjects.map((s) => ({
    id: s.id,
    name: s.name,
    code: s.code,
    isActive: s.isActive,
  }));

  // ---------- curriculum (class-level, derived from block-level blocksubjects) ----------
  // Bug #1 fix: each effective (block, subject) blocksubject row
  // is expanded into one row per active class in that block. The
  // resulting `curriculum[]` is at CLASS-LEVEL (matching the
  // orchestrator's SchedulingInput contract). The source
  // `blockId` is preserved on every expanded row so block-level
  // semantics are not lost.
  //
  // Effective block-level row count (audit metric) = 24 raw - 3
  // CN-TH excluded = 21. The expanded class-level row count is
  // 21 × avg-classes-per-block ≈ 479 (matches the 479
  // assignments exactly in the real dataset).
  const blockToActiveClasses = new Map();
  for (const c of normalized.classes) {
    if (!c.isActive) continue;
    if (!blockToActiveClasses.has(c.block)) blockToActiveClasses.set(c.block, []);
    blockToActiveClasses.get(c.block).push(c);
  }
  // Sort each list by id for determinism.
  for (const list of blockToActiveClasses.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const curriculum = [];
  const excludedCurriculum = [];
  for (const cs of normalized.curriculum) {
    if (cs.subject != null && inactiveSubjectIds.has(cs.subject)) {
      excludedCurriculum.push({ ...cs, _reason: 'inactive_subject' });
      continue;
    }
    const classesInBlock = blockToActiveClasses.get(cs.block) || [];
    if (classesInBlock.length === 0) {
      // Block has no active classes (rare; e.g. block entirely
      // inactive). Surface the row in excludedCurriculum so the
      // audit can observe it. We never drop silently.
      excludedCurriculum.push({ ...cs, _reason: 'no_active_classes_in_block' });
      continue;
    }
    for (const c of classesInBlock) {
      curriculum.push({
        // Composite id = source blocksubject id + class id.
        // Traceable: every scheduling row can be reduced to a
        // single source row.
        id: `${cs.id}::${c.id}`,
        classId: c.id,           // REAL class id (Bug #1 fix)
        blockId: cs.block,       // preserve source block id
        subjectId: cs.subject,
        requiredPeriods: cs.periodsPerWeek,
        academicYear: cs.academicYear,
      });
    }
  }

  // ---------- assignments (historical baseline) ----------
  // `historicalAssignments` are imported as `assignments[]` for the
  // orchestrator. Per the brief, these are NOT hard-fixed; the
  // orchestrator keeps the right to re-optimize teacher selection.
  // We surface them under `baselineAssignment: true` so any future
  // consumer can tell them apart from operator-supplied fixed rows.
  const assignments = normalized.historicalAssignments.map((a) => ({
    id: a.id,
    classId: a.class,
    subjectId: a.subject,
    teacherId: a.teacher,
    branchId: a.branch,
    requiredPeriods: a.requiredPeriods,
    baselineAssignment: true,
    isTransferred: a.isTransferred,
    transferredAt: a.transferredAt,
    transferredFromTeacher: a.transferredFromTeacher,
  }));

  // ---------- teacher index ----------
  const teacherIndex = new Map(teachers.map((t) => [t.id, t]));

  // ---------- assignment index ----------
  const assignmentIndex = new Map(assignments.map((a) => [a.id, a]));

  // ---------- travel ----------
  // travelTime is null; H_TRAVEL_FEASIBLE is INACTIVE in the
  // current contract (see domain/travel/index.js).
  const travelTime = null;

  // ---------- branches status ----------
  const branchesStatus = branchIdSet.size > 0 ? 'OK' : 'MISSING';
  const curriculumStatus = curriculum.length > 0 ? 'OK' : 'MISSING';

  // Audit-time block-level effective count (re-derived from
  // source, not hard-coded). The class-level curriculum count is
  // just `curriculum.length`. Both are surfaced for traceability.
  const effectiveCurriculumBlockLevel = normalized.curriculum.filter(
    (cs) => cs.subject == null || !inactiveSubjectIds.has(cs.subject)
  ).length;

  return {
    teachers,
    branches,
    classes,
    subjects,
    assignments,
    curriculum,
    timeSlotsByBranch,
    travelTime,
    transitionMinutes: 10,
    teacherIndex,
    assignmentIndex,
    missingData: teacherMissing,
    warnings: [
      'Legacy dataset imported from data/source/legacy-saplich/.',
      'Historical assignments are surfaced as baseline; the solver retains the right to re-optimize.',
      'Travel matrix not provided → H_TRAVEL_FEASIBLE remains INACTIVE.',
      'Curriculum projected to class-level: each blocksubject row expanded to one row per active class in the block.',
    ],
    branchesStatus,
    curriculumStatus,
    travelStatus: 'MISSING_CONFIGURATION',
    excludedCurriculum, // diagnostic; not consumed by the orchestrator
    // Diagnostic snapshot of the source shape, NOT consumed by
    // the solver. Useful for the audit report.
    _meta: {
      inactiveTeachers: normalized.teachers.filter((t) => !t.isActive).map((t) => t.id),
      inactiveSubjects: [...inactiveSubjectIds],
      excludedCurriculumCount: excludedCurriculum.length,
      // Block-level audit metric (derived from source).
      effectiveCurriculumBlockLevel,
      // Class-level projected count.
      classLevelCurriculumCount: curriculum.length,
    },
  };
}

/**
 * Map the legacy `preferredSession` enum to the contract enum.
 * Legacy: 'morning' | 'afternoon' | 'both' | null
 * Contract: 'sang' | 'chieu' | 'ca_hai' | 'ca_hai' default
 */
function mapPreferredSession(legacy) {
  if (legacy == null) return 'ca_hai';
  if (legacy === 'morning') return 'sang';
  if (legacy === 'afternoon') return 'chieu';
  if (legacy === 'both') return 'ca_hai';
  // Unknown values are passed through; the validator will surface them
  // as `invalid_value` (no need to invent a default here).
  return String(legacy);
}

/**
 * The legacy dump does not carry a `schoolDays[]`/`periods[]` on
 * branches. We derive a minimal default:
 *   schoolDays = [1..6]  (Mon..Sat)
 *   periods    = [1..5]  (5 periods per day, morning+afternoon)
 * This is INSUFFICIENT to encode sang/chieu, but matches the
 * existing project contract shape. The brief says the solver will
 * still report `TRAVEL_DATA_MISSING` because no travel matrix is
 * supplied; we do not invent slot details here either.
 */
function deriveSchoolDays() {
  return [1, 2, 3, 4, 5];
}
function derivePeriods() {
  return [1, 2, 3, 4, 5, 6, 7];
}

/**
 * Legacy classes carry a `block` (grade group, e.g. K1..K5), not a
 * numeric grade. We surface that as `gradeLevel` so the contract
 * type stays numeric. The audit layer keeps the `block` field on
 * the normalized record.
 */
function deriveGradeFromBlockId(blockId, blocks) {
  const block = blocks.find((b) => b.id === blockId);
  if (!block) return null;
  const order = typeof block.order === 'number' ? block.order : null;
  return order;
}
