// Explanation events. Pure. The AI layer turns these into text
// via a lookup table; it does not invent text.

export const CODES = {
  WHY_TEACHER_SELECTED: 'WHY_TEACHER_SELECTED',
  WHY_TEACHER_REJECTED: 'WHY_TEACHER_REJECTED',
  WHY_TRANSFERRED: 'WHY_TRANSFERRED',
  WHY_SLOT_SELECTED: 'WHY_SLOT_SELECTED',
  WHY_PREFERENCE_VIOLATED: 'WHY_PREFERENCE_VIOLATED',
  WHY_PREFERENCE_SATISFIED: 'WHY_PREFERENCE_SATISFIED',
  WHY_SHORTAGE: 'WHY_SHORTAGE',
  WHY_UNRESOLVABLE: 'WHY_UNRESOLVABLE',
  WHY_SKIPPED: 'WHY_SKIPPED',
};

export const FACTORS = new Set([
  'SPECIALIZATION_MATCH',
  'SPECIALIZATION_MISMATCH',
  'BRANCH_MATCH',
  'BRANCH_TRANSFER_ALLOWED',
  'BRANCH_TRANSFER_PREFERRED',
  'BRANCH_NOT_ALLOWED',
  'TRAVEL_FEASIBLE',
  'TRAVEL_INFEASIBLE',
  'PREFERRED_SESSION',
  'PREFERRED_DAY_OFF',
  'PREFERRED_TRANSFER_BRANCH',
  'WORKLOAD_UNDER',
  'WORKLOAD_OVER',
  'NO_ELIGIBLE_TEACHER',
  'TIME_SLOT_AVAILABLE',
  'TIME_SLOT_TAKEN_BY_TEACHER',
  'TIME_SLOT_TAKEN_BY_CLASS',
  'FIXED_DAY_OFF',
  'DIVERSITY_PENALTY',
]);

export function explainCandidate(candidate, input) {
  const events = [];
  for (const [aId, slots] of candidate.assignments) {
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    const teacher = input.teacherIndex.get(meta.teacherId);
    if (!teacher) continue;
    events.push({
      code: CODES.WHY_TEACHER_SELECTED,
      teacherId: teacher.id,
      assignmentId: aId,
      factors: ['SPECIALIZATION_MATCH'],
      detail: `${teacher.hoTen} for ${meta.subjectId} class ${meta.classId}`,
    });
    for (const s of slots) {
      if (teacher.homeBranchId && s.branchId !== teacher.homeBranchId) {
        events.push({
          code: CODES.WHY_TRANSFERRED,
          teacherId: teacher.id,
          branchId: s.branchId,
          factors: ['BRANCH_TRANSFER_ALLOWED'],
          detail: `${teacher.hoTen} transferred to ${s.branchId} day ${s.day} period ${s.period}`,
        });
      }
    }
  }
  return events;
}

export function renderEvent(event, lang = 'vi') {
  const table = lang === 'vi' ? VI : EN;
  return table[event.code]?.(event) ?? event.code;
}

const VI = {
  WHY_TEACHER_SELECTED: (e) => `Chon giao vien ${e.teacherId ?? ''} cho phan cong ${e.assignmentId ?? ''}`,
  WHY_TRANSFERRED: (e) => `Dieu chuyen giao vien ${e.teacherId ?? ''} sang ${e.branchId ?? ''}`,
  WHY_SLOT_SELECTED: (e) => `Chon tiet ${e.detail ?? ''}`,
  WHY_PREFERENCE_VIOLATED: (e) => `Khong dap ung nguyen vong: ${e.detail ?? ''}`,
  WHY_PREFERENCE_SATISFIED: (e) => `Dap ung nguyen vong: ${e.detail ?? ''}`,
  WHY_SHORTAGE: (e) => `Thieu giao vien: ${e.detail ?? ''}`,
  WHY_UNRESOLVABLE: (e) => `Khong the giai: ${e.detail ?? ''}`,
  WHY_SKIPPED: (e) => `Bo qua: ${e.detail ?? ''}`,
  WHY_TEACHER_REJECTED: (e) => `Tu choi giao vien ${e.teacherId ?? ''}`,
};

const EN = {
  WHY_TEACHER_SELECTED: (e) => `Selected teacher ${e.teacherId ?? ''} for ${e.assignmentId ?? ''}`,
  WHY_TRANSFERRED: (e) => `Transferred teacher ${e.teacherId ?? ''} to ${e.branchId ?? ''}`,
  WHY_SLOT_SELECTED: (e) => `Selected slot ${e.detail ?? ''}`,
  WHY_PREFERENCE_VIOLATED: (e) => `Preference not met: ${e.detail ?? ''}`,
  WHY_PREFERENCE_SATISFIED: (e) => `Preference met: ${e.detail ?? ''}`,
  WHY_SHORTAGE: (e) => `Shortage: ${e.detail ?? ''}`,
  WHY_UNRESOLVABLE: (e) => `Unresolvable: ${e.detail ?? ''}`,
  WHY_SKIPPED: (e) => `Skipped: ${e.detail ?? ''}`,
  WHY_TEACHER_REJECTED: (e) => `Rejected teacher ${e.teacherId ?? ''}`,
};
