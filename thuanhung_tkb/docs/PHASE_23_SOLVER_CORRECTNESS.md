# PHASE 23 — SOLVER CORRECTNESS

> **The solver, given the real-data `SchedulingInput` from
> `loadFromLegacySaplich()`, must produce a candidate that the
> independent constraint evaluator accepts — without relying on the
> legacy baseline as a hidden hard dependency.**

## Scope

Phase 23 is the first phase where the solver is asked to find a
candidate from a real, non-trivial `SchedulingInput`. Phase 22 proved
the catalog + evaluator are correct against the legacy baseline;
Phase 23 proves the **solver** is correct against the same input.

This phase does **NOT** optimize quality. It only proves:

1. The solver can find a feasible candidate on real data.
2. The candidate is genuinely produced by the search — not
   extracted from the legacy baseline.
3. The candidate covers the entire 802-period demand.
4. The independent constraint evaluator accepts the candidate
   (zero hard violations).
5. The solver is deterministic and does not mutate input.
6. The solver reports `EMPTY` / `NO_SOLUTION` cleanly when the
   demand is impossible.

Quality (workload balance, travel, soft preferences, etc.) is a
later phase.

---

## Real-data input

The Phase 23 test (`tests/phase23_solver_correctness.test.js`)
loads the legacy dataset from `data/source/legacy-saplich/` and
projects it into the `SchedulingInput` contract:

```text
teachers        : 40 active teachers
branches        : 7 branches
classes         : 113 classes
subjects        : 6 total, 5 active (CN-TH inactive)
curriculum      : 21 effective block-level rows
                 = 479 class-level rows (1 per active class per block)
assignments     : 479 historical assignments
requiredPeriods : 802 total
travelTime      : null  (H14 = UNSUPPORTED)
```

The CN-TH subject (id `6a95e5f7804df2aa759c60ee`) is inactive and
must never appear in any candidate. The 479 historical assignments
have `baselineAssignment: true`, meaning they are warm-start hints
— not fixed constraints.

### Constraint activation

The Phase 22 catalog surfaces the following activation state on this
input:

| Constraint | Status      | Reason                                            |
|------------|-------------|---------------------------------------------------|
| H01        | ACTIVE      | Class double-booking                              |
| H02        | ACTIVE      | Teacher double-booking                            |
| H03        | ACTIVE      | Teacher eligibility                               |
| H04        | ACTIVE      | Slot-in-branch                                    |
| H05        | ACTIVE      | Demand fulfillment                                |
| H06        | ACTIVE      | Slot validity                                     |
| H07        | ACTIVE      | One teacher per (class, subject)                    |
| H08        | ACTIVE      | Active entities only                              |
| H09        | INACTIVE    | No `soTietTuan > 1` in any teacher                |
| H10        | ACTIVE      | Some teacher has `maxSessionsPerWeek > 0`         |
| H11        | INACTIVE    | No teacher has a `fixedDayOff`                    |
| H12        | INACTIVE    | Session preference is soft (S01)                  |
| H13        | INACTIVE    | No teacher has `allowedTransferBranches`          |
| H14        | UNSUPPORTED | `travelTime === null` — no matrix to evaluate     |
| S01        | ACTIVE      | Some teacher has `preferredSession != ca_hai`     |
| S02        | ACTIVE      | Mirrors H10 soft pressure                         |
| S03        | INACTIVE    | Mirrors H11 soft pressure                         |
| S04        | INACTIVE    | Mirrors H09 — no per-subject workload signal      |
| S05        | INACTIVE    | No `preferredTransferBranches`                    |
| S06        | INACTIVE    | No `preferredGrades`                              |
| S07        | ACTIVE      | Session compactness (always on)                   |
| S08        | ACTIVE      | Teacher-day concentration (always on)             |

The Phase 23 solver respects all activation states. Inactive /
unsupported constraints are not enforced; no fake data is invented
to satisfy them.

---

## Solver architecture

The Phase 23 solver is the existing CSP backtracking solver at
`backend/src/domain/solver.js`, with three Phase 23 changes:

1. **Deterministic solution id.** The previous id was generated
   with `Math.random()` (brief §20 forbids non-deterministic
   sources in search). The id is now derived from the strategy
   seed + a per-solution counter so two solves with the same input
   produce the same id.

2. **Timeout gate inside `fillAssignment`.** The previous timeout
   check was at the start of `tryPlace` only. Without a timeout
   inside the inner `fillAssignment` recursion, an impossible demand
   (`requiredPeriods` far above the branch slot pool) would hang
   for the full time budget before bailing. The Phase 23 solver
   now also checks `Date.now() - start > timeBudget` at every
   recursion level inside `fillAssignment`. An impossible demand
   returns `NO_SOLUTION` cleanly within the budget.

3. **No mutation.** The solver's existing read-only contract is
   preserved — it never writes to `SchedulingInput` or to the
   legacy baseline.

The search algorithm itself is unchanged:

```text
order assignments by  (requiredPeriods DESC, variants ASC)
for each assignment, in order:
  for each variant (teacher, branch):
    for each slot in the branch pool, ordered by composite bias:
      if hard feasible:
        if assignment already has requiredPeriods slots, recurse
        else extend placement, recurse
```

The hard-constraint gate (H01, H02, H03, H04, H07, H08) is applied
*inside* the search via `isHardFeasible()`. The post-search
independent evaluator (catalog) verifies the candidate is also free
of H05, H06, H10, and H14 violations.

---

## Real-data solve

```text
algorithm         : backtracking CSP with strategy-driven bias
strategy          : STRATEGY_C (balanced)
seed              : 0xC0FFEE
timeLimitMs       : 10 000
maxSolutions      : 1
solve status      : OK  (failure = null)
solutions         : 1
solve time        : ~18 ms (single search, well under budget)
placements        : 802
assignments placed: 479 / 479
unique teachers   : 40 / 40
unique branches   : 7 / 7
warnings          : []
```

### Independent evaluator (catalog)

```text
hard violations : 0
soft penalty    : 35.1478
summary.accepted: true
```

The candidate has **zero hard violations** under the Phase 22
catalog. The soft penalty is reported for transparency (Phase 23
does not optimize it).

### Legacy validator (verify)

```text
accepted              : true
hard violations       : 0
coverage.total        : 479
coverage.fullyScheduled: 479
coverage.partiallyScheduled: 0
coverage.notScheduled : 0
```

Two independent evaluations agree on `accepted = true`. The
candidate is a real candidate, not the legacy baseline.

### Identity

The solver candidate is provably not the legacy baseline:

```text
candidate === legacyBaseline                      : false
candidate.assignments === legacyBaseline.scheduleSlots : false

matches at (assignment, day, period)             : 0 / 802
  → the search did not copy the baseline slot-by-slot.
```

The 0 matches also rule out a "search then post-process baseline"
hack. The candidate is genuinely new.

---

## Test surface

`backend/tests/phase23_solver_correctness.test.js` covers 27
invariants. Each invariant maps to a brief section:

| #    | Invariant                                |
|------|----------------------------------------|
| C1   | solver returns a candidate             |
| C2   | candidate is not the legacy baseline   |
| C3   | candidate has 802 placements           |
| C4   | all 479 assignments represented        |
| C5   | every assignment reaches requiredPeriods|
| C6   | no duplicate class slot                |
| C7   | no duplicate teacher slot              |
| C8   | every teacher-subject pairing eligible |
| C9   | every teacher used is active           |
| C9b  | every subject used is active           |
| C10  | CN-TH never appears                    |
| C11  | every placement references valid branch|
| C11b | every placement within branch profile  |
| C12  | every placement has day/period/teacher/branch |
| C13  | evaluator: zero hard violations        |
| C14  | evaluator accepts candidate            |
| C15  | solver deterministic (single run)     |
| C15b | solver deterministic across 5x runs    |
| C16  | solver does not mutate SchedulingInput |
| C17  | solver does not mutate legacy baseline |
| C18  | solver does not fabricate travel data  |
| C19  | solver does not call AI / external     |
| C20  | solver reports NO_SOLUTION cleanly     |
| C21  | solver uses every active teacher       |
| C22  | baseline is independent reference      |
| C23  | Phase 22.1 invariants still hold       |
| C24  | diagnostics.hardViolationCount = 0     |

All 27 pass.

---

## Empty-case example

Phase 23 C20 forces one assignment to demand 999 periods on a
branch with a 25-slot pool:

```text
timeLimitMs     : 500 ms
failure        : NO_SOLUTION
solutions      : 0
warnings       : [ 'NO_SOLUTION: backtracking exhausted with no feasible solution' ]
totalSolveMs   : ~500 ms (the time budget)
```

The solver never fabricates slots. It bails within the budget and
reports `NO_SOLUTION`. The candidate pool remains empty.

The test also asserts no candidate has 999+ slots — a guardrail
against a future regression that might silently drop a partial
placement and call it "done".

---

## Baseline independence

Phase 22 C22 solves with the legacy baseline stripped from the
input:

```text
delete input.legacyBaseline
solve(input)
solutions.length = 1
placements       = 802
hard violations  = 0
accepted         = true
```

The solver does not read the baseline. It is purely a function of
the `SchedulingInput` (teachers, classes, subjects, branches,
assignments, timeSlotsByBranch). The legacy baseline is preserved
as a frozen, append-only bundle in `legacyBaseline` for audit and
warm-start; it is never a hidden hard dependency.

---

## What is intentionally NOT in Phase 23

| Topic                | Why not now                                                      |
|----------------------|------------------------------------------------------------------|
| Optimization         | Brief §1 — Phase 23 is correctness only                          |
| Weight tuning        | Brief §1 — heuristic weights are configurations, not correctness  |
| A/B/C strategy       | Brief §1 — strategy tuning is for ranking, not search existence |
| Multi-solution       | Brief §29 — one valid candidate is enough                        |
| Diversity            | Brief §29 — diversity is for ranking, not existence              |
| AI / LLM             | Brief §30 — solver is pure and deterministic                      |
| Travel matrix        | Brief §12 — `travelTime === null`; H14 stays UNSUPPORTED         |
| Soft score tuning    | Brief §15 — soft penalty 35.15 is reported, not optimized       |

Phase 23 ends here.

---

## Regression

Phase 23 is additive. The full regression suite before Phase 23:

```text
tests: 347
pass : 347
fail : 0
```

After Phase 23:

```text
tests: 374   (347 baseline + 27 Phase 23)
pass : 374
fail : 0
```

No Phase 1–22.1 test was modified. The Phase 23 solver changes
were strictly local to `solver.js` (Math.random removal, timeout
gate) and to the test file (C19 ESM fix).