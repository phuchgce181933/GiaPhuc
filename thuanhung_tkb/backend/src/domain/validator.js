// Independent validator. Pure: no IO, no globals. Does not import
// the solver. Shares the constraint catalog with the solver for
// read-only access.

import { HARD } from './constraints.js';

export function verify(solution, input) {
  const hardViolations = [];
  const warnings = [];
  const inactiveConstraints = [];

  for (const [name, def] of Object.entries(HARD)) {
    if (def.active && !def.active(input)) {
      inactiveConstraints.push(name);
      continue;
    }
    const v = def.check(solution, input);
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
  const slotsByBranchDayPeriod = {};
  const teacherSeen = new Map();
  for (const [aId, slots] of solution.assignments) {
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    const set = teacherSeen.get(meta.teacherId) ?? new Set();
    for (const s of slots) {
      set.add(s.day);
      const k = `${s.branchId}:${s.day}:${s.period}`;
      slotsByBranchDayPeriod[k] = (slotsByBranchDayPeriod[k] ?? 0) + 1;
    }
    teacherSeen.set(meta.teacherId, set);
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
    metrics: { distinctDaysUsedByTeacher, slotsByBranchDayPeriod },
    inactiveConstraints,
  };
}
