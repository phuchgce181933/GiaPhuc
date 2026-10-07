// Constraint catalog. Each constraint is a small, named predicate
// or scoring function. The solver and validator share this catalog
// (read-only). The validator does NOT import the solver.
//
// Hard constraints return a list of HardViolation. Soft preferences
// return a soft score contribution. Inactive constraints return
// { active: false, reason: 'INACTIVE' }.

import { isEligibleFor } from './eligibility.js';
import { slotKey, teacherConflictKey, classConflictKey, profileOf, sessionForSlot, isBlockedTeachingSlot } from './time.js';
import { checkTransition } from './travel/index.js';
import { workloadOf } from './workload.js';
import { canWorkAtBranch, TRANSFER_POLICY_STATUS } from './transfer/transfer.js';
import { classSubjectTeacherKey } from './assignment.js';
export { withEffectiveMeta } from './assignment.js';
import { hasSoftOffPreference, offPreferencePenalty } from './preferences.js';

/** @typedef {{ code: string, where: object, detail: string }} HardViolation */

export function slotsForBranch(branch) {
  if (!branch || !Array.isArray(branch.schoolDays) || !Array.isArray(branch.periods)) return [];
  const out = [];
  for (const day of branch.schoolDays) {
    for (const period of branch.periods) {
      const slot = { branchId: branch.id, day, period };
      const session = sessionForSlot(slot, branch);
      if (!session || isBlockedTeachingSlot(slot, branch)) continue;
      out.push({ ...slot, session });
    }
  }
  return out;
}

/**
 * Build a view-input whose `assignmentIndex` carries the
 * solver's effective (teacherId, branchId) when present. The
 * underlying HARD catalog reads `meta.teacherId`, `meta.branchId`,
 * `meta.classId`, `meta.subjectId`. By materialising a fresh
 * assignmentIndex with the chosen values merged in, the catalog
 * does not need to know about `solution.placements`.
 *
 * Shared between the independent validator (validator.js) and the
 * solver's in-makeCandidate hard-violation count (solver.js). The
 * brief §26 requires the solver to surface a hard-violation count
 * that matches the validator's view; both consumers therefore need
 * the SAME effective meta so the count agrees.
 *
 * Pure. Never mutates `input`. When `solution.placements` is missing
 * or empty, the original input is returned unchanged.
 */
/**
 * Build the (teacherId, branchId) variant list for one Assignment.
 * Pure: never mutates input.
 *
 *   - Imported baseline teacher choices are advisory; eligible home
 *     teachers precede permitted external teachers.
 *   - An explicit teacher remains fixed when teacher changes are disabled.
 *   - If `a.teacherId` is null, every eligible teacher is a candidate.
 *   - If `a.branchId` is set, the branch is fixed.
 *   - If `a.branchId` is null, the slot must still land in the
 *     class's branch (a class only has one branch). The solver may
 *     transfer the teacher from their home branch to that branch
 *     when `allowedTransferBranches` permits it. The variant list
 *     is built from the candidate teacher's home + allowedTransfer
 *     branches, intersected with the class's branch.
 *
 * Returns an array of `{ teacherId, branchId }` decision variants.
 */
export function expandAssignmentVariants(assignment, input, { allowTeacherChange = false } = {}) {
  const classBranch = input.classes?.find((classRecord) => classRecord.id === assignment.classId)?.branchId;
  if (classBranch && assignment.branchId && classBranch !== assignment.branchId) return [];
  const destination = classBranch ?? assignment.branchId;
  const branches = destination ? [destination] : (input.branches ?? []).map((branch) => branch.id);
  const teachers = (input.teachers ?? []).filter((teacher) => teacher.trangThai !== 'inactive' && teacher.isActive !== false
    && (!assignment.teacherId || assignment.baselineAssignment || allowTeacherChange || teacher.id === assignment.teacherId)
    && isEligibleFor(teacher, assignment.subjectId));
  teachers.sort((a, b) => (destination ? Number(b.homeBranchId === destination) - Number(a.homeBranchId === destination) : 0)
    || Number(b.id === assignment.teacherId) - Number(a.id === assignment.teacherId));
  return teachers.flatMap((teacher) => branches.filter((branchId) => canWorkAtBranch(teacher, branchId, input.transferPolicy).status !== TRANSFER_POLICY_STATUS.NOT_ALLOWED)
    .map((branchId) => ({ teacherId: teacher.id, branchId })));
}

export const HARD = {
  H_TEACHER_NO_DOUBLE_BOOK: {
    code: 'H_TEACHER_NO_DOUBLE_BOOK',
    check(solution, input) {
      const out = [];
      // A teacher cannot be at two places at the same time. The
      // conflict key is (teacherId, day, period) — branch-agnostic.
      const byTeacher = new Map();
      for (const [aId, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(aId);
        if (!meta) continue;
        const teacherId = meta.teacherId;
        const arr = byTeacher.get(teacherId) ?? [];
        for (const s of slots) arr.push(s);
        byTeacher.set(teacherId, arr);
      }
      for (const [teacherId, slots] of byTeacher) {
        const seen = new Map();
        for (const s of slots) {
          const k = teacherConflictKey(s, input.branches?.find((branch) => branch.id === s.branchId));
          const prev = seen.get(k);
          if (prev) {
            out.push({
              code: this.code,
              where: { teacherId, day: s.day, period: s.period, branchIdA: prev.branchId, branchIdB: s.branchId },
              detail: `teacher ${teacherId} double-booked at ${k} across branches ${prev.branchId} and ${s.branchId}`,
            });
          }
          seen.set(k, { branchId: s.branchId });
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
          const k = classConflictKey(s, input.branches?.find((branch) => branch.id === s.branchId));
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
      // The validator enforces: every placed slot must belong to the
      // branch that the corresponding assignment actually uses. We
      // accept both the global profile (slot is in any branch) and
      // the per-assignment branch (slot.branchId === assignment.branchId).
      // The per-assignment branch is the binding one. When the
      // assignment's branchId is null (transfer decision), the class's
      // branchId is the binding one.
      for (const [aId, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(aId);
        if (!meta) continue;
        const classRec = input.classes?.find?.((c) => c.id === meta.classId);
        const classBranchId = classRec?.branchId;
      const branchId = classBranchId ?? meta.branchId;
        if (!branchId) continue;
        const allowedSet = new Set(
          (input.timeSlotsByBranch.get(branchId) ?? []).map(slotKey),
        );
        for (const s of slots) {
          if (s.branchId !== branchId) {
            out.push({
              code: this.code,
              where: { assignmentId: aId, slot: s, expectedBranchId: branchId },
              detail: `slot ${slotKey(s)} is not in assignment branch ${branchId}`,
            });
            continue;
          }
          if (!allowedSet.has(slotKey(s))) {
            out.push({
              code: this.code,
              where: { assignmentId: aId, slot: s },
              detail: `slot ${slotKey(s)} is not in branch profile`,
            });
          }
        }
      }
      return out;
    },
  },

  H_TRANSFER_ALLOWED: {
    code: 'H_TRANSFER_ALLOWED',
    active: (input) => input.teachers.some((teacher) => teacher.homeBranchId != null || Array.isArray(teacher.allowedTransferBranches)),
    check(solution, input) {
      const out = [];
      for (const a of solution.assignments.keys()) {
        const meta = input.assignmentIndex.get(a);
        if (!meta) continue;
        const teacher = input.teacherIndex.get(meta.teacherId);
        if (!teacher) continue;
        const home = teacher.homeBranchId;
        if (canWorkAtBranch(teacher, meta.branchId, input.transferPolicy).status === TRANSFER_POLICY_STATUS.NOT_ALLOWED) {
          out.push({
            code: this.code,
            where: { teacherId: teacher.id, branchId: meta.branchId, homeBranchId: home },
            detail: `teacher ${teacher.hoTen} not allowed to transfer to ${meta.branchId}`,
          });
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

  H_CLASS_SUBJECT_ONE_TEACHER: {
    code: 'H_CLASS_SUBJECT_ONE_TEACHER',
    check(solution, input) {
      const out = [];
      // A class-subject demand, including the linked Technology/Informatics pair,
      // must have the same teacher. The validator is the second line of defense.
      const byKey = new Map();
      for (const [aId, slots] of solution.assignments) {
        const meta = input.assignmentIndex.get(aId);
        if (!meta) continue;
        const k = classSubjectTeacherKey(meta.classId, meta.subjectId, input);
        const cur = byKey.get(k) ?? { classId: meta.classId, subjectIds: new Set(), teachers: new Set(), assignmentIds: [] };
        cur.subjectIds.add(meta.subjectId);
        cur.teachers.add(meta.teacherId);
        cur.assignmentIds.push(aId);
        byKey.set(k, cur);
      }
      for (const [, v] of byKey) {
        if (v.teachers.size > 1) {
          out.push({
            code: this.code,
            where: { classId: v.classId, subjectIds: [...v.subjectIds], teacherIds: [...v.teachers] },
            detail: `class ${v.classId} linked subjects ${[...v.subjectIds].join(', ')} have multiple teachers: ${[...v.teachers].join(', ')}`,
          });
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
    scorePerTeacher(teacher, slots, input) {
      const pref = teacher.nguyenVong?.buoiUuTien;
      if (!pref || pref === 'ca_hai') return 1;
      if (slots.length === 0) return 1;
      // Prefer branch profile when available. Fall back to the
      // legacy `period <= 5` rule so existing tests still pass.
      const branchesById = input && Array.isArray(input.branches)
        ? new Map(input.branches.map((b) => [b.id, b]))
        : null;
      let match = 0;
      for (const s of slots) {
        let session;
        if (branchesById && s.branchId) {
          const branch = branchesById.get(s.branchId);
          session = sessionForSlot(s, branch);
        } else {
          session = sessionForSlot(s);
        }
        if (session === pref) match++;
      }
      return match / slots.length;
    },
  },

  S_PREFERRED_DAY_OFF: {
    code: 'S_PREFERRED_DAY_OFF',
    active: (input) => input.teachers.some(hasSoftOffPreference),
    scorePerTeacher(teacher, slots, input) { return 1 - offPreferencePenalty(teacher, slots, input); },
  },

  S_MAX_SESSIONS_PER_WEEK: {
    code: 'S_MAX_SESSIONS_PER_WEEK',
    active: (input) => input.teachers.some((t) => (t.nguyenVong?.soBuoiToiDa ?? 0) > 0),
    scorePerTeacher(teacher, slots, input) {
      const max = teacher.nguyenVong?.soBuoiToiDa ?? 0;
      if (!max) return 1;
      if (slots.length === 0) return 1;
      // Count distinct (day, session) tuples. Session is derived
      // from the branch profile when available, else from the
      // default (period <= 5 -> sang). For the legacy test path
      // (slots have no branchId), use the default.
      const branchesById = input && Array.isArray(input.branches)
        ? new Map(input.branches.map((b) => [b.id, b]))
        : null;
      const sessions = new Set();
      for (const s of slots) {
        let session;
        if (branchesById && s.branchId) {
          const branch = branchesById.get(s.branchId);
          session = sessionForSlot(s, branch);
        } else {
          session = sessionForSlot(s);
        }
        sessions.add(`${s.day}|${session}`);
      }
      if (sessions.size <= max) return 1;
      const over = sessions.size - max;
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

/**
 * Workload score, budget-aware.
 *
 * The score compares the actual slots assigned to a teacher with
 * the teacher's weekly budget (Σ chuyenMon[].soTietTuan). It is
 * NOT "all teachers should have similar counts". A teacher with a
 * budget of 20 should land near 20; a teacher with a budget of 5
 * should land near 5.
 *
 * Returns 1 when the per-teacher deviation is zero; degrades
 * smoothly as the deviation grows. The total score is the mean
 * over all teachers with a positive budget.
 */
export function workloadBalanceScore(solution, input) {
  // Count the actual slots assigned to each teacher. The score is
  // the per-teacher mean of `1 - |actual - budget| / budget`,
  // clamped to [0, 1]. A teacher with a positive budget who lands
  // on their budget gets 1. A teacher with zero budget is excluded
  // from the average (they are not in the active pool).
  const actualByTeacher = new Map();
  for (const [, slots] of solution.assignments) {
    // Each slot carries its teacherId (the solver sets it; the
    // validator relies on the assignment meta to recover it). When
    // teacherId is missing, fall back to assignmentIndex.
    for (const s of slots) {
      const tid = s.teacherId;
      if (tid == null) continue;
      actualByTeacher.set(tid, (actualByTeacher.get(tid) ?? 0) + 1);
    }
  }
  let total = 0, count = 0;
  for (const t of input.teachers) {
    const budget = workloadOf(t);
    if (budget <= 0) continue;
    const actual = actualByTeacher.get(t.id) ?? 0;
    const deviation = Math.abs(actual - budget) / budget;
    const perTeacher = Math.max(0, 1 - deviation);
    total += perTeacher;
    count += 1;
  }
  if (count === 0) return 1;
  return total / count;
}

/**
 * Travel score. (solution, input) -> [0, 1].
 *
 * Computes the share of feasible same-day transitions across
 * branches. When no travel provider is registered, the score
 * defaults to 1 (the constraint is INACTIVE; no penalty is owed).
 * Infeasible transitions are emitted as hard violations by the
 * validator, so this is a soft signal, not the hard gate.
 */
export function travelScoreFn(solution, input) {
  if (!input.travelTime) return 1;
  const teacherSlots = new Map();
  for (const a of solution.assignments.keys()) {
    const meta = input.assignmentIndex.get(a);
    if (!meta) continue;
    const arr = teacherSlots.get(meta.teacherId) ?? [];
    for (const s of solution.assignments.get(a) ?? []) arr.push(s);
    teacherSlots.set(meta.teacherId, arr);
  }
  let total = 0, feasible = 0;
  const transition = input.transitionMinutes ?? 10;
  for (const [, slots] of teacherSlots) {
    if (slots.length < 2) continue;
    const sorted = slots.slice().sort((a, b) => (a.day - b.day) || (a.period - b.period));
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      if (prev.day !== next.day) continue;
      total += 1;
      const t = checkTransition(prev, next, input.travelTime, transition);
      if (t.feasible) feasible += 1;
    }
  }
  if (total === 0) return 1;
  return feasible / total;
}

/**
 * Per-teacher no-gap score: how contiguous is a teacher's slots
 * on each of their days? Returns 1 when every teacher's day is
 * a single contiguous block; degrades when days have gaps.
 *
 * For each teacher-day, the score is `slots.length / span`, where
 * `span = max(periods) - min(periods) + 1`. The total is the
 * mean over teacher-days that have at least 2 slots. A single
 * isolated slot scores 1 by definition.
 */
export function noGapForTeacherDays(teacherDaySlots) {
  let total = 0, matched = 0;
  for (const periods of teacherDaySlots.values()) {
    if (periods.length < 2) {
      total += 1;
      matched += 1;
      continue;
    }
    periods.sort((a, b) => a - b);
    const min = periods[0], max = periods[periods.length - 1];
    const span = max - min + 1;
    total += 1;
    matched += periods.length / span;
  }
  if (total === 0) return 1;
  return matched / total;
}

/**
 * Per-teacher session-compactness score (formerly called
 * "sessionDiversity" before PHASE 17.1). Measures the share of
 * teacher-days where the teacher has slots in AT MOST ONE
 * session. A day with both sang and chieu is a SPLIT day; a day
 * with only sang OR only chieu is COMPACT.
 *
 * Score = 1 - (splitDays / totalDays).
 *
 * Examples:
 *   - 1 morning on Mon, 1 morning on Tue: 2/2 compact = 1
 *   - 1 morning on Mon, 1 afternoon on Mon: 0/1 compact  = 0
 *   - 1 morning on Mon, 1 morning on Tue, 1 afternoon on Tue: 1/2 compact = 0.5
 *   - empty solution: 1 (no penalty)
 *
 * The score is reported on each kept solution and contributes to
 * `overallScore` via `weights.sessionDiversity`. The strategy
 * preset that turns the weight up (B, C) prefers compact teacher
 * schedules. The strategy preset that turns it off (A) is
 * indifferent.
 *
 * PHASE 17.1 rationale: the previous "mixed-day ratio" semantic
 * (1 when split, 0 when compact) actively rewarded teacher
 * schedule fragmentation, conflicting with:
 *   - S_PREFERRED_SESSION (teacher's stated session preference)
 *   - S_MAX_SESSIONS_PER_WEEK (1 morning + 1 afternoon on the same
 *     day counts as 2 sessions)
 *   - compactness and reduced travel
 *   - teacher usability (one block is more practical than two
 *     scattered blocks on the same day)
 *
 * The corrected semantic — "compactness" — preserves the strategy
 * surface (the `sessionDiversity` weight is still in `overallScore`)
 * while removing the conflict with the other objectives. The
 * SOLUTION-to-SOLUTION diversity is still reported separately via
 * `structuralDiversity` in diversity.js.
 *
 * The search does NOT consult this concept; the score is
 * computed only after the candidate is built. This is intentional:
 * the search's job is to find feasible candidates; the score's
 * job is to rank them.
 */
export function sessionDiversityScore(solution, input) {
  const branchesById = input && Array.isArray(input.branches)
    ? new Map(input.branches.map((b) => [b.id, b]))
    : new Map();
  const teacherDays = new Map();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    for (const s of slots) {
      const tk = `${meta.teacherId}|${s.day}`;
      const branch = branchesById.get(s.branchId);
      const sess = sessionForSlot(s, branch);
      const cur = teacherDays.get(tk) ?? new Set();
      cur.add(sess);
      teacherDays.set(tk, cur);
    }
  }
  let total = 0, split = 0;
  for (const sessions of teacherDays.values()) {
    total += 1;
    if (sessions.size >= 2) split += 1;
  }
  if (total === 0) return 1;
  return 1 - split / total;
}
