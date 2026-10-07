// Eligibility — a teacher is eligible for a subject iff the
// subject id is in `teacher.eligibleSubjectIds[]` (the explicit,
// solver-friendly projection) OR the subject name is one of the
// teacher's `chuyenMon[].tenChuyenMon` entries (legacy projection,
// case-sensitive after trim).
//
// Phase 22 §29 — the field name carries its semantic:
//   - `tenChuyenMon` = NAME. It must NOT hold a hex id.
//   - `eligibleSubjectIds[]` = ID. It is the solver-friendly list.
//
// The function accepts EITHER a subject id OR a subject name and
// resolves to "is this teacher eligible?". The constraint catalog
// and validator consult `eligibleSubjectIds[]` first (id-side),
// then fall back to the legacy name-based check.

/** @param {import('./teacher.js').Teacher} teacher */
export function isEligibleFor(teacher, subjectIdOrName) {
  if (!teacher || !subjectIdOrName) return false;
  // 1) Prefer the explicit solver-friendly id list when present.
  if (Array.isArray(teacher.eligibleSubjectIds)) {
    if (teacher.eligibleSubjectIds.includes(subjectIdOrName)) return true;
  }
  // 2) Fall back to the legacy name-based check (fixture paths,
  //    hand-crafted test inputs).
  const target = String(subjectIdOrName).trim();
  if (!Array.isArray(teacher.chuyenMon)) return false;
  return teacher.chuyenMon.some((s) => String(s?.tenChuyenMon ?? '').trim() === target);
}

/**
 * @param {import('./teacher.js').Teacher[]} teachers
 * @param {string} subjectIdOrName
 */
export function eligibleTeachers(teachers, subjectIdOrName) {
  return teachers.filter((t) => isEligibleFor(t, subjectIdOrName));
}