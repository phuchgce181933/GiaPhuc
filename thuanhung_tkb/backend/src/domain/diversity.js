// Diversity filter. (candidates, threshold) -> kept candidates.
// Diversity is computed over the placement identity tuples:
// (teacherId, branchId, day, period). Two solutions that share the
// same teacher-day-period-branch tuple are NOT diverse; solutions
// that differ in teacher are diverse even at the same (branch, day,
// period). This is the contract per PHASE_16 §12.
//
// PHASE 17 — `diversity()` stays as the SLOT-IDENTITY diversity,
// which is the dedupe gate. The orchestrator may also want a
// STRUCTURAL diversity that compares the per-teacher distribution
// of slots across days and sessions. Two solutions that place the
// same set of slots but distribute a teacher's work differently
// are diverse at the slot level (0) but identical at the
// structural level. `structuralDiversity(a, b)` exposes this.

import { sessionForSlot } from './time.js';

function slotKey(s) {
  return `${s.teacherId ?? ''}|${s.branchId}:${s.day}:${s.period}`;
}

function teacherDayDistribution(solution) {
  // For each teacher, a sorted list of (day, period) tuples.
  // The list length is the teacher's slot count. The day-span
  // (max - min + 1) is how many days they touch. The day
  // histogram (count per day) captures "concentrated vs spread".
  const out = new Map();
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const tid = s.teacherId ?? '';
      const cur = out.get(tid) ?? { slots: [], dayCounts: new Map(), sessionCounts: { sang: 0, chieu: 0 } };
      cur.slots.push({ day: s.day, period: s.period, branchId: s.branchId });
      cur.dayCounts.set(s.day, (cur.dayCounts.get(s.day) ?? 0) + 1);
      const branch = solution._branchesById?.get(s.branchId);
      const sess = sessionForSlot(s, branch);
      cur.sessionCounts[sess] += 1;
      out.set(tid, cur);
    }
  }
  return out;
}

export function dedupe(candidates, minEditDistance = 0.15) {
  if (candidates.length === 0) return [];
  const out = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    const cand = candidates[i];
    let diverse = true;
    for (const kept of out) {
      if (diversity(kept, cand) < minEditDistance) {
        diverse = false;
        break;
      }
    }
    if (diverse) out.push(cand);
  }
  return out;
}

export function diversity(a, b) {
  const setA = new Set();
  const setB = new Set();
  for (const slots of a.assignments.values()) for (const s of slots) setA.add(slotKey(s));
  for (const slots of b.assignments.values()) for (const s of slots) setB.add(slotKey(s));
  if (setA.size === 0 && setB.size === 0) return 1;
  let inter = 0;
  for (const k of setA) if (setB.has(k)) inter++;
  const symDiff = setA.size + setB.size - 2 * inter;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : symDiff / union;
}

/**
 * Structural diversity: how different are the per-teacher
 * distributions of work between two solutions? This is the
 * "shape" of the schedule, not the slot identity.
 *
 * Returns an object with:
 *   - teacherDay:   how different are the day-count histograms
 *                   per teacher? Normalized to [0, 1].
 *   - sessionMix:   how different are the per-teacher sang/chieu
 *                   splits? Normalized to [0, 1].
 *   - overall:      weighted blend. 0 means same shape; 1 means
 *                   completely different.
 *
 * The `diversity()` slot identity remains the dedupe gate
 * (PHASE 16). The structural score is reported separately and
 * used as a TIE-BREAKER for the final sort, not for the gate.
 *
 * Why is this needed for real TKB? Two candidates that share all
 * the same (teacher, branch, day, period) tuples (diversity = 0)
 * are still functionally different if one of them concentrates
 * t1's 4 slots on day 1 and the other spreads t1's 4 slots
 * across days 1, 2, 3, 4. Slot identity says "same"; structural
 * diversity says "different". Real TKB care about both.
 */
export function structuralDiversity(a, b, branchesById = null) {
  if (branchesById) {
    a._branchesById = branchesById;
    b._branchesById = branchesById;
  }
  const distA = teacherDayDistribution(a);
  const distB = teacherDayDistribution(b);
  const teachers = new Set([...distA.keys(), ...distB.keys()]);
  if (teachers.size === 0) return { teacherDay: 1, sessionMix: 1, overall: 1 };

  let dayDiff = 0, sessDiff = 0, count = 0;
  for (const tid of teachers) {
    const A = distA.get(tid) ?? { slots: [], dayCounts: new Map(), sessionCounts: { sang: 0, chieu: 0 } };
    const B = distB.get(tid) ?? { slots: [], dayCounts: new Map(), sessionCounts: { sang: 0, chieu: 0 } };
    // Per-teacher day-count distance: sum over days of |A_d - B_d|
    // divided by max(totalA, totalB). Range [0, 1].
    const days = new Set([...A.dayCounts.keys(), ...B.dayCounts.keys()]);
    let daySum = 0, dayMax = 0;
    for (const d of days) {
      const aC = A.dayCounts.get(d) ?? 0;
      const bC = B.dayCounts.get(d) ?? 0;
      daySum += Math.abs(aC - bC);
      dayMax = Math.max(dayMax, A.slots.length, B.slots.length);
    }
    const dayScore = dayMax > 0 ? daySum / (2 * dayMax) : 0;
    dayDiff += dayScore;
    // Per-teacher session-mix distance: |A_sang - B_sang| + |A_chieu - B_chieu|
    // divided by total slots. Range [0, 1].
    const sDiff = Math.abs(A.sessionCounts.sang - B.sessionCounts.sang)
                + Math.abs(A.sessionCounts.chieu - B.sessionCounts.chieu);
    const sMax = Math.max(1, A.slots.length, B.slots.length);
    const sessScore = sDiff / (2 * sMax);
    sessDiff += sessScore;
    count += 1;
  }
  const teacherDay = count > 0 ? dayDiff / count : 0;
  const sessionMix = count > 0 ? sessDiff / count : 0;
  // Weight: 0.6 day-pattern + 0.4 session-mix. Day distribution
  // matters more for TKB (week structure) than session mix.
  const overall = 0.6 * teacherDay + 0.4 * sessionMix;
  return { teacherDay, sessionMix, overall };
}
