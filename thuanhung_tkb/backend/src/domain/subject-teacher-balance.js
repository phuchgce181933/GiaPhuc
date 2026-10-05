import { isEligibleFor } from './eligibility.js';
import { compareOptimizationCandidates } from './comparator.js';
import { deriveMetrics } from './metrics.js';
import { evaluateCandidate } from './constraints/index.js';
import { isAdjacentTeachingPeriod, teachingSessionOf } from './time.js';

export const SUBJECT_TEACHER_BALANCE = 'SUBJECT_TEACHER_BALANCE';
const active = (teacher) => teacher?.trangThai !== 'inactive' && teacher?.isActive !== false;
const placementOf = (candidate, assignmentId, slots) => candidate.placements?.get?.(assignmentId)
  ?? { teacherId: slots?.[0]?.teacherId, branchId: slots?.[0]?.branchId };
const sameSlot = (a, b) => Number(a.day) === Number(b.day)
  && Number(a.period) === Number(b.period)
  && (a.session ?? teachingSessionOf(a.period)) === (b.session ?? teachingSessionOf(b.period));

/**
 * Deterministic best-found local search that moves whole assignments
 * between active teachers eligible for the same subject. Every proposed
 * move is checked by the independent constraint evaluator and is retained
 * only when the global comparator says the full candidate improved.
 */
export function optimizeSubjectTeacherBalance(candidate, input, options = {}) {
  if (!candidate?.assignments || !input?.assignments || !input?.teachers) {
    return { candidate, diagnostics: { searchNodes: 0, assignmentsTransferred: 0, truncated: false } };
  }
  const cfg = input.strategy?.solver ?? {};
  const maxSearchNodes = Math.max(1, Number(options.maxSearchNodes ?? cfg.subjectBalanceMaxSearchNodes ?? 8));
  const maxSearchIterations = Math.max(1, Number(options.maxSearchIterations ?? cfg.subjectBalanceMaxSearchIterations ?? 8));
  const assignmentIndex = input.assignmentIndex ?? new Map(input.assignments.map((assignment) => [assignment.id, assignment]));
  const teacherIndex = input.teacherIndex ?? new Map(input.teachers.map((teacher) => [teacher.id, teacher]));
  const teachers = input.teachers.filter(active);
  const bySubject = new Map();
  for (const assignment of input.assignments) {
    const group = bySubject.get(assignment.subjectId) ?? [];
    group.push(assignment);
    bySubject.set(assignment.subjectId, group);
  }

  const cloneWithTransfer = (source, assignmentId, targetTeacherId) => {
    const assignments = new Map([...source.assignments].map(([id, slots]) => [id, slots.map((slot) => ({ ...slot }))]));
    const placements = new Map([...source.placements].map(([id, placement]) => [id, { ...placement }]));
    const slots = assignments.get(assignmentId);
    const current = placements.get(assignmentId);
    if (!slots || !current) return null;
    assignments.set(assignmentId, slots.map((slot) => ({ ...slot, teacherId: targetTeacherId })));
    placements.set(assignmentId, { ...current, teacherId: targetTeacherId });
    return { ...source, assignments, placements };
  };

  const conflictsWithTarget = (source, assignmentId, targetTeacherId) => {
    const movingSlots = source.assignments.get(assignmentId) ?? [];
    const movingPlacement = placementOf(source, assignmentId, movingSlots);
    for (const [otherId, otherSlots] of source.assignments) {
      if (otherId === assignmentId) continue;
      const otherPlacement = placementOf(source, otherId, otherSlots);
      if (otherPlacement.teacherId !== targetTeacherId) continue;
      for (const moving of movingSlots) for (const existing of otherSlots) {
        if (sameSlot(moving, existing)) return true;
        if (movingPlacement.branchId !== otherPlacement.branchId
          && isAdjacentTeachingPeriod(moving, existing)) return true;
      }
    }
    return false;
  };

  let current = candidate;
  if (!current.metrics) {
    const initialEvaluation = evaluateCandidate(current, input);
    current = { ...current, metrics: deriveMetrics(current, input, input.legacyBaseline ?? null, initialEvaluation) };
  }
  const diagnostics = { searchNodes: 0, assignmentsTransferred: 0, truncated: false };
  const maxAcceptedTransfers = Math.max(1, input.assignments.length);

  while (diagnostics.assignmentsTransferred < maxAcceptedTransfers) {
    if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.searchNodes >= maxSearchIterations) {
      diagnostics.truncated = true;
      break;
    }
    let best = null;
    for (const [subjectId, subjectAssignments] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
      const eligible = teachers.filter((teacher) => isEligibleFor(teacher, subjectId));
      if (eligible.length < 2) continue;
      const subjectLoads = new Map(eligible.map((teacher) => [teacher.id, 0]));
      const totalLoads = new Map(eligible.map((teacher) => [teacher.id, 0]));
      for (const [assignmentId, slots] of current.assignments) {
        const meta = assignmentIndex.get?.(assignmentId);
        if (!meta) continue;
        const teacherId = placementOf(current, assignmentId, slots).teacherId;
        if (!subjectLoads.has(teacherId)) continue;
        totalLoads.set(teacherId, (totalLoads.get(teacherId) ?? 0) + slots.length);
        if (meta.subjectId === subjectId) subjectLoads.set(teacherId, subjectLoads.get(teacherId) + slots.length);
      }
      const sources = eligible.slice().sort((a, b) =>
        (subjectLoads.get(b.id) - subjectLoads.get(a.id))
        || (totalLoads.get(b.id) - totalLoads.get(a.id)) || a.id.localeCompare(b.id));
      const targets = eligible.slice().sort((a, b) =>
        (subjectLoads.get(a.id) - subjectLoads.get(b.id))
        || (totalLoads.get(a.id) - totalLoads.get(b.id)) || a.id.localeCompare(b.id));

      for (const sourceTeacher of sources) {
        for (const targetTeacher of targets) {
          if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.searchNodes >= maxSearchIterations) break;
          if (sourceTeacher.id === targetTeacher.id
            || subjectLoads.get(sourceTeacher.id) <= subjectLoads.get(targetTeacher.id)) continue;
          const movable = subjectAssignments.filter((assignment) =>
            placementOf(current, assignment.id, current.assignments.get(assignment.id) ?? []).teacherId === sourceTeacher.id,
          ).sort((a, b) => (a.requiredPeriods - b.requiredPeriods) || a.id.localeCompare(b.id));
          for (const assignment of movable) {
            if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.searchNodes >= maxSearchIterations) break;
            diagnostics.searchNodes += 1;
            if (!isEligibleFor(targetTeacher, subjectId)
              || conflictsWithTarget(current, assignment.id, targetTeacher.id)) continue;
            const proposed = cloneWithTransfer(current, assignment.id, targetTeacher.id);
            if (!proposed) continue;
            const evaluation = evaluateCandidate(proposed, input);
            if (!evaluation.summary.accepted || evaluation.hard.violations.length !== 0) continue;
            proposed.metrics = deriveMetrics(proposed, input, input.legacyBaseline ?? null, evaluation);
            if (compareOptimizationCandidates(proposed, current) >= 0) continue;
            if (!best || compareOptimizationCandidates(proposed, best) < 0) {
              best = proposed;
            }
          }
        }
        if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.searchNodes >= maxSearchIterations) break;
      }
      if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.searchNodes >= maxSearchIterations) break;
    }
    if (!best) break;
    current = best;
    diagnostics.assignmentsTransferred += 1;
  }

  return { candidate: current, diagnostics };
}
