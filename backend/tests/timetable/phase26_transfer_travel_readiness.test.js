import { withExplicitTestTransferPolicy } from './helpers/scheduling-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadFromLegacySaplich } from '../../src/modules/timetable/engine/loader/legacy-saplich/index.js';
import { solve } from '../../src/modules/timetable/engine/domain/solver.js';
import { STRATEGY_C } from '../../src/modules/timetable/engine/domain/strategies.js';
import { evaluateCandidate, evaluateBaseline, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { buildBranchGraph, indexBranchGraph, resolveBranchId, resolveBranchIds, TRANSFER_POLICY_STATUS, TRANSFER_PERMISSION, TRANSFER_STATUS, homeBranchOf, allowedTransferBranchesOf, preferredTransferBranchesOf, canWorkAtBranch, isAllowedToWorkAt, auditTeacherTransferPolicy, summarizeTeacherTransferPolicy, analyzeTransferHistory, analyzeOrphanReferences, buildTransferAudit } from '../../src/modules/timetable/engine/domain/transfer/index.js';
import { TRAVEL_PROVIDER_STATUS, TRAVEL_FEASIBILITY_REASON, SLOT_ORDER, makeTravelProvider, makeMissingTravelProvider, makeUnsupportedTravelProvider, nullTravelProvider, getTravelProviderStatus, isTravelFeasible, getNextTemporalSlot, checkTransition } from '../../src/modules/timetable/engine/domain/travel/index.js';
function loadFull() {
  return loadFromLegacySaplich();
}
function solveReal(mode = 'GLOBAL_ASSIGNMENT_BALANCED', seed = 0xC0FFEE, timeLimitMs = 5_000) {
  const full = loadFull();
  const input = {
    ...withExplicitTestTransferPolicy(full.scheduling),
    strategy: STRATEGY_C
  };
  input.strategy = {
    ...STRATEGY_C,
    optimizationMode: mode,
    diversification: {
      ...STRATEGY_C.diversification,
      seed
    },
    solver: {
      timeLimitMs,
      maxSolutions: 1000
    }
  };
  const out = solve(input);
  return {
    out,
    input,
    full,
    solution: out.solutions[0] ?? null
  };
}
test('PHASE 26 / 1 — 7 branches resolved from real data', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  assert.equal(graph.length, 7);
  for (const node of graph) {
    assert.equal(typeof node.id, 'string');
    assert.equal(typeof node.code, 'string');
    assert.equal(typeof node.name, 'string');
    assert.equal(node.active, true);
  }
  const codes = graph.map(n => n.code).sort();
  assert.deepEqual(codes, ['PH1', 'PH2', 'PH3', 'PH4', 'PH5', 'PH6', 'PHC']);
  const schedGraph = buildBranchGraph(full.scheduling.branches);
  assert.equal(schedGraph.length, 7);
});
test('PHASE 26 / 2 — every teacher homeBranchId resolves to a branch in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  const index = indexBranchGraph(graph);
  for (const t of full.scheduling.teachers) {
    const home = homeBranchOf(t);
    if (home == null) continue;
    const r = resolveBranchId(home, graph);
    assert.equal(r.status, 'RESOLVED', `teacher ${t.id} home branch ${home} did not resolve`);
    assert.ok(index.has(home), `branch index must contain ${home}`);
  }
});
test('PHASE 26 / 3 — allowedTransferBranches, when present, resolve to branches in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  let checked = 0;
  for (const t of full.scheduling.teachers) {
    const allowed = allowedTransferBranchesOf(t);
    if (allowed.length === 0) continue;
    const r = resolveBranchIds(allowed, graph);
    for (const id of r.resolved) assert.ok(graph.find(n => n.id === id));
    for (const id of r.inactive) assert.fail(`inactive branch ${id} should not appear in active graph`);
    for (const id of r.unknown) assert.fail(`unknown branch ${id} in allowed list`);
    checked += 1;
  }
  assert.equal(checked, 0);
  const target1 = graph[0].id;
  const target2 = graph[1].id;
  const syntheticTeacher = {
    id: 'T-SYN',
    homeBranchId: graph[2].id,
    allowedTransferBranches: [target1, target2]
  };
  const r2 = resolveBranchIds(allowedTransferBranchesOf(syntheticTeacher), graph);
  assert.deepEqual(r2.resolved.sort(), [target1, target2].sort());
  assert.deepEqual(r2.inactive, []);
  assert.deepEqual(r2.unknown, []);
});
test('PHASE 26 / 4 — preferredTransferBranches, when present, resolve to branches in the graph', () => {
  const full = loadFull();
  const graph = buildBranchGraph(full.normalized.branches);
  let checked = 0;
  for (const t of full.scheduling.teachers) {
    const pref = preferredTransferBranchesOf(t);
    if (pref.length === 0) continue;
    const r = resolveBranchIds(pref, graph);
    for (const id of r.resolved) assert.ok(graph.find(n => n.id === id));
    checked += 1;
  }
  assert.equal(checked, 40);
  const target1 = graph[0].id;
  const target2 = graph[1].id;
  const syntheticTeacher = {
    id: 'T-SYN2',
    preferredTransferBranches: [target1, target2]
  };
  const r2 = resolveBranchIds(preferredTransferBranchesOf(syntheticTeacher), graph);
  assert.deepEqual(r2.resolved.sort(), [target1, target2].sort());
});
test('PHASE 26 / 5 — missing homeBranchId is reported, not fabricated', () => {
  const full = loadFull();
  const summary = summarizeTeacherTransferPolicy(full.scheduling.teachers);
  assert.equal(summary.total, 40);
  assert.equal(summary.withoutHomeBranch, 0);
  const t = {
    id: 'T-NO-HOME'
  };
  assert.equal(homeBranchOf(t), null);
  const audit = auditTeacherTransferPolicy(t);
  assert.equal(audit.hasHomeBranch, false);
  assert.equal(audit.homeBranchId, null);
});
test('PHASE 26 / 6 — canWorkAtBranch never reads travel data', () => {
  const t = {
    id: 'T-POLICY',
    homeBranchId: 'PH1',
    allowedTransferBranches: ['PH2']
  };
  const r1 = canWorkAtBranch(t, 'PH1');
  assert.equal(r1.status, TRANSFER_POLICY_STATUS.HOME);
  const r2 = canWorkAtBranch(t, 'PH2');
  assert.equal(r2.status, TRANSFER_POLICY_STATUS.ALLOWED);
  const r3 = canWorkAtBranch(t, 'PH3');
  assert.equal(r3.status, TRANSFER_POLICY_STATUS.NOT_ALLOWED);
  const policyOnly = canWorkAtBranch(t, 'PH2');
  const provider = nullTravelProvider();
  const t1 = {
    branchId: 'PH1',
    day: 1,
    period: 3
  };
  const t2 = {
    branchId: 'PH2',
    day: 1,
    period: 4
  };
  const travel = isTravelFeasible(t1, t2, provider, 10);
  assert.equal(policyOnly.status, TRANSFER_POLICY_STATUS.ALLOWED);
  assert.equal(travel.reason, TRAVEL_FEASIBILITY_REASON.MISSING_PROVIDER);
});
test('PHASE 26 / 7 — historical transferred assignments = 87', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.transferHistory.transferredAssignments.totalTransferred, 87);
});
test('PHASE 26 / 8 — historical transfer logs = 4175', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.transferHistory.totalTransferLogs, 4175);
});
test('PHASE 26 / 9 — transfer logs SUCCESS = 3626', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.transferHistory.byStatus.SUCCESS, 3626);
});
test('PHASE 26 / 10 — transfer logs FAILED = 549', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.transferHistory.byStatus.FAILED, 549);
});
test('PHASE 26 / 11 — orphan transfer references = 731 (transfer logs with orphan assignment id)', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.orphans.orphanTransferAssignmentRefs, 731);
});
test('PHASE 26 / 12 — orphan logs preserved in the audit (no deletion)', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  const originalLength = full.normalized.transferHistory.length;
  const audit2 = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(full.normalized.transferHistory.length, originalLength);
  assert.equal(audit.orphans.orphanTransferLogIds.size, audit2.orphans.orphanTransferLogIds.size);
  assert.ok(audit.orphans.orphanFromTeacher >= 0);
  assert.ok(audit.orphans.orphanToTeacher >= 0);
  assert.ok(audit.orphans.orphanTransferredAssignments >= 0);
});
test('PHASE 26 / 13 — failure reasons preserved verbatim from source', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  const reasons = audit.transferHistory.failureReasons.reasons;
  assert.equal(reasons.ADJACENT_SLOT_AT_BRANCH, 223);
  assert.equal(reasons.TEACHER_CONFLICT, 184);
  assert.equal(reasons.SAME_SESSION_AT_MAIN_BRANCH, 141);
  assert.equal(reasons.SPECIALIZATION_MISMATCH, 1);
  assert.equal(audit.transferHistory.failureReasons.totalFailed, 549);
});
test('PHASE 26 / 14 — H14 (Travel feasibility) remains UNSUPPORTED', () => {
  const full = loadFull();
  const evaluation = evaluateCandidate({
    assignments: new Map(),
    placements: new Map()
  }, full.scheduling);
  assert.equal(evaluation.constraintStatuses.H14, 'UNSUPPORTED');
  assert.ok(evaluation.unsupported.some(e => e.constraintId === 'H14'), 'H14 must be in the unsupported list');
  assert.equal(evaluation.hard.violations.find(v => v.constraintId === 'H14'), undefined, 'H14 must never emit a violation while UNSUPPORTED');
  assert.equal(evaluation.constraintStatuses.H13, 'ACTIVE');
});
test('PHASE 26 / 15 — no travel matrix is fabricated by the audit or solver', () => {
  const full = loadFull();
  assert.equal(full.scheduling.travelTime, null);
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  assert.equal(audit.h14.status, 'UNSUPPORTED');
  const t = {
    id: 'T-X',
    homeBranchId: 'PH1',
    allowedTransferBranches: ['PH2']
  };
  const r = canWorkAtBranch(t, 'PH2');
  assert.equal(r.status, TRANSFER_POLICY_STATUS.ALLOWED);
  assert.equal(typeof r.source, 'string');
});
test('PHASE 26 / 16 — TravelProvider interface is deterministic', () => {
  const provider = makeTravelProvider({
    PH1: {
      PH2: 15,
      PH3: 20
    },
    PH2: {
      PH1: 15
    }
  });
  for (let i = 0; i < 5; i++) {
    assert.equal(provider.travelTime('PH1', 'PH2', 3), 15);
    assert.equal(provider.travelTime('PH1', 'PH3', 3), 20);
    assert.equal(provider.travelTime('PH1', 'PH4', 3), null);
    assert.equal(provider.travelTime('PH1', 'PH1', 3), 0);
    assert.equal(provider.status(), TRAVEL_PROVIDER_STATUS.READY);
  }
});
test('PHASE 26 / 17 — unknown travel does not become 0', () => {
  const missing = makeMissingTravelProvider();
  assert.equal(missing.status(), TRAVEL_PROVIDER_STATUS.MISSING);
  assert.equal(missing.travelTime('PH1', 'PH2', 3), null);
  assert.equal(missing.travelTime('PH1', 'PH1', 3), null);
  const empty = makeTravelProvider({});
  assert.equal(empty.status(), TRAVEL_PROVIDER_STATUS.READY);
  assert.equal(empty.travelTime('PH1', 'PH2', 3), null);
  assert.equal(empty.travelTime('PH1', 'PH1', 3), 0);
  const r = isTravelFeasible({
    branchId: 'PH1',
    day: 1,
    period: 3
  }, {
    branchId: 'PH2',
    day: 1,
    period: 4
  }, empty, 10);
  assert.equal(r.feasible, false);
  assert.equal(r.minutes, null);
  assert.equal(r.reason, TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA);
  const r2 = isTravelFeasible({
    branchId: 'PH1',
    day: 1,
    period: 3
  }, {
    branchId: 'PH2',
    day: 1,
    period: 4
  }, missing, 10);
  assert.equal(r2.reason, TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA);
  assert.equal(r2.minutes, null);
  const unsupported = makeUnsupportedTravelProvider();
  const r3 = isTravelFeasible({
    branchId: 'PH1',
    day: 1,
    period: 3
  }, {
    branchId: 'PH2',
    day: 1,
    period: 4
  }, unsupported, 10);
  assert.equal(r3.reason, TRAVEL_FEASIBILITY_REASON.PROVIDER_UNSUPPORTED);
  const r4 = isTravelFeasible({
    branchId: 'PH1',
    day: 1,
    period: 3
  }, {
    branchId: 'PH2',
    day: 1,
    period: 4
  }, null, 10);
  assert.equal(r4.reason, TRAVEL_FEASIBILITY_REASON.MISSING_PROVIDER);
});
test('PHASE 26 / 19 — transfer helpers are deterministic and pure', () => {
  const teachers = [{
    id: 'A',
    homeBranchId: 'PH1',
    allowedTransferBranches: ['PH2']
  }, {
    id: 'B',
    homeBranchId: 'PH1',
    allowedTransferBranches: []
  }, {
    id: 'C',
    homeBranchId: null,
    allowedTransferBranches: ['PH2']
  }, {
    id: 'D',
    homeBranchId: 'PH1',
    preferredTransferBranches: ['PH3']
  }];
  const expected = [['A', 'PH1', TRANSFER_POLICY_STATUS.HOME], ['A', 'PH2', TRANSFER_POLICY_STATUS.ALLOWED], ['A', 'PH3', TRANSFER_POLICY_STATUS.NOT_ALLOWED], ['B', 'PH1', TRANSFER_POLICY_STATUS.HOME], ['B', 'PH2', TRANSFER_POLICY_STATUS.NOT_ALLOWED], ['C', 'PH1', TRANSFER_POLICY_STATUS.NOT_ALLOWED], ['C', 'PH2', TRANSFER_POLICY_STATUS.ALLOWED], ['D', 'PH3', TRANSFER_POLICY_STATUS.NOT_ALLOWED]];
  for (let i = 0; i < 3; i++) {
    for (const [tid, bid, status] of expected) {
      const t = teachers.find(x => x.id === tid);
      const r = canWorkAtBranch(t, bid);
      assert.equal(r.status, status, `${tid} @ ${bid} expected ${status}, got ${r.status}`);
      const expectedPermission = status === TRANSFER_POLICY_STATUS.HOME || status === TRANSFER_POLICY_STATUS.ALLOWED ? TRANSFER_PERMISSION.ALLOW : status === TRANSFER_POLICY_STATUS.NOT_ALLOWED ? TRANSFER_PERMISSION.DENY : TRANSFER_PERMISSION.UNKNOWN;
      assert.equal(isAllowedToWorkAt(t, bid), expectedPermission);
    }
  }
});
test('PHASE 26 / 20 — baseline transfer rows are HISTORICAL only (not solver-fixed)', () => {
  const full = loadFull();
  const audit = buildTransferAudit({
    branches: full.normalized.branches,
    teachers: full.scheduling.teachers,
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentAssignments: full.scheduling.assignments
  });
  const transferredRows = full.legacyBaseline.assignments.filter(a => a.isTransferred);
  assert.equal(transferredRows.length, audit.transferHistory.transferredAssignments.totalTransferred);
  const schedTransferred = full.scheduling.assignments.filter(a => a.isTransferred);
  assert.equal(schedTransferred.length, 87);
  for (const a of schedTransferred.slice(0, 5)) {
    assert.equal(a.baselineAssignment, true);
  }
});
test('PHASE 26 / 21 — Phase 25 GLOBAL_ASSIGNMENT_BALANCED still produces a candidate on real data', () => {
  const {
    out,
    solution
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.equal(out.failure, null);
  assert.ok(solution, 'solver must return a candidate');
  assert.equal(solution.metrics.hardViolations, 0);
  assert.equal(solution.metrics.teacherCount, 40);
  assert.equal(solution.metrics.totalPeriods, 802);
});
test('PHASE 26 / 22 — generated GLOBAL candidate is valid; legacy baseline is judged under current rules', () => {
  const {
    solution,
    input,
    full
  } = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
  assert.ok(solution, 'solver must return a candidate');
  const placements = new Map();
  for (const a of full.scheduling.assignments) {
    const p = solution.placements.get(a.id);
    if (p) placements.set(a.id, {
      teacherId: p.teacherId,
      branchId: p.branchId
    });
  }
  const candidate = {
    assignments: solution.assignments,
    placements
  };
  const evaluation = evaluateCandidate(candidate, input);
  assert.equal(evaluation.summary.totalHardViolations, 0);
  assert.equal(isAccepted(evaluation), true);
  const baselineEval = evaluateBaseline(full.legacyBaseline, input);
  assert.ok(baselineEval.evaluation.summary.totalHardViolations > 0);
});
test('PHASE 26 / 23 — getTravelProviderStatus normalises all three factory outputs', () => {
  assert.equal(getTravelProviderStatus(makeTravelProvider({})), TRAVEL_PROVIDER_STATUS.READY);
  assert.equal(getTravelProviderStatus(makeMissingTravelProvider()), TRAVEL_PROVIDER_STATUS.MISSING);
  assert.equal(getTravelProviderStatus(makeUnsupportedTravelProvider()), TRAVEL_PROVIDER_STATUS.UNSUPPORTED);
  assert.equal(getTravelProviderStatus(null), TRAVEL_PROVIDER_STATUS.UNSUPPORTED);
});
test('PHASE 26 / 24 — getNextTemporalSlot is order-aware and pure', () => {
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 3
  }, {
    day: 1,
    period: 4
  }), SLOT_ORDER.ADJACENT);
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 3
  }, {
    day: 1,
    period: 3
  }), SLOT_ORDER.SAME_SLOT);
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 3
  }, {
    day: 2,
    period: 1
  }), SLOT_ORDER.DIFFERENT_DAY);
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 3
  }, {
    day: 1,
    period: 1
  }), SLOT_ORDER.NOT_ADJACENT);
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 5
  }, {
    day: 1,
    period: 6
  }), SLOT_ORDER.ADJACENT);
  assert.equal(getNextTemporalSlot({
    day: 1,
    period: 9
  }, {
    day: 2,
    period: 1
  }), SLOT_ORDER.DIFFERENT_DAY);
});
test('PHASE 26 / 25 — checkTransition is preserved as an alias of isTravelFeasible', () => {
  const prev = {
    branchId: 'PH1',
    day: 1,
    period: 3
  };
  const next = {
    branchId: 'PH2',
    day: 1,
    period: 4
  };
  const a = isTravelFeasible(prev, next, null, 10);
  const b = checkTransition(prev, next, null, 10);
  assert.deepEqual(a, b);
});
test('PHASE 26 / 26 — analyzeOrphanReferences returns a stable structure', () => {
  const full = loadFull();
  const r1 = analyzeOrphanReferences({
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentTeachers: full.scheduling.teachers,
    currentBranches: full.scheduling.branches,
    currentAssignments: full.scheduling.assignments
  });
  const r2 = analyzeOrphanReferences({
    transferHistory: full.normalized.transferHistory,
    baselineAssignments: full.legacyBaseline.assignments,
    currentTeachers: full.scheduling.teachers,
    currentBranches: full.scheduling.branches,
    currentAssignments: full.scheduling.assignments
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
test('PHASE 26 / 27 — analyzeTransferHistory exposes the brief-required buckets', () => {
  const full = loadFull();
  const a = analyzeTransferHistory(full.normalized.transferHistory, full.legacyBaseline.assignments);
  assert.equal(a.totalTransferLogs, 4175);
  assert.equal(a.byStatus.SUCCESS, 3626);
  assert.equal(a.byStatus.FAILED, 549);
  assert.equal(a.transferredAssignments.totalTransferred, 87);
  assert.equal(a.successByBranch.cross + a.successByBranch.same + a.successByBranch.unknownBranch, a.byStatus.SUCCESS);
});
