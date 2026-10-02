// Situation report. Pure function from the normalized model
// to a structured analysis. Deterministic.

import { workloadOf } from './workload.js';
import { eligibleTeachers } from './eligibility.js';

export function buildSituation(input) {
  const teacherSummaries = input.teachers.map((t) => ({
    id: t.id,
    hoTen: t.hoTen,
    specializations: t.chuyenMon.map((s) => s.tenChuyenMon),
    workload: workloadOf(t),
    hasPreference: Boolean(t.nguyenVong),
    homeBranchId: t.homeBranchId ?? null,
  }));

  const subjectDemand = new Map();
  for (const a of input.assignments) {
    const k = `${a.branchId}|${a.subjectId}`;
    const cur = subjectDemand.get(k) ?? { branchId: a.branchId, subjectId: a.subjectId, demand: 0 };
    cur.demand += a.requiredPeriods;
    subjectDemand.set(k, cur);
  }

  const subjectSupply = new Map();
  for (const t of input.teachers) {
    if (!t.homeBranchId) continue;
    for (const s of t.chuyenMon) {
      const k = `${t.homeBranchId}|${s.tenChuyenMon}`;
      const cur = subjectSupply.get(k) ?? { branchId: t.homeBranchId, subjectId: s.tenChuyenMon, supply: 0 };
      cur.supply += s.soTietTuan;
      subjectSupply.set(k, cur);
    }
  }

  const shortage = [];
  const surplus = [];
  for (const [k, d] of subjectDemand) {
    const s = subjectSupply.get(k) ?? { supply: 0 };
    if (d.demand > s.supply) shortage.push({ ...d, supply: s.supply, gap: d.demand - s.supply });
    else if (s.supply > d.demand) surplus.push({ ...d, supply: s.supply, gap: s.supply - d.demand });
  }

  const unresolvable = [];
  for (const a of input.assignments) {
    const eligible = eligibleTeachers(input.teachers, a.subjectId)
      .filter((t) => !t.homeBranchId || t.homeBranchId === a.branchId);
    if (eligible.length === 0) {
      unresolvable.push({ assignmentId: a.id, subjectId: a.subjectId, branchId: a.branchId, reason: 'NO_ELIGIBLE_TEACHER' });
    }
  }

  return {
    teachers: teacherSummaries,
    branches: input.branches.map((b) => ({ id: b.id, name: b.name ?? b.id })),
    shortage,
    surplus,
    conflicts: [],
    unresolvable,
    missingData: input.missingData ?? [],
  };
}
