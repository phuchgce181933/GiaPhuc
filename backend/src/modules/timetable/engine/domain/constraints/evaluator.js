// Constraint evaluator — Phase 22.
//
// PHASE 22 INTRODUCES A STRUCTURED, INDEPENDENT CONSTRAINT EVALUATOR.
//
// The evaluator is the only function that decides whether a
// candidate (a Map<assignmentId, Slot[]>, possibly with a
// `placements` Map) is feasible. It walks the catalog and:
//   - runs each constraint's `active(input)` predicate to decide
//     whether the constraint is ACTIVE or INACTIVE;
//   - runs `evaluate(candidate, input)` for ACTIVE constraints;
//   - aggregates hard violations and soft penalties;
//   - never mutates the candidate or input;
//   - is deterministic: same inputs → same result;
//
// The evaluator does NOT import the solver, the AI strategy, the
// orchestrator, the scorer, the explainer, or any randomness. It
// is a pure function.
//
// PHASE 22 §22 — aggregate shape:
//
//   {
//     hard:        { violated: boolean, violations: Violation[] },
//     soft:        { penalty: number,    violations: Violation[] },
//     inactive:    [{ constraintId, reason }],
//     unsupported: [{ constraintId, reason }],
//     constraintStatuses: { [id]: 'ACTIVE' | 'INACTIVE' | 'UNSUPPORTED' },
//     summary: {
//       totalHardViolations: number,
//       totalSoftPenalty:    number,
//       accepted:            boolean,
//       reasons:             string[],   // human-readable top reasons
//     },
//   }
//
// Hard-violation gating: a candidate with ANY hard violation is
// NOT accepted, regardless of soft score. This is a guardrail that
// the brief explicitly requires (§22).
//
// UNSUPPORTED distinguishes "no data" (INACTIVE) from "data
// dependency missing, would have to invent" (UNSUPPORTED). Today
// only H14 (Travel) is UNSUPPORTED — the matrix is not provided.
// The matrix will never be invented.

import { CATALOG, HARD_CONSTRAINTS, SOFT_CONSTRAINTS, normalizeCandidate } from './catalog.js';

const UNSUPPORTED = new Set([
  // H14 cannot be evaluated without a travel matrix; we never
  // fabricate one. The constraint's `active` predicate already
  // returns false when `travelTime` is null, so the entry surfaces
  // as INACTIVE. We also tag it UNSUPPORTED for the audit so the
  // caller can distinguish "no data" from "data present but no
  // active policy".
  'H14',
]);

/**
 * Evaluate a candidate against the constraint catalog.
 *
 * @param {object} candidate - { assignments: Map|Array<[id, slots]>, placements?: Map<id, { teacherId, branchId }> }
 * @param {object} input     - SchedulingInput (the same shape the orchestrator consumes)
 * @returns {object}         - the aggregate report
 */
export function evaluateCandidate(candidate, input) {
  if (!input) throw new TypeError('evaluateCandidate: input is required');
  if (!candidate) throw new TypeError('evaluateCandidate: candidate is required');

  const hard = { violated: false, violations: [] };
  const soft = { penalty: 0, violations: [] };
  const inactive = [];
  const unsupported = [];
  const constraintStatuses = {};
  const reasons = [];

  // Walk the catalog. Order does not matter (the function is
  // commutative across independent constraints).
  for (const c of CATALOG) {
    const isActive = c.active ? c.active(input) : true;
    if (!isActive) {
      if (UNSUPPORTED.has(c.id)) {
        constraintStatuses[c.id] = 'UNSUPPORTED';
        unsupported.push({ constraintId: c.id, reason: 'data_dependency_missing' });
      } else {
        constraintStatuses[c.id] = 'INACTIVE';
        inactive.push({ constraintId: c.id, reason: 'data_dependency_missing' });
      }
      continue;
    }
    constraintStatuses[c.id] = 'ACTIVE';
    const violations = c.evaluate(candidate, input) ?? [];
    if (c.category === 'HARD') {
      if (violations.length > 0) {
        hard.violations.push(...violations);
        for (const v of violations.slice(0, 1)) reasons.push(`[${c.id}] ${v.message}`);
      }
    } else if (c.category === 'SOFT') {
      if (violations.length > 0) {
        soft.violations.push(...violations);
        for (const v of violations) soft.penalty += Number(v.penalty) || 0;
      }
    }
  }

  hard.violated = hard.violations.length > 0;
  // Brief §22: hard violation > any soft score. `accepted` is
  // therefore STRICTLY determined by hard.violated (and never
  // overridden by a good soft score). The flag is here for the
  // auditor / explainer, not as a hint that soft could redeem
  // hard failures.
  const accepted = !hard.violated;

  return {
    hard,
    soft,
    inactive,
    unsupported,
    constraintStatuses,
    summary: {
      totalHardViolations: hard.violations.length,
      totalSoftPenalty: soft.penalty,
      accepted,
      reasons,
    },
  };
}

// ============================================================================
// Baseline evaluation helper (Phase 22 §27, Phase 22.1 reconciliation)
// ============================================================================

// Day-name → day-number used to convert legacy baseline slots
// (which carry "Monday" / "Tuesday" / ...) into the canonical
// numeric day used by the rest of the model.
const DAY_NAME_TO_NUMBER = Object.freeze({
  Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4,
  Friday: 5, Saturday: 6, Sunday: 7,
});

// Session-name → session-code used to convert legacy baseline
// slots (which carry "morning" / "afternoon") into the canonical
// session code used by `classConflictKey` / `teacherConflictKey`.
const SESSION_NAME_TO_CODE = Object.freeze({
  morning: 'sang',
  afternoon: 'chieu',
  sang: 'sang',
  chieu: 'chieu',
  ca_hai: 'ca_hai',
});

/**
 * Evaluate the legacy historical baseline as a candidate. We do
 * NOT modify the baseline; we only convert its slots into the
 * candidate shape and run the evaluator. The result tells us how
 * many hard violations the historical baseline carries (without
 * promoting it to a target).
 *
 * The legacy baseline slots live on `normalized.historicalScheduleSlots`
 * (after Phase 19 ingestion). Each slot has the assignment id; we
 * group by assignment.
 *
 * Returns:
 *     { candidate:  <rounded candidate>,
 *       evaluation: <result of evaluateCandidate> }
 *
 * The candidate is fully built but never written back; baseline
 * preservation is preserved per Phase 20/21/22 invariant.
 *
 * Phase 22.1 §5: every field on the raw slot is preserved on the
 * candidate slot, except for the documented representation
 * mappings (day-name → day-number, session-name → session-code).
 * No field is dropped silently.
 */
export function evaluateBaseline(baseline, input) {
  const slotsByAssignment = new Map();
  const teacherByAssignment = new Map();
  const branchByAssignment = new Map();
  const placements = new Map();

  const assignments = input?.assignments ?? [];
  const assignmentIndex = new Map();
  for (const a of assignments) assignmentIndex.set(a.id, a);

  // Build a classId → branchId index so the candidate slot can
  // be stamped with the correct branch (the baseline does not
  // carry branchId on each slot — branch is implied by class).
  const classToBranch = new Map();
  for (const c of input?.classes ?? []) {
    if (c?.id) classToBranch.set(c.id, c.branchId);
  }

  if (baseline) {
    const slots = baseline.scheduleSlots ?? [];
    for (const s of slots) {
      const aId = s.assignment;
      const aMeta = assignmentIndex.get(aId);
      const classBranch = aMeta ? classToBranch.get(aMeta.classId) : null;
      // Convert the legacy day-name to the canonical day-number
      // (1..7). Falls back to the raw value if it is already a
      // number, or the raw value if the format is unknown.
      const dayNum = typeof s.day === 'number'
        ? s.day
        : DAY_NAME_TO_NUMBER[s.day] ?? s.day;
      // Convert the legacy session-name to the canonical session
      // code (sang / chieu). Falls back to the raw value if
      // already in canonical form, or the raw value if unknown.
      // This is the representation mapping that makes the brief-
      // correct (entity, day, session, period) identity work
      // across the Phase 19 raw format and the Phase 22 catalog.
      const sessCode = typeof s.session === 'string'
        ? (SESSION_NAME_TO_CODE[s.session] ?? s.session)
        : s.session;
      const branchId = s.branch ?? classBranch ?? null;
      const arr = slotsByAssignment.get(aId) ?? [];
      arr.push({
        branchId,
        day: dayNum,
        session: sessCode,
        period: s.period,
        // Preserve the source slot id for traceability
        // (Phase 22.1 §2 — violation must be traceable back to
        // the source scheduleslot).
        _sourceSlotId: s.id,
        _sourceAssignmentId: s.assignment,
        _sourceClass: s.class,
        _sourceTeacher: s.teacher,
        _sourceSubject: s.subject,
      });
      slotsByAssignment.set(aId, arr);
      if (s.teacher) teacherByAssignment.set(aId, s.teacher);
      if (branchId) branchByAssignment.set(aId, branchId);
    }
  }
  for (const [aId, teacherId] of teacherByAssignment) {
    placements.set(aId, {
      teacherId,
      branchId: branchByAssignment.get(aId) ?? assignmentIndex.get(aId)?.branchId ?? null,
    });
  }

  const candidate = {
    assignments: slotsByAssignment,
    placements,
  };
  const evaluation = evaluateCandidate(candidate, input);
  return { candidate, evaluation };
}

// Re-export the catalog for callers that want a single import.
export { CATALOG, HARD_CONSTRAINTS, SOFT_CONSTRAINTS, normalizeCandidate };

// ============================================================================
// Constraint gating helper
// ============================================================================

/**
 * `isAccepted(evaluation)` — a strict gate that the solver can
 * consult. Hard violations are fatal; soft penalties are
 * irrelevant to acceptance. Per Phase 22 §22: "hard violation >
 * any soft score".
 */
export function isAccepted(evaluation) {
  return Boolean(evaluation) && evaluation.summary.accepted === true;
}

/**
 * The total cost a candidate imposes on the constraint catalog.
 * = hard.violations.length * HARD_WEIGHT + soft.penalty
 *
 * The constant is exported so future scoring work can reuse it
 * without inventing a new formula. Today no solver reads it.
 */
export const HARD_WEIGHT = 1.0;
export function totalCost(evaluation) {
  if (!evaluation) return Infinity;
  return HARD_WEIGHT * evaluation.hard.violations.length + evaluation.soft.penalty;
}