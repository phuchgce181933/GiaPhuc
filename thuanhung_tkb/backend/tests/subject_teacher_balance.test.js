import test from 'node:test';
import assert from 'node:assert/strict';
import { subjectTeacherWorkload } from '../src/domain/metrics.js';
import { compareOptimizationCandidates } from '../src/domain/comparator.js';
import { optimizeSubjectTeacherBalance } from '../src/domain/subject-teacher-balance.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { slotsForBranch } from '../src/domain/constraints.js';
import { deriveMetrics } from '../src/domain/metrics.js';

const branch = { id: 'b', schoolDays: [1,2,3,4,5], periods: [1,2,3,4,5,6,7], sessions: { sang:[1,2,3,4], chieu:[5,6,7] } };
const teachers = ['t1','t2','t3'].map((id) => ({ id, trangThai: 'active', eligibleSubjectIds: ['s'] }));

function fixture(loads = [3,2,1]) {
  let n = 0;
  const availableSlots = slotsForBranch(branch);
  const assignments = [];
  const rows = [];
  for (let teacher = 0; teacher < loads.length; teacher += 1) {
    for (let i = 0; i < loads[teacher]; i += 1) {
      const id = `a${n}`;
      assignments.push({ id, classId: `c${n}`, subjectId: 's', teacherId: `t${teacher + 1}`, branchId: 'b', requiredPeriods: 1 });
      rows.push([id, [{ ...availableSlots[n % availableSlots.length], teacherId: `t${teacher + 1}` }]]);
      n += 1;
    }
  }
  const input = {
    branches: [branch], teachers, subjects: [{ id: 's', name: 'Math', trangThai: 'active' }], classes: [],
    assignments, assignmentIndex: new Map(assignments.map((a) => [a.id, a])), teacherIndex: new Map(teachers.map((t) => [t.id, t])),
    timeSlotsByBranch: new Map([['b', slotsForBranch(branch)]]),
  };
  const candidate = { assignments: new Map(rows), placements: new Map(rows.map(([id, slots]) => [id, { teacherId: slots[0].teacherId, branchId: 'b' }])) };
  return { input, candidate };
}

test('subject workload includes eligible zero-load teachers and omits singleton subjects', () => {
  const { input, candidate } = fixture([2]);
  input.teachers = [teachers[0]];
  const result = subjectTeacherWorkload(candidate, input);
  assert.deepEqual(result.report, {});
  const multi = fixture();
  const report = subjectTeacherWorkload(multi.candidate, multi.input);
  assert.deepEqual(report.report.Math.teachers.map((t) => t.periods), [3,2,1]);
  assert.equal(report.subjectWorkloadSpread, 2);
  const withZero = fixture([2,1]);
  assert.deepEqual(subjectTeacherWorkload(withZero.candidate, withZero.input).report.Math.teachers.map((t) => t.periods), [2,1,0]);
  withZero.input.teachers[0].eligibleSubjectIds.push('another-subject');
  assert.equal(subjectTeacherWorkload(withZero.candidate, withZero.input).report.Math.teachers[0].periods, 2);
});

test('subject spread is a comparator objective after overall teacher spread', () => {
  const a = { assignments: new Map(), metrics: { subjectWorkloadSpread: 0 } };
  const b = { assignments: new Map(), metrics: { subjectWorkloadSpread: 1 } };
  assert.equal(compareOptimizationCandidates(a, b), -1);
});

test('best-found reassignment improves subject load while preserving independent feasibility', () => {
  const { input, candidate } = fixture();
  candidate.metrics = { hardViolations: 0, workloadSpread: 2, maxTeacherLoad: 3, workloadStdev: 0.816, subjectWorkloadSpread: 2, subjectWorkloadStdev: 0.816, preferencePenalty: 0 };
  const result = optimizeSubjectTeacherBalance(candidate, input, { maxSearchNodes: 60, maxSearchIterations: 60 });
  assert.ok(result.diagnostics.assignmentsTransferred > 0);
  assert.equal(result.candidate.metrics.subjectWorkloadSpread, 0);
  const evaluated = evaluateCandidate(result.candidate, input);
  assert.equal(evaluated.hard.violations.length, 0);
});

test('overall and subject balance include zero-load eligible teachers: [2,1] beats [3,0]', () => {
  const make = (loads) => {
    const { input, candidate } = fixture(loads);
    input.teachers = input.teachers.slice(0, 2);
    candidate.metrics = deriveMetrics(candidate, input, null, evaluateCandidate(candidate, input));
    return candidate;
  };
  const concentrated = make([3,0]);
  const balanced = make([2,1]);
  assert.equal(concentrated.metrics.overallWorkloadSpread, 3);
  assert.equal(balanced.metrics.overallWorkloadSpread, 1);
  assert.ok(compareOptimizationCandidates(balanced, concentrated) < 0);
});

test('subject balance reports [30,10,0] and sums actual periods once for a multi-specialization teacher', () => {
  const { input, candidate } = fixture([30,10,0]);
  assert.deepEqual(subjectTeacherWorkload(candidate, input).report.Math.teachers.map((teacher) => teacher.periods), [30,10,0]);
});

test('local transfer: every kept move respects target permission and rebuilds transfer metadata', () => {
  const { input, candidate } = fixture([3,0,0]);
  input.teachers = input.teachers.map((teacher, index) => ({ ...teacher, homeBranchId: index ? 'other' : 'b', allowedTransferBranches: index ? ['b'] : [] }));
  input.teacherIndex = new Map(input.teachers.map((teacher) => [teacher.id, teacher]));
  candidate.transfers = [{ teacherId: 'stale', fromBranchId: 'wrong', toBranchId: 'wrong' }];
  const result = optimizeSubjectTeacherBalance(candidate, input, { maxSearchNodes: 100, maxSearchIterations: 10 });
  assert.ok(result.diagnostics.assignmentsTransferred > 0);
  assert.equal(result.diagnostics.verdict, 'BEST_FOUND');
  assert.ok(result.candidate.transfers.every((transfer) => transfer.teacherId !== 'stale' && transfer.fromBranchId === 'other' && transfer.toBranchId === 'b'));
  assert.equal(result.candidate.transfers.length, 2);
  assert.equal(evaluateCandidate(result.candidate, input).summary.accepted, true);
  input.teachers.forEach((teacher) => { teacher.allowedTransferBranches = []; });
  const denied = optimizeSubjectTeacherBalance(candidate, input, { maxSearchNodes: 100, maxSearchIterations: 10 });
  assert.equal(denied.diagnostics.assignmentsTransferred, 0);
});

test('local transfer: declared budget counts rounds separately from attempted moves', () => {
  const { input, candidate } = fixture([12,0,0]);
  const result = optimizeSubjectTeacherBalance(candidate, input, { maxSearchNodes: 200, maxSearchIterations: 10 });
  assert.ok(result.diagnostics.searchNodes > 8);
  assert.ok(result.diagnostics.iterations <= 10);
  assert.equal(result.candidate.metrics.subjectWorkloadSpread, 0);
});
