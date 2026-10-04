// PHASE 26 — transfer module public surface.
//
// The transfer module is read-only: it formalises the transfer
// policy surface, audits historical transfer logs, and reports
// orphan references. It does NOT activate H13 (Transfer allowed)
// on the real dataset (no teacher carries `allowedTransferBranches`)
// and it does NOT activate H14 (Travel feasible). Those activations
// remain parked per the constraint catalog.

export {
  // Branch graph
  buildBranchGraph,
  indexBranchGraph,
  resolveBranchId,
  resolveBranchIds,
} from './branch-graph.js';

export {
  // Transfer semantics
  TRANSFER_POLICY_STATUS,
  TRANSFER_PERMISSION,
  homeBranchOf,
  allowedTransferBranchesOf,
  preferredTransferBranchesOf,
  canWorkAtBranch,
  isAllowedToWorkAt,
  auditTeacherTransferPolicy,
  summarizeTeacherTransferPolicy,
} from './transfer.js';

export {
  // Historical analysis
  TRANSFER_STATUS,
  summarizeTransferStatus,
  summarizeFailureReasons,
  summarizeTransferBranches,
  summarizeTransferredAssignments,
  analyzeTransferHistory,
} from './history-analysis.js';

export {
  // Orphan classification
  analyzeOrphanReferences,
} from './orphan-analysis.js';

import { buildBranchGraph } from './branch-graph.js';
import {
  summarizeTeacherTransferPolicy,
  auditTeacherTransferPolicy,
} from './transfer.js';
import { analyzeTransferHistory } from './history-analysis.js';
import { analyzeOrphanReferences } from './orphan-analysis.js';

/**
 * Build the full Phase 26 transfer audit report. This is the
 * function the test suite and the documentation consult.
 *
 *   {
 *     branchGraph:      [...nodes],
 *     branchGraphIndex: Map<id, node>,
 *     teacherTransferPolicy: { total, withHomeBranch, ..., withoutAnyTransferPolicy },
 *     transferHistory:  { totalTransferLogs, byStatus, failureReasons, successByBranch, transferredAssignments },
 *     orphans:          { orphanFromTeacher, ..., totalOrphanReferences },
 *     h13:              { status: 'INACTIVE', reason: 'data_dependency_missing' },
 *     h14:              { status: 'UNSUPPORTED', reason: 'no_travel_matrix' },
 *   }
 *
 * The report is read-only. No field is mutated, no value is
 * invented.
 */
export function buildTransferAudit({
  branches,
  teachers,
  transferHistory,
  baselineAssignments,
  currentAssignments,
}) {
  const graph = buildBranchGraph(branches);
  const policySummary = summarizeTeacherTransferPolicy(teachers);
  // Per-teacher audit list. Useful for the documentation.
  const perTeacher = Array.isArray(teachers) ? teachers.map(auditTeacherTransferPolicy) : [];

  // H13 is INACTIVE on the real dataset: no teacher carries a
  // non-empty `allowedTransferBranches`. The summary above is the
  // proof; we surface it explicitly so the test can assert it.
  const h13 = {
    status: policySummary.withAllowedTransferBranches > 0 ? 'ACTIVE' : 'INACTIVE',
    reason: policySummary.withAllowedTransferBranches > 0
      ? 'data_present'
      : 'data_dependency_missing',
  };

  // H14 is UNSUPPORTED: no travel matrix is in the input.
  // (Phase 26 does not change this; the constraint catalog
  // already reports UNSUPPORTED.)
  const h14 = {
    status: 'UNSUPPORTED',
    reason: 'no_travel_matrix',
  };

  // Orphan analysis. We pass the BRANCHES list so we can also
  // report orphan-branch references, even though the real
  // dataset has none.
  const orphans = analyzeOrphanReferences({
    transferHistory,
    baselineAssignments,
    currentTeachers: teachers,
    currentBranches: branches,
    currentAssignments,
  });

  return {
    branchGraph: graph,
    branchGraphIndex: new Map(graph.map((n) => [n.id, n])),
    teacherTransferPolicy: policySummary,
    perTeacherTransferPolicy: perTeacher,
    transferHistory: analyzeTransferHistory(transferHistory, baselineAssignments),
    orphans,
    h13,
    h14,
  };
}
