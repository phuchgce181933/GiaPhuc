// Constraint catalog — Phase 22.
//
// PHASE 22 INTRODUCES A STRUCTURED, INDEPENDENT CONSTRAINT CATALOG.
// This catalog is independent from the solver, the AI strategy,
// the orchestrator search heuristic, and the scorer. It is
// deterministic: same input + same candidate = same violations.
//
// Every constraint has:
//   id          stable identifier (H01..H14, S01..S08)
//   code        human-readable code (also surfaced in violations)
//   name        short label
//   category    HARD | SOFT
//   severity    BLOCKING (hard) | PENALTY (soft)
//   description long-form description for the audit document
//   active      (input) => boolean  (data-driven activation)
//   evaluate    (candidate, input) => Violation[]
//
// A constraint may be ACTIVE, INACTIVE, or UNSUPPORTED.
// INACTIVE means the constraint does not apply because required
// data is missing. UNSUPPORTED means the constraint cannot be
// evaluated because a hard dependency (e.g. travel provider) is
// not yet wired. Neither status is a violation; both are reported
// in the audit.
//
// The constraint catalog is read-only. The solver does not
// modify it; the evaluator does not either. The catalog is the
// authoritative source of "what a feasible solution looks like";
// the evaluator is the function that checks a candidate against
// the catalog.
//
// Virtual entities (avoid invented) — see PHASE 22 §25 / §29:
//   - travelTime === null → H_TRAVEL_FEASIBLE = INACTIVE
//   - teacher.allowedTransferBranches missing → H_TRANSFER_ALLOWED = INACTIVE
//   - teacher.nguyenVong.soBuoiToiDa missing → H_MAX_SESSIONS_PER_WEEK = INACTIVE
//   - teacher.nguyenVong.thuNghi missing → H_FIXED_DAY_OFF = INACTIVE
//   - teacher.nguyenVong.buoiUuTien missing → S_PREFERRED_SESSION = INACTIVE
//   - capacity data missing → H_WORKLOAD_CAPACITY = INACTIVE
//
// Hard constraints are STRUCTURAL — a violation is fatal. Soft
// constraints are SCORE CONTRIBUTIONS — a violation is a penalty
// that the candidate's score absorbs but does not invalidate.

import { teacherConflictKey, classConflictKey, slotKey, sessionForSlot, isAdjacentTeachingPeriod, isBlockedTeachingSlot, normalizeSession } from '../time.js';
import { isEligibleFor } from '../eligibility.js';
import { checkTransition } from '../travel/index.js';
import { capacityTeacher } from '../workload.js';
import { candidateAssignments, classSubjectTeacherKey, effectiveAssignmentMeta, effectiveTeacherSlots, curriculumCoverage } from '../assignment.js';
import { canWorkAtBranch, TRANSFER_POLICY_STATUS } from '../transfer/transfer.js';
import { fixedDaysOffOf, hasSoftOffPreference, offPreferencePenalty } from '../preferences.js';

// ============================================================================
// Violation schema (per PHASE 22 §21)
// ============================================================================
//
// A violation is:
//   {
//     constraintId: 'H01',
//     code: 'H_CLASS_NO_DOUBLE_BOOK',
//     severity: 'BLOCKING' | 'PENALTY',
//     entityType: 'class' | 'teacher' | 'assignment' | 'slot' | 'teacher-day' | 'teacher-branch' | 'workload' | 'session',
//     entityIds: string[],
//     message: string,
//     penalty: number,
//   }
//
// `penalty` is the soft cost contribution (0 for hard violations;
// soft constraints accumulate into the soft total).

// ============================================================================
// Candidate contract
// ============================================================================
//
// The evaluator accepts a candidate of the shape the project's
// existing verify() consumes:
//
//   {
//     assignments: Map<assignmentId, Slot[]>,
//     slots?: Map<assignmentId, Slot[]>,   // alias
//     placements?: Map<assignmentId, { teacherId, branchId }>,
//   }
//
// Slot shape: { branchId, day, period, session? }
//
// The candidate is what a solver (Phase 23+) will emit. Today the
// candidate is a hand-built one or the legacy baseline converted
// to candidate shape.

function isCandidate(v) {
  if (!v || typeof v !== 'object') return false;
  return v.assignments instanceof Map
      || (Array.isArray(v.assignments))
      || (v.slots instanceof Map)
      || (Array.isArray(v.slots));
}

/**
 * Normalize a candidate into the canonical form used by the
 * catalog: a Map<assignmentId, Slot[]>.
 */
export function normalizeCandidate(candidate) {
  return candidateAssignments(candidate);
}

function placementTeacherId(candidate, input, aId) {
  return effectiveAssignmentMeta(candidate, aId, input)?.teacherId ?? null;
}

function placementBranchId(candidate, input, aId) {
  return effectiveAssignmentMeta(candidate, aId, input)?.branchId ?? null;
}

function placementClassId(input, aId) {
  return input.assignmentIndex?.get?.(aId)?.classId ?? null;
}

function placementSubjectId(input, aId) {
  return input.assignmentIndex?.get?.(aId)?.subjectId ?? null;
}

// ============================================================================
// HARD CONSTRAINTS
// ============================================================================

export const HARD_CONSTRAINTS = [
  // H01 — Class no double booking -----------------------------------------
  {
    id: 'H01',
    code: 'H_CLASS_NO_DOUBLE_BOOK',
    name: 'Class no double booking',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'A class cannot have two subjects at the same (day, session, period). ' +
      'Identity is (classId + day + session + period). The session component ' +
      'is mandatory: two slots at the same (day, period) but in different ' +
      'sessions (sang vs chieu) are NOT a conflict — they are different ' +
      'physical times. See Phase 22.1 audit for the legacy-baseline ' +
      'reconciliation.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const byClass = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const arr = byClass.get(meta.classId) ?? [];
        for (const s of slots) arr.push(s);
        byClass.set(meta.classId, arr);
      }
      const out = [];
      for (const [classId, slots] of byClass) {
        const seen = new Map();
        for (const s of slots) {
          const k = classConflictKey(s, input.branches?.find((branch) => branch.id === s.branchId));
          const prev = seen.get(k);
          if (prev) {
            out.push({
              constraintId: 'H01',
              code: 'H_CLASS_NO_DOUBLE_BOOK',
              severity: 'BLOCKING',
              entityType: 'class',
              entityIds: [classId],
              message: `class ${classId} has two slots at ${k}`,
              penalty: 0,
            });
          }
          seen.set(k, true);
        }
      }
      return out;
    },
  },

  // H02 — Teacher no double booking ---------------------------------------
  {
    id: 'H02',
    code: 'H_TEACHER_NO_DOUBLE_BOOK',
    name: 'Teacher no double booking',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'A teacher cannot be at two places at the same time. ' +
      'Identity is (teacherId + day + session + period), branch-agnostic. ' +
      'A teacher at two different branches in the same session AND ' +
      'period is still a conflict. Two slots at the same (day, period) ' +
      'but in different sessions (sang vs chieu) are NOT a conflict. ' +
      'See Phase 22.1 audit for the legacy-baseline reconciliation.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const byTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacherId = placementTeacherId(candidate, input, aId);
        if (!teacherId) continue;
        const arr = byTeacher.get(teacherId) ?? [];
        for (const s of slots) arr.push({ ...s, _aId: aId });
        byTeacher.set(teacherId, arr);
      }
      const out = [];
      for (const [teacherId, slots] of byTeacher) {
        const seen = new Map();
        for (const s of slots) {
          const k = teacherConflictKey(s, input.branches?.find((branch) => branch.id === s.branchId));
          const prev = seen.get(k);
          if (prev) {
            out.push({
              constraintId: 'H02',
              code: 'H_TEACHER_NO_DOUBLE_BOOK',
              severity: 'BLOCKING',
              entityType: 'teacher',
              entityIds: [teacherId],
              message: `teacher ${teacherId} double-booked at ${k} across branches ${prev.branchId} and ${s.branchId}`,
              penalty: 0,
            });
          }
          seen.set(k, { branchId: s.branchId });
        }
      }
      return out;
    },
  },

  // H03 — Assignment subject eligibility ----------------------------------
  {
    id: 'H03',
    code: 'H_TEACHER_ELIGIBLE',
    name: 'Assignment subject eligibility',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'A teacher may only teach a subject if the subject id is in their ' +
      '`eligibleSubjectIds[]` (preferred) or if the subject name is in ' +
      '`chuyenMon[].tenChuyenMon` (legacy fallback). The catalog consults ' +
      '`eligibleSubjectIds[]` first.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacher = input.teacherIndex?.get?.(meta.teacherId);
        if (!teacher || !isEligibleFor(teacher, meta.subjectId)) {
          out.push({
            constraintId: 'H03',
            code: 'H_TEACHER_ELIGIBLE',
            severity: 'BLOCKING',
            entityType: 'assignment',
            entityIds: [aId, meta.teacherId, meta.subjectId],
            message: `teacher ${teacher?.hoTen ?? meta.teacherId} is not eligible for ${meta.subjectId}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H04 — Assignment belongs to class branch ------------------------------
  {
    id: 'H04',
    code: 'H_SLOT_IN_BRANCH',
    name: 'Assignment belongs to class branch',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'Every placed slot must belong to the same branch as the class it ' +
      'serves. The assignment.branchId may be set explicitly or fall back ' +
      'to class.branchId. Cross-branch placement is a violation unless the ' +
      'future transfer feature moves the teacher across branches (then the ' +
      'target branch is the class branch).',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const classRec = Array.isArray(input.classes)
          ? input.classes.find((c) => c.id === meta.classId) : null;
        const classBranchId = classRec?.branchId;
        const branchId = classBranchId ?? input.assignmentIndex?.get?.(aId)?.branchId ?? meta.branchId;
        if (!branchId) continue;
        if (meta.branchId !== branchId) {
          out.push({ constraintId: 'H04', code: 'H_SLOT_IN_BRANCH', severity: 'BLOCKING', entityType: 'assignment', entityIds: [aId],
            message: `placement branch ${meta.branchId} does not match class branch ${branchId}`, penalty: 0 });
        }
        for (const s of slots) {
          if (s.branchId !== branchId) {
            out.push({
              constraintId: 'H04',
              code: 'H_SLOT_IN_BRANCH',
              severity: 'BLOCKING',
              entityType: 'assignment',
              entityIds: [aId],
              message: `slot ${slotKey(s)} on branch ${s.branchId} is not in class branch ${branchId}`,
              penalty: 0,
            });
          }
        }
      }
      return out;
    },
  },

  // H05 — Demand fulfillment -----------------------------------------------
  {
    id: 'H05',
    code: 'H_ASSIGNMENT_COMPLETE',
    name: 'Demand fulfillment',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'Every assignment must have exactly `requiredPeriods` slots. ' +
      'Partial fulfillment (0 < scheduled < required) is a hard violation; ' +
      'an unfilled assignment (0 scheduled) is also a hard violation. ' +
      'Partial-fulfillment allowance would be a future explicit rule.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const slots = slotsByAssignment.get(aId) ?? [];
        if (slots.length !== meta.requiredPeriods) {
          out.push({
            constraintId: 'H05',
            code: 'H_ASSIGNMENT_COMPLETE',
            severity: 'BLOCKING',
            entityType: 'assignment',
            entityIds: [aId],
            message: `assignment ${aId} has ${slots.length}/${meta.requiredPeriods} slots`,
            penalty: 0,
          });
        }
      }
      for (const pair of curriculumCoverage(input, candidate)) {
        out.push({ constraintId: 'H05', code: 'H_ASSIGNMENT_COMPLETE', severity: 'BLOCKING', entityType: 'class-subject',
          entityIds: [pair.classId, pair.subjectId], message: `curriculum needs ${pair.requiredPeriods} periods but candidate schedules ${pair.assignedPeriods}`, penalty: 0 });
      }
      // Also check unplaced assignments — any assignment not in the
      // candidate's placements map is unplaced.
      if (Array.isArray(input.assignments)) {
        for (const a of input.assignments) {
          if (!slotsByAssignment.has(a.id)) {
            out.push({
              constraintId: 'H05',
              code: 'H_ASSIGNMENT_COMPLETE',
              severity: 'BLOCKING',
              entityType: 'assignment',
              entityIds: [a.id],
              message: `assignment ${a.id} has 0/${a.requiredPeriods ?? 0} slots (unplaced)`,
              penalty: 0,
            });
          }
        }
      }
      return out;
    },
  },

  // H06 — No slot collision -------------------------------------------------
  {
    id: 'H06',
    code: 'H_SLOT_VALID',
    name: 'No slot collision',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'Every placed slot must carry a valid (branchId, day, period) that ' +
      'is in the branch profile. Missing or invalid slot fields are ' +
      'violations.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const branchIds = new Set((input.branches ?? []).map((b) => b.id));
      const branchProfile = new Map();
      for (const b of input.branches ?? []) {
        if (!b?.id) continue;
        const slots = [];
        for (const day of b.schoolDays ?? []) {
          for (const period of b.periods ?? []) {
            slots.push(`${b.id}:${day}:${period}`);
          }
        }
        branchProfile.set(b.id, new Set(slots));
      }
      for (const [aId, slots] of slotsByAssignment) {
        if (!input.assignmentIndex?.get?.(aId) && !input.assignments?.some((assignment) => assignment.id === aId)) {
          out.push({ constraintId: 'H06', code: 'H_SLOT_VALID', severity: 'BLOCKING', entityType: 'assignment', entityIds: [aId],
            message: `UNKNOWN_ASSIGNMENT: ${aId} is not in the scheduling input`, penalty: 0 });
        }
        for (const s of slots) {
          if (s == null || typeof s !== 'object') {
            out.push({
              constraintId: 'H06',
              code: 'H_SLOT_VALID',
              severity: 'BLOCKING',
              entityType: 'slot',
              entityIds: [aId],
              message: `slot for ${aId} is not an object`,
              penalty: 0,
            });
            continue;
          }
          if (s.branchId == null || s.day == null || s.period == null) {
            out.push({
              constraintId: 'H06',
              code: 'H_SLOT_VALID',
              severity: 'BLOCKING',
              entityType: 'slot',
              entityIds: [aId],
              message: `slot for ${aId} is missing branchId/day/period`,
              penalty: 0,
            });
            continue;
          }
          if (!Number.isInteger(Number(s.day)) || Number(s.day) < 1 || Number(s.day) > 7
            || !Number.isInteger(Number(s.period)) || Number(s.period) < 1) {
            out.push({ constraintId: 'H06', code: 'H_SLOT_VALID', severity: 'BLOCKING', entityType: 'slot', entityIds: [aId],
              message: 'A slot needs an integer weekday and positive integer period.', penalty: 0 });
          }
          if (!branchIds.has(s.branchId)) {
            out.push({
              constraintId: 'H06',
              code: 'H_SLOT_VALID',
              severity: 'BLOCKING',
              entityType: 'slot',
              entityIds: [aId],
              message: `slot for ${aId} references unknown branch ${s.branchId}`,
              penalty: 0,
            });
            continue;
          }
          const allowed = branchProfile.get(s.branchId);
          const branch = input.branches.find((entry) => entry.id === s.branchId);
          const expectedSession = sessionForSlot(s, branch);
          if (!expectedSession || (s.session != null && normalizeSession(s.session) !== expectedSession)) {
            out.push({ constraintId: 'H06', code: 'H_SLOT_VALID', severity: 'BLOCKING', entityType: 'slot', entityIds: [aId],
              message: `slot ${slotKey(s)} session ${s.session} does not match calendar session ${expectedSession}`, penalty: 0 });
          }
          if (allowed && !allowed.has(`${s.branchId}:${s.day}:${s.period}`)) {
            out.push({
              constraintId: 'H06',
              code: 'H_SLOT_VALID',
              severity: 'BLOCKING',
              entityType: 'slot',
              entityIds: [aId],
              message: `slot ${slotKey(s)} is not in branch profile`,
              penalty: 0,
            });
          }
        }
      }
      return out;
    },
  },

  // H07 — Assignment identity (one teacher per logical demand) -----------
  {
    id: 'H07',
    code: 'H_CLASS_SUBJECT_ONE_TEACHER',
    name: 'Assignment identity',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'A class-subject demand maps to one teacher; Công nghệ and Tin học are linked. ' +
      'Split assignments (two teachers for the same logical demand) are a ' +
      'violation. The contract does not currently support split assignments.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const byKey = new Map();
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const k = classSubjectTeacherKey(meta.classId, meta.subjectId, input);
        const teacherId = placementTeacherId(candidate, input, aId);
        if (!teacherId) continue;
        const cur = byKey.get(k) ?? { classId: meta.classId, subjectIds: new Set(), teachers: new Set() };
        cur.subjectIds.add(meta.subjectId);
        cur.teachers.add(teacherId);
        byKey.set(k, cur);
      }
      const out = [];
      for (const [, v] of byKey) {
        if (v.teachers.size > 1) {
          out.push({
            constraintId: 'H07',
            code: 'H_CLASS_SUBJECT_ONE_TEACHER',
            severity: 'BLOCKING',
            entityType: 'class-subject',
            entityIds: [v.classId, ...v.subjectIds, ...v.teachers],
            message: `class ${v.classId} linked subjects ${[...v.subjectIds].join(', ')} have multiple teachers: ${[...v.teachers].join(', ')}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H08 — Active entities --------------------------------------------------
  {
    id: 'H08',
    code: 'H_ACTIVE_ENTITY',
    name: 'Active entities only',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'Solver candidates must reference only active entities. The legacy ' +
      'dump may still contain inactive teachers / subjects / classes / ' +
      'branches / curriculum rows; those remain in NORMALIZED for audit ' +
      'but never enter the candidate pool.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const teacherIsActive = new Map((input.teachers ?? []).map((t) => [t.id, t.trangThai !== 'inactive' && t.isActive !== false]));
      const subjectIsActive = new Map((input.subjects ?? []).map((s) => [s.id, s.isActive !== false]));
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        if (teacherIsActive.get(meta.teacherId) !== true) {
          out.push({
            constraintId: 'H08',
            code: 'H_ACTIVE_ENTITY',
            severity: 'BLOCKING',
            entityType: 'teacher',
            entityIds: [meta.teacherId],
            message: `assignment ${aId} references inactive teacher ${meta.teacherId}`,
            penalty: 0,
          });
        }
        if (subjectIsActive.has(meta.subjectId) && subjectIsActive.get(meta.subjectId) === false) {
          out.push({
            constraintId: 'H08',
            code: 'H_ACTIVE_ENTITY',
            severity: 'BLOCKING',
            entityType: 'subject',
            entityIds: [meta.subjectId],
            message: `assignment ${aId} references inactive subject ${meta.subjectId}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H09 — Workload capacity ------------------------------------------------
  {
    id: 'H09',
    code: 'H_WORKLOAD_CAPACITY',
    name: 'Workload capacity',
    category: 'HARD',
    severity: 'BLOCKING',
    description: 'Scheduled periods must not exceed explicit capacityPeriodsPerWeek. Historical workload and specialization demand are not capacity.',
    active: (input) => (input.teachers ?? []).some((teacher) => capacityTeacher(teacher) !== null),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const actualByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        actualByTeacher.set(meta.teacherId, (actualByTeacher.get(meta.teacherId) ?? 0) + slots.length);
      }
      for (const t of input.teachers ?? []) {
        const cap = capacityTeacher(t);
        if (cap === null) continue;
        const actual = actualByTeacher.get(t.id) ?? 0;
        if (actual > cap) {
          out.push({
            constraintId: 'H09',
            code: 'H_WORKLOAD_CAPACITY',
            severity: 'BLOCKING',
            entityType: 'workload',
            entityIds: [t.id],
            message: `teacher ${t.hoTen ?? t.id} workload ${actual} exceeds capacity ${cap}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H10 — Max sessions/week ------------------------------------------------
  {
    id: 'H10',
    code: 'H_MAX_SESSIONS_PER_WEEK',
    name: 'Max sessions per week',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'If a teacher declares `maxSessionsPerWeek`, the number of distinct ' +
      '(day, session) tuples assigned to them must not exceed it. Periods ' +
      'do NOT count toward this; morning + afternoon on the same day is ' +
      'two sessions, not one. If the field is missing, the constraint is ' +
      'INACTIVE.',
    active: (input) => Array.isArray(input.teachers) && input.teachers.some((t) => (t.nguyenVong?.soBuoiToiDa ?? 0) > 0),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const branchesById = new Map((input.branches ?? []).map((b) => [b.id, b]));
      const sessionsByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const cur = sessionsByTeacher.get(meta.teacherId) ?? new Set();
        for (const s of slots) {
          const branch = branchesById.get(s.branchId);
          const sess = sessionForSlot(s, branch);
          cur.add(`${s.day}|${sess}`);
        }
        sessionsByTeacher.set(meta.teacherId, cur);
      }
      for (const t of input.teachers ?? []) {
        const max = t.nguyenVong?.soBuoiToiDa ?? 0;
        if (!max) continue;
        const used = sessionsByTeacher.get(t.id)?.size ?? 0;
        if (used > max) {
          out.push({
            constraintId: 'H10',
            code: 'H_MAX_SESSIONS_PER_WEEK',
            severity: 'BLOCKING',
            entityType: 'teacher',
            entityIds: [t.id],
            message: `teacher ${t.hoTen ?? t.id} uses ${used} sessions/week, exceeds max ${max}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H11 — Fixed day off ----------------------------------------------------
  {
    id: 'H11',
    code: 'H_FIXED_DAY_OFF',
    name: 'Fixed day off',
    category: 'HARD',
    severity: 'BLOCKING',
    description: 'Only explicit fixedDayOff is hard. Preferred day/part and legacy nguyenVong day wishes are soft.',
    active: (input) => (input.teachers ?? []).some((t) => fixedDaysOffOf(t).length > 0),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const daysByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const cur = daysByTeacher.get(meta.teacherId) ?? new Set();
        for (const s of slots) cur.add(s.day);
        daysByTeacher.set(meta.teacherId, cur);
      }
      for (const t of input.teachers ?? []) {
        const off = fixedDaysOffOf(t);
        if (off.length === 0) continue;
        const used = daysByTeacher.get(t.id) ?? new Set();
        const hits = off.filter((d) => used.has(d));
        if (hits.length > 0) {
          out.push({
            constraintId: 'H11',
            code: 'H_FIXED_DAY_OFF',
            severity: 'BLOCKING',
            entityType: 'teacher-day',
            entityIds: [t.id, ...hits.map(String)],
            message: `teacher ${t.hoTen ?? t.id} scheduled on day off ${hits.join(',')}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H12 — Preferred session (SOFT mapping — listed under hard for catalogue)
  //   NOTE: brief §14 says preference is SOFT. We expose the HARD-shaped
  //   variant only when a teacher has declared a session preference AND
  //   the domain contract says it is hard. Today the contract says SOFT.
  //   So this constraint always reports INACTIVE. The soft variant is
  //   S01. Kept here for catalogue completeness.
  {
    id: 'H12',
    code: 'H_PREFERRED_SESSION',
    name: 'Preferred session (hard, when contract says so)',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'A teacher with a session preference (`buoiUuTien ∈ {sang, chieu}`) ' +
      'must be scheduled only in that session when this is a hard ' +
      'constraint. Today the contract declares this is SOFT, so this ' +
      'constraint is INACTIVE in the current domain.',
    active: () => false,
    evaluate() { return []; },
  },

  // H13 — Transfer permission ----------------------------------------------
  {
    id: 'H13',
    code: 'H_TRANSFER_ALLOWED',
    name: 'Transfer permission',
    category: 'HARD',
    severity: 'BLOCKING',
    description: 'Home is permitted. AUTO_SHORTAGE allows external teaching after the home stage; non-empty explicit branch restrictions still apply. EXPLICIT requires declared external permission.',
    active: (input) => (input.teachers ?? []).some((teacher) => teacher.homeBranchId != null || Array.isArray(teacher.allowedTransferBranches)),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacher = input.teacherIndex?.get?.(meta.teacherId);
        if (!teacher) continue;
        const assignmentBranch = placementBranchId(candidate, input, aId);
        if (!assignmentBranch) continue;
        if (canWorkAtBranch(teacher, assignmentBranch, input.transferPolicy).status === TRANSFER_POLICY_STATUS.NOT_ALLOWED) {
          out.push({
            constraintId: 'H13',
            code: 'H_TRANSFER_ALLOWED',
            severity: 'BLOCKING',
            entityType: 'teacher-branch',
            entityIds: [teacher.id, assignmentBranch],
            message: `teacher ${teacher.hoTen ?? teacher.id} not allowed to transfer to ${assignmentBranch}`,
            penalty: 0,
          });
        }
      }
      return out;
    },
  },

  // H14 — Travel feasibility (UNSUPPORTED when matrix missing) -----------
  {
    id: 'H14',
    code: 'H_TRAVEL_FEASIBLE',
    name: 'Travel feasibility',
    category: 'HARD',
    severity: 'BLOCKING',
    description:
      'Cross-branch transitions on the same day must be feasible in the ' +
      'travel matrix. When `travelTime` is null (no travel provider), the ' +
      'constraint is INACTIVE / UNSUPPORTED — the matrix is never fabricated. ' +
      'A future TravelProvider can plug into the catalog without changing ' +
      'this entry.',
    active: (input) => Boolean(input?.travelTime),
    evaluate(candidate, input) {
      if (!input?.travelTime) return [];
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const teacherSlots = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacherId = placementTeacherId(candidate, input, aId);
        const arr = teacherSlots.get(teacherId) ?? [];
        for (const s of slots) arr.push(s);
        teacherSlots.set(teacherId, arr);
      }
      const transition = input.transitionMinutes ?? 10;
      for (const [teacherId, slots] of teacherSlots) {
        const sorted = slots.slice().sort((a, b) => (a.day - b.day) || (a.period - b.period));
        for (let i = 1; i < sorted.length; i++) {
          const prev = sorted[i - 1];
          const next = sorted[i];
          if (prev.day !== next.day) continue;
          const t = checkTransition(prev, next, input.travelTime, transition);
          if (!t.feasible) {
            out.push({
              constraintId: 'H14',
              code: 'H_TRAVEL_FEASIBLE',
              severity: 'BLOCKING',
              entityType: 'slot',
              entityIds: [teacherId],
              message: `travel from ${prev.branchId} to ${next.branchId} on day ${next.day}: ${t.reason}`,
              penalty: 0,
            });
          }
        }
      }
      return out;
    },
  },
  {
    id: 'H15', code: 'H_CALENDAR_BLOCKED_SLOT', name: 'Blocked calendar slot', category: 'HARD', severity: 'BLOCKING',
    description: 'Monday morning period 1 and Friday morning period 4 are unavailable.', active: () => true,
    evaluate(candidate, input) {
      const out = [];
      for (const [assignmentId, slots] of normalizeCandidate(candidate)) for (const slot of slots ?? []) {
        if (isBlockedTeachingSlot(slot, input.branches?.find((branch) => branch.id === slot.branchId))) {
          out.push({ constraintId:'H15',code:'H_CALENDAR_BLOCKED_SLOT',severity:'BLOCKING',entityType:'slot',entityIds:[assignmentId],message:`slot Monday M1 / Friday M4 is blocked`,penalty:0 });
        }
      }
      return out;
    },
  },
  {
    id: 'H16', code: 'H_CLASS_SUBJECT_NON_CONSECUTIVE', name: 'Same subject not consecutive', category: 'HARD', severity: 'BLOCKING',
    description: 'A class cannot have the same subject in adjacent periods within one teaching session.', active: () => true,
    evaluate(candidate, input) {
      const groups = new Map();
      for (const [aId, slots] of normalizeCandidate(candidate)) {
        const meta = effectiveAssignmentMeta(candidate, aId, input); if (!meta) continue;
        const key = `${meta.classId}|${meta.subjectId}`; const list = groups.get(key) ?? [];
        for (const slot of slots ?? []) list.push({ ...slot, assignmentId:aId, classId:meta.classId, subjectId:meta.subjectId });
        groups.set(key,list);
      }
      const out=[];
      for (const list of groups.values()) for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++) if(isAdjacentTeachingPeriod(list[i], list[j], input.branches?.find((branch) => branch.id === list[i].branchId), input.branches?.find((branch) => branch.id === list[j].branchId))) out.push({constraintId:'H16',code:'H_CLASS_SUBJECT_NON_CONSECUTIVE',severity:'BLOCKING',entityType:'class',entityIds:[list[i].classId,list[i].subjectId],message:`same subject occupies adjacent periods ${list[i].period} and ${list[j].period}`,penalty:0});
      return out;
    },
  },
  {
    id: 'H17', code: 'H_TEACHER_BRANCH_TRANSITION', name: 'No adjacent cross-branch teaching', category: 'HARD', severity: 'BLOCKING',
    description: 'A teacher cannot teach consecutive periods at different branches within one session.', active: () => true,
    evaluate(candidate, input) {
      const groups=new Map();
      for(const [aId,slots] of normalizeCandidate(candidate)) { const teacherId=placementTeacherId(candidate,input,aId); if(!teacherId)continue; const list=groups.get(teacherId)??[]; for(const slot of slots??[])list.push({...slot,teacherId});groups.set(teacherId,list); }
      const out=[];
      for(const [teacherId,list] of groups) for(let i=0;i<list.length;i++) for(let j=i+1;j<list.length;j++) if(list[i].branchId!==list[j].branchId&&isAdjacentTeachingPeriod(list[i],list[j])) out.push({constraintId:'H17',code:'H_TEACHER_BRANCH_TRANSITION',severity:'BLOCKING',entityType:'teacher',entityIds:[teacherId,list[i].branchId,list[j].branchId],message:`teacher cannot move from ${list[i].branchId} to ${list[j].branchId} between adjacent periods`,penalty:0});
      return out;
    },
  },
];

// ============================================================================
// SOFT CONSTRAINTS
// ============================================================================

export const SOFT_CONSTRAINTS = [
  // S01 — Teacher preferred session ----------------------------------------
  {
    id: 'S01',
    code: 'S_PREFERRED_SESSION',
    name: 'Teacher preferred session',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'A teacher with `nguyenVong.buoiUuTien` is rewarded (penalty = 0) ' +
      'when their slots are in that session; penalized by the share that ' +
      'falls outside. `ca_hai` is no penalty. Missing preference → INACTIVE.',
    active: (input) => Array.isArray(input.teachers) && input.teachers.some((t) => t.nguyenVong?.buoiUuTien && t.nguyenVong.buoiUuTien !== 'ca_hai'),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out_ = [];
      const branchesById = new Map((input.branches ?? []).map((b) => [b.id, b]));
      const slotsByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const arr = slotsByTeacher.get(meta.teacherId) ?? [];
        for (const s of slots) arr.push(s);
        slotsByTeacher.set(meta.teacherId, arr);
      }
      for (const t of input.teachers ?? []) {
        const pref = t.nguyenVong?.buoiUuTien;
        if (!pref || pref === 'ca_hai') continue;
        const slots = slotsByTeacher.get(t.id) ?? [];
        if (slots.length === 0) continue;
        let match = 0;
        for (const s of slots) {
          const branch = branchesById.get(s.branchId);
          const sess = sessionForSlot(s, branch);
          if (sess === pref) match++;
        }
        const ratio = match / slots.length;
        const penalty = 1 - ratio;
        if (penalty > 0) {
          out_.push({
            constraintId: 'S01',
            code: 'S_PREFERRED_SESSION',
            severity: 'PENALTY',
            entityType: 'session',
            entityIds: [t.id],
            message: `teacher ${t.hoTen ?? t.id} preferred ${pref}, matched ${match}/${slots.length}`,
            penalty,
          });
        }
      }
      return out_;
    },
  },

  // S02 — Max sessions pressure -------------------------------------------
  {
    id: 'S02',
    code: 'S_MAX_SESSIONS_PRESSURE',
    name: 'Max sessions pressure',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'Soft penalty when a teacher\'s distinct (day, session) usage ' +
      'exceeds `maxSessionsPerWeek`. The penalty is the excess ratio ' +
      'above the cap. Hard version is H10; this is the soft pressure.',
    active: (input) => Array.isArray(input.teachers) && input.teachers.some((t) => (t.nguyenVong?.soBuoiToiDa ?? 0) > 0),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const branchesById = new Map((input.branches ?? []).map((b) => [b.id, b]));
      const sessionsByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const cur = sessionsByTeacher.get(meta.teacherId) ?? new Set();
        for (const s of slots) {
          const branch = branchesById.get(s.branchId);
          const sess = sessionForSlot(s, branch);
          cur.add(`${s.day}|${sess}`);
        }
        sessionsByTeacher.set(meta.teacherId, cur);
      }
      for (const t of input.teachers ?? []) {
        const max = t.nguyenVong?.soBuoiToiDa ?? 0;
        if (!max) continue;
        const used = sessionsByTeacher.get(t.id)?.size ?? 0;
        if (used > max) {
          const penalty = (used - max) / max;
          out.push({
            constraintId: 'S02',
            code: 'S_MAX_SESSIONS_PRESSURE',
            severity: 'PENALTY',
            entityType: 'session',
            entityIds: [t.id],
            message: `teacher ${t.hoTen ?? t.id} uses ${used} sessions, exceeds cap ${max}`,
            penalty,
          });
        }
      }
      return out;
    },
  },

  // S03 — preferred day/part off is soft; fixedDaysOffOf belongs to H11.
  {
    id: 'S03', code: 'S_PREFERRED_DAY_OFF', name: 'Preferred day and part off', category: 'SOFT', severity: 'PENALTY',
    description: 'Penalty for teaching in the preferred day and part; never prohibits teaching.',
    active: (input) => (input.teachers ?? []).some(hasSoftOffPreference),
    evaluate(candidate, input) {
      const byTeacher = effectiveTeacherSlots(candidate, input);
      return (input.teachers ?? []).flatMap((teacher) => {
        const penalty = offPreferencePenalty(teacher, byTeacher.get(teacher.id) ?? [], input);
        return penalty ? [{ constraintId: 'S03', code: 'S_PREFERRED_DAY_OFF', severity: 'PENALTY', entityType: 'teacher-day',
          entityIds: [teacher.id], message: 'Teaching during a preferred day/part off', penalty }] : [];
      });
    },
  },

  // S04 — Workload balance -------------------------------------------------
  {
    id: 'S04',
    code: 'S_WORKLOAD_BALANCE',
    name: 'Workload balance',
    category: 'SOFT',
    severity: 'PENALTY',
    description: 'Soft deviation from an explicitly declared weekly capacity. Unknown source capacity is excluded.',
    active: (input) => (input.teachers ?? []).some((teacher) => capacityTeacher(teacher) !== null),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const actualByTeacher = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        actualByTeacher.set(meta.teacherId, (actualByTeacher.get(meta.teacherId) ?? 0) + slots.length);
      }
      let totalPenalty = 0, count = 0;
      for (const t of input.teachers ?? []) {
        const budget = capacityTeacher(t);
        if (budget === null || budget === 0) continue;
        const actual = actualByTeacher.get(t.id) ?? 0;
        const deviation = Math.abs(actual - budget) / budget;
        totalPenalty += deviation;
        count += 1;
      }
      if (count === 0) return [];
      const aggregate = totalPenalty / count;
      return [{
        constraintId: 'S04',
        code: 'S_WORKLOAD_BALANCE',
        severity: 'PENALTY',
        entityType: 'workload',
        entityIds: [],
        message: `workload deviation mean: ${aggregate.toFixed(3)}`,
        penalty: aggregate,
      }];
    },
  },

  // S05 — Transfer preference ---------------------------------------------
  {
    id: 'S05',
    code: 'S_TRANSFER_PREFERENCE',
    name: 'Transfer preference',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'Soft reward for placing a teacher at one of their preferred ' +
      'transfer branches. Missing `preferredTransferBranches` → INACTIVE.',
    active: (input) => Array.isArray(input.teachers) && input.teachers.some((t) => Array.isArray(t.preferredTransferBranches) && t.preferredTransferBranches.length > 0),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacher = input.teacherIndex?.get?.(meta.teacherId);
        if (!teacher) continue;
        const pref = teacher.preferredTransferBranches;
        if (!Array.isArray(pref) || pref.length === 0) continue;
        const branchId = placementBranchId(candidate, input, aId);
        if (!branchId) continue;
        if (teacher.homeBranchId != null && branchId !== teacher.homeBranchId && !pref.includes(branchId)) {
          out.push({
            constraintId: 'S05',
            code: 'S_TRANSFER_PREFERENCE',
            severity: 'PENALTY',
            entityType: 'teacher-branch',
            entityIds: [teacher.id, branchId],
            message: `teacher ${teacher.hoTen ?? teacher.id} at non-preferred branch ${branchId}`,
            penalty: 0.1,
          });
        }
      }
      return out;
    },
  },

  // S06 — Preferred grade -------------------------------------------------
  {
    id: 'S06',
    code: 'S_PREFERRED_GRADE',
    name: 'Preferred grade',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'Soft reward for placing a teacher on classes of their preferred ' +
      'grade. Missing `preferredGrades` → INACTIVE.',
    active: (input) => Array.isArray(input.teachers) && input.teachers.some((t) => Array.isArray(t.preferredGrades) && t.preferredGrades.length > 0),
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const out = [];
      const classById = new Map((input.classes ?? []).map((c) => [c.id, c]));
      for (const aId of slotsByAssignment.keys()) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        const teacher = input.teacherIndex?.get?.(meta.teacherId);
        if (!teacher) continue;
        const pref = teacher.preferredGrades;
        if (!Array.isArray(pref) || pref.length === 0) continue;
        const cls = classById.get(meta.classId);
        if (!cls) continue;
        if (!pref.includes(cls.gradeLevel)) {
          out.push({
            constraintId: 'S06',
            code: 'S_PREFERRED_GRADE',
            severity: 'PENALTY',
            entityType: 'teacher-class',
            entityIds: [teacher.id, cls.id],
            message: `teacher ${teacher.hoTen ?? teacher.id} at non-preferred grade ${cls.gradeLevel}`,
            penalty: 0.05,
          });
        }
      }
      return out;
    },
  },

  // S07 — Session compactness (formerly sessionDiversity) -----------------
  {
    id: 'S07',
    code: 'S_SESSION_COMPACTNESS',
    name: 'Session compactness',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'Penalty is proportional to the share of teacher-days that span ' +
      'BOTH sang and chieu. Compact days (only sang OR only chieu) pay ' +
      'no penalty. Empty candidate → no penalty. Semantic per Phase 17.1.',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const branchesById = new Map((input.branches ?? []).map((b) => [b.id, b]));
      const teacherDays = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        for (const s of slots) {
          const k = `${meta.teacherId}|${s.day}`;
          const branch = branchesById.get(s.branchId);
          const sess = sessionForSlot(s, branch);
          const cur = teacherDays.get(k) ?? new Set();
          cur.add(sess);
          teacherDays.set(k, cur);
        }
      }
      let total = 0, split = 0;
      for (const sessions of teacherDays.values()) {
        total += 1;
        if (sessions.size >= 2) split += 1;
      }
      if (total === 0) return [];
      const penalty = split / total;
      if (penalty === 0) return [];
      return [{
        constraintId: 'S07',
        code: 'S_SESSION_COMPACTNESS',
        severity: 'PENALTY',
        entityType: 'session',
        entityIds: [],
        message: `session compactness: ${split}/${total} teacher-days split`,
        penalty,
      }];
    },
  },

  // S08 — Teacher-day concentration ---------------------------------------
  {
    id: 'S08',
    code: 'S_TEACHER_DAY_CONCENTRATION',
    name: 'Teacher-day concentration',
    category: 'SOFT',
    severity: 'PENALTY',
    description:
      'Penalty when a teacher-day has scattered (non-contiguous) ' +
      'periods. Score per teacher-period is 1 when all slots on that day ' +
      'form a contiguous block; degrades as gaps appear. Duplicate ' +
      'periods (from cross-assignment overlaps) do not count toward ' +
      'the spread — uniqueness is the right notion of "concentration".',
    active: () => true,
    evaluate(candidate, input) {
      const slotsByAssignment = normalizeCandidate(candidate);
      const teacherDays = new Map();
      for (const [aId, slots] of slotsByAssignment) {
        const meta = effectiveAssignmentMeta(candidate, aId, input);
        if (!meta) continue;
        for (const s of slots) {
          const k = `${meta.teacherId}|${s.day}`;
          const cur = teacherDays.get(k) ?? new Set();
          cur.add(s.period);
          teacherDays.set(k, cur);
        }
      }
      let total = 0, gapPenalty = 0;
      for (const [key, periodSet] of teacherDays) {
        const periods = [...periodSet];
        if (periods.length < 2) {
          total += 1;
          continue;
        }
        total += 1;
        periods.sort((a, b) => a - b);
        const min = periods[0], max = periods[periods.length - 1];
        const span = max - min + 1;
        const fill = periods.length / span;
        gapPenalty += (1 - fill);
      }
      if (total === 0) return [];
      const aggregate = gapPenalty / total;
      if (aggregate === 0) return [];
      return [{
        constraintId: 'S08',
        code: 'S_TEACHER_DAY_CONCENTRATION',
        severity: 'PENALTY',
        entityType: 'teacher-day',
        entityIds: [],
        message: `teacher-day gap penalty mean: ${aggregate.toFixed(3)}`,
        penalty: aggregate,
      }];
    },
  },
];

// ============================================================================
// Composite catalog
// ============================================================================

export const CATALOG = [...HARD_CONSTRAINTS, ...SOFT_CONSTRAINTS];

export const CATALOG_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));

export function getConstraint(id) {
  return CATALOG_BY_ID.get(id) ?? null;
}

export function listHard() {
  return HARD_CONSTRAINTS.slice();
}

export function listSoft() {
  return SOFT_CONSTRAINTS.slice();
}
