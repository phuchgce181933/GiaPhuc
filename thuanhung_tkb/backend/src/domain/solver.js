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
  withEffectiveMeta,
} from './constraints.js';
import { slotKey, teacherSlotKey, classSlotKey, orderByTime } from './time.js';
import { checkTransition } from './travel/index.js';
import { isEligibleFor } from './eligibility.js';
import { workloadOf } from './workload.js';
import { deriveMetrics, teacherLoads } from './metrics.js';
import { compareOptimizationCandidates, isBetter } from './comparator.js';

// PHASE 24 — optimization modes. Inlined here (not imported
// from `./strategies.js`) so the Phase 23 C19 contract
// (solver must not import from `./strategies`) is preserved.
// These values are the same as `OPTIMIZATION_MODES` in
// `./strategies.js`; the constant is duplicated to keep the
// import graph one-directional (solver → strategies is
// forbidden). Tests that consult the modes should import
// from `./strategies.js`.
//
// PHASE 25 — adds `GLOBAL_ASSIGNMENT_BALANCED`. The new mode
// keeps the Phase 24 variant sort and variant expansion (so
// the variant list is identical to ASSIGNMENT_BALANCED), but
// changes the SEARCH CONTROL: after the first complete feasible
// candidate is found, the solver CONTINUES searching and
// retains the best candidate globally. The `bestCandidate` is
// returned when the search stops. The comparator in
// `./comparator.js` is the single source of truth for
// "is A better than B" at the global level.
//
// PHASE 31.1 — DETERMINISM, AND WHY THE BOUND IS NOT OPTIONAL
//
// A result is byte-identical across runs when, and only when:
//
//   same input + same seed + same strategy
//   + the search was not truncated by the wall clock
//
// In GLOBAL_ASSIGNMENT_BALANCED the iteration ceiling is
// `Number.MAX_SAFE_INTEGER`, so `timeLimitMs` is the only real
// bound — and a wall clock is a property of the MACHINE, not of
// the input. On a busy host the search completes fewer
// iterations, compares fewer candidates, and a different
// candidate becomes the incumbent. Measured on this dataset: two
// runs of the same seed completed 49 and 32 candidates. The
// search is a pure function of the seed; what varied was how much
// of it ran.
//
// Two bounds, two properties:
//
//   maxSearchIterations: N  DETERMINISTIC_SEARCH. Stops after N
//                         iterations — a count, not a duration —
//                         so every run does the same work on any
//                         machine. `timeLimitMs` remains a safety
//                         valve.
//
//   timeLimitMs only       TIME_BUDGETED_SEARCH. Reproducible only
//                         while the budget does not bind, which
//                         depends on load. Callers MUST check
//                         `diagnostics.searchLimited` before
//                         claiming determinism.
//
// `diagnostics.searchStoppedBy` says which bound ended the search,
// and `diagnostics.searchLimited` is true if and only if it was
// `TIME_BUDGET`. That is what makes a determinism assertion honest
// instead of hopeful.
const OPTIMIZATION_MODES = Object.freeze({
  BASE_FEASIBLE: 'BASE_FEASIBLE',
  ASSIGNMENT_BALANCED: 'ASSIGNMENT_BALANCED',
  PREFERENCE_FIRST: 'PREFERENCE_FIRST',
  GLOBAL_ASSIGNMENT_BALANCED: 'GLOBAL_ASSIGNMENT_BALANCED',
});

export function solve(input) {
  const start = Date.now();
  const {
    timeLimitMs = 5000,
    maxSolutions = 5,
    maxSearchIterations,
  } = input.strategy.solver ?? {};
  const timeBudget = Math.max(50, Number(timeLimitMs ?? 5000));
  const cap = Math.max(1, Number(maxSolutions ?? 5));

  // PHASE 31.1 — the seed-stable search bound.
  //
  // `timeBudget` is a WALL-CLOCK bound, so the number of search
  // iterations it permits depends on how fast the machine is. That
  // makes a GLOBAL search load-dependent: a busy host stops the
  // search earlier, fewer candidates are compared, and a different
  // candidate can end up as the incumbent. Two runs of the same
  // (input, seed, strategy) then legitimately disagree.
  //
  // `maxSearchIterations` is the DETERMINISTIC alternative: it bounds
  // the search by a count of iterations, not by elapsed time, so the
  // same (input, seed, strategy) always performs the same amount of
  // work and reaches the same incumbent regardless of machine speed.
  // The time budget remains in force as a safety valve; when it is
  // the bound that stops the search, `searchLimited` is true and no
  // determinism claim is valid (see `searchStoppedBy`).
  //
  // Absent/unset means "no iteration bound", which preserves the
  // pre-31.1 behavior exactly (wall clock is the only bound).
  const iterationBound = Number.isInteger(maxSearchIterations) && maxSearchIterations > 0
    ? maxSearchIterations
    : null;

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
  //
  // PHASE 24 — when `optimizationMode` is `ASSIGNMENT_BALANCED`
  // or `PREFERENCE_FIRST`, the variant list is expanded to
  // include ALL eligible teachers, not just the historical
  // (pre-set) teacher. The pre-set teacher is kept FIRST in
  // the list as a tie-break preference so that BASE_FEASIBLE
  // behavior is recoverable by re-running with that mode.
  // The variant-ordering inside the search still applies the
  // mode's heuristic on top of this list.
  //
  // When `optimizationMode` is `BASE_FEASIBLE` (default), the
  // variant list is the original Phase 23 set: pre-set teacher
  // (if any) only. Phase 23 behavior is preserved.
  const optimizationModeForVariants = input.strategy?.optimizationMode ?? 'BASE_FEASIBLE';
  const variantsByAssignment = new Map();
  const unresolvable = [];
  for (const a of input.assignments) {
    let variants = expandAssignmentVariants(a, input);
    if (variants.length === 0) {
      unresolvable.push({ assignmentId: a.id, reason: 'no_decision_variants' });
    }
    if (optimizationModeForVariants !== 'BASE_FEASIBLE') {
      // PHASE 24 — expand to all eligible teachers whose home
      // branch is the assignment's branch (or who have an
      // explicit transfer path). The pre-set teacher (if any)
      // is kept FIRST in the list so it remains the natural
      // tie-break.
      const classRec = Array.isArray(input.classes)
        ? input.classes.find((c) => c.id === a.classId)
        : null;
      const classBranchId = classRec?.branchId ?? null;
      const effectiveBranchId = a.branchId ?? classBranchId;
      const allEligible = (input.teachers ?? []).filter(
        (t) => isEligibleFor(t, a.subjectId),
      );
      const extra = [];
      for (const t of allEligible) {
        const home = t.homeBranchId;
        if (!home) continue;
        if (effectiveBranchId && home !== effectiveBranchId) {
          if (!Array.isArray(t.allowedTransferBranches) || !t.allowedTransferBranches.includes(effectiveBranchId)) continue;
        }
        if (variants.some((v) => v.teacherId === t.id && v.branchId === home)) continue;
        extra.push({ teacherId: t.id, branchId: home });
      }
      variants = [...variants, ...extra];
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
  //
  // PHASE 24 — `optimizationMode` selects WHICH objective the
  // solver uses to pick among eligible teachers for an assignment.
  // The mode is read from `input.strategy.optimizationMode` and
  // defaults to `BASE_FEASIBLE` (Phase 23 behavior) so existing
  // strategy presets without the field still work.
  //
  // The previous version of this block read `strategy?.objectives`
  // and `strategy?.optimizationMode` from a `strategy` variable
  // destructured out of `input.strategy.solver` (the { timeLimitMs,
  // maxSolutions } sub-object). That sub-object carries NO objectives
  // / mode; the result was that every read returned `undefined`, the
  // BALANCED mode was silently demoted to BASE_FEASIBLE, and the
  // Phase 24 objective never influenced the search. The fix reads
  // both fields off the parent `input.strategy` object.
  const objectives = input.strategy?.objectives ?? {};
  const balancedWorkload = Boolean(objectives.balancedWorkload);
  const noGapTeacherDay = Boolean(objectives.noGapTeacherDay);
  const optimizationMode = input.strategy?.optimizationMode ?? OPTIMIZATION_MODES.BASE_FEASIBLE;
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
      // PHASE 25 — increment the per-solve search-node counter at
      // every recursion level. This is the unit of work for the
      // Phase 25 diagnostics; brief §22 / §23 require separating
      // `searchNodes` (recursion calls) from `completeCandidates`
      // (full candidates found). The counter is captured by the
      // closure above; it lives in the per-solve scope, not in
      // any per-search scope.
      searchNodes += 1;
      // PHASE 23 — timeout gate at every recursion level. Without
      // this the inner `fillAssignment` recursion (which does not
      // bubble up through `tryPlace`) would happily exhaust the
      // slot pool on an impossible demand. With this gate, an
      // impossible demand (e.g. requiredPeriods > branchPool size)
      // returns null within the time budget instead of hanging
      // forever.
      if (Date.now() - start > timeBudget) {
        prunedBranches += 1;
        return null;
      }
      if (idx === order.length) return state;
      const a = order[idx];
      const required = a.requiredPeriods;
      // If this assignment already has slots placed (it shouldn't
      // for a fresh search, but guard anyway), make sure we top up
      // to `required` before moving on.
      const fillAssignment = () => {
        if (Date.now() - start > timeBudget) {
          prunedBranches += 1;
          return false;
        }
        const variants = variantsByAssignment.get(a.id);
        // PHASE 17 — variant ordering is strategy-aware. When
        // `balancedWorkload` is on, prefer the teacher with the
        // most budget headroom. Otherwise shuffle by localRng.
        //
        // PHASE 24 — `optimizationMode` is the primary driver of
        // variant ordering. It is ORTHOGONAL to the legacy
        // `objectives.balancedWorkload` switch (which only nudges
        // by the variant bonus). The mode can re-order the
        // variants before the legacy bias is added.
        //
        //   BASE_FEASIBLE:        keep the existing ordering
        //                         (variant index + rng tie-break).
        //   ASSIGNMENT_BALANCED:  sort by CURRENT projected load
        //                         (lower load first). The current
        //                         load is the number of periods
        //                         already placed for that teacher
        //                         in the partial state.
        //   PREFERENCE_FIRST:     prefer teachers whose
        //                         `nguyenVong.buoiUuTien` matches
        //                         the assignment's branch session
        //                         (S01). Falls back to the same
        //                         tie-break as BASE_FEASIBLE.
        //
        // Hard constraints still rule. The mode re-orders; it
        // never skips a teacher the search would otherwise try.
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
            // PHASE 24 — projected load AFTER placing this
            // assignment. Counted from the partial state, not
            // from the budget. The metric is `current + 1` for
            // the placement we're considering right now.
            let projectedLoad = 1;
            for (const [, p] of state.placements) {
              if (p.teacherId === v.teacherId) projectedLoad += p.slots.length;
            }
            // PHASE 24 — preference match (for PREFERENCE_FIRST).
            // True iff the teacher's session preference matches
            // the assignment's branch session (S01).
            let preferenceMatch = 0;
            if (optimizationMode === OPTIMIZATION_MODES.PREFERENCE_FIRST) {
              const t = input.teacherIndex.get(v.teacherId);
              const pref = t?.nguyenVong?.buoiUuTien;
              const branch = input.branches?.find?.((b) => b.id === v.branchId);
              if (pref && pref !== 'ca_hai' && branch) {
                const sp = Array.isArray(branch.sessions?.sang) ? branch.sessions.sang : null;
                const cp = Array.isArray(branch.sessions?.chieu) ? branch.sessions.chieu : null;
                // Most of the work is sang; without a profile we
                // assume the default mapping.
                const session = sp ? 'sang' : (cp ? 'chieu' : 'sang');
                if (pref === session) preferenceMatch = -10; // strong nudge down
              }
            }
            return { v, i, r: localRng(), bonus, projectedLoad, preferenceMatch };
          })
          .sort((x, y) => {
            // PHASE 24 — primary key by mode.
            //
            // PHASE 25 — GLOBAL_ASSIGNMENT_BALANCED reuses the
            // ASSIGNMENT_BALANCED variant list and projected-load
            // sort, but adds the per-iteration RNG as a TIEBREAKER
            // BEFORE the i DESC tiebreak. This is the diversification
            // mechanism: with the rng as a primary tiebreaker,
            // different iterations (with different `localRng`
            // outputs) will pick DIFFERENT variants when projected
            // loads tie. The i DESC tiebreak is preserved as the
            // final deterministic tiebreak.
            //
            // Why this matters for Phase 25:
            //   - ASSIGNMENT_BALANCED's variant sort is
            //     deterministic per state, so every iteration finds
            //     the same teacher distribution. The Phase 24 audit
            //     documented this as the LIMITED_SEARCH limitation.
            //   - GLOBAL_ASSIGNMENT_BALANCED's variant sort uses
            //     the per-iteration RNG so different iterations
            //     genuinely explore different teacher choices. The
            //     comparator then keeps the best candidate per the
            //     global objective.
            //
            // Determinism contract (brief §10):
            //   - `localRng` is `mulberry32(currentSeed)` where
            //     `currentSeed` advances deterministically after
            //     every iteration. So the variant order is fully
            //     determined by (input, strategy, seed, iteration).
            //   - Two runs with the same (input, strategy, seed,
            //     timeBudget) produce identical sequences of
            //     variants and identical candidates. We do NOT
            //     introduce Math.random() or timestamps.
            //   - The Phase 24 / Phase 23 tests must continue to
            //     pass; this change is scoped to
            //     GLOBAL_ASSIGNMENT_BALANCED only.
            //
            // Regression guarantee (brief §11):
            //   - BASE_FEASIBLE, ASSIGNMENT_BALANCED, and
            //     PREFERENCE_FIRST keep their existing variant
            //     sorts. The new GLOBAL mode is additive; it does
            //     not change the other modes' behavior.
            const isBalancedLike = optimizationMode === OPTIMIZATION_MODES.ASSIGNMENT_BALANCED
              || optimizationMode === OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
            const isGlobal = optimizationMode === OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
            if (isBalancedLike) {
              // Lower projected load first.
              if (x.projectedLoad !== y.projectedLoad) return x.projectedLoad - y.projectedLoad;
              // PHASE 25 — for GLOBAL_ASSIGNMENT_BALANCED, use
              // the per-iteration rng as a primary tiebreaker
              // BEFORE the i DESC tiebreak. This lets different
              // iterations pick different variants when loads
              // tie, enabling genuine search diversification.
              // The rng is deterministic per iteration (derived
              // from the strategy seed).
              if (isGlobal && x.r !== y.r) return x.r - y.r;
              // Tie-break: the legacy "first variant wins" bias
              // (variant index ascending) is INVERTED in BALANCED
              // modes. The pre-set teacher is index 0; the
              // alternatives are index 1, 2, ... Inverting the
              // tiebreak lets the alternatives win when loads
              // tie — a deterministic but mode-dependent signal
              // that the optimization is consulting the search
              // (Phase 24 audit).
              if (x.i !== y.i) return y.i - x.i;
              // Final tiebreak.
              return x.r - y.r;
            } else if (optimizationMode === OPTIMIZATION_MODES.PREFERENCE_FIRST) {
              if (x.preferenceMatch !== y.preferenceMatch) return x.preferenceMatch - y.preferenceMatch;
            }
            // Fall through (BASE_FEASIBLE or any unrecognised mode):
            // existing tie-break — pre-set (i=0) wins, then rng.
            if (x.bonus !== y.bonus) return x.bonus - y.bonus;
            if (x.i !== y.i) return x.i - y.i;
            return x.r - y.r;
          })
          .map((x) => x.v);
        for (const variant of variantOrder) {
          if (Date.now() - start > timeBudget) return false;
          const pool = (branchPool.get(variant.branchId) ?? [])
            .map((s) => ({
              s,
              composite: slotComposite(variant.teacherId, s, state),
              r: localRng(),
            }))
            .sort((x, y) => (x.composite - y.composite) || (x.r - y.r))
            .map((x) => x.s);
          for (const slot of pool) {
            if (Date.now() - start > timeBudget) return false;
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
  //
  // PHASE 25 — search control is now mode-aware. In
  // GLOBAL_ASSIGNMENT_BALANCED, the solver:
  //   1. Discovers a complete feasible candidate.
  //   2. Treats it as the incumbent.
  //   3. CONTINUES searching (penalizing the incumbent's slots
  //      to explore alternatives).
  //   4. Compares each new complete candidate against the
  //      incumbent using the global comparator.
  //   5. Replaces the incumbent only when the new candidate is
  //      STRICTLY better (per `isBetter`).
  //   6. Returns the incumbent when the time budget is exhausted
  //      OR no more feasible candidates can be found.
  // The solver never claims global optimum; it claims
  // `BEST_FOUND` (the best candidate discovered within the
  // time budget). This is a documented limitation.
  //
  // For BASE_FEASIBLE / ASSIGNMENT_BALANCED / PREFERENCE_FIRST,
  // the previous behavior is preserved (up to `maxSolutions`
  // candidates, returned as `found`). The Phase 24 / Phase 23
  // tests must continue to pass without modification.
  let currentSeed = seed;
  // PHASE 25 — incumbent state. The incumbent is the BEST
  // complete candidate discovered so far. It is `null` until
  // the first complete candidate is found. The `found` array
  // holds the per-search candidates (for backward compatibility);
  // `incumbent` is the best of them. The diagnostics record
  // aggregate metrics across the search.
  let incumbent = null;
  // Diagnostics counters. Aggregated across the whole solve.
  let searchNodes = 0;          // recursive calls into tryPlace
  let completeCandidates = 0;   // complete feasible candidates found
  let bestCandidateUpdates = 0; // how many times the incumbent was replaced
  let prunedBranches = 0;       // branches cut by the time budget
  let infeasibleBranches = 0;   // branches that ran out of variants
  let timeBudgetHit = false;
  // PHASE 25 — only continue after the first candidate in
  // GLOBAL mode. For all other modes, the existing
  // `maxSolutions` cap is the hard limit on iterations.
  const isGlobal = optimizationMode === OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
  // For non-global modes, the maxIterations is `cap` (1..maxSolutions).
  // For global mode, the search runs until the time budget is
  // exhausted OR the search is provably complete. We still cap
  // the number of search iterations to a hard ceiling so the
  // solver cannot loop forever even with an infinite time
  // budget. The cap is per-solve; the time budget is the primary
  // bound.
  const maxIterations = isGlobal
    ? Number.MAX_SAFE_INTEGER  // time budget is the primary bound
    : cap;
  // PHASE 31.1 — the effective iteration ceiling. When the caller
  // supplies `maxSearchIterations`, that count is the bound and it
  // is seed-stable; otherwise the historical behavior is preserved
  // (wall clock only, in GLOBAL mode).
  const effectiveIterationBound = iterationBound ?? maxIterations;
  // PHASE 31.1 — why the search loop stopped. This is the honest
  // answer to "was the result decided by the seed or by the clock",
  // and it is what a determinism claim must be conditioned on:
  //   ITERATION_LIMIT / SEARCH_EXHAUSTED / SOLUTION_CAP
  //       -> decided by the seed, reproducible
  //   TIME_BUDGET
  //       -> decided by wall clock, NOT reproducible
  let searchStoppedBy = 'UNKNOWN';
  // PHASE 25 — penalty for incumbent's slots so the next search
  // explores alternatives. This is the same as the existing
  // per-candidate penalty but is applied after the FIRST
  // candidate is found in global mode.
  while (
    found.length < cap
    && completeCandidates < effectiveIterationBound
    && Date.now() - start < timeBudget
  ) {
    const localRng = mulberry32(currentSeed);
    const state = searchOne(localRng);
    if (!state) {
      // The search exhausted (no more feasible candidates).
      // Count this as an infeasible branch for diagnostics.
      infeasibleBranches += 1;
      // PHASE 31.1 — the search space itself is finished, so this
      // stop is seed-decided and reproducible.
      searchStoppedBy = 'SEARCH_EXHAUSTED';
      break;
    }
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
    completeCandidates += 1;
    const cand = makeCandidate(state, input, found.length);
    // PHASE 17: record which strategy produced this candidate.
    cand.strategyId = input.strategy.id;
    // PHASE 25 — global comparator: in global mode, every
    // complete candidate is compared against the incumbent.
    // In non-global modes, the existing behavior is preserved
    // (push up to `cap` candidates, no comparison).
    if (isGlobal) {
      // Record this candidate's metrics on its `diagnostics`.
      // Always push to `found` so the diagnostics reflect every
      // complete candidate we examined.
      found.push(cand);
      if (incumbent === null) {
        // First complete candidate — becomes the incumbent.
        incumbent = cand;
        bestCandidateUpdates += 1;
      } else if (isBetter(cand, incumbent)) {
        // New candidate is strictly better — replace incumbent.
        incumbent = cand;
        bestCandidateUpdates += 1;
      }
      // ELSE: new candidate is NOT better. Keep incumbent.
      // This satisfies brief §12: "worse candidate does not
      // replace incumbent".
      // Penalize the current candidate's slots so the next
      // search explores alternatives. The penalty is the same
      // as the existing per-candidate penalty.
      for (const [, p] of cand.assignments) {
        for (const s of p) {
          const k = slotKey(s);
          slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 10);
        }
      }
    } else {
      // Existing behavior: push the candidate, penalize, continue.
      found.push(cand);
      for (const [, p] of cand.assignments) {
        for (const s of p) {
          const k = slotKey(s);
          slotPenalty.set(k, (slotPenalty.get(k) ?? 0) + 10);
        }
      }
    }
    currentSeed = (currentSeed * 1103515245 + 12345) >>> 0;
  }

  // Did the time budget expire before we found any candidate?
  if (Date.now() - start >= timeBudget && found.length === 0) {
    timeBudgetHit = true;
  }
  if (Date.now() - start >= timeBudget && completeCandidates >= 1) {
    timeBudgetHit = true;
  }

  // PHASE 31.1 — resolve which bound ended the search. The loop may
  // have left for one of four reasons, and they are NOT equivalent:
  //
  //   TIME_BUDGET     the wall clock ran out. The number of
  //                   iterations performed depends on machine
  //                   speed, so the incumbent is load-dependent and
  //                   the result is NOT reproducible.
  //   ITERATION_LIMIT  the caller-supplied `maxSearchIterations`
  //                   was reached. Seed-decided, reproducible.
  //   SEARCH_EXHAUSTED the search space ran out. Seed-decided,
  //                   reproducible. (Set inside the loop.)
  //   SOLUTION_CAP    `maxSolutions` candidates were produced.
  //                   Seed-decided, reproducible.
  //
  // The clock wins ties: if the budget expired the search was
  // truncated by the clock even if an iteration limit coincided,
  // because the branch-pruning gates inside `tryPlace` may have
  // already fired on an earlier, clock-dependent iteration.
  if (timeBudgetHit) {
    searchStoppedBy = 'TIME_BUDGET';
  } else if (searchStoppedBy === 'UNKNOWN') {
    if (iterationBound !== null && completeCandidates >= iterationBound) {
      searchStoppedBy = 'ITERATION_LIMIT';
    } else if (found.length >= cap) {
      searchStoppedBy = 'SOLUTION_CAP';
    } else {
      searchStoppedBy = 'SEARCH_EXHAUSTED';
    }
  }

  if (found.length === 0) {
    warnings.push('NO_SOLUTION: backtracking exhausted with no feasible solution');
  }

  // PHASE 25 — for global mode, the returned `solutions` array
  // contains only the BEST candidate (the incumbent), with
  // attached search diagnostics. The brief §24 requires
  // "best candidate" only — no top-5, no diversity.
  // For non-global modes, `solutions` is the existing list
  // (up to `cap` candidates).
  let finalSolutions;
  // PHASE 31.1 — `searchLimited` now has an exact meaning: the
  // search was truncated by a bound that is NOT reproducible, i.e.
  // the wall clock. A search that stopped on the iteration limit,
  // the solution cap, or exhaustion is complete with respect to its
  // own contract and is reproducible, so it is not "limited".
  // This is what makes a determinism assertion honest: it is only
  // valid when this is false.
  const searchLimited = searchStoppedBy === 'TIME_BUDGET';
  if (isGlobal) {
    if (incumbent === null) {
      finalSolutions = [];
    } else {
      finalSolutions = [incumbent];
      // Attach the global-mode diagnostics onto the incumbent.
      // The existing `diagnostics` field is for per-candidate
      // solver output; we add `global` for the per-solve
      // aggregate.
      incumbent.diagnostics.global = {
        bestCandidateUpdates,
        completeCandidates,
        searchNodes,
        prunedBranches,
        infeasibleBranches,
        timeBudgetHit,
        searchLimited,
        searchStoppedBy,
        iterationBound,
        verdict: 'BEST_FOUND',
      };
    }
  } else {
    finalSolutions = found;
  }

  // The solver's hard-constraint gate is the search itself, not a
  // post-pass. We still count the active hard violations for
  // diagnostic visibility; in well-formed runs the count is 0.
  // PHASE 24 — the candidate's `metrics` object already records
  // `hardViolations` from the in-catalog HARD set. We mirror it
  // onto the legacy `diagnostics.hardViolationCount` for the
  // pre-Phase 24 consumers (orchestrator, scorer, validator).
  for (const c of finalSolutions) {
    c.diagnostics.hardViolationCount = c.metrics?.hardViolations ?? 0;
  }

  return {
    solutions: finalSolutions,
    diagnostics: {
      strategiesAttempted: 1,
      totalSolveMs: Date.now() - start,
      warnings,
      unresolvable,
      // PHASE 25 — solver-level diagnostics. Always present,
      // even for non-global modes (where most counters are 0).
      searchNodes,
      completeCandidates,
      bestCandidateUpdates,
      prunedBranches,
      infeasibleBranches,
      timeBudgetHit,
      searchLimited,
      // PHASE 31.1 — which bound ended the search, and the bound
      // that was requested. A caller asserting determinism must
      // read `searchStoppedBy` (not just `searchLimited`) so it can
      // distinguish a reproducible stop from a clock-truncated one.
      searchStoppedBy,
      iterationBound,
      optimizationMode,
    },
    failure: finalSolutions.length === 0 ? 'NO_SOLUTION' : null,
  };
}

// PHASE 23 — deterministic solution id. The previous version
// used `Math.random().toString(36).slice(2, 10)` which made the
// id non-deterministic (Phase 23 brief §20). The id is now
// derived from the strategy seed and a per-solution counter so
// that two solves with the same input produce the same id.
function makeCandidateId(inputSeed, counter) {
  // Cheap, stable 8-hex-char id. Not cryptographic; it is just
  // an opaque handle.
  const mix = (inputSeed ^ (counter * 0x9E3779B1)) >>> 0;
  return mix.toString(16).padStart(8, '0');
}

function makeCandidate(state, input, candidateCounter) {
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
  // PHASE 24 — surface per-candidate metrics. The metrics
  // object is PURE (no IO, no clock) and deterministic. It is
  // derived BEFORE the candidate is returned so downstream
  // consumers (scorer, orchestrator, explainer) can read it
  // without re-computing.
  //
  // The optional baseline is taken from the input when present.
  // Phase 23 input did not carry a baseline; Phase 24 callers
  // (orchestrator, tests) may pass one for comparison. The
  // solver never reads the baseline for placement decisions —
  // it is REPORTED, not USED.
  const baselineForMetrics = input.legacyBaseline ?? null;
  // Run the independent evaluator so the metrics object can
  // surface hardViolations / softPenalty / accepted alongside
  // the workload stats. The evaluator is pure and does not
  // import this solver. We count HARD violations against the
  // EFFECTIVE assignment meta (with the solver's chosen
  // teacherId/branchId merged in), so the in-candidate count
  // matches the validator's view (validator.js uses the same
  // `withEffectiveMeta` helper). Without this, the solver and
  // validator disagree on `H_TRANSFER_ALLOWED` for open-branch
  // assignments (Phase 23 bug — see phase16 hardening §80).
  let evaluation = null;
  try {
    const viewInput = withEffectiveMeta({ assignments, placements }, input);
    evaluation = { hard: { violations: [] }, soft: { penalty: 0, violations: [] } };
    for (const [name, def] of Object.entries(HARD)) {
      if (def.active && !def.active(viewInput)) continue;
      const v = def.check({ assignments, placements }, viewInput);
      if (v && v.length) {
        evaluation.hard.violations.push(...v);
      }
    }
  } catch {
    evaluation = { hard: { violations: [] }, soft: { penalty: 0, violations: [] } };
  }
  evaluation.summary = { accepted: evaluation.hard.violations.length === 0 };
  const metrics = deriveMetrics(
    { assignments, placements },
    input,
    baselineForMetrics,
    evaluation,
  );
  return {
    id: `sol-${makeCandidateId(input.seed, candidateCounter)}`,
    strategyId: input.strategy.id,
    assignments,
    placements,
    transfers,
    diagnostics: {
      hardViolationCount: evaluation.hard.violations.length,
      preferenceHits: 0,
      preferenceMisses: 0,
      objectiveValues: {},
    },
    metrics,
  };
}
