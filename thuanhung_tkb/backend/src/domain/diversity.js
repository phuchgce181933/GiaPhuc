// Diversity filter. (candidates, threshold) -> kept candidates.
// Diversity is computed over the placement identity tuples:
// (teacherId, branchId, day, period). Two solutions that share the
// same teacher-day-period-branch tuple are NOT diverse; solutions
// that differ in teacher are diverse even at the same (branch, day,
// period). This is the contract per PHASE_16 §12.

function slotKey(s) {
  return `${s.teacherId ?? ''}|${s.branchId}:${s.day}:${s.period}`;
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
