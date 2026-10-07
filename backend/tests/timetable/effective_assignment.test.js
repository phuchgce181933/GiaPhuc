import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCandidate } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { deriveMetrics } from '../../src/modules/timetable/engine/domain/metrics.js';
import { getConstraint } from '../../src/modules/timetable/engine/domain/constraints/catalog.js';
function transferred({
  target = {},
  periods = [[2, 2]],
  placementsAsArray = false
} = {}) {
  const teachers = [{
    id: 'A',
    hoTen: 'A',
    trangThai: 'active',
    eligibleSubjectIds: ['s'],
    chuyenMon: [{
      tenChuyenMon: 's',
      soTietTuan: 20
    }],
    nguyenVong: {
      buoiUuTien: 'ca_hai',
      thuNghi: []
    }
  }, {
    id: 'B',
    hoTen: 'B',
    trangThai: 'active',
    eligibleSubjectIds: ['s'],
    chuyenMon: [{
      tenChuyenMon: 's',
      soTietTuan: 20
    }],
    nguyenVong: {
      buoiUuTien: 'ca_hai',
      thuNghi: []
    },
    ...target
  }];
  const assignment = {
    id: 'a',
    teacherId: 'A',
    classId: 'c',
    subjectId: 's',
    branchId: 'b',
    requiredPeriods: periods.length
  };
  const slots = periods.map(([day, period]) => ({
    branchId: 'b',
    day,
    period,
    session: period <= 4 ? 'sang' : 'chieu',
    teacherId: 'A'
  }));
  const placementEntries = [['a', {
    teacherId: 'B',
    branchId: 'b'
  }]];
  const candidate = {
    assignments: new Map([['a', slots]]),
    placements: placementsAsArray ? placementEntries : new Map(placementEntries)
  };
  const input = {
    teachers,
    teacherIndex: new Map(teachers.map(teacher => [teacher.id, teacher])),
    branches: [{
      id: 'b',
      schoolDays: [1, 2, 3, 4, 5],
      periods: [1, 2, 3, 4, 5, 6, 7],
      sessions: {
        sang: [1, 2, 3, 4],
        chieu: [5, 6, 7]
      }
    }],
    subjects: [{
      id: 's',
      name: 'Subject',
      isActive: true
    }],
    classes: [{
      id: 'c',
      branchId: 'b',
      gradeLevel: 2
    }],
    assignments: [assignment],
    assignmentIndex: new Map([['a', assignment]]),
    travelTime: null
  };
  return {
    input,
    candidate
  };
}
function rejects(fixture, id) {
  const evaluation = evaluateCandidate(fixture.candidate, fixture.input);
  assert.equal(evaluation.summary.accepted, false);
  assert.ok(evaluation.hard.violations.some(violation => violation.constraintId === id), JSON.stringify(evaluation));
}
test('effective teacher: transfer to an ineligible teacher is rejected by H03', () => {
  rejects(transferred({
    target: {
      eligibleSubjectIds: ['other'],
      chuyenMon: [{
        tenChuyenMon: 'other',
        soTietTuan: 20
      }]
    }
  }), 'H03');
});
test('effective teacher: H03 also uses placements serialized as entries', () => {
  rejects(transferred({
    target: {
      eligibleSubjectIds: ['other'],
      chuyenMon: [{
        tenChuyenMon: 'other',
        soTietTuan: 20
      }]
    },
    placementsAsArray: true
  }), 'H03');
});
test('effective teacher: unknown and inactive targets are rejected', () => {
  rejects(transferred({
    target: {
      trangThai: 'inactive'
    }
  }), 'H08');
  const missing = transferred();
  missing.candidate.placements.get('a').teacherId = 'unknown';
  rejects(missing, 'H03');
});
test('effective teacher: target fixed day off is rejected by H11', () => {
  rejects(transferred({
    target: {
      fixedDayOff: [2],
      nguyenVong: {
        thuNghi: [2]
      }
    }
  }), 'H11');
});
test('effective teacher: target max sessions is rejected by H10', () => {
  rejects(transferred({
    target: {
      nguyenVong: {
        soBuoiToiDa: 1
      }
    },
    periods: [[2, 2], [3, 2]]
  }), 'H10');
});
test('effective teacher: explicit target capacity is rejected by H09', () => {
  rejects(transferred({
    target: {
      capacityPeriodsPerWeek: 1
    },
    periods: [[2, 2], [3, 2]]
  }), 'H09');
});
test('effective teacher: empty allowed branches cannot permit a cross-branch transfer', () => {
  rejects(transferred({
    target: {
      homeBranchId: 'home',
      allowedTransferBranches: [],
      preferredTransferBranches: ['b']
    }
  }), 'H13');
});
test('effective teacher: declared branch permission permits the otherwise valid transfer', () => {
  const fixture = transferred({
    target: {
      homeBranchId: 'home',
      allowedTransferBranches: ['b']
    }
  });
  assert.equal(evaluateCandidate(fixture.candidate, fixture.input).summary.accepted, true);
});
test('effective branch: a forged home-branch placement cannot hide teaching at the prohibited class branch', () => {
  const fixture = transferred({
    target: {
      homeBranchId: 'home',
      allowedTransferBranches: []
    }
  });
  fixture.candidate.placements.get('a').branchId = 'home';
  rejects(fixture, 'H04');
});
test('effective teacher: workload, subject and preference metrics ignore stale slot teacher ids', () => {
  const fixture = transferred({
    target: {
      nguyenVong: {
        buoiUuTien: 'chieu',
        desiredTeachingSessionsPerWeek: 2
      }
    }
  });
  const metrics = deriveMetrics(fixture.candidate, fixture.input);
  assert.deepEqual(metrics.subjectWorkload.Subject.teachers.map(({
    teacherId,
    periods
  }) => [teacherId, periods]), [['A', 0], ['B', 1]]);
  assert.equal(metrics.preferenceBreakdown.session, 1);
  assert.equal(metrics.preferenceBreakdown.desiredSessions, 0.5);
  assert.deepEqual(metrics.teacherWorkloads.map(({
    teacherId,
    periods
  }) => [teacherId, periods]), [['A', 0], ['B', 1]]);
});
test('effective teacher: soft catalog rules use the target teacher even when evaluated directly', () => {
  const fixture = transferred({
    target: {
      homeBranchId: 'home',
      allowedTransferBranches: ['b'],
      preferredTransferBranches: ['elsewhere'],
      preferredGrades: [3],
      nguyenVong: {
        buoiUuTien: 'chieu',
        soBuoiToiDa: 1,
        thuNghi: [2]
      }
    },
    periods: [[2, 2], [3, 2]]
  });
  for (const id of ['S01', 'S02', 'S05', 'S06']) {
    assert.ok(getConstraint(id).evaluate(fixture.candidate, fixture.input).length > 0, id);
  }
});
test('effective teacher: evaluation does not mutate assignment, placement or slots', () => {
  const fixture = transferred();
  const before = JSON.stringify({
    input: [...fixture.input.assignmentIndex],
    placements: [...fixture.candidate.placements],
    assignments: [...fixture.candidate.assignments]
  });
  evaluateCandidate(fixture.candidate, fixture.input);
  assert.equal(JSON.stringify({
    input: [...fixture.input.assignmentIndex],
    placements: [...fixture.candidate.placements],
    assignments: [...fixture.candidate.assignments]
  }), before);
});
