// PHASE 26 — historical transfer audit (read-only).
//
// Produces a structured report of the historical transfer logs in
// the legacy dataset. The audit NEVER mutates the input, NEVER
// uses historical counts as optimizer weights, and NEVER promotes
// a historical success to a hard-constraint activation.
//
// The catalog of failure reasons is preserved verbatim from the
// source:
//
//   - ADJACENT_SLOT_AT_BRANCH        (223 — most common)
//   - TEACHER_CONFLICT                (184)
//   - SAME_SESSION_AT_MAIN_BRANCH     (141)
//   - SPECIALIZATION_MISMATCH         (  1)
//
// These names are HISTORICAL EVIDENCE, not active constraints.
// They become hard / soft constraints only when the Phase 22
// catalog defines a corresponding rule. Today, only H13 (Transfer
// permission) touches transfer policy, and only via the
// `allowedTransferBranches` field — never via historical counts.

export const TRANSFER_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * Bucket a transfer history by its `status` field. Returns:
 *   { SUCCESS, FAILED, UNKNOWN, total, byStatus: { ...counts } }
 *
 * Records with a null / missing / unrecognized status are counted
 * under UNKNOWN. The audit does NOT silently drop them.
 */
export function summarizeTransferStatus(transferHistory) {
  const byStatus = { SUCCESS: 0, FAILED: 0, UNKNOWN: 0 };
  if (!Array.isArray(transferHistory)) {
    return { ...byStatus, total: 0, byStatus: { ...byStatus } };
  }
  for (const t of transferHistory) {
    const s = t?.status;
    if (s === TRANSFER_STATUS.SUCCESS) byStatus.SUCCESS++;
    else if (s === TRANSFER_STATUS.FAILED) byStatus.FAILED++;
    else byStatus.UNKNOWN++;
  }
  return {
    SUCCESS: byStatus.SUCCESS,
    FAILED: byStatus.FAILED,
    UNKNOWN: byStatus.UNKNOWN,
    total: transferHistory.length,
    byStatus: { ...byStatus },
  };
}

/**
 * Bucket transfer history by the `failureReason` field. Returns:
 *   { reasons: { [reason]: count }, totalFailed }
 *
 * Reasons are preserved verbatim. Records with `status = SUCCESS`
 * are not included. Records with a missing reason are bucketed
 * under the literal key `'(none)'` for traceability.
 */
export function summarizeFailureReasons(transferHistory) {
  const reasons = {};
  let totalFailed = 0;
  if (!Array.isArray(transferHistory)) {
    return { reasons, totalFailed };
  }
  for (const t of transferHistory) {
    if (t?.status !== TRANSFER_STATUS.FAILED) continue;
    totalFailed++;
    const r = t?.failureReason;
    const key = r == null || r === '' ? '(none)' : String(r);
    reasons[key] = (reasons[key] ?? 0) + 1;
  }
  return { reasons, totalFailed };
}

/**
 * Bucket successful transfers by the (fromBranch, toBranch) pair.
 *   - 'same'            = from === to
 *   - 'cross'           = from != to and both are present
 *   - 'unknown-branch'  = at least one branch is null
 *
 * Returns:
 *   { same, cross, unknownBranch, total }
 */
export function summarizeTransferBranches(transferHistory) {
  let same = 0, cross = 0, unknownBranch = 0;
  if (!Array.isArray(transferHistory)) {
    return { same, cross, unknownBranch, total: 0 };
  }
  for (const t of transferHistory) {
    if (t?.status !== TRANSFER_STATUS.SUCCESS) continue;
    if (!t.fromBranch || !t.toBranch) {
      unknownBranch++;
    } else if (t.fromBranch === t.toBranch) {
      same++;
    } else {
      cross++;
    }
  }
  return {
    same,
    cross,
    unknownBranch,
    total: same + cross + unknownBranch,
  };
}

/**
 * Bucket transferred (isTransferred=true) baseline assignments by
 * the presence / absence of `transferredFromTeacher`.
 *
 * Returns:
 *   {
 *     totalTransferred,
 *     withOrigin,
 *     withoutOrigin,
 *   }
 *
 * The `withoutOrigin` count is the historical-orphan count for
 * transferred assignments. These rows are PRESERVED in the audit
 * (no deletion, no fabrication, no repair).
 */
export function summarizeTransferredAssignments(assignments) {
  let totalTransferred = 0;
  let withOrigin = 0;
  let withoutOrigin = 0;
  if (!Array.isArray(assignments)) {
    return { totalTransferred, withOrigin, withoutOrigin };
  }
  for (const a of assignments) {
    if (!a || a.isTransferred !== true) continue;
    totalTransferred++;
    if (a.transferredFromTeacher == null) withoutOrigin++;
    else withOrigin++;
  }
  return { totalTransferred, withOrigin, withoutOrigin };
}

/**
 * Build the full historical transfer audit. The function is the
 * single Phase 26 entry point for transfer-history analytics.
 *
 *   {
 *     totalTransferLogs,
 *     byStatus: { SUCCESS, FAILED, UNKNOWN, total, byStatus: {...} },
 *     failureReasons: { reasons, totalFailed },
 *     successByBranch: { same, cross, unknownBranch, total },
 *     transferredAssignments: { totalTransferred, withOrigin, withoutOrigin },
 *   }
 */
export function analyzeTransferHistory(transferHistory, assignments) {
  return {
    totalTransferLogs: Array.isArray(transferHistory) ? transferHistory.length : 0,
    byStatus: summarizeTransferStatus(transferHistory),
    failureReasons: summarizeFailureReasons(transferHistory),
    successByBranch: summarizeTransferBranches(transferHistory),
    transferredAssignments: summarizeTransferredAssignments(assignments),
  };
}
