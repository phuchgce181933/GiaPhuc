// Pre-scheduler input validator.
//
// Returns TWO reports:
// - `issues`: structural problems the source data has — surfacing
//   these is INVALID_INPUT. Includes broken references, missing
//   required fields where the field is supposed to be present.
// - `missing`: legitimate absences of optional data — these are
//   MISSING_DATA, not INVALID_INPUT. The orchestrator decides what
//   to do based on which critical entities (Branch / Class /
//   Curriculum / Assignment / Travel) are missing.
//
// Pure. No I/O.

/**
 * @typedef {{
 *   code: 'missing_required_field'|'invalid_reference'|'invalid_value'|'unresolvable_demand',
 *   entity: 'teacher'|'class'|'subject'|'branch'|'curriculum'|'assignment'|'travel'|'input',
 *   entityId?: string,
 *   field?: string,
 *   detail: string,
 * }} ValidationIssue
 */

/**
 * @param {object} model
 * @returns {{ issues: ValidationIssue[], missing: { entity: string, reason: string }[] }}
 */
import { curriculumCoverage } from './assignment.js';
import { sessionForSlot } from './time.js';

export function validateInput(model) {
  const issues = [];
  const missing = [];

  // 1. Teachers.
  const teacherIds = new Set();
  for (const t of model.teachers ?? []) {
    if (!t.id) {
      issues.push({ code: 'missing_required_field', entity: 'teacher', field: 'id', detail: 'teacher is missing id' });
      continue;
    }
    if (teacherIds.has(t.id)) {
      issues.push({ code: 'invalid_value', entity: 'teacher', entityId: t.id, field: 'id', detail: `duplicate teacher id ${t.id}` });
    }
    teacherIds.add(t.id);
    if (t.capacityPeriodsPerWeek != null && (!Number.isInteger(t.capacityPeriodsPerWeek) || t.capacityPeriodsPerWeek < 0)) {
      issues.push({ code: 'invalid_value', entity: 'teacher', entityId: t.id, field: 'capacityPeriodsPerWeek', detail: 'Weekly capacity must be a non-negative integer or null (unknown).' });
    }
    if (!t.hoTen) {
      issues.push({ code: 'missing_required_field', entity: 'teacher', entityId: t.id, field: 'hoTen', detail: `teacher ${t.id} missing hoTen` });
    }
    if (!Array.isArray(t.chuyenMon) || t.chuyenMon.length === 0) {
      issues.push({ code: 'missing_required_field', entity: 'teacher', entityId: t.id, field: 'chuyenMon', detail: `teacher ${t.id} (${t.hoTen}) has no specializations` });
    }
  }

  // 2. Branches.
  const branchIds = new Set();
  if (!Array.isArray(model.branches) || model.branches.length === 0) {
    missing.push({ entity: 'Branch', reason: 'No authoritative branch data' });
  }
  for (const b of model.branches ?? []) {
    if (!b.id) {
      issues.push({ code: 'missing_required_field', entity: 'branch', field: 'id', detail: 'branch is missing id' });
      continue;
    }
    branchIds.add(b.id);
    if (!Array.isArray(b.schoolDays) || b.schoolDays.length === 0) {
      issues.push({ code: 'missing_required_field', entity: 'branch', entityId: b.id, field: 'schoolDays', detail: `branch ${b.id} has no schoolDays` });
    }
    if (!Array.isArray(b.periods) || b.periods.length === 0) {
      issues.push({ code: 'missing_required_field', entity: 'branch', entityId: b.id, field: 'periods', detail: `branch ${b.id} has no periods` });
    }
    if (b.schoolDays?.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) issues.push({ code: 'invalid_value', entity: 'branch', entityId: b.id, field: 'schoolDays', detail: 'School days must be integer weekday numbers.' });
    if (b.periods?.some((period) => !Number.isInteger(period) || period < 1 || !sessionForSlot({ period }, b))) {
      issues.push({ code: 'invalid_value', entity: 'branch', entityId: b.id, field: 'periods', detail: 'Periods must be positive integers with one calendar session; period 5 is afternoon.' });
    }
  }

  // 3. Classes.
  if (!Array.isArray(model.classes) || model.classes.length === 0) {
    missing.push({ entity: 'Class', reason: 'No authoritative class data' });
  }
  const classIds = new Set();
  for (const c of model.classes ?? []) {
    if (!c.id) {
      issues.push({ code: 'missing_required_field', entity: 'class', field: 'id', detail: 'class is missing id' });
      continue;
    }
    classIds.add(c.id);
    if (!c.branchId) {
      issues.push({ code: 'missing_required_field', entity: 'class', entityId: c.id, field: 'branchId', detail: `class ${c.id} missing branchId` });
    } else if (!branchIds.has(c.branchId)) {
      issues.push({ code: 'invalid_reference', entity: 'class', entityId: c.id, field: 'branchId', detail: `class ${c.id} references unknown branch ${c.branchId}` });
    }
  }

  // 4. Subjects.
  const subjectIds = new Set();
  for (const s of model.subjects ?? []) {
    if (!s.name && !s.id) {
      issues.push({ code: 'missing_required_field', entity: 'subject', field: 'name', detail: 'subject is missing name and id' });
      continue;
    }
    const id = s.id ?? s.name;
    if (subjectIds.has(id)) {
      issues.push({ code: 'invalid_value', entity: 'subject', entityId: id, field: 'id', detail: `duplicate subject ${id}` });
    }
    subjectIds.add(id);
  }

  // 5. Curriculum.
  if (!Array.isArray(model.curriculum) || model.curriculum.length === 0) {
    missing.push({ entity: 'Curriculum', reason: 'No authoritative curriculum data' });
  }
  for (const c of model.curriculum ?? []) {
    if (!c.classId) {
      issues.push({ code: 'missing_required_field', entity: 'curriculum', field: 'classId', detail: 'curriculum entry missing classId' });
      continue;
    }
    if (!classIds.has(c.classId)) {
      issues.push({ code: 'invalid_reference', entity: 'curriculum', field: 'classId', detail: `curriculum references unknown class ${c.classId}` });
    }
    if (!c.subjectId) {
      issues.push({ code: 'missing_required_field', entity: 'curriculum', field: 'subjectId', detail: `curriculum for ${c.classId} missing subjectId` });
    } else if (!subjectIds.has(c.subjectId)) {
      issues.push({ code: 'invalid_reference', entity: 'curriculum', field: 'subjectId', detail: `curriculum references unknown subject ${c.subjectId}` });
    }
    if (!Number.isInteger(c.requiredPeriods) || c.requiredPeriods < 0) {
      issues.push({ code: 'invalid_value', entity: 'curriculum', field: 'requiredPeriods', detail: `curriculum for ${c.classId}/${c.subjectId} has invalid requiredPeriods` });
    }
  }

  // 6. Assignments.
  if (!Array.isArray(model.assignments) || model.assignments.length === 0) {
    missing.push({ entity: 'Assignment', reason: 'No authoritative assignment data' });
  }
  const seenAssignmentIds = new Set();
  for (const a of model.assignments ?? []) {
    if (!a.id) {
      issues.push({ code: 'missing_required_field', entity: 'assignment', field: 'id', detail: 'assignment is missing id' });
      continue;
    }
    if (seenAssignmentIds.has(a.id)) {
      issues.push({ code: 'invalid_value', entity: 'assignment', entityId: a.id, field: 'id', detail: `duplicate assignment id ${a.id}` });
    }
    seenAssignmentIds.add(a.id);
    if (!a.teacherId && !(a.baselineAssignment === true && a.requiresTeacherAssignment === true)) {
      issues.push({ code: 'missing_required_field', entity: 'assignment', entityId: a.id, field: 'teacherId', detail: `assignment ${a.id} missing teacherId` });
    } else if (a.teacherId && !teacherIds.has(a.teacherId)) {
      issues.push({ code: 'invalid_reference', entity: 'assignment', entityId: a.id, field: 'teacherId', detail: `assignment ${a.id} references unknown teacher ${a.teacherId}` });
    }
    if (!a.classId) {
      issues.push({ code: 'missing_required_field', entity: 'assignment', entityId: a.id, field: 'classId', detail: `assignment ${a.id} missing classId` });
    } else if (!classIds.has(a.classId)) {
      issues.push({ code: 'invalid_reference', entity: 'assignment', entityId: a.id, field: 'classId', detail: `assignment ${a.id} references unknown class ${a.classId}` });
    }
    if (!a.subjectId) {
      issues.push({ code: 'missing_required_field', entity: 'assignment', entityId: a.id, field: 'subjectId', detail: `assignment ${a.id} missing subjectId` });
    } else if (!subjectIds.has(a.subjectId)) {
      issues.push({ code: 'invalid_reference', entity: 'assignment', entityId: a.id, field: 'subjectId', detail: `assignment ${a.id} references unknown subject ${a.subjectId}` });
    }
    if (!a.branchId) {
      issues.push({ code: 'missing_required_field', entity: 'assignment', entityId: a.id, field: 'branchId', detail: `assignment ${a.id} missing branchId` });
    } else if (!branchIds.has(a.branchId)) {
      issues.push({ code: 'invalid_reference', entity: 'assignment', entityId: a.id, field: 'branchId', detail: `assignment ${a.id} references unknown branch ${a.branchId}` });
    }
    if (!Number.isInteger(a.requiredPeriods) || a.requiredPeriods < 0) {
      issues.push({ code: 'invalid_value', entity: 'assignment', entityId: a.id, field: 'requiredPeriods', detail: `assignment ${a.id} has invalid requiredPeriods` });
    }
    if (a.subjectId && a.teacherId && teacherIds.has(a.teacherId)) {
      const teacher = model.teachers.find((t) => t.id === a.teacherId);
      if (teacher && Array.isArray(teacher.chuyenMon)) {
        // Phase 22 §29: prefer the explicit id-side field. Fall
        // back to the legacy name-based check when the teacher
        // has no eligibleSubjectIds[] (e.g. fixture-based inputs).
        let eligible;
        if (Array.isArray(teacher.eligibleSubjectIds)) {
          eligible = teacher.eligibleSubjectIds.includes(a.subjectId);
        } else {
          eligible = teacher.chuyenMon.some((s) => s.tenChuyenMon === a.subjectId);
        }
        if (!eligible) {
          issues.push({
            code: 'unresolvable_demand',
            entity: 'assignment',
            entityId: a.id,
            detail: `teacher ${teacher.hoTen ?? teacher.id} is not eligible for ${a.subjectId}`,
          });
        }
      }
    }
  }

  // 7. Travel: legitimate absence is MISSING_DATA, not INVALID_INPUT.
  if (!model.travelTime) {
    missing.push({ entity: 'Travel', reason: 'No travel matrix' });
  }

  // 8. timeSlotsByBranch consistency.
  for (const k of model.timeSlotsByBranch?.keys?.() ?? []) {
    if (!branchIds.has(k)) {
      issues.push({
        code: 'invalid_reference',
        entity: 'input',
        field: 'timeSlotsByBranch',
        detail: `timeSlotsByBranch key ${k} is not in branches`,
      });
    }
  }

  for (const pair of curriculumCoverage(model)) {
    issues.push({ code: 'curriculum_coverage_mismatch', entity: 'curriculum', entityId: `${pair.classId}/${pair.subjectId}`, field: 'requiredPeriods',
      detail: `Curriculum requires ${pair.requiredPeriods} periods, assignments cover ${pair.assignedPeriods}.` });
  }
  return { issues, missing };
}
