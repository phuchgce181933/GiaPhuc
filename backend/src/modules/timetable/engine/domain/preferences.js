import { normalizeSession, sessionForSlot } from './time.js';

const DAY_NUMBERS = Object.freeze({ MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6, SUNDAY: 7 });

export function dayNumber(value) {
  if (value == null || value === '' || value === 'NONE') return null;
  const number = DAY_NUMBERS[String(value).toUpperCase()] ?? Number(value);
  return Number.isInteger(number) && number >= 1 && number <= 7 ? number : null;
}

export function fixedDaysOffOf(teacher) {
  const value = teacher.fixedDayOff ?? [];
  return [...new Set((Array.isArray(value) ? value : [value]).map(dayNumber).filter((day) => day !== null))];
}

export function softOffPreference(teacher) {
  const preference = teacher.nguyenVong ?? {};
  // The old nguyenVong day list is a preference, not proof of a fixed rule.
  // A genuine legacy fixedDayOff is carried separately by the projection.
  if (preference.preferredOffDay == null && !fixedDaysOffOf(teacher).length && preference.thuNghi?.length) {
    const days = preference.thuNghi.map(dayNumber).filter((day) => day !== null);
    return { day: days[0] ?? null, days, part: 'FULL_DAY' };
  }
  return {
    day: dayNumber(preference.preferredOffDay ?? preference.preferredOffDayNumber ?? teacher.preferredOffDay),
    part: preference.preferredOffPart ?? teacher.preferredOffPart ?? 'NONE',
  };
}

export function hasSoftOffPreference(teacher) {
  const { day, part } = softOffPreference(teacher);
  return day !== null && ['MORNING', 'AFTERNOON', 'FULL_DAY'].includes(part);
}

export function offPreferencePenalty(teacher, slots, input = {}) {
  if (!hasSoftOffPreference(teacher)) return 0;
  const { day, days = [day], part } = softOffPreference(teacher);
  const branches = new Map((input.branches ?? []).map((branch) => [branch.id, branch]));
  return days.filter((preferredDay) => slots.some((slot) => Number(slot.day) === preferredDay && (part === 'FULL_DAY'
    || sessionForSlot(slot, branches.get(slot.branchId)) === (part === 'MORNING' ? 'sang' : 'chieu')))).length / days.length;
}

export function teacherPreferencePenalties(teacher, slots, input = {}) {
  const parts = { session: null, desiredSessions: null, offDay: null, offPart: null, transferBranch: null, preferredGrade: null, transferPriority: null };
  const preference = teacher.nguyenVong ?? {};
  const branches = new Map((input.branches ?? []).map((branch) => [branch.id, branch]));
  const sessionFor = (slot) => sessionForSlot(slot, branches.get(slot.branchId));
  const preferred = normalizeSession(preference.buoiUuTien ?? teacher.preferredSession);
  if (preferred && preferred !== 'ca_hai') {
    parts.session = slots.length ? slots.filter((slot) => sessionFor(slot) !== preferred).length / slots.length : 0;
  }
  const desired = preference.desiredTeachingSessionsPerWeek;
  if (desired != null && desired !== '' && Number.isInteger(Number(desired)) && Number(desired) >= 0) {
    const sessions = new Set(slots.map((slot) => `${slot.day}|${sessionFor(slot)}`));
    parts.desiredSessions = Math.abs(sessions.size - Number(desired)) / Math.max(Number(desired), 1);
  }
  if (hasSoftOffPreference(teacher)) {
    parts.offDay = offPreferencePenalty(teacher, slots, input);
    parts.offPart = parts.offDay;
  }
  const transfers = slots.filter((slot) => teacher.homeBranchId != null && slot.branchId !== teacher.homeBranchId);
  const preferredBranches = teacher.preferredTransferBranches ?? [];
  if (preferredBranches.length) parts.transferBranch = transfers.length
    ? transfers.filter((slot) => !preferredBranches.includes(slot.branchId)).length / transfers.length : 0;
  const grades = teacher.preferredGrades ?? [];
  if (grades.length) {
    const classes = new Map((input.classes ?? []).map((classRecord) => [classRecord.id, classRecord]));
    const known = slots.filter((slot) => classes.get(slot.classId)?.gradeLevel != null);
    parts.preferredGrade = known.length ? known.filter((slot) => !grades.includes(classes.get(slot.classId).gradeLevel)).length / known.length : 0;
  }
  const priority = teacher.transferPriority ?? [];
  if (priority.length) parts.transferPriority = transfers.length ? transfers.reduce((sum, slot) => {
    const rank = priority.indexOf(slot.branchId);
    return sum + (rank < 0 ? 1 : rank / Math.max(priority.length - 1, 1));
  }, 0) / transfers.length : 0;
  return parts;
}
