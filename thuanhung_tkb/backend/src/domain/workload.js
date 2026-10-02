// Workload is a derived, runtime-only value.
// Sum of soTietTuan across a teacher's specializations.

export function workloadOf(teacher) {
  let total = 0;
  for (const s of teacher.chuyenMon) total += Number(s.soTietTuan) || 0;
  return total;
}

export function workloadSummary(teachers) {
  return teachers.map((t) => ({
    teacherId: t.id,
    hoTen: t.hoTen,
    workload: workloadOf(t),
  }));
}
