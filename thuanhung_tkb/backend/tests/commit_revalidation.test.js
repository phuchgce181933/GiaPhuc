import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildControlledFixture, loadBenchmarkDataset } from '../src/benchmark/dataset.js';
import { solve } from '../src/domain/solver.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { PreviewStore, generateSchedules } from '../src/api/generate.js';
import { commit } from '../src/api/commit.js';
import { ScheduleStore } from '../src/persistence/schedule-store.js';
import { expandAssignmentVariants } from '../src/domain/constraints.js';

function transferFixture() {
  const input = buildControlledFixture();
  input.curriculum = input.assignments.map(({ classId, subjectId, requiredPeriods }) => ({ classId, subjectId, requiredPeriods }));
  input.strategy = { ...input.strategy, solver: { maxSolutions: 1, maxSearchIterations: 1, timeLimitMs: 1000 } };
  const candidate = solve(input).solutions[0];
  assert.ok(candidate);
  const assignment = input.assignments.find((row) => row.requiredPeriods === 3);
  const target = { ...input.teachers[0], id: 'target', hoTen: 'Target teacher', homeBranchId: 'other', allowedTransferBranches: [assignment.branchId], nguyenVong: { buoiUuTien: 'ca_hai', soBuoiToiDa: 0, thuNghi: [] } };
  input.teachers = [...input.teachers, target];
  input.teacherIndex = new Map(input.teachers.map((teacher) => [teacher.id, teacher]));
  candidate.placements.set(assignment.id, { teacherId: target.id, branchId: assignment.branchId });
  // Keep the old teacher stamped on the slots: placement must be authoritative.
  return { input, candidate, assignment, target };
}

for (const [rule, change] of [
  ['H03', (fixture) => { fixture.target.eligibleSubjectIds = ['other']; fixture.target.chuyenMon = [{ tenChuyenMon: 'other', soTietTuan: 1 }]; }],
  ['H08', (fixture) => { fixture.target.trangThai = 'inactive'; }],
  ['H09', (fixture) => { fixture.target.capacityPeriodsPerWeek = 2; }],
  ['H10', (fixture) => { fixture.target.nguyenVong.soBuoiToiDa = 1; }],
  ['H11', (fixture) => { fixture.target.fixedDayOff = [fixture.candidate.assignments.get(fixture.assignment.id)[0].day]; }],
  ['H13', (fixture) => { fixture.target.allowedTransferBranches = []; }],
]) {
  test(`commit: target teacher violation ${rule} is rejected before any write`, async () => {
    const fixture = transferFixture(); change(fixture);
    assert.ok(evaluateCandidate(fixture.candidate, fixture.input).hard.violations.some((violation) => violation.constraintId === rule));
    const dir = mkdtempSync(join(tmpdir(), 'tkb-target-commit-'));
    try {
      const previewStore = new PreviewStore();
      previewStore.put('request', [{ id: 'solution', candidate: fixture.candidate, solution: { rank: 1 } }]);
      const scheduleStore = new ScheduleStore({ dir });
      const result = await commit({ body: { requestId: 'request', solutionId: 'solution' }, deps: { previewStore, scheduleStore, loadDataset: () => ({ input: fixture.input, provenance: {} }) } });
      assert.equal(result.status, 409);
      assert.equal(result.payload.persisted, false);
      assert.equal(scheduleStore.list().length, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('commit: an eligible, permitted target survives revalidation and readback contains the effective teacher', async () => {
  const fixture = transferFixture();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-target-commit-'));
  try {
    const previewStore = new PreviewStore();
    previewStore.put('request', [{ id: 'solution', candidate: fixture.candidate, solution: { rank: 1 } }]);
    const scheduleStore = new ScheduleStore({ dir });
    const result = await commit({ body: { requestId: 'request', solutionId: 'solution' }, deps: { previewStore, scheduleStore, loadDataset: () => ({ input: fixture.input, provenance: {} }) } });
    assert.equal(result.status, 200);
    const rows = scheduleStore.read(result.payload.scheduleId).slots.filter((slot) => slot.assignmentId === fixture.assignment.id);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((slot) => slot.teacherId === fixture.target.id));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cross-branch variants: destination is the class branch and requires explicit permission', () => {
  const fixture = transferFixture();
  fixture.assignment.baselineAssignment = false; // explicit operator-fixed decision, not imported history
  fixture.assignment.teacherId = fixture.target.id;
  const variants = expandAssignmentVariants(fixture.assignment, fixture.input);
  assert.deepEqual(variants, [{ teacherId: fixture.target.id, branchId: fixture.assignment.branchId }]);
  fixture.target.allowedTransferBranches = [];
  assert.deepEqual(expandAssignmentVariants(fixture.assignment, fixture.input), []);
});

test('real legacy API generation in EXPLICIT mode: missing branch permissions produce an honest empty result', async () => {
  const loaded = loadBenchmarkDataset({ transferPolicy:'EXPLICIT', catalogStore:{read:()=>({schemaVersion:1,revision:0,teachers:{},subjects:{},classes:{}})}, preferenceStore: { readAll: () => ({}) } });
  const result = await generateSchedules({ body: { candidateCount: 1, optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED', useAI: false },
    deps: { loadDataset: () => loaded, previewStore: new PreviewStore(), makePlanner: () => null, aiProviderName: 'off' } });
  assert.equal(result.status, 200);
  assert.equal(result.payload.status, 'EMPTY');
  assert.equal(result.payload.solutions.length, 0);
  assert.equal(result.payload.transfer.h13, 'ACTIVE');
  assert.equal(result.payload.travel.h14, 'UNSUPPORTED');
  assert.ok(result.payload.diagnostics.solver.rejectedReasons.some((reason) => reason.failure === 'UNRESOLVABLE_ASSIGNMENT'));
  const blocked = loaded.input.assignments.filter((assignment) =>
    expandAssignmentVariants(assignment, loaded.input, { allowTeacherChange: true }).length === 0);
  assert.equal(blocked.length, 61);
  const noPermission = result.payload.diagnostics.solver.unresolvable.filter((row) => row.reasonCode === 'NO_PERMITTED_TEACHER');
  assert.deepEqual(noPermission.map((row) => row.assignmentId).sort(),
    blocked.map((assignment) => assignment.id).sort());
  assert.equal(new Set(noPermission.map((row) => row.assignmentId)).size, 61);
  assert.ok(result.payload.diagnostics.solver.unresolvable.every((row) =>
    row.eligibleTeacherCount > 0 && row.classId && row.subjectId && row.branchId));
  assert.equal(noPermission.reduce((sum, row) => sum + row.requiredPeriods, 0), 76);
  const branchStage = result.payload.diagnostics.solver.branchScheduling;
  assert.equal(branchStage.localAssignments, 417);
  assert.equal(branchStage.localPeriods, 722);
  assert.equal(branchStage.pendingAssignments.length, 62);
  assert.equal(result.payload.diagnostics.solver.unresolvable.find((row) => row.reasonCode === 'LOCAL_CAPACITY_REQUIRES_TRANSFER').requiredPeriods, 4);
});
