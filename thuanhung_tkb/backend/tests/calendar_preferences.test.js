import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionOf, sessionForSlot, countTeachingSessions } from '../src/domain/time.js';
import { slotsForBranch } from '../src/domain/constraints.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { preferencePenaltyBreakdown } from '../src/domain/metrics.js';
import { buildScheduleRows } from '../src/persistence/schedule-record.js';
import { loadBenchmarkDataset } from '../src/benchmark/dataset.js';
import { validateInput } from '../src/domain/validate.js';
import { solve } from '../src/domain/solver.js';
import { STRATEGY_C } from '../src/domain/strategies.js';
import { buildIndex, mapCalendar, mapPlacements } from '../src/api/mappers.js';

const branch = { id: 'b', schoolDays: [1,2,3,4,5], periods: [1,2,3,4,5,6,7], sessions: { sang: [1,2,3,4], chieu: [5,6,7] } };
function fixture(periods = [5], preference = {}) {
  const teacher = { id: 't', hoTen: 'Teacher', trangThai: 'active', eligibleSubjectIds: ['s'], nguyenVong: { buoiUuTien: 'ca_hai', ...preference } };
  const assignment = { id: 'a', classId: 'c', subjectId: 's', teacherId: 't', branchId: 'b', requiredPeriods: periods.length };
  const input = { teachers: [teacher], teacherIndex: new Map([['t', teacher]]), branches: [branch], classes: [{ id: 'c', branchId: 'b' }], subjects: [{ id: 's', isActive: true }], assignments: [assignment], assignmentIndex: new Map([['a', assignment]]) };
  const candidate = { assignments: new Map([['a', periods.map((period) => ({ branchId: 'b', teacherId: 't', day: 2, period }))]]), placements: new Map([['a', { teacherId: 't', branchId: 'b' }]]) };
  return { input, candidate };
}

for (const [period, expected] of [[1, 'sang'], [4, 'sang'], [5, 'chieu'], [7, 'chieu']]) {
  test(`calendar: default period ${period} is ${expected}`, () => assert.equal(sessionOf(period), expected));
}

test('calendar: generated slots, branch sessions and persisted sessions agree', () => {
  const slots = slotsForBranch(branch);
  assert.equal(slots.length, 33);
  for (const slot of slots) assert.equal(slot.session, sessionForSlot(slot, branch));
  assert.equal(slots.find((slot) => slot.period === 5).session, 'chieu');
  const { candidate, input } = fixture();
  candidate.assignments.get('a')[0] = slots.find((slot) => slot.day === 2 && slot.period === 5);
  assert.equal(buildScheduleRows(candidate, input).rows[0].session, 'chieu');
});

test('calendar: API preserves valid session-period pairs instead of a Cartesian product', () => {
  const { input, candidate } = fixture();
  input.timeSlotsByBranch = new Map([['b', slotsForBranch(branch)]]);
  const index = buildIndex(input);
  const days = mapCalendar(input, index).days;
  assert.deepEqual(days.find((day) => day.day === 1).periodsBySession.sang, [2,3,4]);
  assert.deepEqual(days.find((day) => day.day === 5).periodsBySession.sang, [1,2,3]);
  for (const day of days) {
    assert.deepEqual(day.periodsBySession.chieu, [5,6,7]);
    assert.ok(!day.periodsBySession.sang.includes(5));
  }
  assert.equal(mapPlacements(candidate, index)[0].session, 'chieu');
});

test('calendar: a contradictory session cannot bypass a same-teacher conflict', () => {
  const { candidate, input } = fixture([5]);
  candidate.assignments.get('a')[0].session = 'sang';
  const evaluation = evaluateCandidate(candidate, input);
  assert.equal(evaluation.summary.accepted, false);
  assert.ok(evaluation.hard.violations.some((violation) => violation.constraintId === 'H06'));
});

test('calendar: aliases are accepted only when their session matches the period', () => {
  const { candidate, input } = fixture([5]);
  candidate.assignments.get('a')[0].session = 'afternoon';
  assert.equal(evaluateCandidate(candidate, input).summary.accepted, true);
  candidate.assignments.get('a')[0].session = 'morning';
  assert.equal(evaluateCandidate(candidate, input).summary.accepted, false);
});

test('calendar: a profile declaring period 5 as morning is invalid, never a second session authority', () => {
  const { input, candidate } = fixture([5]);
  input.teachers[0].chuyenMon = [{ tenChuyenMon: 's', soTietTuan: 1 }];
  input.curriculum = input.assignments.map((assignment) => ({ ...assignment }));
  input.branches = [{ ...branch, sessions: { sang: [1,2,3,4,5], chieu: [6,7] } }];
  assert.ok(validateInput(input).issues.some((issue) => issue.entity === 'branch'));
  assert.notEqual(sessionForSlot({ period: 5 }, input.branches[0]), 'sang');
  assert.equal(evaluateCandidate(candidate, input).summary.accepted, false);
});

for (const [day, period] of [[1,1], [5,4]]) {
  test(`calendar: solver cannot place blocked day ${day} period ${period} from an injected slot pool`, () => {
    const { input } = fixture([period]);
    input.timeSlotsByBranch = new Map([['b', [{ branchId: 'b', day, period, session: 'sang' }]]]);
    input.strategy = { ...STRATEGY_C, solver: { maxSolutions: 1, timeLimitMs: 100 } };
    assert.equal(solve(input).solutions.length, 0);
  });
}

for (const [part, period, penalty] of [['MORNING', 5, 0], ['MORNING', 2, 1], ['AFTERNOON', 2, 0], ['AFTERNOON', 5, 1], ['FULL_DAY', 2, 1], ['FULL_DAY', 5, 1], ['NONE', 2, 0]]) {
  test(`soft off preference: ${part} at Tuesday period ${period} has penalty ${penalty}`, () => {
    const { candidate, input } = fixture([period], { preferredOffDay: 'TUESDAY', preferredOffPart: part });
    const evaluation = evaluateCandidate(candidate, input);
    const breakdown = preferencePenaltyBreakdown(candidate, input);
    assert.equal(evaluation.summary.accepted, true);
    assert.equal(breakdown.offDay, penalty);
    assert.equal(breakdown.offPart, penalty);
    assert.equal(evaluation.soft.violations.some((violation) => violation.constraintId === 'S03'), penalty > 0);
  });
}

test('soft off preference: overlay does not overwrite a genuine fixed day off', () => {
  const first = loadBenchmarkDataset({ preferenceStore: { readAll: () => ({}) } });
  const teacher = first.input.teachers[0];
  const loaded = loadBenchmarkDataset({ preferenceStore: { readAll: () => ({ [teacher.id]: { preferredOffDay: 'TUESDAY', preferredOffPart: 'MORNING', desiredTeachingSessionsPerWeek: null } }) } });
  const projected = loaded.input.teacherIndex.get(teacher.id);
  assert.deepEqual(projected.nguyenVong.thuNghi, teacher.nguyenVong.thuNghi);
  assert.equal(projected.nguyenVong.preferredOffDay, 'TUESDAY');
  assert.equal(evaluateCandidate({ assignments: new Map(), placements: new Map() }, loaded.input).constraintStatuses.H11, 'INACTIVE');
});

test('desired sessions: null means no preference', () => {
  const { candidate, input } = fixture([2], { desiredTeachingSessionsPerWeek: null });
  assert.equal(preferencePenaltyBreakdown(candidate, input).desiredSessions, 0);
});

test('legacy nguyenVong day list remains soft; only explicit fixedDayOff activates H11', () => {
  const { candidate, input } = fixture([2], { thuNghi: [2] });
  const evaluation = evaluateCandidate(candidate, input);
  assert.equal(evaluation.summary.accepted, true);
  assert.equal(evaluation.constraintStatuses.H11, 'INACTIVE');
  assert.equal(preferencePenaltyBreakdown(candidate, input).offPart, 1);
  input.teachers[0].fixedDayOff = [2];
  assert.ok(evaluateCandidate(candidate, input).hard.violations.some((violation) => violation.constraintId === 'H11'));
});

test('desired sessions: counts unique day/session, including an eligible teacher with zero sessions', () => {
  const { candidate, input } = fixture([1,2,3,4], { desiredTeachingSessionsPerWeek: 1 });
  assert.equal(countTeachingSessions(candidate.assignments, 't'), 1);
  assert.equal(preferencePenaltyBreakdown(candidate, input).desiredSessions, 0);
  candidate.assignments.get('a').push({ branchId: 'b', teacherId: 't', day: 2, period: 5 });
  assert.equal(countTeachingSessions(candidate.assignments, 't'), 2);
  assert.equal(preferencePenaltyBreakdown(candidate, input).desiredSessions, 1);
  assert.equal(preferencePenaltyBreakdown({ assignments: new Map() }, input).desiredSessions, 1);
});
