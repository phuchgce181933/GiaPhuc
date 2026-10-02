// Constraint catalog. Each constraint is a small, named predicate
// or scoring function. The solver and validator share this catalog.
//
// Hard constraints return a list of HardViolation. Soft preferences
// return a soft score contribution. Inactive constraints return
// { active: false, reason: 'INACTIVE' }.

import { isEligibleFor } from './eligibility.js';
import { slotKey } from './time.js';
import { checkTransition } from './travel.js';

/** @typedef {{ code: string, where: object, detail: string }} HardViolation */

export function slotsForBranch(branch) {
  if (!branch || !Array.isArray(branch.schoolDays) || !Array.isArray(branch.periods)) return [];
  const out = [];
  for (const day of branch.schoolDays) {
    for (const period of branch.periods) {
      out.push({ branchId: branch.id, day, period });
    }
  }
  return out;
}

export const HARD = {
  H_TEACHER_NO_DOUBLE_BOOK: {
    code: 'H_TEACHER_NO_DOUBLE_BOOK',
    check(solution, input) {
      const out = [];
      // A teacher must not have two slots at the same (day, period, branch).
      // Group by teacher via input.assignmentIndex.
      const byTeacher = new Map();
      for (const [aId, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(aId);
        if (!meta) continue;
        const arr = byTeacher.get(meta.teacherId) ?? [];
        for (const s of slots) arr.push(s);
        byTeacher.set(meta.teacherId, arr);
      }
      for (const [teacherId, slots] of byTeacher) {
        const seen = new Map();
        for (const s of slots) {
          const k = slotKey(s);
          const prev = seen.get(k);
          if (prev) {
            out.push({
              code: this.code,
              where: { teacherId, day: s.day, period: s.period, branchId: s.branchId },
              detail: `teacher ${teacherId} double-booked at ${k}`,
            });
          }
          seen.set(k, true);
        }
      }
      return out;
    },
  },

  H_CLASS_NO_DOUBLE_BOOK: {
    code: 'H_CLASS_NO_DOUBLE_BOOK',
    check(solution, input) {
      const out = [];
      // A class must not have two slots at the same (day, period).
      const byClass = new Map();
      for (const [aId, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(aId);
        if (!meta) continue;
        const arr = byClass.get(meta.classId) ?? [];
        for (const s of slots) arr.push(s);
        byClass.set(meta.classId, arr);
      }
      for (const [classId, slots] of byClass) {
        const seen = new Map();
        for (const s of slots) {
          const k = `${s.day}:${s.period}`;
          const prev = seen.get(k);
          if (prev) {
            out.push({
              code: this.code,
              where: { classId, day: s.day, period: s.period },
              detail: `class ${classId} has two subjects at ${k}`,
            });
          }
          seen.set(k, true);
        }
      }
      return out;
    },
  },

  H_TEACHER_ELIGIBLE: {
    code: 'H_TEACHER_ELIGIBLE',
    check(solution, input) {
      const out = [];
      for (const a of solution.assignments.keys()) {
        const meta = input.assignmentIndex.get(a);
        if (!meta) continue;
        const teacher = input.teacherIndex.get(meta.teacherId);
        if (!teacher) continue;
        if (!isEligibleFor(teacher, meta.subjectId)) {
          out.push({
            code: this.code,
            where: { assignmentId: a, teacherId: meta.teacherId, subjectId: meta.subjectId },
            detail: `teacher ${teacher.hoTen} is not eligible for ${meta.subjectId}`,
          });
        }
      }
      return out;
    },
  },

  H_ASSIGNMENT_COMPLETE: {
    code: 'H_ASSIGNMENT_COMPLETE',
    check(solution, input) {
      const out = [];
      for (const [a, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(a);
        if (!meta) continue;
        if (slots.length !== meta.requiredPeriods) {
          out.push({
            code: this.code,
            where: { assignmentId: a },
            detail: `assignment ${a} has ${slots.length}/${meta.requiredPeriods} slots`,
          });
        }
      }
      return out;
    },
  },

  H_SLOT_IN_BRANCH: {
    code: 'H_SLOT_IN_BRANCH',
    check(solution, input) {
      const out = [];
      const allowed = new Set();
      for (const slots of input.timeSlotsByBranch.values()) {
        for (const s of slots) allowed.add(slotKey(s));
      }
      for (const [, slots] of solution.assignments) {
        for (const s of slots) {
          if (!allowed.has(slotKey(s))) {
            out.push({
              code: this.code,
              where: s,
              detail: `slot ${slotKey(s)} is not in any branch profile`,
            });
          }
        }
      }
      return out;
    },
  },

  H_TRANSFER_ALLOWED: {
    code: 'H_TRANSFER_ALLOWED',
    active: (input) => input.teachers.some((t) => Array.isArray(t.allowedTransferBranches)),
    check(solution, input) {
      const out = [];
      for (const a of solution.assignments.keys()) {
        const meta = input.assignmentIndex.get(a);
        if (!meta) continue;
        const teacher = input.teacherIndex.get(meta.teacherId);
        if (!teacher || !Array.isArray(teacher.allowedTransferBranches)) continue;
        for (const slot of solution.assignments.get(a) ?? []) {
          if (slot.branchId !== (teacher.homeBranchId ?? slot.branchId)) {
            if (!teacher.allowedTransferBranches.includes(slot.branchId)) {
              out.push({
                code: this.code,
                where: { teacherId: teacher.id, branchId: slot.branchId },
                detail: `teacher ${teacher.hoTen} not allowed to transfer to ${slot.branchId}`,
              });
            }
          }
        }
      }
      return out;
    },
  },

  H_TRAVEL_FEASIBLE: {
    code: 'H_TRAVEL_FEASIBLE',
    active: (input) => Boolean(input.travelTime),
    check(solution, input) {
      const out = [];
      if (!input.travelTime) return out;
      const teacherSlots = new Map();
      for (const a of solution.assignments.keys()) {
        const meta = input.assignmentIndex.get(a);
        if (!meta) continue;
        const arr = teacherSlots.get(meta.teacherId) ?? [];
        for (const s of solution.assignments.get(a) ?? []) arr.push(s);
        teacherSlots.set(meta.teacherId, arr);
      }
      for (const [teacherId, slots] of teacherSlots) {
        slots.sort((a, b) => (a.day - b.day) || (a.period - b.period));
        for (let i = 1; i < slots.length; i++) {
          const prev = slots[i - 1];
          const next = slots[i];
          if (prev.day !== next.day) continue;
          const transition = input.transitionMinutes ?? 10;
          const t = checkTransition(prev, next, input.travelTime, transition);
          if (!t.feasible) {
            out.push({
              code: this.code,
              where: { teacherId, day: next.day, period: next.period },
              detail: `travel from ${prev.branchId} to ${next.branchId} on day ${next.day}: ${t.reason}`,
            });
          }
        }
      }
      return out;
    },
  },

  H_NO_DUPLICATE_SLOT: {
    code: 'H_NO_DUPLICATE_SLOT',
    check(solution) {
      const out = [];
      for (const [, slots] of solution.assignments) {
        const seen = new Set();
        for (const s of slots) {
          const k = slotKey(s);
          if (seen.has(k)) {
            out.push({ code: this.code, where: s, detail: `duplicate slot ${k}` });
          }
          seen.add(k);
        }
      }
      return out;
    },
  },
};

export const SOFT = {
  S_PREFERRED_SESSION: {
    code: 'S_PREFERRED_SESSION',
    active: (input) => input.teachers.some((t) => t.nguyenVong?.buoiUuTien && t.nguyenVong.buoiUuTien !== 'ca_hai'),
    scorePerTeacher(teacher, slots) {
      const pref = teacher.nguyenVong?.buoiUuTien;
      if (!pref || pref === 'ca_hai') return 1;
      if (slots.length === 0) return 1;
      let match = 0;
      for (const s of slots) {
        const session = s.period <= 5 ? 'sang' : 'chieu';
        if (session === pref) match++;
      }
      return match / slots.length;
    },
  },

  S_PREFERRED_DAY_OFF: {
    code: 'S_PREFERRED_DAY_OFF',
    active: (input) => input.teachers.some((t) => (t.nguyenVong?.thuNghi ?? []).length > 0),
    scorePerTeacher(teacher, slots) {
      const off = teacher.nguyenVong?.thuNghi ?? [];
      if (off.length === 0) return 1;
      const used = new Set(slots.map((s) => s.day));
      let hits = 0;
      for (const d of off) if (used.has(d)) hits++;
      return 1 - hits / off.length;
    },
  },

  S_MAX_SESSIONS_PER_WEEK: {
    code: 'S_MAX_SESSIONS_PER_WEEK',
    active: (input) => input.teachers.some((t) => (t.nguyenVong?.soBuoiToiDa ?? 0) > 0),
    scorePerTeacher(teacher, slots) {
      const max = teacher.nguyenVong?.soBuoiToiDa ?? 0;
      if (!max) return 1;
      const used = new Set(slots.map((s) => s.day));
      if (used.size <= max) return 1;
      const over = used.size - max;
      return Math.max(0, 1 - over / max);
    },
  },

  S_HOME_BRANCH: {
    code: 'S_HOME_BRANCH',
    active: (input) => input.teachers.some((t) => t.homeBranchId),
    scorePerTeacher(teacher, slots) {
      if (!teacher.homeBranchId) return 1;
      if (slots.length === 0) return 1;
      let home = 0;
      for (const s of slots) if (s.branchId === teacher.homeBranchId) home++;
      return home / slots.length;
    },
  },
};

export function workloadBalanceScore(solution, input) {
  const byTeacher = new Map();
  for (const a of solution.assignments.keys()) {
    const meta = input.assignmentIndex.get(a);
    if (!meta) continue;
    byTeacher.set(meta.teacherId, (byTeacher.get(meta.teacherId) ?? 0) + 1);
  }
  if (byTeacher.size === 0) return 1;
  const counts = [...byTeacher.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  if (mean === 0) return 1;
  const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
  const cv = Math.sqrt(variance) / mean;
  return Math.max(0, 1 - cv);
}

export function noGapScore(solution) {
  let total = 0, matched = 0;
  const teacherSlots = new Map();
  for (const [, slots] of solution.assignments) {
    for (const s of slots) {
      const k = s.branchId ?? '';
      const arr = teacherSlots.get(k) ?? [];
      arr.push(s);
      teacherSlots.set(k, arr);
    }
  }
  // Aggregate per (teacher, day) by walking the assignment map.
  const perTeacher = new Map();
  for (const a of solution.assignments.keys()) {
    // teacher is encoded in the assignment meta via input later.
    // For pure no-gap we use the solution's slot identity, not teacher.
    // The scorer wires this with input.assignmentIndex when it calls.
  }
  // Fallback: just count unique days used; return 1 if no slots.
  if (solution.assignments.size === 0) return 1;
  // The "by teacher" refinement is applied in scorer.js. This base
  // function returns 1 to signal "no slots to score"; the scorer
  // takes the per-teacher view and calls noGapForTeacherDays.
  return 1;
}

export function noGapForTeacherDays(teacherDaySlots) {
  let total = 0, matched = 0;
  for (const periods of teacherDaySlots.values()) {
    if (periods.length < 2) continue;
    periods.sort((a, b) => a - b);
    const min = periods[0], max = periods[periods.length - 1];
    const span = max - min + 1;
    total += 1;
    if (span === periods.length) matched += 1;
    else matched += periods.length / span;
  }
  if (total === 0) return 1;
  return matched / total;
}
