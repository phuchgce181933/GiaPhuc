// Pure scorer. (solution, input) -> Score. Deterministic.
//
// PHASE 16 pipeline order (matches the contract in PIPELINE.md):
//   candidate
//     ↓ quality scoring (preference, workload, travel, transfer)
//     ↓ diversity scoring (vs prior kept candidates)
//     ↓ overall score
//     ↓ sort/select
//
// diversityScore is therefore computed against the already-kept
// candidates BEFORE the overall score is finalised. The orchestrator
// passes the prior candidates to this function; on a single-candidate
// run, diversity defaults to 1.
//
// PHASE 17 pipeline adds:
//   - noGapScore: based on the per-teacher-day contiguity of slots.
//   - sessionDiversityScore: based on the per-teacher mix of
//     sang/chieu sessions across days.
//   - structuralDiversityScore: based on the slot identity set of
//     the candidate vs the prior kept candidates. The orchestrator
//     still uses the plain `diversity()` for the dedupe gate, but
//     the structural score is reported separately so callers can
//     audit the diversity claim.

import {
  SOFT,
  workloadBalanceScore,
  travelScoreFn,
  noGapForTeacherDays,
  sessionDiversityScore,
} from './constraints.js';
import { diversity } from './diversity.js';

export function score(solution, input, priorCandidates = []) {
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
      const v = def.scorePerTeacher(t, slots, input);
      prefSum += v;
      prefCount += 1;
    }
  }
  const preferenceScore = prefCount > 0 ? prefSum / prefCount : 1;

  const workloadScore = workloadBalanceScore(solution, input);
  const travelScore = travelScoreFn(solution, input);

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

  // PHASE 17 — wire noGap and session-diversity into the score.
  const teacherDayPeriodsMap = new Map();
  for (const [tid, slots] of teacherSlots) {
    for (const s of slots) {
      const k = `${tid}|${s.day}`;
      const arr = teacherDayPeriodsMap.get(k) ?? [];
      arr.push(s.period);
      teacherDayPeriodsMap.set(k, arr);
    }
  }
  const noGapScore = noGapForTeacherDays(teacherDayPeriodsMap);
  const sessionDiversityValue = sessionDiversityScore(solution, input);

  // Diversity is the minimum distance to any prior candidate. When
  // no prior candidates exist, the score is 1 (no penalty).
  let diversityScore = 1;
  if (priorCandidates.length > 0) {
    for (const prior of priorCandidates) {
      diversityScore = Math.min(diversityScore, diversity(prior, solution));
    }
  }

  const w = input.strategy.weights;
  const hard = solution.diagnostics?.hardViolationCount ?? 0;
  const overallScore =
    w.preference * preferenceScore +
    w.workload * workloadScore +
    w.travel * travelScore +
    w.transfer * transferScore +
    w.diversity * diversityScore +
    (w.noGap ?? 0) * noGapScore +
    (w.sessionDiversity ?? 0) * sessionDiversityValue -
    (hard > 0 ? 1e6 : 0);

  return {
    hardViolationCount: hard,
    overallScore,
    preferenceScore,
    workloadScore,
    travelScore,
    transferScore,
    diversityScore,
    noGapScore,
    sessionDiversityScore: sessionDiversityValue,
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

export { noGapForTeacherDays, sessionDiversityScore };
