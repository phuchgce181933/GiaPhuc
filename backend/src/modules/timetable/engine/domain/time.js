// Pure utilities for the (day, period, session) time model.
// No IO, no side effects.

export const DAYS = [1, 2, 3, 4, 5];

export function teachingSessionOf(period) { return sessionOf(period); }

export function isAdjacentTeachingPeriod(a, b, branchA, branchB = branchA) {
  return Number(a?.day) === Number(b?.day) && sessionForSlot(a, branchA) === sessionForSlot(b, branchB)
    && Math.abs(Number(a.period) - Number(b.period)) === 1;
}

export function countTeachingSessions(schedule, teacherId, branches = []) {
  const branchIndex = new Map(branches.map((branch) => [branch.id, branch]));
  const sessions = new Set();
  const entries = schedule instanceof Map ? schedule.entries() : (schedule ?? []);
  for (const [, slots] of entries) for (const slot of slots ?? []) {
    if (slot?.teacherId === teacherId) sessions.add(`${slot.day}|${sessionForSlot(slot, branchIndex.get(slot.branchId))}`);
  }
  return sessions.size;
}

export const SESSION_CODES = ['sang', 'chieu', 'ca_hai'];

/**
 * Classify a period number into a session.
 * @param {number} period 1..N
 * @param {{ sangMax?: number, chieuMax?: number }} profile
 * @returns {'sang' | 'chieu' | 'ca_hai'}
 */
export function sessionOf(period, profile = {}) {
  const number = Number(period);
  if (profile.sangPeriods || profile.chieuPeriods) {
    const morning = profile.sangPeriods?.some((value) => Number(value) === number) ?? false;
    const afternoon = profile.chieuPeriods?.some((value) => Number(value) === number) ?? false;
    if (morning && number > 4) return null;
    return morning === afternoon ? null : morning ? 'sang' : 'chieu';
  }
  if (profile.sessionByPeriod) {
    const session = profile.sessionByPeriod.get(number) ?? null;
    return session === 'sang' && number > 4 ? null : session;
  }
  const sangMax = Math.min(profile.sangMax ?? 4, 4);
  if (Number(period) <= sangMax) return 'sang';
  return 'chieu';
}

/**
 * Derive a session profile from a branch's period list. The
 * branch may either:
 *
 *   - carry an explicit `sessions` map: { sang: [..periods], chieu: [..periods] }
 *   - or rely on the default (period 1..4 = sang, rest = chieu).
 *
 * Pure. Deterministic. No branch mutation.
 */
export function profileOf(branch) {
  if (!branch) return { sangMax: 4, sangPeriods: null, chieuPeriods: null, sessionByPeriod: null };
  if (branch.sessions && typeof branch.sessions === 'object') {
    const sangPeriods = Array.isArray(branch.sessions.sang) ? branch.sessions.sang : null;
    const chieuPeriods = Array.isArray(branch.sessions.chieu) ? branch.sessions.chieu : null;
    const sessionByPeriod = new Map();
    if (sangPeriods) for (const p of sangPeriods) sessionByPeriod.set(Number(p), 'sang');
    if (chieuPeriods) for (const p of chieuPeriods) sessionByPeriod.set(Number(p), 'chieu');
    const sangMax = sangPeriods?.length
      ? Math.max(...sangPeriods)
      : (chieuPeriods?.length ? Math.min(...chieuPeriods) - 1 : 4);
    return { sangMax, sangPeriods, chieuPeriods, sessionByPeriod };
  }
  return { sangMax: 4, sangPeriods: null, chieuPeriods: null, sessionByPeriod: null };
}

/**
 * Resolve the session of a slot using the branch's profile.
 * Falls back to the default (period <= 4) when no profile is given.
 */
export function sessionForSlot(slot, branch) {
  // Resolve through sessionOf without allocating an index for each pair in H17.
  const profile = branch?.sessions ? {
    sangPeriods: Array.isArray(branch.sessions.sang) ? branch.sessions.sang : [],
    chieuPeriods: Array.isArray(branch.sessions.chieu) ? branch.sessions.chieu : [],
  } : {};
  return sessionOf(slot?.period, profile);
}

export function isBlockedTeachingSlot(slot, branch) {
  const session = sessionForSlot(slot, branch);
  return session === 'sang' && ((Number(slot.day) === 1 && Number(slot.period) === 1)
    || (Number(slot.day) === 5 && Number(slot.period) === 4));
}

/**
 * Two slots collide iff same day AND same period.
 * Branch is part of the identity tuple but conflict is branch-agnostic
 * for a single teacher or a single class.
 */
export function slotsEqual(a, b) {
  return a.day === b.day && a.period === b.period;
}

// ============================================================================
// CONFLICT-IDENTITY KEYS (Phase 22.1 §4 — include session)
// ============================================================================
//
// Per the Phase 22 brief §3 / §4, the conflict identity for both
// H01 (class) and H02 (teacher) MUST be (entity, day, session, period).
// The original `classSlotKey` / `teacherSlotKey` below drop
// `session`, which caused the Phase 22 baseline evaluation to
// flag 83 cross-session class pairs and 252 cross-session
// teacher pairs as "double bookings" — a known bug. The Phase
// 19/20 integrity check uses the correct identity and reports
// 0 raw duplicates.
//
// The new `classConflictKey` / `teacherConflictKey` keep the
// brief-correct identity. They normalize the session value to
// one of {sang, chieu, ca_hai} so cross-namespace sessions
// (raw data uses "morning" / "afternoon") compare equal.
//
// The old `classSlotKey` / `teacherSlotKey` are PRESERVED for
// callers that still need the (day, period)-only identity
// (e.g. the solver's pruning, the legacy validator). They are
// marked with a deprecation comment but kept working.

const SESSION_ALIAS = new Map([
  ['morning', 'sang'],
  ['afternoon', 'chieu'],
  ['sang', 'sang'],
  ['chieu', 'chieu'],
  ['ca_hai', 'ca_hai'],
]);

/**
 * Normalize a session string to one of the canonical codes
 * (sang / chieu / ca_hai). Returns `null` if the value is
 * missing or unrecognized. Phase 22.1 §5: never silently
 * fabricate a session; if the source value is unknown, return
 * `null` and let the conflict key reflect that.
 */
export function normalizeSession(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  return SESSION_ALIAS.get(s) ?? null;
}

/**
 * Brief-correct identity for class conflict detection.
 * = (classId, day, session, period). The class id is the
 * caller's responsibility (this function only builds the
 * time-part of the key, branch-agnostic).
 *
 * Includes a normalized session component so that two slots
 * at the same (day, period) but in different sessions (morning
 * vs afternoon) do NOT collide.
 *
 * If session is missing or unrecognized, the key includes a
 * sentinel "?" — the collision is then ambiguous and the
 * catalog will report it as a potential violation (rather
 * than silently passing). This matches the H06 missing-field
 * policy.
 */
export function classConflictKey(slot, branch) {
  const sess = normalizeSession(slot?.session) ?? sessionForSlot(slot, branch) ?? '?';
  return `${slot.day}:${sess}:${slot.period}`;
}

/**
 * Brief-correct identity for teacher conflict detection.
 * = (teacherId, day, session, period). Branch-agnostic.
 * Same session semantics as `classConflictKey`.
 */
export function teacherConflictKey(slot, branch) {
  const sess = normalizeSession(slot?.session) ?? sessionForSlot(slot, branch) ?? '?';
  return `${slot.day}:${sess}:${slot.period}`;
}

/**
 * Identity for a teacher schedule slot — branch-agnostic, NO
 * session. A teacher cannot be at two branches at the same
 * (day, period).
 *
 * DEPRECATED for conflict detection: use `teacherConflictKey`
 * instead, which includes session. Kept for callers that
 * intentionally work in the (day, period) plane (e.g. solver
 * pruning, the legacy validator).
 */
export function teacherSlotKey(slot) {
  return `${slot.day}:${slot.period}`;
}

/**
 * Identity for a class schedule slot — branch-agnostic, NO
 * session. A class cannot have two subjects at the same
 * (day, period).
 *
 * DEPRECATED for conflict detection: use `classConflictKey`
 * instead, which includes session. Kept for callers that
 * intentionally work in the (day, period) plane.
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
