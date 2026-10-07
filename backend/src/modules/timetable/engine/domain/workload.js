// Workload is a derived, runtime-only value.
// Sum of soTietTuan across a teacher's specializations.

import { isEligibleFor } from './eligibility.js';
import { fixedDaysOffOf } from './preferences.js';
import { isBlockedTeachingSlot, sessionForSlot } from './time.js';
import { canWorkAtBranch, TRANSFER_POLICY_STATUS } from './transfer/transfer.js';

export function workloadOf(teacher) {
  let total = 0;
  for (const s of teacher?.chuyenMon ?? []) total += Number(s.soTietTuan) || 0;
  return total;
}

// A specialization demand or historical teachingWorkload is not a capacity.
// Legacy capacity remains unknown until an operator supplies this explicit field.
export function capacityTeacher(teacher) {
  const capacity = teacher?.capacityPeriodsPerWeek;
  return Number.isInteger(capacity) && capacity >= 0 ? capacity : null;
}

// A calendar upper bound, not an inferred contractual workload. A teacher's
// same time at several branches is one possible teaching period, counted once.
export function availableTeachingPeriods(teacher, input) {
  const daysOff = fixedDaysOffOf(teacher);
  const sessions = new Map();
  for (const [branchId, slots] of input.timeSlotsByBranch ?? []) {
    if (canWorkAtBranch(teacher,branchId,input.transferPolicy).status === TRANSFER_POLICY_STATUS.NOT_ALLOWED) continue;
    const branch = input.branches?.find((row) => row.id === branchId);
    for (const slot of slots) {
      const session = sessionForSlot(slot,branch);
      if (!session || daysOff.includes(Number(slot.day)) || isBlockedTeachingSlot(slot,branch)) continue;
      const key = `${slot.day}|${session}`;
      const periods = sessions.get(key) ?? new Set(); periods.add(Number(slot.period)); sessions.set(key,periods);
    }
  }
  const sizes = [...sessions.values()].map((periods) => periods.size).sort((a,b) => b-a);
  const maxSessions = teacher.nguyenVong?.soBuoiToiDa;
  const calendar = sizes.slice(0,maxSessions > 0 ? maxSessions : sizes.length).reduce((sum,size) => sum+size,0);
  return Math.min(calendar,capacityTeacher(teacher) ?? Infinity);
}

export function subjectCapacityShortages(input) {
  if (!input.timeSlotsByBranch?.size) return [];
  const demands = new Map();
  for (const assignment of input.assignments ?? []) demands.set(assignment.subjectId,(demands.get(assignment.subjectId) ?? 0)+assignment.requiredPeriods);
  const teachers = (input.teachers ?? []).filter((teacher) => teacher.isActive !== false && teacher.trangThai !== 'inactive');
  const eligible = new Map([...demands.keys()].map((subjectId) => [subjectId,teachers.filter((teacher) => isEligibleFor(teacher,subjectId))]));
  const shortages = [];
  const check = (subjectIds,group) => {
    const requiredPeriods = subjectIds.reduce((sum,id) => sum+demands.get(id),0);
    const capacities = group.map((teacher) => ({teacherId:teacher.id,availablePeriods:availableTeachingPeriods(teacher,input),capacityPeriodsPerWeek:capacityTeacher(teacher)}));
    const availablePeriods = capacities.reduce((sum,row) => sum+row.availablePeriods,0);
    if (requiredPeriods > availablePeriods) shortages.push({subjectIds,teacherIds:group.map((teacher) => teacher.id),requiredPeriods,availablePeriods,shortagePeriods:requiredPeriods-availablePeriods,teachers:capacities});
  };
  for (const [subjectId,group] of eligible) check([subjectId],group);
  const visited = new Set();
  for (const first of demands.keys()) {
    if (visited.has(first)) continue;
    const queue = [first]; const subjects = []; const group = new Map();
    while (queue.length) {
      const subjectId = queue.shift(); if (visited.has(subjectId)) continue;
      visited.add(subjectId); subjects.push(subjectId);
      for (const teacher of eligible.get(subjectId)) group.set(teacher.id,teacher);
      for (const [other,rows] of eligible) if (!visited.has(other) && rows.some((teacher) => group.has(teacher.id))) queue.push(other);
    }
    if (subjects.length > 1) check(subjects,[...group.values()]);
  }
  return shortages;
}

export function workloadSummary(teachers) {
  return teachers.map((t) => ({
    teacherId: t.id,
    hoTen: t.hoTen,
    workload: workloadOf(t),
  }));
}
