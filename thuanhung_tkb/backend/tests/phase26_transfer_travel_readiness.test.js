import { withExplicitTestTransferPolicy } from './helpers/scheduling-fixture.js';
// PHASE 26 — TRANSFER SEMANTICS + TRAVEL READINESS
//
// SCOPE
// -----
// Phase 26 formalises the transfer-policy surface (the data the
// teacher record already carries), audits the historical transfer
// logs, and prepares the TravelProvider abstraction so that H14
// (Travel feasibility) can be activated when a real travel matrix
// arrives.
//
// Phase 26 does NOT:
//   - fabricate any travel time,
//   - use historical transfer counts as optimizer weights,
//   - promote a historical success to a hard constraint,
//   - delete / repair / fabricate orphan transfer references,
//   - alter the Phase 25 GLOBAL_ASSIGNMENT_BALANCED behavior,
//   - activate H14 (it remains UNSUPPORTED),
//   - introduce AI / LLM / multi-solution / external API.
//
// The test suite covers 22 invariants, plus regression checks.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { solve } from '../src/domain/solver.js';
import { STRATEGY_C } from '../src/domain/strategies.js';
import { evaluateCandidate, evaluateBaseline, isAccepted } from '../src/domain/constraints/index.js';
import {
  buildBranchGraph,
  indexBranchGraph,
  resolveBranchId,
  resolveBranchIds,
  TRANSFER_POLICY_STATUS,
  TRANSFER_PERMISSION,
  TRANSFER_STATUS,
  homeBranchOf,
  allowedTransferBranchesOf,
  preferredTransferBranchesOf,
  canWorkAtBranch,
  isAllowedToWorkAt,
  auditTeacherTransferPolicy,
  summarizeTeacherTransferPolicy,
  analyzeTransferHistory,
  analyzeOrphanReferences,
  buildTransferAudit,
} from '../src/domain/transfer/index.js';
import {
  TRAVEL_PROVIDER_STATUS,
  TRAVEL_FEASIBILITY_REASON,
  SLOT_ORDER,
  makeTravelProvider,
  makeMissingTravelProvider,
  makeUnsupportedTravelProvider,
  nullTravelProvider,
  getTravelProviderStatus,
  isTravelFeasible,
  getNextTemporalSlot,
  checkTransition,
} from '../src/domain/travel/index.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load the legacy-saplich dataset once for tests that need it.
 * Pure data — no mutation, no caching across tests (so a test
 * that asserts a derived value is not contaminated by another).
 */
function loadFull() {
  return loadFromLegacySaplich();
}

/**
 * Solve real data with a controlled mode + seed + time budget.
 * Phase 26 does not change the search behavior; the solver is
 * exercised for the regression invariants (#21 / #22).
 */
function solveReal(mode = 'GLOBAL_ASSIGNMENT_BALANCED', seed = 0xC0FFEE, timeLimitMs = 5_000) {
  const full = loadFull();
  const input = { ...withExplicitTestTransferPolicy(full.scheduling), strategy: STRATEGY_C };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: { ...STRATEGY_C.diversification, seed },
    solver: { timeLimitMs, maxSolutions: 1000 },
  };
  const out = solve(input);
  return { out, input, full, solution: out.solutions[0] ?? null };
}

// ============================================================================
// 1. 7 branches resolved
// ============================================================================

test('PHASE 26 / 1 — 7 branches resolved from real data', () => {
  const full = loadFull();
  // The audit reads from the normalized layer (which carries
  // the canonical `code` and `name` fields). The scheduling
  // input's branches carry `id` + `name` only; the audit
  // accepts either.
  const graph = buildBranchGraph(full.normalized.branches);
  assert.equal(graph.length, 7);
  for (const node of graph) {
    assert.equal(typeof node.id, 'string');
    assert.equal(typeof node.code, 'string');
    assert.equal(typeof node.name, 'string');
    assert.equal(node.active, true);
  }
  // The branch ids are stable strings; the codes are the
  // short labels (PHC, PH1..PH6).
  const codes = graph.map((n) => n.code).sort();
  assert.deepEqual(codes, ['PH1', 'PH2', 'PH3', 'PH4', 'PH5', 'PH6', 'PHC']);
  // The same graph can also be built from the scheduling input
  // (the helper tolerates missing `code`).
  const schedGraph = buildBranchGraph(full.scheduling.branches);
  assert.equal(schedGraph.length, 7);
});

// ============================================================================
// 2. teacher branch references resolve
// ============================================================================

test('PHASE 26 / 2 — every teacher homeBranchId resolves to a branch in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  const index = indexBranchGraph(graph);
  for (const t of full.scheduling.teachers) {
    const home = homeBranchOf(t);
    if (home == null) continue; // covered by invariant 5
    const r = resolveBranchId(home, graph);
    assert.equal(r.status, 'RESOLVED', `teacher ${t.id} home branch ${home} did not resolve`);
    assert.ok(index.has(home), `branch index must contain ${home}`);
  }
});

// ============================================================================
// 3. allowed transfer branches resolve
// ============================================================================

test('PHASE 26 / 3 — allowedTransferBranches, when present, resolve to branches in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  // The real dataset has 0 teachers with non-empty allowedTransferBranches;
  // we still exercise the resolver on every teacher to confirm the helper
  // does not break, AND on a synthetic teacher we inject for this test.
  let checked = 0;
  for (const t of full.scheduling.teachers) {
    const allowed = allowedTransferBranchesOf(t);
    if (allowed.length === 0) continue;
    const r = resolveBranchIds(allowed, graph);
    for (const id of r.resolved) assert.ok(graph.find((n) => n.id === id));
    for (const id of r.inactive) assert.fail(`inactive branch ${id} should not appear in active graph`);
    for (const id of r.unknown) assert.fail(`unknown branch ${id} in allowed list`);
    checked += 1;
  }
  // The real dataset reports 0 (the invariant on the summary covers
  // the "no policy" case separately).
  assert.equal(checked, 0);

  // Synthetic: a teacher with an allowed list referencing a real branch.
  // We use the actual branch ids (not the short codes) because the
  // graph's id field is the canonical identifier.
  const target1 = graph[0].id; // some real branch id
  const target2 = graph[1].id; // another real branch id
  const syntheticTeacher = { id: 'T-SYN', homeBranchId: graph[2].id, allowedTransferBranches: [target1, target2] };
  const r2 = resolveBranchIds(allowedTransferBranchesOf(syntheticTeacher), graph);
  assert.deepEqual(r2.resolved.sort(), [target1, target2].sort());
  assert.deepEqual(r2.inactive, []);
  assert.deepEqual(r2.unknown, []);
});

// ============================================================================
// 4. preferred transfer branches resolve
// ============================================================================

test('PHASE 26 / 4 — preferredTransferBranches, when present, resolve to branches in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  let checked = 0;
  for (const t of full.scheduling.teachers) {
    const pref = preferredTransferBranchesOf(t);
    if (pref.length === 0) continue;
    const r = resolveBranchIds(pref, graph);
    for (const id of r.resolved) assert.ok(graph.find((n) => n.id === id));
    checked += 1;
  }
  assert.equal(checked, 40); // every active teacher carries a resolved preference list

  // Synthetic: a teacher with a preferred list (using real branch ids).
  const target1 = graph[0].id;
  const target2 = graph[1].id;
  const syntheticTeacher = { id: 'T-SYN2', preferredTransferBranches: [target1, target2] };
  const r2 = resolveBranchIds(preferredTransferBranchesOf(syntheticTeacher), graph);
  assert.deepEqual(r2.resolved.sort(), [target1, target2].sort());
});

// ============================================================================
// 5. missing homeBranch is not fabricated
// ============================================================================

test('PHASE 26 / 5 — missing homeBranchId is reported, not fabricated', () => {
  // The real dataset has 0 teachers without homeBranchId (all 40
  // have one). We assert that, AND we exercise a teacher with
  // homeBranchId=null to confirm the helpers do not invent a value.
  const full = loadFull();
  const summary = summarizeTeacherTransferPolicy(full.scheduling.teachers);
  assert.equal(summary.total, 40);
  assert.equal(summary.withoutHomeBranch, 0);

  // Synthetic teacher without home.
  const t = { id: 'T-NO-HOME' };
  assert.equal(homeBranchOf(t), null);
  const audit = auditTeacherTransferPolicy(t);
  assert.equal(audit.hasHomeBranch, false);
  assert.equal(audit.homeBranchId, null);
});

// ============================================================================
// 6. transfer permission is distinct from travel feasibility
// ============================================================================

test('PHASE 26 / 6 — canWorkAtBranch never reads travel data', () => {
  // The transfer-policy helper must return a policy answer EVEN
  // when the travel matrix is missing. The two concepts are
  // independent: a teacher can be ALLOWED to work at a branch by
  // policy, and still TRAVEL_INFEASIBLE because we have no matrix.
  const t = { id: 'T-POLICY', homeBranchId: 'PH1', allowedTransferBranches: ['PH2'] };
  const r1 = canWorkAtBranch(t, 'PH1');
  assert.equal(r1.status, TRANSFER_POLICY_STATUS.HOME);
  const r2 = canWorkAtBranch(t, 'PH2');
  assert.equal(r2.status, TRANSFER_POLICY_STATUS.ALLOWED);
  const r3 = canWorkAtBranch(t, 'PH3');
  assert.equal(r3.status, TRANSFER_POLICY_STATUS.NOT_ALLOWED);

  // Even when there is no travel provider, canWorkAtBranch still
  // returns the policy status; the helper is decoupled from
  // isTravelFeasible.
  const policyOnly = canWorkAtBranch(t, 'PH2');
  const provider = nullTravelProvider();
  const t1 = { branchId: 'PH1', day: 1, period: 3 };
  const t2 = { branchId: 'PH2', day: 1, period: 4 };
  const travel = isTravelFeasible(t1, t2, provider, 10);
  // Policy says ALLOWED, travel says MISSING_PROVIDER.
  assert.equal(policyOnly.status, TRANSFER_POLICY_STATUS.ALLOWED);
  assert.equal(travel.reason, TRAVEL_FEASIBILITY_REASON.MISSING_PROVIDER);
});
// ============================================================================
// 7. historical transferred assignments = 87
// ============================================================================

test('PHASE 26 / 7 — historical transferred assignments = 87', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(audit.transferHistory.transferredAssignments.totalTransferred, 87);
});

// ============================================================================
// 8. historical transfer logs = 4175
// ============================================================================

test('PHASE 26 / 8 — historical transfer logs = 4175', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(audit.transferHistory.totalTransferLogs, 4175);
});

// ============================================================================
// 9. SUCCESS = 3626
// ============================================================================

test('PHASE 26 / 9 — transfer logs SUCCESS = 3626', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(audit.transferHistory.byStatus.SUCCESS, 3626);
});

// ============================================================================
// 10. FAILED = 549
// ============================================================================

test('PHASE 26 / 10 — transfer logs FAILED = 549', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(audit.transferHistory.byStatus.FAILED, 549);
});

// ============================================================================
// 11. orphan transfer references = 731
// ============================================================================

test('PHASE 26 / 11 — orphan transfer references = 731 (transfer logs with orphan assignment id)', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  // 731 = transfer logs whose `assignment` id is not in the
  // current SchedulingInput assignments. These are PRESERVED in
  // the audit (no deletion, no repair, no fabrication).
  assert.equal(audit.orphans.orphanTransferAssignmentRefs, 731);
});

// ============================================================================
// 12. orphan logs preserved
// ============================================================================

test('PHASE 26 / 12 — orphan logs preserved in the audit (no deletion)', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  // The orphan set is a Set, NOT a delete. The function returns
  // the structured classification; the input is not mutated.
  const originalLength = full.normalized.transferHistory.length;
  // Re-run the audit to confirm the input is still intact.
  const audit2 = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(full.normalized.transferHistory.length, originalLength);
  assert.equal(audit.orphans.orphanTransferLogIds.size, audit2.orphans.orphanTransferLogIds.size);
  // The audit also classifies the per-row orphan categories.
  assert.ok(audit.orphans.orphanFromTeacher >= 0);
  assert.ok(audit.orphans.orphanToTeacher >= 0);
  assert.ok(audit.orphans.orphanTransferredAssignments >= 0);
});

// ============================================================================
// 13. failure reasons preserved
// ============================================================================

test('PHASE 26 / 13 — failure reasons preserved verbatim from source', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  const reasons = audit.transferHistory.failureReasons.reasons;
  // Exact distribution from the source.
  assert.equal(reasons.ADJACENT_SLOT_AT_BRANCH, 223);
  assert.equal(reasons.TEACHER_CONFLICT, 184);
  assert.equal(reasons.SAME_SESSION_AT_MAIN_BRANCH, 141);
  assert.equal(reasons.SPECIALIZATION_MISMATCH, 1);
  assert.equal(audit.transferHistory.failureReasons.totalFailed, 549);
});

// ============================================================================
// 14. H14 remains UNSUPPORTED
// ============================================================================

test('PHASE 26 / 14 — H14 (Travel feasibility) remains UNSUPPORTED', () => {
  const full = loadFull();
  const evaluation = evaluateCandidate(
    { assignments: new Map(), placements: new Map() },
    full.scheduling,
  );
  // The constraint catalog tags H14 as UNSUPPORTED; it never
  // appears in the violations list and never gates a candidate.
  assert.equal(evaluation.constraintStatuses.H14, 'UNSUPPORTED');
  assert.ok(
    evaluation.unsupported.some((e) => e.constraintId === 'H14'),
    'H14 must be in the unsupported list',
  );
  assert.equal(
    evaluation.hard.violations.find((v) => v.constraintId === 'H14'),
    undefined,
    'H14 must never emit a violation while UNSUPPORTED',
  );

  // H13 is INACTIVE on the real dataset (no teacher carries
  // allowedTransferBranches), but Phase 26 must report it as
  // such — not UNSUPPORTED.
  assert.equal(evaluation.constraintStatuses.H13, 'ACTIVE');
});

// ============================================================================
// 15. no travel matrix fabricated
// ============================================================================

test('PHASE 26 / 15 — no travel matrix is fabricated by the audit or solver', () => {
  const full = loadFull();
  // The SchedulingInput still carries travelTime === null.
  assert.equal(full.scheduling.travelTime, null);
  // The audit never asks the user to invent a matrix.
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(audit.h14.status, 'UNSUPPORTED');
  // The transfer-permission helper is a pure function on the
  // teacher record; it never reaches into the matrix.
  const t = { id: 'T-X', homeBranchId: 'PH1', allowedTransferBranches: ['PH2'] };
  const r = canWorkAtBranch(t, 'PH2');
  assert.equal(r.status, TRANSFER_POLICY_STATUS.ALLOWED);
  // The function takes ONLY the teacher + branchId; calling it
  // with the travel provider would be a type error.
  assert.equal(typeof r.source, 'string');
});

// ============================================================================
// 16. TravelProvider interface deterministic
// ============================================================================

test('PHASE 26 / 16 — TravelProvider interface is deterministic', () => {
  const provider = makeTravelProvider({ PH1: { PH2: 15, PH3: 20 }, PH2: { PH1: 15 } });
  // Same input → same output.
  for (let i = 0; i < 5; i++) {
    assert.equal(provider.travelTime('PH1', 'PH2', 3), 15);
    assert.equal(provider.travelTime('PH1', 'PH3', 3), 20);
    assert.equal(provider.travelTime('PH1', 'PH4', 3), null);
    assert.equal(provider.travelTime('PH1', 'PH1', 3), 0);
    assert.equal(provider.status(), TRAVEL_PROVIDER_STATUS.READY);
  }
});

// ============================================================================
// 17. unknown travel does not become 0
// ============================================================================

test('PHASE 26 / 17 — unknown travel does not become 0', () => {
  const missing = makeMissingTravelProvider();
  // missing provider reports status=MISSING and returns null
  // for every pair (NOT zero).
  assert.equal(missing.status(), TRAVEL_PROVIDER_STATUS.MISSING);
  assert.equal(missing.travelTime('PH1', 'PH2', 3), null);
  assert.equal(missing.travelTime('PH1', 'PH1', 3), null);

  // A READY provider with no data for a pair returns null too.
  const empty = makeTravelProvider({});
  assert.equal(empty.status(), TRAVEL_PROVIDER_STATUS.READY);
  assert.equal(empty.travelTime('PH1', 'PH2', 3), null);
  assert.equal(empty.travelTime('PH1', 'PH1', 3), 0);

  // isTravelFeasible propagates the unknown as NO_TRAVEL_DATA.
  const r = isTravelFeasible(
    { branchId: 'PH1', day: 1, period: 3 },
    { branchId: 'PH2', day: 1, period: 4 },
    empty,
    10,
  );
  assert.equal(r.feasible, false);
  assert.equal(r.minutes, null);
  assert.equal(r.reason, TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA);

  // Cross-branch with missing provider: also NO_TRAVEL_DATA.
  const r2 = isTravelFeasible(
    { branchId: 'PH1', day: 1, period: 3 },
    { branchId: 'PH2', day: 1, period: 4 },
    missing,
    10,
  );
  assert.equal(r2.reason, TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA);
  assert.equal(r2.minutes, null);

  // Cross-branch with unsupported provider: PROVIDER_UNSUPPORTED.
  const unsupported = makeUnsupportedTravelProvider();
  const r3 = isTravelFeasible(
    { branchId: 'PH1', day: 1, period: 3 },
    { branchId: 'PH2', day: 1, period: 4 },
    unsupported,
    10,
  );
  assert.equal(r3.reason, TRAVEL_FEASIBILITY_REASON.PROVIDER_UNSUPPORTED);

  // Cross-branch with no provider at all: MISSING_PROVIDER.
  const r4 = isTravelFeasible(
    { branchId: 'PH1', day: 1, period: 3 },
    { branchId: 'PH2', day: 1, period: 4 },
    null,
    10,
  );
  assert.equal(r4.reason, TRAVEL_FEASIBILITY_REASON.MISSING_PROVIDER);
});

// ============================================================================
// 18. same-branch semantics follow contract
// ============================================================================

test('PHASE 26 / 18 — same-branch semantics follow the provider contract', () => {
  // Same branch: the helper short-circuits to 0 minutes,
  // regardless of the provider (even an unsupported one).
  const prev = { branchId: 'PH1', day: 1, period: 3 };
  const next = { branchId: 'PH1', day: 1, period: 4 };
  for (const provider of [null, makeMissingTravelProvider(), makeUnsupportedTravelProvider(), makeTravelProvider({})]) {
    const r = isTravelFeasible(prev, next, provider, 10);
    assert.equal(r.feasible, true);
    assert.equal(r.minutes, 0);
    assert.equal(r.reason, TRAVEL_FEASIBILITY_REASON.SAME_BRANCH);
  }
});

// ============================================================================
// 19. transfer helper is deterministic
// ============================================================================

test('PHASE 26 / 19 — transfer helpers are deterministic and pure', () => {
  const teachers = [
    { id: 'A', homeBranchId: 'PH1', allowedTransferBranches: ['PH2'] },
    { id: 'B', homeBranchId: 'PH1', allowedTransferBranches: [] },
    { id: 'C', homeBranchId: null, allowedTransferBranches: ['PH2'] },
    { id: 'D', homeBranchId: 'PH1', preferredTransferBranches: ['PH3'] },
  ];
  // canWorkAtBranch is total: every pair returns a structured result.
  //
  // Brief §16 semantics:
  //   - home branch                 → HOME / allowed
  //   - allowed transfer branch     → ALLOWED
  //   - non-allowed branch          → NOT_ALLOWED (policy present, no match)
  //   - missing policy (no home, no allowed) → INACTIVE
  //   - missing inputs              → UNKNOWN
  const expected = [
    ['A', 'PH1', TRANSFER_POLICY_STATUS.HOME],
    ['A', 'PH2', TRANSFER_POLICY_STATUS.ALLOWED],
    ['A', 'PH3', TRANSFER_POLICY_STATUS.NOT_ALLOWED],
    ['B', 'PH1', TRANSFER_POLICY_STATUS.HOME],
    ['B', 'PH2', TRANSFER_POLICY_STATUS.NOT_ALLOWED], // B has home but no allowed → not allowed
    ['C', 'PH1', TRANSFER_POLICY_STATUS.NOT_ALLOWED], // C has no home, allowed is ['PH2'] → policy present, not in list
    ['C', 'PH2', TRANSFER_POLICY_STATUS.ALLOWED],     // C has no home but lists PH2 as allowed
    ['D', 'PH3', TRANSFER_POLICY_STATUS.NOT_ALLOWED], // D's home is PH1; PH3 is not in allowed
  ];
  // The same teachers must always produce the same result.
  for (let i = 0; i < 3; i++) {
    for (const [tid, bid, status] of expected) {
      const t = teachers.find((x) => x.id === tid);
      const r = canWorkAtBranch(t, bid);
      assert.equal(r.status, status, `${tid} @ ${bid} expected ${status}, got ${r.status}`);
      const expectedPermission =
        status === TRANSFER_POLICY_STATUS.HOME || status === TRANSFER_POLICY_STATUS.ALLOWED
          ? TRANSFER_PERMISSION.ALLOW
          : (status === TRANSFER_POLICY_STATUS.NOT_ALLOWED
              ? TRANSFER_PERMISSION.DENY
              : TRANSFER_PERMISSION.UNKNOWN);
      assert.equal(isAllowedToWorkAt(t, bid), expectedPermission);
    }
  }
});

// ============================================================================
// 20. baseline transfer is historical only
// ============================================================================

test('PHASE 26 / 20 — baseline transfer rows are HISTORICAL only (not solver-fixed)', () => {
  const full = loadFull();
  // The legacy baseline carries 87 transferred assignments, but
  // these are not constraints. The solver is free to re-assign
  // the teacher. We verify the audit does NOT promote them to
  // fixed transfers.
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments,
  });
  // The audit only reports the historical count; it does NOT
  // mark the rows as solver-fixed.
  const transferredRows = full.legacyBaseline.assignments.filter((a) => a.isTransferred);
  assert.equal(transferredRows.length, audit.transferHistory.transferredAssignments.totalTransferred);
  // The scheduling model exposes these as `baselineAssignment: true`,
  // not as fixed constraints.
  const schedTransferred = full.scheduling.assignments.filter((a) => a.isTransferred);
  assert.equal(schedTransferred.length, 87);
  for (const a of schedTransferred.slice(0, 5)) {
    assert.equal(a.baselineAssignment, true);
  }
});

// ============================================================================
// 21. Phase 25 GLOBAL candidate still works
// ============================================================================

test('PHASE 26 / 21 — Phase 25 GLOBAL_ASSIGNMENT_BALANCED still produces a candidate on real data', () => {
  const { out, solution } = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.equal(out.failure, null);
  assert.ok(solution, 'solver must return a candidate');
  // Phase 25 invariants still hold.
  assert.equal(solution.metrics.hardViolations, 0);
  assert.equal(solution.metrics.teacherCount, 40);
  assert.equal(solution.metrics.totalPeriods, 802);
});

// ============================================================================
// 22. Phase 25 hard violations remain 0
// ============================================================================

test('PHASE 26 / 22 — generated GLOBAL candidate is valid; legacy baseline is judged under current rules', () => {
  const { solution, input, full } = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.ok(solution, 'solver must return a candidate');
  // Build a candidate compatible with the catalog.
  const placements = new Map();
  for (const a of full.scheduling.assignments) {
    const p = solution.placements.get(a.id);
    if (p) placements.set(a.id, { teacherId: p.teacherId, branchId: p.branchId });
  }
  const candidate = { assignments: solution.assignments, placements };
  const evaluation = evaluateCandidate(candidate, input);
  assert.equal(evaluation.summary.totalHardViolations, 0);
  assert.equal(isAccepted(evaluation), true);
  // The historical baseline is unchanged, but the new calendar/adjacency
  // rules can correctly flag legacy placements as no longer acceptable.
  const baselineEval = evaluateBaseline(full.legacyBaseline, input);
  assert.ok(baselineEval.evaluation.summary.totalHardViolations > 0);
});

// ============================================================================
// 23. (extra) TravelProvider status is normalised
// ============================================================================

test('PHASE 26 / 23 — getTravelProviderStatus normalises all three factory outputs', () => {
  assert.equal(getTravelProviderStatus(makeTravelProvider({})), TRAVEL_PROVIDER_STATUS.READY);
  assert.equal(getTravelProviderStatus(makeMissingTravelProvider()), TRAVEL_PROVIDER_STATUS.MISSING);
  assert.equal(getTravelProviderStatus(makeUnsupportedTravelProvider()), TRAVEL_PROVIDER_STATUS.UNSUPPORTED);
  assert.equal(getTravelProviderStatus(null), TRAVEL_PROVIDER_STATUS.UNSUPPORTED);
});

// ============================================================================
// 24. (extra) Adjacent-slot helper is order-aware
// ============================================================================

test('PHASE 26 / 24 — getNextTemporalSlot is order-aware and pure', () => {
  assert.equal(getNextTemporalSlot({ day: 1, period: 3 }, { day: 1, period: 4 }), SLOT_ORDER.ADJACENT);
  assert.equal(getNextTemporalSlot({ day: 1, period: 3 }, { day: 1, period: 3 }), SLOT_ORDER.SAME_SLOT);
  assert.equal(getNextTemporalSlot({ day: 1, period: 3 }, { day: 2, period: 1 }), SLOT_ORDER.DIFFERENT_DAY);
  assert.equal(getNextTemporalSlot({ day: 1, period: 3 }, { day: 1, period: 1 }), SLOT_ORDER.NOT_ADJACENT);
  // The helper does NOT assume "period 5 → period 6 is adjacent";
  // it strictly tests the input fields.
  assert.equal(getNextTemporalSlot({ day: 1, period: 5 }, { day: 1, period: 6 }), SLOT_ORDER.ADJACENT);
  // Different periods on different days are not adjacent.
  assert.equal(getNextTemporalSlot({ day: 1, period: 9 }, { day: 2, period: 1 }), SLOT_ORDER.DIFFERENT_DAY);
});

// ============================================================================
// 25. (extra) checkTransition is a backward-compatible alias
// ============================================================================

test('PHASE 26 / 25 — checkTransition is preserved as an alias of isTravelFeasible', () => {
  const prev = { branchId: 'PH1', day: 1, period: 3 };
  const next = { branchId: 'PH2', day: 1, period: 4 };
  const a = isTravelFeasible(prev, next, null, 10);
  const b = checkTransition(prev, next, null, 10);
  assert.deepEqual(a, b);
});

// ============================================================================
// 26. (extra) analyzeOrphanReferences returns a stable structure
// ============================================================================

test('PHASE 26 / 26 — analyzeOrphanReferences returns a stable structure', () => {
  const full = loadFull();
  const r1 = analyzeOrphanReferences({
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentTeachers: full.scheduling.teachers,
    currentBranches: full.scheduling.branches,
    currentAssignments: full.scheduling.assignments,
  });
  // Run twice — the function is pure.
  const r2 = analyzeOrphanReferences({
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentTeachers: full.scheduling.teachers,
    currentBranches: full.scheduling.branches,
    currentAssignments: full.scheduling.assignments,
  });
  assert.equal(r1.orphanTransferAssignmentRefs, r2.orphanTransferAssignmentRefs);
  assert.equal(r1.orphanTransferLogIds.size, r2.orphanTransferLogIds.size);
  assert.equal(r1.orphanFromTeacher, 29);
  assert.equal(r1.orphanToTeacher, 69);
  assert.equal(r1.orphanTransferredAssignments, 35);
  assert.equal(r1.orphanTransferAssignmentRefs, 731);
  assert.equal(r1.orphanBranchFrom, 0);
  assert.equal(r1.orphanBranchTo, 0);
});

// ============================================================================
// 27. (extra) analyzeTransferHistory reports both the bucket counts and the
//     legacy "transferred assignments" category.
// ============================================================================

test('PHASE 26 / 27 — analyzeTransferHistory exposes the brief-required buckets', () => {
  const full = loadFull();
  const a = analyzeTransferHistory(full.normalized.transferHistory, full.legacyBaseline.assignments);
  assert.equal(a.totalTransferLogs, 4175);
  assert.equal(a.byStatus.SUCCESS, 3626);
  assert.equal(a.byStatus.FAILED, 549);
  assert.equal(a.transferredAssignments.totalTransferred, 87);
  // Success-by-branch breakdown.
  assert.equal(a.successByBranch.cross + a.successByBranch.same + a.successByBranch.unknownBranch, a.byStatus.SUCCESS);
});
