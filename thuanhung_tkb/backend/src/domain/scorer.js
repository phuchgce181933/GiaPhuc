// Pure scorer. (solution, input) -> Score. Deterministic.

import { SOFT, workloadBalanceScore, noGapForTeacherDays } from './constraints.js';

export function score(solution, input) {
  const teacherSlots = new Map();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    const arr = teacherSlots.get(meta.teacherId) ?? [];
    for (const s of slots) arr.push(s);
    teacherSlots.set(meta.teacherId, arr);
  }

  let prefSum = 0, prefCount = 0;
  for (const [name, def] of Object.entries(SOFT)) {
    if (def.active && !def.active(input)) continue;
    for (const t of input.teachers) {
      const slots = teacherSlots.get(t.id) ?? [];
      const v = def.scorePerTeacher(t, slots);
      prefSum += v;
      prefCount += 1;
    }
  }
  const preferenceScore = prefCount > 0 ? prefSum / prefCount : 1;

  const workloadScore = workloadBalanceScore(solution, input);

  const travelScore = 1;

  let transferSum = 0, transferCount = 0;
  for (const t of input.teachers) {
    if (!t.homeBranchId) continue;
    const slots = teacherSlots.get(t.id) ?? [];
    if (slots.length === 0) continue;
    let home = 0;
    for (const s of slots) if (s.branchId === t.homeBranchId) home++;
    transferSum += home / slots.length;
    transferCount += 1;
  }
  const transferScore = transferCount > 0 ? transferSum / transferCount : 1;

  const diversityScore = 1;

  const w = input.strategy.weights;
  const hard = solution.diagnostics?.hardViolationCount ?? 0;
  const overallScore =
    w.preference * preferenceScore +
    w.workload * workloadScore +
    w.travel * travelScore +
    w.transfer * transferScore +
    w.diversity * diversityScore -
    (hard > 0 ? 1e6 : 0);

  return {
    hardViolationCount: hard,
    overallScore,
    preferenceScore,
    workloadScore,
    travelScore,
    transferScore,
    diversityScore,
  };
}

export function teacherDayPeriods(solution, input) {
  const out = new Map();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    const byDay = new Map();
    for (const s of slots) {
      const k = `${meta.teacherId}|${s.day}`;
      const arr = byDay.get(k) ?? [];
      arr.push(s.period);
      byDay.set(k, arr);
    }
    for (const [k, periods] of byDay) {
      const prev = out.get(k) ?? [];
      prev.push(...periods);
      out.set(k, prev);
    }
  }
  return out;
}

export { noGapForTeacherDays };
