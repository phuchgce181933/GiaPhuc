// Pure utilities for the (day, period, session) time model.
// No IO, no side effects.

export const DAYS = [1, 2, 3, 4, 5, 6, 7];

export const SESSION_CODES = ['sang', 'chieu', 'ca_hai'];

/**
 * Classify a period number into a session.
 * @param {number} period 1..N
 * @param {{ sangMax?: number, chieuMax?: number }} profile
 * @returns {'sang' | 'chieu' | 'ca_hai'}
 */
export function sessionOf(period, profile = {}) {
  const sangMax = profile.sangMax ?? 5;
  if (period <= sangMax) return 'sang';
  return 'chieu';
}

/**
 * Derive a session profile from a branch's period list. The
 * branch may either:
 *
 *   - carry an explicit `sessions` map: { sang: [..periods], chieu: [..periods] }
 *   - or rely on the default (period 1..5 = sang, rest = chieu).
 *
 * Pure. Deterministic. No branch mutation.
 */
export function profileOf(branch) {
  if (!branch) return { sangMax: 5, sangPeriods: null, chieuPeriods: null, sessionByPeriod: null };
  if (branch.sessions && typeof branch.sessions === 'object') {
    const sangPeriods = Array.isArray(branch.sessions.sang) ? branch.sessions.sang : null;
    const chieuPeriods = Array.isArray(branch.sessions.chieu) ? branch.sessions.chieu : null;
    const sessionByPeriod = new Map();
    if (sangPeriods) for (const p of sangPeriods) sessionByPeriod.set(p, 'sang');
    if (chieuPeriods) for (const p of chieuPeriods) sessionByPeriod.set(p, 'chieu');
    const sangMax = sangPeriods?.length
      ? Math.max(...sangPeriods)
      : (chieuPeriods?.length ? Math.min(...chieuPeriods) - 1 : 5);
    return { sangMax, sangPeriods, chieuPeriods, sessionByPeriod };
  }
  return { sangMax: 5, sangPeriods: null, chieuPeriods: null, sessionByPeriod: null };
}

/**
 * Resolve the session of a slot using the branch's profile.
 * Falls back to the default (period <= 5) when no profile is given.
 */
export function sessionForSlot(slot, branch) {
  const profile = profileOf(branch);
  if (profile.sessionByPeriod) {
    return profile.sessionByPeriod.get(slot.period) ?? 'chieu';
  }
  return sessionOf(slot.period, profile);
}

/**
 * Two slots collide iff same day AND same period.
 * Branch is part of the identity tuple but conflict is branch-agnostic
 * for a single teacher or a single class.
 */
export function slotsEqual(a, b) {
  return a.day === b.day && a.period === b.period;
}

/**
 * Identity for a teacher schedule slot — branch-agnostic. A teacher
 * cannot be at two branches at the same (day, period).
 */
export function teacherSlotKey(slot) {
  return `${slot.day}:${slot.period}`;
}

/**
 * Identity for a class schedule slot — branch-agnostic (a class
 * belongs to a single branch, so cross-branch conflict is impossible
 * for a single class).
 */
export function classSlotKey(slot) {
  return `${slot.day}:${slot.period}`;
}

/**
 * Identity for a time-slot placement — used by diversity, H_SLOT_IN_BRANCH,
 * and the solver's slot pool. Includes branchId because the same
 * (day, period) on different branches is a different placement.
 */
export function slotKey(slot) {
  return `${slot.branchId}:${slot.day}:${slot.period}`;
}

export function assignmentKey(branchId, day, period) {
  return `${branchId}:${day}:${period}`;
}

/**
 * For a teacher working across branches, list ordered by time of day.
 * The travel check picks consecutive entries on different branches.
 */
export function orderByTime(slots) {
  return [...slots].sort((a, b) => (a.day - b.day) || (a.period - b.period));
}
