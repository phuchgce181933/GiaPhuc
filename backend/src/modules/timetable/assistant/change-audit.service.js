'use strict';

function describeChange(before, after, directory) {
  const teacher = directory?.teachers?.find((row) => row.id === after.teacherId);
  const cls = directory?.classes?.find((row) => row.id === after.classId);
  return { teacherId: after.teacherId, teacherName: teacher?.name ?? after.teacherId, classId: after.classId, className: cls?.name ?? after.classId,
    from: { day: before.day, session: before.session, period: before.period }, to: { day: after.day, session: after.session, period: after.period } };
}

function audit({ original, nextRows, changes, evaluation, travelAvailable, originalContentHash }) {
  const changedIds = new Set(changes.map((row) => row.assignmentId));
  const affectedTeachers = new Set(changes.map((row) => row.teacherId));
  const affectedClasses = new Set(changes.map((row) => row.classId));
  return {
    mode: 'ASSISTED_ADJUSTMENT', sourceScheduleId: original.scheduleId, sourceVersion: original.version,
    changedSlots: changes.length, affectedTeachers: affectedTeachers.size, affectedClasses: affectedClasses.size,
    hardConstraints: evaluation.summary.totalHardViolations, softPenalty: evaluation.summary.totalSoftPenalty,
    travel: { available: travelAvailable === true, status: travelAvailable === true ? 'CHECKED' : 'NOT_CHECKED' },
    originalContentHash, changedAssignmentIds: [...changedIds],
  };
}

module.exports = { describeChange, audit };
