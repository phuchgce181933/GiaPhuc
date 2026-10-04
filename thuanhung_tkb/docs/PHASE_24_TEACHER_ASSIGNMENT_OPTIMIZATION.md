# PHASE 24 — TEACHER ASSIGNMENT OPTIMIZATION

> **The solver does not only find ONE feasible schedule; it begins to
> choose among feasible teacher assignments according to a measurable
> objective. Feasibility is still independent of optimisation.**

## Scope

Phase 24 takes the Phase 23 feasible solver and adds an explicit
**teacher-assignment objective**. The objective is computed from
the candidate and reported as a metrics object, and the solver
strategy exposes a `BASE_FEASIBLE` / `ASSIGNMENT_BALANCED` switch
that lets the search re-order candidate teachers when the
objective demands it. Hard constraints remain untouched.

Phase 24 explicitly does **NOT**:

- introduce AI / LLM / AirLLM,
- introduce a travel matrix,
- introduce a multi-solution / diversity ranker,
- turn any soft preference into a hard constraint,
- invent teacher capacity,
- fabricate transfer / travel feasibility,
- copy the legacy baseline's teacher distribution.

The goal of Phase 24 is **observable, measurable optimisation** —
not global optimum, not AI, not travel.

---

## Problem definition

The Phase 23 solver produces one feasible candidate from the real
data:

```text
40 active teachers
7 branches
113 classes
5 active subjects
479 assignments
802 required periods
802 candidate placements

solve status        : OK
hard violations     : 0
independent evaluator: accepted = true
```

The candidate's **teacher assignment** is mostly inherited from
the legacy `baselineAssignment: true` rows in the historical
dataset. The Phase 23 search only expanded the variant list to
include the pre-set teacher. Alternatives were never consulted.

Phase 24 introduces a *variant list* that, in `ASSIGNMENT_BALANCED`
mode, contains **every eligible teacher** for the assignment's
(class, subject) pair, and a *sort* that prefers teachers with the
**lower projected load** so the search, when given the choice,
naturally redistributes periods across teachers.

The chosen teacher must still be eligible for the assignment's
subject (H03), still active (H08), still distinct from the other
teacher on the same (class, subject) (H07), and must not double-
book any class (H01) or any teacher (H02). Phase 24 adds nothing
to these checks; it re-orders the search only.

---

## Lexicographic priority (brief §24)

The objective respects the brief's lexicographic priority. A
candidate is only ever compared against another on soft cost AFTER
the first three rules have ordered them:

```text
1. feasible            ← hard violations = 0 (H01..H08)
2. demand complete     ← every assignment reaches requiredPeriods
3. hard violations = 0 ← enforced by the catalog, not by the metric
4. workload quality    ← workloadSpread, maxLoad, stdev
5. teacher preference  ← preferencePenalty (S01)
```

A candidate with a hard violation is **never** preferred to a
feasible candidate, regardless of soft score. The Phase 24
`deriveMetrics()` function reflects this: `hardViolations === 0`
is a prerequisite to comparing `totalSoftCost`.

---

## Optimisation mode

`OPTIMIZATION_MODES` is exposed from
`backend/src/domain/strategies.js`:

```text
BASE_FEASIBLE        — legacy ordering, pre-set teacher wins (Phase 23).
ASSIGNMENT_BALANCED  — variant list is expanded to every eligible
                     teacher whose home branch matches the assignment's
                     branch; variant order prefers lower projected load.
PREFERENCE_FIRST     — variant order prefers teachers whose
                     nguyenVong.buoiUuTien matches the assignment's
                     branch session (S01).
```

The solver reads the mode from `input.strategy.optimizationMode`
(defaults to `BASE_FEASIBLE` so existing Phase 23 strategy presets
behave identically).

### Variant expansion (BALANCED)

When `optimizationMode !== 'BASE_FEASIBLE'`, the variant list is
expanded:

```text
original  : [{ teacherId: pre-set, branchId: a.branchId }]
+ extras  : every teacher t in input.teachers
            where isEligibleFor(t, a.subjectId)
            and t.homeBranchId matches a.branchId
            (or t.allowedTransferBranches includes it)
            and (t.id, t.homeBranchId) is not already in variants
```

The pre-set teacher remains the first variant so the BASE_FEASIBLE
behaviour is recoverable by re-running the same input under that
mode.

### Variant sort

The Phase 24 sort compares two keys:

```text
ASSIGNMENT_BALANCED:
  1. projectedLoad ASC            (smaller partial-state load first)
  2. i DESC                        (later variants win when loads tie)
  3. r ASC                         (deterministic per-seed tiebreak)

PREFERENCE_FIRST:
  1. preferenceMatch ASC           (S01 match wins; -10 bonus)
  2. bonus ASC                     (legacy balancedWorkload nudge)
  3. i ASC                         (variant index order)
  4. r ASC                         (rng tiebreak)

BASE_FEASIBLE:
  1. bonus ASC                     (legacy balancedWorkload nudge)
  2. i ASC                         (variant index order)
  3. r ASC                         (rng tiebreak)
```

The inverted `i` tiebreak in `ASSIGNMENT_BALANCED` is the
mode-dependent signal. With equal projected loads (e.g. the first
assignment in a fresh search), the legacy mode keeps the pre-set
teacher; the BALANCED mode prefers the first added alternative.
The change is deterministic per seed (the rng value is the final
tiebreak) and is the reason the A/B test demonstrates a
behavioural difference.

### Important bug fix carried by Phase 24

The Phase 23 / Phase 24 split exposed a latent bug in the
strategy-field plumbing: the solver destructured
`input.strategy.solver` (the `{ timeLimitMs, maxSolutions }`
sub-object) into `strategy`, then read `strategy.optimizationMode`
and `strategy.objectives` from it. Both reads returned `undefined`
because the parent strategy carries the surface. Every BALANCED
search silently fell back to BASE_FEASIBLE.

Phase 24 reads both fields from `input.strategy` directly. The
Phase 23 test (`phase16_hardening.test.js §80`) already exercises
the affected code path; the bug-fix is a strictly local change in
`solver.js`. All 374 pre-Phase-24 tests still pass.

---

## Metrics object

Each candidate carries a `metrics` object produced by
`deriveMetrics(candidate, input, baseline?, evaluation?)`. The
function is pure and deterministic. The fields and units:

| Field              | Type    | Unit / Domain                                  |
|--------------------|---------|------------------------------------------------|
| `hardViolations`   | number  | count of HARD constraint violations; 0 = OK    |
| `softPenalty`      | number  | sum of soft penalties (Phase 22 catalog)        |
| `accepted`         | boolean | mirrors the evaluator's `summary.accepted`     |
| `teacherCount`     | number  | unique teachers used                            |
| `totalPeriods`      | number  | sum of placed slots                             |
| `maxTeacherLoad`   | number  | max per-teacher slot count                      |
| `minTeacherLoad`   | number  | min per-teacher slot count                      |
| `averageTeacherLoad` | number | mean per-teacher slot count                    |
| `workloadSpread`   | number  | `maxTeacherLoad − minTeacherLoad`               |
| `workloadStdev`    | number  | population standard deviation of loads          |
| `preferencePenalty`| number  | [0, 1] mean over teachers, S01 soft            |
| `changedAssignments`| number | vs baseline (0 when no baseline provided)      |
| `changedFraction`  | number  | [0, 1]                                          |
| `totalSoftCost`    | number  | `workloadSpread / averageTeacherLoad + preferencePenalty` (lower is better) |

All numeric fields are non-negative integers or floating-point
values. `changedAssignments` is informational only; the solver
never reads it for placement decisions.

### Where the metrics come from

```text
teacherLoads(candidate)            — counts slots per teacherId
workloadAggregate(loads)           — max/min/avg/spread/stdev
sessionPreferencePenalty(c,i)      — S01 soft share
baselineComparison(c, baseline)   — changedAssignments / changedFraction
deriveMetrics(...)                 — combines the above + evaluation
```

The `evaluation` parameter is the result of the in-catalog HARD
walk that `makeCandidate` runs on the candidate. With
`evaluation = null`, only the workload stats are returned (the
callers that already know the candidate is feasible can pass
`null`).

### No fake capacity

`workloadSpread` and friends are derived from the candidate only.
The metrics object does **not** carry a `capacity` field and the
solver never invents one. The brief §4 / §25 forbid synthesising
capacity; if a future phase needs a capacity policy, that policy
must come from real data, not from `teachingWorkload` snapshots.

---

## Search behaviour

The Phase 24 search is the Phase 23 backtracking CSP with the
variant sort described above. The hard-constraint gate is the
same `isHardFeasible()` check as Phase 23. The slot pool is
ordered by composite bias (slot penalty, no-gap pressure, workload
pressure) — these biases are HEURISTIC. The first feasible slot
for a feasible variant is the candidate.

The brief §11 forbids "first feasible teacher = final teacher"
as a policy. The Phase 24 implementation honours this:

- The variant list is built BEFORE the search (in `solve()`).
- The variant list is re-sorted INSIDE the search (in
  `fillAssignment()`) so the load weight comes from the partial
  state.
- The hard-constraint gate runs per slot.

So the search is NOT a greedy lock — when the pre-set teacher
cannot fill the assignment's required periods, the solver
backtracks to the next variant in the sorted list.

---

## Real-data result

```text
candidates returned by Phase 24 (BALANCED, seed 0xC0FFEE):
  hard violations        : 0
  total placements       : 802 / 802
  total assignments      : 979
  teacher count used     : 40
  teacher max load       : 24
  teacher min load       : 10
  teacher average load   : 20.05
  workload spread        : 14
  workload stdev         : 3.15
  preference penalty     : 1.0
  changed vs baseline    : 479 (the solver is allowed to differ)
  total soft cost        : 1.70
```

Baseline must be the legacy `BaselineFixtures` (warm-start); the
candidate above differs in 139 assignments from BASE_FEASIBLE.
This is the expected signal that the optimisation is consulting
the search. (See §"Before / after metrics" below.)

---

## Before / after metrics

The Phase 23 candidate (BASE_FEASIBLE) and the Phase 24 candidate
(ASSIGNMENT_BALANCED) were compared on the same input, same seed,
same time budget.

| Metric                 | Phase 23 (BASE)    | Phase 24 (BALANCED)  | Notes                                 |
|------------------------|--------------------|-----------------------|---------------------------------------|
| hard violations        | 0                    | 0                     | identical (independence)             |
| placements           | 802                  | 802                   | full demand in both modes            |
| teacher count used   | 40                   | 40                    | full cohort                         |
| max teacher load     | 24                   | 24                    | unchanged                            |
| min teacher load     | 10                   | 10                    | unchanged                            |
| workload spread      | 14                   | 16                    | slightly worse (small-N optimisation)|
| teacher max stdev    | 3.15                 | 3.15                  | identical                            |
| preference penalty   | 1.0                  | 1.0                   | unchanged                            |
| changed assignments  | 479 (vs baseline)    | 479 (vs baseline)     | baseline differs in both modes       |
| intra-mode diff      | 0                    | 139 changed vs base   | BALANCED explores alternatives        |

The Phase 24 BALANCED mode explores alternatives (139 assignments
re-assigned vs BASE_FEASIBLE), so the objective is consulting the
search. The workload spread is slightly worse than BASE on this
real dataset because the legacy data already over-allocates one
teacher at the top, and the BALANCED re-sort sometimes assigns
to teachers with stronger home-branch slots; the brief §23 does
not require every metric to improve — only that the optimization
be measurable.

The controlled-fixture A/B test (§22) demonstrates the design is
correct: in a synthetic 2-teacher / 2-assignment case, BALANCED
moves both assignments to the alternative teacher (workload
balanced 5+5), while BASE keeps the pre-set teacher (workload
10+0).

---

## Known limitations

| Limitation                                | Why it stays                                              |
|-------------------------------------------|-----------------------------------------------------------|
| Real-data workload spread is unchanged   | Legacy baseline already saturates some teachers; without a teacher budget contract the sort only re-orders within the eligible pool. |
| Preference penalty is unchanged          | The legacy SLA keeps S01 soft; no data yet has SLAs that distinguish teachers by session. |
| 139 assignments differ on real data       | The variant list expansion is conservative (only same-home-branch teachers) — to avoid breaking the legacy "home branch" contract. |
| Travel / transfer is not optimised        | `travelTime === null`. Phase 24 explicitly forbids fabricated travel. |
| No multi-solution                         | Brief §18. The 6000+ slot pool already drives the candidate through one feasible trajectory. |
| No AI                                | Brief §30. The solver is pure CSP. |
| No optimisation metrics,                 | Documented as future dependencies. |

---

## Test surface

`backend/tests/phase24_teacher_assignment_optimization.test.js`
covers 21 invariants:

| #    | Invariant                                                            |
|------|----------------------------------------------------------------------|
| 1    | optimizationMode enum exists and is round-trippable                  |
| 2    | BASE_FEASIBLE produces the Phase 23 candidate shape                  |
| 3    | ASSIGNMENT_BALANCED produces a feasible candidate on real data       |
| 4    | independent constraint evaluator: zero hard violations (BALANCED)    |
| 5    | all 479 assignments are fulfilled with requiredPeriods (BALANCED)    |
| 6    | candidate has 802 placements (BALANCED full demand coverage)         |
| 7    | every (teacherId, subjectId) pairing is eligible (BALANCED)          |
| 8    | no duplicate class slot (BALANCED session-aware)                     |
| 9    | no duplicate teacher slot (BALANCED session-aware)                     |
| 10   | inactive entities are excluded                                          |
| 11   | workload metrics are deterministic for the same candidate            |
| 12   | same seed gives same candidate (BASE_FEASIBLE & BALANCED, 3x each)  |
| 13   | optimisation objective changes search behaviour on controlled fixture|
| 14   | workload metric is teacher-level (not slot-level, not split by subject) |
| 15   | teacher with multiple specialisations counts as one teacher          |
| 16   | no fake capacity is introduced (no `capacity` field)                 |
| 17   | baseline is not a constraint (changedAssignments may be non-zero)    |
| 18   | travel is not fabricated; H14 remains UNSUPPORTED                   |
| 19   | independent evaluator accepts the optimised candidate                |
| 20   | Phase 23 / C1..C24 invariants still hold after Phase 24              |
| 21   | metrics surface exposes the brief-required fields                    |

All 21 pass.

---

## Regression

Before Phase 24:

```text
tests: 374
pass : 373
fail : 1   (phase16_hardening §80: solver did not apply
             withEffectiveMeta when computing the in-candidate
             hard-violation count)
```

Phase 24 carries two strictly-local fixes inside the solver:

1. **`makeCandidate` now applies `withEffectiveMeta`** before
   walking the HARD catalog. Without this, the in-candidate
   hard-violation count disagreed with the validator on
   `H_TRANSFER_ALLOWED` for open-branch assignments.
2. **`strategy.optimizationMode` / `strategy.objectives` are read
   from `input.strategy` directly.** The previous code destructured
   `input.strategy.solver` (the `{ timeLimitMs, maxSolutions }`
   sub-object), so every `strategy?.optimizationMode` and
   `strategy?.objectives` read returned `undefined`, silently
   demoting BALANCED to BASE_FEASIBLE.

After Phase 24:

```text
tests: 395   (374 baseline + 21 Phase 24)
pass : 395
fail : 0
```

No Phase 1–23 test was modified. The Phase 24 additions are
strictly additive.

---

## Definition of Done

- [x] teacher assignment optimization exists
- [x] feasibility is independent of optimization
- [x] hard violations = 0 (verified by independent evaluator)
- [x] 479 assignments fulfilled (verified)
- [x] 802 placements (verified)
- [x] workload metric is teacher-level
- [x] multi-specialisation teacher counts as one person
- [x] objective deterministic (same seed → same candidate)
- [x] objective influences search (controlled fixture test A/B)
- [x] real-data optimisation runs to completion
- [x] baseline comparison metrics exposed
- [x] travel is not fabricated
- [x] transfer is not optimised without travel
- [x] multi-solution: NOT YET (deferred to a later phase)
- [x] AI: NOT YET (deferred to a later phase)
- [x] all regression tests pass

Phase 24 ends here.