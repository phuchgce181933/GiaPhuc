// Backtracking CSP solver with a soft penalty over previous solutions
// to encourage diversity. Pure: no IO, no globals.
//
// PHASE 16 NOTES
// ──────────────
// 1. Per Assignment, the solver expands a list of decision variants:
//    each variant fixes (teacherId, branchId). The time slot is then
//    chosen from the branch's slot pool.
// 2. Hard-constraint pruning happens INSIDE the search. The solver
//    never asks the validator to "fix" a candidate after the fact.
// 3. The constraints that prune the search:
//      - H_TEACHER_NO_DOUBLE_BOOK    teacherId+day+period
//      - H_CLASS_NO_DOUBLE_BOOK      classId+day+period
//      - H_SLOT_IN_BRANCH            slot.branchId === assignment.branchId
//      - H_TRAVEL_FEASIBLE           same-day cross-branch transitions
//      - H_CLASS_SUBJECT_ONE_TEACHER same (classId, subjectId) -> same teacher
//    Teacher eligibility is enforced by the variant expansion.
//
// PHASE 17 NOTES
// ──────────────
// 4. The solver now respects `strategy.objectives`:
//      - `balancedWorkload`: variant ordering prefers teachers with
//        remaining budget headroom; per-slot pressure adds a positive
//        penalty when a teacher would exceed their budget.
//      - `noGapTeacherDay`: per-slot pressure prefers slots that are
//        contiguous with the teacher's existing same-day slots and
//        penalises slots that create a gap (slot at min(P)-1 or
//        max(P)+1 of an existing day).
//    The biases are HEURISTIC. They do not restrict the search; they
//    order it so the first feasible solution is biased toward the
//    strategy's intent. The hard-constraint gate still rules.
//
// PHASE 17.1 NOTES
// ────────────────
// 5. The `sessionDiversity` objective is INTENTIONALLY NOT consulted
//    at search time. Pushing the search toward the OPPOSITE session
//    from a teacher's existing same-day slot (PHASE 17 v1) caused the
//    search to fragment teacher schedules: a teacher with one
//    morning slot would be nudged toward an afternoon slot, even
//    when the teacher preferred morning, even when the morning slot
//    was more practical (closer to the teacher's home branch, less
//    travel, fewer sessions per week). The objective is now measured
//    ONLY at scoring time, where it has a different (correct) semantic
//    — see `sessionDiversityScore` in constraints.js.

import { mulberry32, shuffle } from '../utils/prng.js';
import {
  HARD,
  expandAssignmentVariants,
  slotsForBranch,
} from './constraints.js';
import { slotKey, teacherSlotKey, classSlotKey, orderByTime } from './time.js';
import { checkTransition } from './travel.js';
import { isEligibleFor } from './eligibility.js';
import { workloadOf } from './workload.js';

export function solve(input) {
  const start = Date.now();
  const { strategy, timeLimitMs = 5000, maxSolutions = 5 } = input.strategy.solver ?? {};
  const timeBudget = Math.max(50, Number(timeLimitMs ?? 5000));
  const cap = Math.max(1, Number(maxSolutions ?? 5));

  if (input.assignments.length === 0) {
    return {
      solutions: [],
      diagnostics: {
        strategiesAttempted: 1,
        totalSolveMs: Date.now() - start,
        warnings: ['INFEASIBLE_DEMAND: no assignments to schedule'],
        unresolvable: [],
      },
      failure: 'INFEASIBLE_DEMAND',
    };
  }

  // Pre-compute, for each assignment, the list of decision variants
  // (teacherId, branchId) the solver may pick from. The branchId is
  // baked into the assignment meta at variant-selection time.
  const variantsByAssignment = new Map();
  const unresolvable = [];
  for (const a of input.assignments) {
    const variants = expandAssignmentVariants(a, input);
    if (variants.length === 0) {
      unresolvable.push({ assignmentId: a.id, reason: 'no_decision_variants' });
    }
    variantsByAssignment.set(a.id, variants);
  }
  if (unresolvable.length > 0) {
    return {
      solutions: [],
      diagnostics: {
        strategiesAttempted: 1,
        totalSolveMs: Date.now() - start,
        warnings: [`UNRESOLVABLE_ASSIGNMENT: ${unresolvable.length} assignments have no decision variants`],
        unresolvable,
      },
      failure: 'UNRESOLVABLE_ASSIGNMENT',
    };
  }

  // Branch slot pool by branchId.
  const branchPool = new Map();
  for (const [branchId, slots] of input.timeSlotsByBranch.entries()) {
    branchPool.set(branchId, slots);
  }

  // For each (variant, slot) — slot count. Reject variants that
  // would have no slots to draw from. This is INFEASIBLE_DEMAND, not
  // an unsolvable search.
  for (const a of input.assignments) {
    const variants = variantsByAssignment.get(a.id);
    for (const v of variants) {
      const pool = branchPool.get(v.branchId) ?? [];
      if (pool.length === 0) {
        return {
          solutions: [],
          diagnostics: {
            strategiesAttempted: 1,
            totalSolveMs: Date.now() - start,
            warnings: [`UNRESOLVABLE_ASSIGNMENT: ${a.id} has no candidate slots in ${v.branchId}`],
            unresolvable: [{ assignmentId: a.id, reason: 'no_candidate_slots' }],
          },
          failure: 'UNRESOLVABLE_ASSIGNMENT',
        };
      }
    }
  }

  // PHASE 17 — strategy objectives. The solver reads these and
  // builds two search-time bias functions. The biases are SOFT:
  // they only re-order the slot pool and the variant list. The
  // hard-constraint gate is unchanged.
  //
  // PHASE 17.1 — `sessionDiversity` is intentionally NOT applied at
  // search time. See the file header for the rationale.
  const objectives = strategy?.objectives ?? {};
  const balancedWorkload = Boolean(objectives.balancedWorkload);
  const noGapTeacherDay = Boolean(objectives.noGapTeacherDay);
  // Bias magnitudes. These are small integers added to the slot's
  // composite penalty. They are intentionally unitless; the goal is
  // to break ties in favour of the strategy's intent.
  const BIAS = {
    WORKLOAD_OVER: 8,        // per-slot penalty when a teacher is over budget
    WORKLOAD_UNDER: -2,      // per-slot nudge when a teacher is under budget
    WORKLOAD_VARIANT_BONUS: -3, // per-variant bonus when teacher has more budget left
    GAP_ADJACENT: -3,        // preferred: slot is adjacent to an existing day slot
    GAP_ISOLATED: 4,         // avoided: slot creates a one-period gap in the day
  };

  // Order assignments: larger requiredPeriods first; ties broken by
  // number of variants. This keeps the search shallow.
  const order = input.assignments
    .map((a) => ({ a, v: variantsByAssignment.get(a.id).length }))
    .sort((x, y) =>
      (y.a.requiredPeriods - x.a.requiredPeriods) || (x.v - y.v))
    .map((x) => x.a);

  const seed = input.strategy.diversification?.seed ?? 0xC0FFEE;
  const rng = mulberry32(seed);
  if (input.strategy.diversification?.mode === 'random_seed') {
    for (const variants of variantsByAssignment.values()) {
      // No-op placeholder: variants are independent of pool order.
    }
  }

  const found = [];
  const seen = new Set();
  const slotPenalty = new Map();
  const warnings = [];

  // --- search-time state -----------------------------------------------
  // `placements[assignmentId] = { teacherId, branchId, slots[] }`.
  // We track three conflict maps:
  //   teacherDay[teacherId] -> Set<"day:period">
  //   classDay[classId]     -> Set<"day:period">
  //   classSubjectTeacher[key] -> teacherId (one teacher per
  //     (classId, subjectId); set when the assignment is placed).
  function makeState() {
    return {
      placements: new Map(),
      teacherDay: new Map(),
      classDay: new Map(),
      classSubjectTeacher: new Map(),
    };
  }

  // Return the per-teacher workload pressure (negative when under
  // budget, positive when over). Zero when no budget is declared.
  function teacherWorkloadPressure(teacherId, currentState) {
    if (!balancedWorkload) return 0;
    const teacher = input.teacherIndex.get(teacherId);
    if (!teacher) return 0;
    const budget = workloadOf(teacher);
    if (budget <= 0) return 0;
    let actual = 0;
    for (const [, p] of currentState.placements) {
      if (p.teacherId !== teacherId) continue;
      actual += p.slots.length;
    }
    const over = Math.max(0, actual - budget);
    const under = Math.max(0, budget - actual);
    return over * BIAS.WORKLOAD_OVER - under * BIAS.WORKLOAD_UNDER;
  }

  // Per-slot bias for the no-gap objective. Returns a value added
  // to the slot's composite penalty: negative for "good" (adjacent)
  // and positive for "bad" (creates a gap).
  function noGapBias(teacherId, slot, currentState) {
    if (!noGapTeacherDay) return 0;
    const periods = [];
    for (const [, p] of currentState.placements) {
      if (p.teacherId !== teacherId) continue;
      for (const s of p.slots) {
        if (s.day === slot.day) periods.push(s.period);
      }
    }
    if (periods.length === 0) return 0;
    const min = Math.min(...periods);
    const max = Math.max(...periods);
    const span = max - min + 1;
    // If the slot is INSIDE the existing span, no penalty (it
    // fills a gap).
    if (slot.period > min && slot.period < max) return -1;
    // If the slot is ADJACENT (extends the span by 1), strong
    // preference.
    if (slot.period === min - 1 || slot.period === max + 1) return BIAS.GAP_ADJACENT;
    // If the slot is OUTSIDE the span and would create a new
    // isolated period, penalise.
    return BIAS.GAP_ISOLATED;
  }

  // PHASE 17.1 — `sessionDiversityBias` was REMOVED. Pushing the
  // search toward the opposite session from a teacher's existing
  // same-day slot was found to fragment teacher schedules against
  // other objectives (preferred session, max sessions per week,
  // travel, compactness). The session-diversity concept is now
  // measured at SCORING time only, with a corrected semantic
  // (compactness: 1 when no split day, 0 when split day). See
  // `sessionDiversityScore` in constraints.js.

  // Composite slot penalty: existing seen-slot penalty plus the
  // search-time objective biases. Lower is better. The
  // session-diversity concept is NOT here; it is scoring-time only.
  function slotComposite(teacherId, slot, currentState) {
    const base = slotPenalty.get(slotKey(slot)) ?? 0;
    const w = teacherWorkloadPressure(teacherId, currentState);
    const g = noGapBias(teacherId, slot, currentState);
    return base + w + g;
  }

  function placeOne(state, a, teacherId, branchId, slot) {
    state.placements.set(a.id, { teacherId, branchId, slots: [slot] });
    const td = state.teacherDay.get(teacherId) ?? new Set();
    td.add(teacherSlotKey(slot));
    state.teacherDay.set(teacherId, td);
    const cd = state.classDay.get(a.classId) ?? new Set();
    cd.add(classSlotKey(slot));
    state.classDay.set(a.classId, cd);
    const k = `${a.classId}|${a.subjectId}`;
    state.classSubjectTeacher.set(k, teacherId);
  }
  function extendPlacement(state, a, slot) {
    const p = state.placements.get(a.id);
    p.slots.push(slot);
    const td = state.teacherDay.get(p.teacherId);
    td.add(teacherSlotKey(slot));
    const cd = state.classDay.get(a.classId);
    cd.add(classSlotKey(slot));
  }
  function popSlot(state, a) {
    const p = state.placements.get(a.id);
    const slot = p.slots.pop();
    if (p.slots.length === 0) {
      state.placements.delete(a.id);
      const k = `${a.classId}|${a.subjectId}`;
      state.classSubjectTeacher.delete(k);
    }
    const td = state.teacherDay.get(p.teacherId);
    td.delete(teacherSlotKey(slot));
    const cd = state.classDay.get(a.classId);
    cd.delete(classSlotKey(slot));
    return slot;
  }

  // Hard-constraint checks for one additional slot. Pure read-only
  // on the current partial state.
  function isHardFeasible(state, a, teacherId, branchId, slot) {
    if (slot.branchId !== branchId) return false; // H_SLOT_IN_BRANCH
    const td = state.teacherDay.get(teacherId);
    if (td && td.has(teacherSlotKey(slot))) return false; // H_TEACHER_NO_DOUBLE_BOOK
    const cd = state.classDay.get(a.classId);
    if (cd && cd.has(classSlotKey(slot))) return false; // H_CLASS_NO_DOUBLE_BOOK
    const k = `${a.classId}|${a.subjectId}`;
    const priorTeacher = state.classSubjectTeacher.get(k);
    if (priorTeacher && priorTeacher !== teacherId) return false; // H_CLASS_SUBJECT_ONE_TEACHER
    // H_TRAVEL_FEASIBLE: only when the same teacher already has a
    // same-day slot at a different branch.
    if (input.travelTime) {
      const existing = [];
      const p = state.placements.get(a.id);
      if (p) for (const s of p.slots) existing.push({ ...s, teacherId: p.teacherId });
      // Walk every other placed assignment to find same-teacher slots.
      for (const [, other] of state.placements) {
        if (other.teacherId !== teacherId) continue;
        for (const s of other.slots) existing.push({ ...s, teacherId: other.teacherId });
      }
      for (const s of existing) {
        if (s.day !== slot.day || s.period === slot.period) continue;
        if (s.branchId === slot.branchId) continue;
        const t = checkTransition(s, slot, input.travelTime, input.transitionMinutes ?? 10);
        if (!t.feasible) return false;
      }
    }
    return true;
  }

  function signature(state) {
    const parts = [];
    for (const a of order) {
      const p = state.placements.get(a.id);
      const sk = p ? p.slots.map((s) => slotKey(s)).sort().join('|') : '';
      parts.push(`${a.id}=${p?.teacherId ?? ''}:${p?.branchId ?? ''}:${sk}`);
    }
    return parts.join(';');
  }

  // One search iteration. Returns the placements Map on success.
  function searchOne(localRng) {
    const state = makeState();

    function tryPlace(idx) {
      if (Date.now() - start > timeBudget) return null;
      if (idx === order.length) return state;
      const a = order[idx];
      const required = a.requiredPeriods;
      // If this assignment already has slots placed (it shouldn't
      // for a fresh search, but guard anyway), make sure we top up
      // to `required` before moving on.
      const fillAssignment = () => {
        const variants = variantsByAssignment.get(a.id);
        // PHASE 17 — variant ordering is strategy-aware. When
        // `balancedWorkload` is on, prefer the teacher with the
        // most budget headroom. Otherwise shuffle by localRng.
        const variantOrder = variants
          .map((v, i) => {
            let bonus = 0;
            if (balancedWorkload) {
              const t = input.teacherIndex.get(v.teacherId);
              if (t) {
                const budget = workloadOf(t);
                if (budget > 0) bonus = BIAS.WORKLOAD_VARIANT_BONUS * Math.min(5, Math.floor(budget / 5));
              }
            }
            return { v, i, r: localRng(), bonus };
          })
          .sort((x, y) => (x.bonus - y.bonus) || (x.i - y.i) || (x.r - y.r))
          .map((x) => x.v);
        for (const variant of variantOrder) {
          const pool = (branchPool.get(variant.branchId) ?? [])
            .map((s) => ({
              s,
              composite: slotComposite(variant.teacherId, s, state),
              r: localRng(),
            }))
            .sort((x, y) => (x.composite - y.composite) || (x.r - y.r))
            .map((x) => x.s);
          for (const slot of pool) {
            const existing = state.placements.get(a.id);
            const used = new Set(existing ? existing.slots.map(slotKey) : []);
            if (used.has(slotKey(slot))) continue;
            if (!isHardFeasible(state, a, variant.teacherId, variant.branchId, slot)) continue;
            if (existing) {
              extendPlacement(state, a, slot);
            } else {
              placeOne(state, a, variant.teacherId, variant.branchId, slot);
            }
            const p = state.placements.get(a.id);
            if (p.slots.length >= required) return true;
            const recursed = fillAssignment();
            if (recursed) return true;
            popSlot(state, a);
          }
        }
        return false;
      };
      if (!fillAssignment()) return null;
      return tryPlace(idx + 1);
    }

    return tryPlace(0);
  }

  // Run independent searches, accumulating penalty between them.
  let currentSeed = seed;
  while (found.length < cap && Date.now() - start < timeBudget) {
    const localRng = mulberry32(currentSeed);
    const state = searchOne(localRng);
    if (!state) break;
    const sig = signature(state);
    if (seen.has(sig)) {
      // Penalize this signature's slots harder to break the cycle.
      for (const [, p] of state.placements) {
        for (const s of p.slots) {
          const k = slotKey(s);
          slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 50);
        }
      }
      currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
      continue;
    }
    seen.add(sig);
    const cand = makeCandidate(state, input);
    // PHASE 17: record which strategy produced this candidate.
    cand.strategyId = input.strategy.id;
    found.push(cand);
    // Penalize used slots and reseed for the next search.
    for (const [, p] of cand.assignments) {
      for (const s of p) {
        const k = slotKey(s);
        slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 10);
      }
    }
    currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
  }

  if (found.length === 0) {
    warnings.push('NO_SOLUTION: backtracking exhausted with no feasible solution');
  }

  // The solver's hard-constraint gate is the search itself, not a
  // post-pass. We still count the active hard violations for
  // diagnostic visibility; in well-formed runs the count is 0.
  for (const c of found) {
    c.diagnostics.hardViolationCount = 0;
    for (const [name, def] of Object.entries(HARD)) {
      if (def.active && !def.active(input)) continue;
      const v = def.check(c, input);
      c.diagnostics.hardViolationCount += v.length;
    }
  }

  return {
    solutions: found,
    diagnostics: {
      strategiesAttempted: 1,
      totalSolveMs: Date.now() - start,
      warnings,
      unresolvable,
    },
    failure: found.length === 0 ? 'NO_SOLUTION' : null,
  };
}

function makeCandidate(state, input) {
  const assignments = new Map();
  const placements = new Map();
  const transfers = [];
  for (const [aId, p] of state.placements) {
    // Each slot carries its teacherId so downstream consumers
    // (diversity, explain, scorer) can read it without re-resolving
    // via assignmentIndex.
    const slots = p.slots.map((s) => ({ ...s, teacherId: p.teacherId }));
    assignments.set(aId, slots);
    // The placement meta records the solver's effective choice of
    // (teacherId, branchId). The validator and explainer use this
    // to apply constraints against the chosen (not the requested)
    // branch and teacher.
    placements.set(aId, { teacherId: p.teacherId, branchId: p.branchId });
    const meta = input.assignmentIndex.get(aId);
    if (!meta) continue;
    const teacher = input.teacherIndex.get(p.teacherId);
    if (!teacher?.homeBranchId) continue;
    if (p.branchId !== teacher.homeBranchId) {
      for (const s of p.slots) {
        transfers.push({
          teacherId: teacher.id,
          fromBranchId: teacher.homeBranchId,
          toBranchId: s.branchId,
          day: s.day,
          period: s.period,
        });
      }
    }
  }
  return {
    id: `sol-${Math.random().toString(36).slice(2, 10)}`,
    strategyId: input.strategy.id,
    assignments,
    placements,
    transfers,
    diagnostics: {
      hardViolationCount: 0,
      preferenceHits: 0,
      preferenceMisses: 0,
      objectiveValues: {},
    },
  };
}
