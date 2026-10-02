// Independent validator. Pure: no IO, no globals. Does not import
// the solver. Shares the constraint catalog with the solver for
// read-only access.
//
// PHASE 16: the validator reads the solver's effective placement
// (teacherId, branchId) from `solution.placements` when present,
// and falls back to `input.assignmentIndex` otherwise. This lets a
// solution carry the chosen (teacherId, branchId) for an open
// assignment, while still working with hand-crafted solutions in
// tests that have no placements map.

import { HARD } from './constraints.js';

function placementTeacherId(solution, input, aId) {
  return solution.placements?.get(aId)?.teacherId
    ?? input.assignmentIndex.get(aId)?.teacherId
    ?? null;
}

function placementBranchId(solution, input, aId) {
  return solution.placements?.get(aId)?.branchId
    ?? input.assignmentIndex.get(aId)?.branchId
    ?? null;
}

function placementClassId(solution, input, aId) {
  return input.assignmentIndex.get(aId)?.classId ?? null;
}

function placementSubjectId(solution, input, aId) {
  return input.assignmentIndex.get(aId)?.subjectId ?? null;
}

export function verify(solution, input) {
  const hardViolations = [];
  const warnings = [];
  const inactiveConstraints = [];

  for (const [name, def] of Object.entries(HARD)) {
    if (def.active && !def.active(input)) {
      inactiveConstraints.push(name);
      continue;
    }
    // For each constraint, we re-derive (solution, input)-shaped
    // views that always carry the effective teacherId and branchId
    // on the assignment meta. The HARD catalog expects the meta
    // to have `teacherId`, `branchId`, `classId`, `subjectId`.
    const viewInput = withEffectiveMeta(solution, input);
    const v = def.check(solution, viewInput);
    if (v && v.length) hardViolations.push(...v);
  }

  let total = 0, full = 0, partial = 0, none = 0;
  for (const a of input.assignments) {
    total += 1;
    const slots = solution.assignments.get(a.id) ?? [];
    if (slots.length === 0) none += 1;
    else if (slots.length === a.requiredPeriods) full += 1;
    else partial += 1;
  }

  const distinctDaysUsedByTeacher = {};
  const distinctSessionsUsedByTeacher = {};
  const slotsByBranchDayPeriod = {};
  const teacherSeen = new Map();
  const teacherSessionSeen = new Map();
  for (const [aId, slots] of solution.assignments) {
    const teacherId = placementTeacherId(solution, input, aId);
    if (!teacherId) continue;
    const set = teacherSeen.get(teacherId) ?? new Set();
    const sSet = teacherSessionSeen.get(teacherId) ?? new Set();
    for (const s of slots) {
      set.add(s.day);
      const k = `${s.branchId}:${s.day}:${s.period}`;
      slotsByBranchDayPeriod[k] = (slotsByBranchDayPeriod[k] ?? 0) + 1;
    }
    teacherSeen.set(teacherId, set);
    teacherSessionSeen.set(teacherId, sSet);
  }
  for (const [tid, set] of teacherSeen) distinctDaysUsedByTeacher[tid] = set.size;

  if (inactiveConstraints.length) {
    warnings.push(`INACTIVE: ${inactiveConstraints.join(', ')}`);
  }

  return {
    accepted: hardViolations.length === 0 && none === 0,
    hardViolations,
    warnings,
    coverage: { totalAssignments: total, fullyScheduled: full, partiallyScheduled: partial, notScheduled: none },
    metrics: { distinctDaysUsedByTeacher, distinctSessionsUsedByTeacher, slotsByBranchDayPeriod },
    inactiveConstraints,
  };
}

/**
 * Build a view-input whose `assignmentIndex` carries the
 * solver's effective (teacherId, branchId) when present. The
 * underlying HARD catalog reads `meta.teacherId`, `meta.branchId`,
 * `meta.classId`, `meta.subjectId`. By materialising a fresh
 * assignmentIndex with the chosen values merged in, the catalog
 * does not need to know about `solution.placements`.
 */
function withEffectiveMeta(solution, input) {
  if (!solution.placements) return input;
  const merged = new Map();
  for (const [aId, meta] of input.assignmentIndex) {
    const placement = solution.placements.get(aId);
    if (!placement) {
      merged.set(aId, meta);
      continue;
    }
    merged.set(aId, {
      ...meta,
      teacherId: placement.teacherId ?? meta.teacherId,
      branchId: placement.branchId ?? meta.branchId,
    });
  }
  return { ...input, assignmentIndex: merged };
}
