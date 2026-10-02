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
 * Two slots collide iff same day AND same period.
 * Branch is part of the identity tuple but conflict is branch-agnostic
 * for a single teacher or a single class.
 */
export function slotsEqual(a, b) {
  return a.day === b.day && a.period === b.period;
}

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
