import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFinalSolutions } from '../../src/modules/timetable/engine/domain/global-scoring.js';
import { deriveMetrics } from '../../src/modules/timetable/engine/domain/metrics.js';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { generateSolutions } from '../../src/modules/timetable/engine/domain/multi-solution.js';
import { buildControlledFixture } from '../../src/modules/timetable/engine/loader/catalog-dataset.js';
function pool() {
  const teachers = ['A', 'B'].map(id => ({
    id,
    homeBranchId: 'b',
    eligibleSubjectIds: ['s'],
    nguyenVong: {
      buoiUuTien: 'sang'
    }
  }));
  const assignments = [1, 2, 3].map(id => ({
    id: String(id),
    teacherId: 'A',
    classId: `c${id}`,
    subjectId: 's',
    branchId: 'b',
    requiredPeriods: 1
  }));
  const input = {
    teachers,
    teacherIndex: new Map(teachers.map(teacher => [teacher.id, teacher])),
    assignments,
    assignmentIndex: new Map(assignments.map(assignment => [assignment.id, assignment])),
    classes: assignments.map(assignment => ({
      id: assignment.classId,
      branchId: 'b'
    })),
    subjects: [{
      id: 's',
      name: 'Subject'
    }],
    branches: [{
      id: 'b',
      schoolDays: [2],
      periods: [1, 2, 3, 4, 5, 6, 7],
      sessions: {
        sang: [1, 2, 3, 4],
        chieu: [5, 6, 7]
      }
    }],
    curriculum: assignments.map(assignment => ({
      ...assignment
    }))
  };
  const make = (id, periods, teacherIds) => {
    const candidate = {
      id,
      assignments: new Map(assignments.map((assignment, index) => [assignment.id, [{
        branchId: 'b',
        day: 2,
        period: periods[index],
        teacherId: teacherIds[index]
      }]])),
      placements: new Map(assignments.map((assignment, index) => [assignment.id, {
        branchId: 'b',
        teacherId: teacherIds[index]
      }]))
    };
    candidate.metrics = deriveMetrics(candidate, input, null, evaluateCandidate(candidate, input));
    return candidate;
  };
  return {
    input,
    candidates: [make('balanced', [5, 6, 7], ['A', 'A', 'B']), make('preferred', [2, 3, 4], ['A', 'A', 'A'])]
  };
}
const weightsFor = dimension => Object.fromEntries(['WORKLOAD_BALANCE', 'MAX_TEACHER_LOAD', 'WORKLOAD_STDEV', 'PREFERENCE', 'STRUCTURAL_DIVERSITY', 'SLOT_DIVERSITY'].map(id => [id, id === dimension ? 3 : 0]));
test('selection: explicit workload versus preference weights change selection from the same feasible pool', () => {
  const {
    input,
    candidates
  } = pool();
  const choose = dimension => selectFinalSolutions(candidates, {
    input,
    count: 1,
    scoringConfig: {
      weights: weightsFor(dimension)
    }
  });
  assert.equal(choose('WORKLOAD_BALANCE').solutions[0].id, 'balanced');
  assert.equal(choose('PREFERENCE').solutions[0].id, 'preferred');
});
test('selection: changing weights cannot admit a hard-invalid candidate', () => {
  const {
    input,
    candidates
  } = pool();
  candidates[1].placements.get('1').teacherId = 'unknown';
  const result = selectFinalSolutions(candidates, {
    input,
    count: 1,
    scoringConfig: {
      weights: weightsFor('PREFERENCE')
    }
  });
  assert.equal(result.solutions[0].id, 'balanced');
  assert.equal(result.diagnostics.rejectedInfeasible, 1);
});
test('selection: evaluator exceptions fail closed', () => {
  const {
    input,
    candidates
  } = pool();
  input.teacherIndex = {
    get() {
      throw new Error('broken input index');
    }
  };
  const result = selectFinalSolutions(candidates, {
    input,
    count: 1
  });
  assert.equal(result.solutions.length, 0);
});
test('multi-solution: BASE generation does not search discarded candidates within each solve', () => {
  const input = buildControlledFixture();
  input.strategy = {
    ...input.strategy,
    optimizationMode: 'BASE_FEASIBLE',
    solver: {
      maxSolutions: 50
    }
  };
  const output = generateSolutions(input, {
    count: 1,
    respectStrategyMode: true,
    maxSearchIterations: 50,
    perSolveTimeBudgetMs: 1000
  });
  assert.equal(output.solutions.length, 1);
  assert.equal(output.diagnostics.completeCandidates, 1);
});
