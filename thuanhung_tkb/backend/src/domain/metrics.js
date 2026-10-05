// PHASE 24 — teacher assignment metrics.
//
// All metrics are PURE: derived from a candidate and the
// SchedulingInput, with optional baseline for comparison. No
// mutation, no randomness, no clock reads. Same input → same
// metrics object.
//
// The metrics object is the audit surface for the brief §20
// requirement: every metric name and unit is documented. They
// are reported on each candidate and on the legacy baseline so
// the Phase 24 audit can compare them side by side.
//
// Per brief §15, the comparison is informational only. The
// baseline is not a constraint; metrics measure a candidate's
// own qualities.

import { isEligibleFor } from './eligibility.js';

// ============================================================================
// Workload metrics (per teacher)
// ============================================================================

/**
 * Build the per-teacher load: for each teacher that appears in
 * the candidate, the count of placements (one per slot).
 *
 * The brief §4 is explicit: capacity is consulted ONLY when
 * present and meaningful. With H09 INACTIVE on real data, the
 * `capacity` field is left null in the report — the brief §25
 * forbids inventing capacity.
 */
export function teacherLoads(candidate) {
  const loads = new Map();
  if (!candidate || !candidate.assignments) return loads;
  for (const [, slots] of candidate.assignments) {
    for (const s of slots) {
      if (!s?.teacherId) continue;
      loads.set(s.teacherId, (loads.get(s.teacherId) ?? 0) + 1);
    }
  }
  return loads;
}

/**
 * Aggregate of teacherLoads: spread, max, min, average, stdev.
 * Every metric is a non-negative number. Teachers with zero
 * loads are EXCLUDED from the aggregate (a teacher with no
 * assignment is irrelevant to the distribution). The total
 * demand is preserved separately so callers can sanity-check.
 */
export function workloadAggregate(loads) {
  const values = [...loads.values()].filter((v) => v > 0);
  if (values.length === 0) {
    return {
      teacherCount: 0,
      totalPeriods: 0,
      maxLoad: 0,
      minLoad: 0,
      averageLoad: 0,
      workloadSpread: 0,
      workloadStdev: 0,
    };
  }
  const total = values.reduce((a, v) => a + v, 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const avg = total / values.length;
  // Population standard deviation. Phase 24 does not sample; we
  // have the entire population.
  let varSum = 0;
  for (const v of values) varSum += (v - avg) ** 2;
  const stdev = Math.sqrt(varSum / values.length);
  return {
    teacherCount: values.length,
    totalPeriods: total,
    maxLoad: max,
    minLoad: min,
    averageLoad: avg,
    workloadSpread: max - min,
    workloadStdev: stdev,
  };
}

// ============================================================================
// Preference penalty (S01 semantics, soft)
// ============================================================================

/**
 * Soft penalty from S01 (preferred session). Mirrors the
 * catalog's scoring rule without importing the catalog — this
 * is a derivation, not a constraint. Returns a number in [0, 1].
 *
 * The brief §6 keeps preferences as soft. We do NOT promote
 * them to hard; the penalty is informational.
 */
export function sessionPreferencePenalty(candidate, input) {
  return preferencePenaltyBreakdown(candidate, input).total;
}

/**
 * Subject-level assignment load for every active teacher eligible for
 * the subject. Only actual candidate placements count; declared
 * specialization workload is not an assignment. A single eligible
 * teacher is reported as non-balancable and omitted from the objective.
 */
export function subjectTeacherWorkload(candidate, input) {
  const assignmentIndex = input?.assignmentIndex ?? new Map();
  const activeTeachers = (input?.teachers ?? []).filter((teacher) =>
    teacher.trangThai !== 'inactive' && teacher.isActive !== false,
  );
  const subjects = new Map((input?.subjects ?? []).map((subject) => [subject.id, subject]));
  const subjectIds = [...new Set((input?.assignments ?? []).map((assignment) => assignment.subjectId))].sort();
  const loadsBySubject = new Map();
  for (const subjectId of subjectIds) {
    const eligible = activeTeachers.filter((teacher) => isEligibleFor(teacher, subjectId));
    if (eligible.length < 2) continue;
    loadsBySubject.set(subjectId, new Map(eligible.map((teacher) => [teacher.id, 0])));
  }

  for (const [assignmentId, slots] of candidate?.assignments ?? []) {
    const assignment = assignmentIndex.get?.(assignmentId);
    const subjectLoads = loadsBySubject.get(assignment?.subjectId);
    if (!subjectLoads) continue;
    const teacherId = candidate?.placements?.get?.(assignmentId)?.teacherId
      ?? slots?.[0]?.teacherId ?? assignment?.teacherId;
    if (!subjectLoads.has(teacherId)) continue;
    subjectLoads.set(teacherId, subjectLoads.get(teacherId) + (slots?.length ?? 0));
  }

  const report = {};
  let subjectWorkloadSpread = 0;
  let subjectWorkloadStdev = 0;
  for (const [subjectId, loads] of loadsBySubject) {
    const teachers = [...loads].map(([teacherId, periods]) => ({ teacherId, periods }))
      .sort((a, b) => a.teacherId.localeCompare(b.teacherId));
    const values = teachers.map((teacher) => teacher.periods);
    const spread = Math.max(...values) - Math.min(...values);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    const stdev = Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
    const subjectName = subjects.get(subjectId)?.name ?? subjects.get(subjectId)?.tenMon ?? subjectId;
    const key = Object.hasOwn(report, subjectName) ? `${subjectName} (${subjectId})` : subjectName;
    report[key] = { subjectId, subjectName, teachers, spread, stdev };
    subjectWorkloadSpread += spread;
    subjectWorkloadStdev += stdev;
  }
  return { report, subjectWorkloadSpread, subjectWorkloadStdev };
}

export function preferencePenaltyBreakdown(candidate, input) {
  if (!candidate || !input?.branches) return { session:0, desiredSessions:0, offDay:0, offPart:0, transferBranch:0, total:0 };
  const branchesById = new Map(input.branches.map((b) => [b.id, b]));
  const slotsByTeacher = new Map();
  const assignments = input.assignmentIndex ?? new Map();
  for (const [assignmentId, slots] of candidate.assignments ?? new Map()) {
    const teacherId = assignments.get?.(assignmentId)?.teacherId;
    for (const s of slots) {
      const id = s?.teacherId ?? teacherId;
      if (!id) continue;
      const arr = slotsByTeacher.get(id) ?? [];
      arr.push(s);
      slotsByTeacher.set(id, arr);
    }
  }
  const sums = { session: 0, desiredSessions: 0, offDay: 0, offPart: 0, transferBranch: 0 };
  const counts = { ...sums };
  for (const t of input.teachers ?? []) {
    const slots = slotsByTeacher.get(t.id) ?? [];
    if (slots.length === 0) continue;
    const preference = t.nguyenVong ?? {};
    const pref = preference.buoiUuTien;
    const sessionFor = (s) => {
      const branch = branchesById.get(s.branchId);
      if (branch?.sessions?.sang?.includes(s.period)) return 'sang';
      if (branch?.sessions?.chieu?.includes(s.period)) return 'chieu';
      return s.period <= 4 ? 'sang' : 'chieu';
    };
    if (pref && pref !== 'ca_hai') {
      const match = slots.filter((s) => sessionFor(s) === pref).length;
      sums.session += 1 - match / slots.length; counts.session++;
    }
    const sessions = new Set(slots.map((s) => `${s.day}|${sessionFor(s)}`));
    const desired = Number(preference.desiredTeachingSessionsPerWeek);
    if (Number.isFinite(desired) && desired >= 0) {
      sums.desiredSessions += Math.abs(sessions.size - desired) / Math.max(desired, 1); counts.desiredSessions++;
    }
    const offDay = Number(preference.preferredOffDayNumber ?? (preference.thuNghi?.[0] ?? 0));
    if (offDay > 0) {
      sums.offDay += slots.some((s) => Number(s.day) === offDay) ? 1 : 0; counts.offDay++;
    }
    const offPart = preference.preferredOffPart;
    if (offDay > 0 && ['MORNING','AFTERNOON','FULL_DAY'].includes(offPart)) {
      const target = offPart === 'MORNING' ? 'sang' : offPart === 'AFTERNOON' ? 'chieu' : null;
      sums.offPart += slots.some((s) => Number(s.day) === offDay && (!target || sessionFor(s) === target)) ? 1 : 0; counts.offPart++;
    }
    const preferredBranches = t.preferredTransferBranches ?? [];
    const transfers = slots.filter((s) => s.branchId !== t.homeBranchId);
    if (preferredBranches.length && transfers.length) {
      sums.transferBranch += transfers.filter((s) => !preferredBranches.includes(s.branchId)).length / transfers.length;
      counts.transferBranch++;
    }
  }
  const parts = Object.fromEntries(Object.keys(sums).map((key) => [key, counts[key] ? sums[key] / counts[key] : 0]));
  return { ...parts, total: Object.values(parts).reduce((a, b) => a + b, 0) };
}

// ============================================================================
// Baseline comparison (brief §16 — observation only)
// ============================================================================

/**
 * Compare a candidate's teacher assignments to the legacy
 * baseline. Returns:
 *   {
 *     totalAssignments: number,
 *     sameTeacher:      number,
 *     changedTeacher:   number,
 *     changedFraction:  number,   // sameTeacher / totalAssignments
 *   }
 *
 * The candidate carries a `placements` Map with the chosen
 * teacherId per assignment. The baseline's teacher for each
 * assignment is taken from `baseline.teacherByAssignment` if
 * provided, or from the raw scheduleSlots (legacy format) if
 * available. We never mutate the baseline.
 */
export function baselineComparison(candidate, baseline) {
  const out = {
    totalAssignments: 0,
    sameTeacher: 0,
    changedTeacher: 0,
    changedFraction: 0,
  };
  if (!candidate || !baseline) return out;
  // Build a teacherByAssignment map from the baseline.
  const teacherByAssignment = new Map();
  const slots = baseline.scheduleSlots ?? [];
  for (const s of slots) {
    if (s.assignment && s.teacher) {
      teacherByAssignment.set(s.assignment, s.teacher);
    }
  }
  // If the baseline already exposes a teacherByAssignment map,
  // prefer it (legacy-baseline.js shape).
  if (baseline.teacherByAssignment instanceof Map) {
    for (const [aId, tId] of baseline.teacherByAssignment) {
      teacherByAssignment.set(aId, tId);
    }
  }
  const candidatePlacements = candidate.placements;
  if (!(candidatePlacements instanceof Map)) return out;
  for (const aId of candidatePlacements.keys()) {
    out.totalAssignments += 1;
    const candT = candidatePlacements.get(aId)?.teacherId;
    const baseT = teacherByAssignment.get(aId);
    if (candT == null) continue;
    if (baseT != null && baseT === candT) {
      out.sameTeacher += 1;
    } else if (baseT != null) {
      out.changedTeacher += 1;
    }
  }
  out.changedFraction = out.totalAssignments > 0
    ? out.changedTeacher / out.totalAssignments
    : 0;
  return out;
}

// ============================================================================
// Combined metrics object (brief §20)
// ============================================================================

/**
 * The combined metrics object. Every field is documented and
 * deterministic. The function is the single entry point Phase 24
 * uses to report a candidate.
 *
 *   {
 *     hardViolations:   number,  // from the independent evaluator
 *     softPenalty:      number,  // from the independent evaluator
 *     accepted:         boolean, // short-circuit to the evaluator gate
 *     teacherCount:     number,  // unique teachers used
 *     totalPeriods:     number,  // sum of scheduled periods
 *     maxTeacherLoad:   number,  // max of per-teacher periods
 *     minTeacherLoad:   number,  // min of per-teacher periods
 *     averageTeacherLoad: number, // mean of per-teacher periods
 *     workloadSpread:   number,  // max - min
 *     workloadStdev:    number,  // population stdev
 *     preferencePenalty: number, // [0, 1] from S01-style scoring
 *     changedAssignments: number, // vs baseline (0 if no baseline)
 *     changedFraction:  number,  // [0, 1]
 *     totalSoftCost:    number,  // workloadSpread/avg + preferencePenalty
 *                              // (lower is better; informational)
 *   }
 *
 * `totalSoftCost` is a one-number summary for ranking candidates
 * with the same `accepted = true` status. The formula is the
 * brief's stated lexicographic priority (4 = workload quality,
 * 5 = teacher preference). It is NOT a hard constraint.
 */
export function deriveMetrics(candidate, input, baseline = null, evaluation = null) {
  const loads = teacherLoads(candidate);
  const wAgg = workloadAggregate(loads);
  const subjectWorkload = subjectTeacherWorkload(candidate, input);
  const preferenceBreakdown = preferencePenaltyBreakdown(candidate, input);
  const prefPenalty = preferenceBreakdown.total;
  const baselineDiff = baselineComparison(candidate, baseline);
  const ev = evaluation ?? null;
  const hardViolations = ev ? ev.hard.violations.length : null;
  const softPenalty = ev ? ev.soft.penalty : null;
  const accepted = ev ? ev.summary.accepted : null;
  // One-number soft cost: spread (normalized by average) + preference.
  // Both are in [0, ∞) and lower is better.
  const normSpread = wAgg.averageLoad > 0 ? wAgg.workloadSpread / wAgg.averageLoad : 0;
  const totalSoftCost = normSpread + prefPenalty;
  return {
    hardViolations,
    softPenalty,
    accepted,
    teacherCount: wAgg.teacherCount,
    totalPeriods: wAgg.totalPeriods,
    maxTeacherLoad: wAgg.maxLoad,
    minTeacherLoad: wAgg.minLoad,
    averageTeacherLoad: wAgg.averageLoad,
    workloadSpread: wAgg.workloadSpread,
    workloadStdev: wAgg.workloadStdev,
    subjectWorkload: subjectWorkload.report,
    subjectWorkloadSpread: subjectWorkload.subjectWorkloadSpread,
    subjectWorkloadStdev: subjectWorkload.subjectWorkloadStdev,
    preferencePenalty: prefPenalty,
    preferenceBreakdown,
    changedAssignments: baselineDiff.changedTeacher,
    changedFraction: baselineDiff.changedFraction,
    totalSoftCost,
  };
}
