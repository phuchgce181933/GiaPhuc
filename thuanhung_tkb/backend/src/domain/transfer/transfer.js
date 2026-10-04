// PHASE 26 — transfer semantics.
//
// Formalises the transfer POLICY surface a teacher carries:
//   - homeBranchId
//   - allowedTransferBranches[]
//   - preferredTransferBranches[]
//   - transferPriority[]
//
// Phase 26 distinguishes two concepts that the existing catalog
// has been conflating:
//
//   TRANSFER_ALLOWED   — a teacher is *permitted* by their policy
//                        to work at a non-home branch.
//
//   TRAVEL_FEASIBLE    — a teacher can actually *travel* from one
//                        branch to another in the available time
//                        between two slots. This requires a
//                        TravelProvider, which Phase 26 does NOT
//                        activate. The check is in
//                        `domain/travel/feasibility.js`.
//
// The two concepts are NOT equivalent. A teacher may be
// `allowedTransferBranches: ['PH2']` but we have no travel time
// from PH1 to PH2, so we cannot say the move is feasible. The
// helper `canWorkAtBranch` reports the policy only; it never
// touches travel.

// ============================================================================
// Status constants
// ============================================================================

export const TRANSFER_POLICY_STATUS = Object.freeze({
  HOME: 'HOME',                   // the branch is the teacher's home
  ALLOWED: 'ALLOWED',             // the branch is in allowedTransferBranches
  NOT_ALLOWED: 'NOT_ALLOWED',     // the branch is neither home nor allowed
  INACTIVE: 'INACTIVE',           // no transfer policy is recorded
  UNKNOWN: 'UNKNOWN',             // inputs are missing (no fabrication)
});

export const TRANSFER_PERMISSION = Object.freeze({
  ALLOW: 'ALLOW',
  DENY: 'DENY',
  UNKNOWN: 'UNKNOWN',
});

// ============================================================================
// Null-safe accessors
// ============================================================================

/**
 * Return the teacher's `homeBranchId`, or `null` if it is missing.
 * The function never invents a value.
 */
export function homeBranchOf(teacher) {
  if (!teacher || typeof teacher !== 'object') return null;
  return teacher.homeBranchId ?? null;
}

/**
 * Return the teacher's `allowedTransferBranches` as an array.
 * Returns `[]` if missing. The function never invents values.
 */
export function allowedTransferBranchesOf(teacher) {
  if (!teacher || typeof teacher !== 'object') return [];
  if (!Array.isArray(teacher.allowedTransferBranches)) return [];
  return teacher.allowedTransferBranches.filter((b) => b != null);
}

/**
 * Return the teacher's `preferredTransferBranches` as an array.
 * Returns `[]` if missing. The function never invents values.
 */
export function preferredTransferBranchesOf(teacher) {
  if (!teacher || typeof teacher !== 'object') return [];
  if (!Array.isArray(teacher.preferredTransferBranches)) return [];
  return teacher.preferredTransferBranches.filter((b) => b != null);
}

// ============================================================================
// canWorkAtBranch — the policy helper
// ============================================================================

/**
 * Decide whether a teacher is *permitted* to work at a target
 * branch by their policy. The helper is PURE and never throws
 * on missing data. It returns one of:
//
//   { status: 'HOME',        branchId, source: 'homeBranchId' }
//   { status: 'ALLOWED',     branchId, source: 'allowedTransferBranches' }
//   { status: 'NOT_ALLOWED', branchId, source: 'no_policy_match' }
//   { status: 'INACTIVE',    branchId, source: 'no_transfer_policy' }
//   { status: 'UNKNOWN',     branchId, source: 'missing_inputs' }
//
// The function NEVER:
//
//   - invents a home branch for the teacher,
//   - uses historical transfer logs to bypass a missing policy,
//   - reads from outside the teacher record (no branch / class lookup),
//   - touches travel feasibility (H14).
//
// The helper is the foundation of H13 (Transfer permission) when
// the activation predicate decides to fire it.
 */
export function canWorkAtBranch(teacher, branchId) {
  if (!teacher || typeof teacher !== 'object') {
    return { status: TRANSFER_POLICY_STATUS.UNKNOWN, branchId: branchId ?? null, source: 'missing_inputs' };
  }
  if (branchId == null) {
    return { status: TRANSFER_POLICY_STATUS.UNKNOWN, branchId: null, source: 'missing_inputs' };
  }
  const home = homeBranchOf(teacher);
  if (home != null && home === branchId) {
    return { status: TRANSFER_POLICY_STATUS.HOME, branchId, source: 'homeBranchId' };
  }
  const allowed = allowedTransferBranchesOf(teacher);
  if (allowed.length === 0) {
    if (home == null) {
      // No home, no allowed list → policy is INACTIVE. We do not
      // know whether the teacher is allowed to work at this
      // branch; we only know the policy does not say.
      return { status: TRANSFER_POLICY_STATUS.INACTIVE, branchId, source: 'no_transfer_policy' };
    }
    return { status: TRANSFER_POLICY_STATUS.NOT_ALLOWED, branchId, source: 'no_policy_match' };
  }
  if (allowed.includes(branchId)) {
    return { status: TRANSFER_POLICY_STATUS.ALLOWED, branchId, source: 'allowedTransferBranches' };
  }
  return { status: TRANSFER_POLICY_STATUS.NOT_ALLOWED, branchId, source: 'no_policy_match' };
}

/**
 * Boolean wrapper. The three return values:
 *   ALLOW     — teacher is allowed by policy.
 *   DENY      — teacher is explicitly NOT allowed by policy.
 *   UNKNOWN   — policy is missing; we do not know.
 *
 * `canWorkAtBranch(...)` is the source of truth; this helper just
 * collapses the four policy statuses to a tri-state for callers
 * that only need yes/no/maybe.
 */
export function isAllowedToWorkAt(teacher, branchId) {
  const r = canWorkAtBranch(teacher, branchId);
  if (r.status === TRANSFER_POLICY_STATUS.HOME) return TRANSFER_PERMISSION.ALLOW;
  if (r.status === TRANSFER_POLICY_STATUS.ALLOWED) return TRANSFER_PERMISSION.ALLOW;
  if (r.status === TRANSFER_POLICY_STATUS.NOT_ALLOWED) return TRANSFER_PERMISSION.DENY;
  return TRANSFER_PERMISSION.UNKNOWN;
}

// ============================================================================
// Audit helpers
// ============================================================================

/**
 * Audit a teacher's transfer surface. Returns:
 *   {
 *     teacherId,
 *     hasHomeBranch,
 *     homeBranchId,
 *     allowedTransferBranches:  string[],
 *     preferredTransferBranches: string[],
 *     hasTransferPolicy,
 *   }
 *
 * The audit is read-only. The caller can serialize it directly
 * to the Phase 26 report.
 */
export function auditTeacherTransferPolicy(teacher) {
  if (!teacher || typeof teacher !== 'object') {
    return {
      teacherId: null,
      hasHomeBranch: false,
      homeBranchId: null,
      allowedTransferBranches: [],
      preferredTransferBranches: [],
      hasTransferPolicy: false,
    };
  }
  const home = homeBranchOf(teacher);
  const allowed = allowedTransferBranchesOf(teacher);
  const preferred = preferredTransferBranchesOf(teacher);
  return {
    teacherId: teacher.id ?? null,
    hasHomeBranch: home != null,
    homeBranchId: home,
    allowedTransferBranches: allowed,
    preferredTransferBranches: preferred,
    // A policy is "present" when the teacher carries at least one
    // of: homeBranchId, allowedTransferBranches, or
    // preferredTransferBranches. Absence means the policy is
    // INACTIVE in the current contract.
    hasTransferPolicy: home != null || allowed.length > 0 || preferred.length > 0,
  };
}

/**
 * Summary over a teacher list.
 *
 *   {
 *     total,
 *     withHomeBranch,
 *     withoutHomeBranch,
 *     withAllowedTransferBranches,
 *     withPreferredTransferBranches,
 *     withAnyTransferPolicy,
 *     withoutAnyTransferPolicy,
 *   }
 */
export function summarizeTeacherTransferPolicy(teachers) {
  if (!Array.isArray(teachers)) {
    return {
      total: 0,
      withHomeBranch: 0,
      withoutHomeBranch: 0,
      withAllowedTransferBranches: 0,
      withPreferredTransferBranches: 0,
      withAnyTransferPolicy: 0,
      withoutAnyTransferPolicy: 0,
    };
  }
  let withHome = 0, withAllowed = 0, withPreferred = 0, withAny = 0;
  for (const t of teachers) {
    const audit = auditTeacherTransferPolicy(t);
    if (audit.hasHomeBranch) withHome++;
    if (audit.allowedTransferBranches.length > 0) withAllowed++;
    if (audit.preferredTransferBranches.length > 0) withPreferred++;
    if (audit.hasTransferPolicy) withAny++;
  }
  return {
    total: teachers.length,
    withHomeBranch: withHome,
    withoutHomeBranch: teachers.length - withHome,
    withAllowedTransferBranches: withAllowed,
    withPreferredTransferBranches: withPreferred,
    withAnyTransferPolicy: withAny,
    withoutAnyTransferPolicy: teachers.length - withAny,
  };
}
