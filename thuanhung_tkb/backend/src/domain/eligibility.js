// A teacher is eligible for a subject iff the subject name is
// one of their chuyenMon[].tenChuyenMon entries. Comparison is
// case-sensitive, trimmed.

/** @param {import('./teacher.js').Teacher} teacher */
export function isEligibleFor(teacher, subjectName) {
  if (!subjectName) return false;
  const target = String(subjectName).trim();
  return teacher.chuyenMon.some((s) => s.tenChuyenMon.trim() === target);
}

/**
 * @param {import('./teacher.js').Teacher[]} teachers
 * @param {string} subjectName
 */
export function eligibleTeachers(teachers, subjectName) {
  return teachers.filter((t) => isEligibleFor(t, subjectName));
}
