import { isEligibleFor } from './eligibility.js';
import { compareOptimizationCandidates } from './comparator.js';
import { deriveMetrics } from './metrics.js';
import { evaluateCandidate } from './constraints/index.js';
import { isAdjacentTeachingPeriod, sessionForSlot } from './time.js';
import { effectiveAssignmentMeta } from './assignment.js';
import { effectiveTeacherSlots } from './assignment.js';
import { teacherPreferencePenalties } from './preferences.js';
import { canWorkAtBranch, TRANSFER_POLICY_STATUS, buildCandidateTransfers } from './transfer/transfer.js';

export const SUBJECT_TEACHER_BALANCE = 'SUBJECT_TEACHER_BALANCE';
const active = (teacher) => teacher?.trangThai !== 'inactive' && teacher?.isActive !== false;
const sameSlot = (a, b, input) => Number(a.day) === Number(b.day) && Number(a.period) === Number(b.period)
  && sessionForSlot(a, input.branches.find((branch) => branch.id === a.branchId)) === sessionForSlot(b, input.branches.find((branch) => branch.id === b.branchId));

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
  const placementOf = (source, id) => effectiveAssignmentMeta(source, id, input);
  const maxSearchNodes = Math.max(1, Number(options.maxSearchNodes ?? cfg.subjectBalanceMaxSearchNodes ?? 256));
  const maxSearchIterations = Math.max(1, Number(options.maxSearchIterations ?? cfg.subjectBalanceMaxSearchIterations ?? 16));
  const started = Date.now();
  const timeBudgetMs = options.timeBudgetMs ?? cfg.subjectBalanceTimeLimitMs ?? 2000;
  const assignmentIndex = input.assignmentIndex ?? new Map(input.assignments.map((assignment) => [assignment.id, assignment]));
  const teacherIndex = input.teacherIndex ?? new Map(input.teachers.map((teacher) => [teacher.id, teacher]));
  const teachers = input.teachers.filter(active);
  const bySubject = new Map();
  for (const assignment of input.assignments) {
    const group = bySubject.get(assignment.subjectId) ?? [];
    group.push(assignment);
    bySubject.set(assignment.subjectId, group);
  }

  const cloneWithTransfer = (source, assignmentIds, targetTeacherId) => {
    const assignments = new Map([...source.assignments].map(([id, slots]) => [id, slots.map((slot) => ({ ...slot }))]));
    const placements = new Map([...source.placements].map(([id, placement]) => [id, { ...placement }]));
    for (const assignmentId of assignmentIds) {
      const slots = assignments.get(assignmentId); const current = placements.get(assignmentId);
      if (!slots || !current) return null;
      assignments.set(assignmentId, slots.map((slot) => ({ ...slot, teacherId: targetTeacherId })));
      placements.set(assignmentId, { ...current, teacherId: targetTeacherId });
    }
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
        if (sameSlot(moving, existing, input)) return true;
        if (movingPlacement.branchId !== otherPlacement.branchId
          && isAdjacentTeachingPeriod(moving, existing, input.branches.find((branch) => branch.id === moving.branchId), input.branches.find((branch) => branch.id === existing.branchId))) return true;
      }
    }
    return false;
  };

  const diagnostics = { searchNodes: 0, assignmentsTransferred: 0, logicalGroupsTransferred:0, preferenceMoves:0, iterations: 0, truncated: false, verdict: 'BEST_FOUND', stoppedBy: 'LOCAL_OPTIMUM' };
  const initialEvaluation = evaluateCandidate(candidate, input);
  if (!initialEvaluation.summary.accepted) return { candidate, diagnostics: { ...diagnostics, stoppedBy: 'INVALID_START' } };
  let current = { ...candidate, metrics: deriveMetrics(candidate, input, input.legacyBaseline ?? null, initialEvaluation) };
  const maxAcceptedTransfers = Math.max(1, input.assignments.length);

  while (diagnostics.assignmentsTransferred < maxAcceptedTransfers) {
    if (diagnostics.searchNodes >= maxSearchNodes || diagnostics.iterations >= maxSearchIterations || Date.now() - started >= timeBudgetMs) {
      diagnostics.truncated = true;
      diagnostics.stoppedBy = Date.now() - started >= timeBudgetMs ? 'TIME_BUDGET' : diagnostics.searchNodes >= maxSearchNodes ? 'NODE_LIMIT' : 'ITERATION_LIMIT';
      break;
    }
    diagnostics.iterations += 1;
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
        (totalLoads.get(b.id) - totalLoads.get(a.id))
        || (subjectLoads.get(b.id) - subjectLoads.get(a.id)) || a.id.localeCompare(b.id));
      const targets = eligible.slice().sort((a, b) =>
        (totalLoads.get(a.id) - totalLoads.get(b.id))
        || (subjectLoads.get(a.id) - subjectLoads.get(b.id)) || a.id.localeCompare(b.id));

      for (const sourceTeacher of sources) {
        for (const targetTeacher of targets) {
          if (diagnostics.searchNodes >= maxSearchNodes || Date.now() - started >= timeBudgetMs) break;
          if (sourceTeacher.id === targetTeacher.id
            || totalLoads.get(sourceTeacher.id) < totalLoads.get(targetTeacher.id)) continue;
          const movable = subjectAssignments.filter((assignment) =>
            placementOf(current, assignment.id, current.assignments.get(assignment.id) ?? []).teacherId === sourceTeacher.id,
          ).sort((a, b) => (a.requiredPeriods - b.requiredPeriods) || a.id.localeCompare(b.id));
          const visitedClasses = new Set();
          for (const assignment of movable) {
            if (visitedClasses.has(assignment.classId)) continue;
            visitedClasses.add(assignment.classId);
            const logicalGroup = movable.filter((row) => row.classId === assignment.classId);
            if (diagnostics.searchNodes >= maxSearchNodes || Date.now() - started >= timeBudgetMs) break;
            diagnostics.searchNodes += 1;
            const destination = effectiveAssignmentMeta(current, assignment.id, input)?.branchId;
            if (options.transferAssignmentIds && !options.transferAssignmentIds.has(assignment.id)
              && targetTeacher.homeBranchId !== destination) continue;
            if (!isEligibleFor(targetTeacher, subjectId)
              || canWorkAtBranch(targetTeacher, destination, input.transferPolicy).status === TRANSFER_POLICY_STATUS.NOT_ALLOWED
              || conflictsWithTarget(current, assignment.id, targetTeacher.id)) continue;
            if (logicalGroup.some((row) => conflictsWithTarget(current,row.id,targetTeacher.id))) continue;
            const proposed = cloneWithTransfer(current, logicalGroup.map((row) => row.id), targetTeacher.id);
            if (!proposed) continue;
            const beforePreference = deriveMetrics(current,input).preferenceBreakdown.transferBranch;
            const afterPreference = deriveMetrics(proposed,input).preferenceBreakdown.transferBranch;
            if (afterPreference > beforePreference) continue;
            const evaluation = evaluateCandidate(proposed, input);
            if (!evaluation.summary.accepted || evaluation.hard.violations.length !== 0) continue;
            proposed.metrics = deriveMetrics(proposed, input, input.legacyBaseline ?? null, evaluation);
            if (compareOptimizationCandidates(proposed, current) >= 0) continue;
            if (!best || compareOptimizationCandidates(proposed, best) < 0) {
              best = proposed;
              best._movedAssignments = logicalGroup.length;
            }
          }
        }
        if (diagnostics.searchNodes >= maxSearchNodes || Date.now() - started >= timeBudgetMs) break;
      }
      if (diagnostics.searchNodes >= maxSearchNodes || Date.now() - started >= timeBudgetMs) break;
    }
    if (!best) {
      if (diagnostics.searchNodes >= maxSearchNodes || Date.now() - started >= timeBudgetMs) {
        diagnostics.truncated = true;
        diagnostics.stoppedBy = Date.now() - started >= timeBudgetMs ? 'TIME_BUDGET' : 'NODE_LIMIT';
      }
      break;
    }
    current = best;
    diagnostics.assignmentsTransferred += best._movedAssignments;
    diagnostics.logicalGroupsTransferred += 1;
    delete current._movedAssignments;
  }

  if (options.optimizePreferences) {
    const preferenceCost = (teacher,slots) => Object.entries(teacherPreferencePenalties(teacher,slots,input))
      .filter(([key]) => key !== 'offDay').reduce((sum,[,value]) => sum+(value ?? 0),0);
    for (let round=0;round<8 && diagnostics.searchNodes<maxSearchNodes && Date.now()-started<timeBudgetMs;round++) {
      let kept = false;
      const byTeacher = effectiveTeacherSlots(current,input);
      preferenceSearch: for (const assignment of input.assignments) {
        const meta = placementOf(current,assignment.id); const teacher = teacherIndex.get(meta.teacherId);
        const teacherSlots = byTeacher.get(meta.teacherId) ?? [];
        const before = preferenceCost(teacher,teacherSlots); if (before <= 0) continue;
        const slots = current.assignments.get(assignment.id) ?? [];
        for (let index=0;index<slots.length;index++) for (const target of input.timeSlotsByBranch?.get(meta.branchId) ?? []) {
          if (diagnostics.searchNodes>=maxSearchNodes || Date.now()-started>=timeBudgetMs) break preferenceSearch;
          if (sameSlot(slots[index],target,input)) continue;
          diagnostics.searchNodes++;
          const proposed = cloneWithTransfer(current,[assignment.id],meta.teacherId);
          proposed.assignments.get(assignment.id)[index] = {...target,teacherId:meta.teacherId};
          const nextTeacherSlots = effectiveTeacherSlots(proposed,input).get(meta.teacherId) ?? [];
          if (preferenceCost(teacher,nextTeacherSlots) >= before) continue;
          const evaluation = evaluateCandidate(proposed,input); if (!evaluation.summary.accepted) continue;
          proposed.metrics = deriveMetrics(proposed,input,input.legacyBaseline ?? null,evaluation);
          if (compareOptimizationCandidates(proposed,current)>=0) continue;
          current = proposed; diagnostics.preferenceMoves++; kept=true; break preferenceSearch;
        }
      }
      if (!kept) break;
    }
  }

  current = { ...current, transfers: buildCandidateTransfers(current, input) };
  return { candidate: current, diagnostics };
}
