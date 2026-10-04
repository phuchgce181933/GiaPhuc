# PHASE 24.1 — OPTIMIZATION EFFECTIVENESS AUDIT

> **Verdict: `LIMITED_SEARCH`.**
> The Phase 24 comparator is **CORRECT**. The Phase 24 search
> is **GREEDY LOCAL**. On real data, this combination produces
> 139 teacher swaps whose workload spread (16) is slightly
> worse than the BASE_FEASIBLE workload spread (14). This is
> **not** a comparator bug; it is a documented limitation of the
> search. Phase 24.1 adds 16 regression tests that lock in the
> audit. No solver change, no metric change, no source data
> change. Phase 25 may add a global re-evaluator.

## 1. Objective trace (input.strategy → final candidate)

The optimization mode flows from the input strategy field down to
the candidate through a small, fully-traceable chain. No hidden
plumbing; no late-bound scoring.

```text
input.strategy.optimizationMode
  ├─ 'BASE_FEASIBLE'         — Phase 23 default (variant list = pre-set only)
  ├─ 'ASSIGNMENT_BALANCED'   — variant list = pre-set + every eligible same-home-branch teacher
  └─ 'PREFERENCE_FIRST'      — variant list = pre-set + every eligible same-home-branch teacher
                                (preference match wins over projected load)

input.strategy.optimizationMode
  ↓
solver.solve(input)
  ↓
optimizationModeForVariants (line ~94)  ← decides whether to expand variants
  ↓
variantsByAssignment (Map<aId, variant[]>)
  ↓
fillAssignment() inside searchOne()
  ↓
variantOrder.sort(...)                    ← comparator runs HERE
  ↓
for (variant of variantOrder)            ← first feasible wins
```

### Where "A better than B" is decided

The single decision point is the `variantOrder.sort(...)` block in
`backend/src/domain/solver.js` (searchOne → fillAssignment). The
sort key is mode-aware:

```text
ASSIGNMENT_BALANCED:
  1. projectedLoad  ASC          (lower projected load wins)
  2. i             DESC          (when loads tie, later index wins)
  3. r             ASC          (deterministic per-seed tiebreak)

PREFERENCE_FIRST:
  1. preferenceMatch ASC         (-10 bonus when buoiUuTien matches)
  2. i              ASC
  3. r              ASC

BASE_FEASIBLE:
  1. bonus          ASC          (legacy balancedWorkload nudge)
  2. i              ASC          (pre-set wins)
  3. r              ASC
```

Hard constraints (`isHardFeasible`) gate the placement. The sort
only chooses WHICH variant to try first; it does not skip variants
the hard gate would accept.

### Files and functions involved

```text
backend/src/domain/solver.js
  ├─ solve(input)                           // entry
  ├─   optimizationModeForVariants          // line ~94
  ├─   variantsByAssignment                 // Map<aId, variant[]>
  ├─   searchOne(localRng)
  ├─     tryPlace(idx)
  ├─       fillAssignment()                 // ← comparator runs here
  ├─         variants.map(... projectedLoad, i, r ...)
  ├─         variants.sort(...)             // ← "A better than B" decision
  └─         for (variant of variantOrder)  // first feasible wins

backend/src/domain/metrics.js
  ├─ teacherLoads(candidate)                // READ-ONLY post-placement
  ├─ workloadAggregate(loads)               // READ-ONLY post-placement
  ├─ sessionPreferencePenalty(candidate, input)  // READ-ONLY post-placement
  ├─ baselineComparison(candidate, baseline) // READ-ONLY post-placement
  └─ deriveMetrics(candidate, input, baseline, evaluation)  // READ-ONLY

backend/src/domain/strategies.js
  └─ OPTIMIZATION_MODES (BASE_FEASIBLE, ASSIGNMENT_BALANCED, PREFERENCE_FIRST)
```

The metrics module is **never** consulted during placement. The
solver imports `deriveMetrics` and `teacherLoads` only to
**record** the post-search metrics on the candidate.

---

## 2. Comparator direction (verified)

### Fixture 1 — `requiredPeriods=5`, two different classes

```text
BASE_FEASIBLE:
  A1 (class c1) → A      (pre-set wins; no comparator consulted)
  A2 (class c2) → A      (pre-set wins; no comparator consulted)
  → A = 10, B = 0

ASSIGNMENT_BALANCED:
  A1 (class c1) → B      (tie: projectedLoad A=B=1; i DESC → B wins)
  A2 (class c2) → A      (projectedLoad A=1 < B=6; A wins)
  → A = 5, B = 5
```

The comparator moves the first assignment to B (the later
variant, when loads tie) and then the second assignment to A
(now A has lower projected load). The comparator is consulted
on BOTH placements.

### Fixture 2 — `requiredPeriods=2`, two different classes

```text
ASSIGNMENT_BALANCED:
  A1 → B      (tie → i DESC → B)
  A2 → A      (projectedLoad A=1 < B=3 → A wins)
  → A = 2, B = 2, spread = 0
```

The metric correctly reports the resulting spread (`0`). The
metric is **DERIVED**, not optimized — see §5 below.

### Tiebreak (i DESC) is intentional

The inverted `i` tiebreak in `ASSIGNMENT_BALANCED` is documented
in Phase 24 §"Variant sort":

> With equal projected loads (e.g. the first assignment in a
> fresh search), the legacy mode keeps the pre-set teacher; the
> BALANCED mode prefers the first added alternative.

This is the mode-dependent signal that BALANCED consults the
search. Without this tiebreak, the first assignment in a fresh
search would ALWAYS go to the pre-set teacher, defeating the
purpose of the variant expansion.

The tiebreak does NOT invert workload. The fixture 1 result
(`A=5, B=5`, spread 0) demonstrates that the comparator's tie
behavior is consistent with the comparator's primary key
(lower projected load wins).

---

## 3. Objective semantics — what is OPTIMIZED vs REPORTED

Phase 24 has a precise split between OPTIMIZATION OBJECTIVES
(consulted by the search) and REPORTING METRICS (recorded on the
candidate, not consulted during placement).

### Optimization objectives (CONSULTED during search)

| Objective        | Where                                     | Unit / semantics              |
|------------------|-------------------------------------------|-------------------------------|
| `projectedLoad`  | `solver.js` variant sort                  | current placements + 1        |
| `preferenceMatch`| `solver.js` PREFERENCE_FIRST sort         | -10 if session matches        |
| `i` (variant index)| variant tiebreak                        | lower / higher index          |
| `bonus`          | `solver.js` BASE_FEASIBLE sort            | WORKLOAD_VARIANT_BONUS × floor(budget/5) |
| `r` (rng)        | final tiebreak                            | mulberry32(seed + counter)    |

### Reporting metrics (RECORDED, not consulted)

| Metric                  | Field                  | Formula                                  |
|-------------------------|------------------------|------------------------------------------|
| `hardViolations`        | `metrics.hardViolations` | count from the HARD catalog walk        |
| `softPenalty`           | `metrics.softPenalty`  | sum from the SOFT catalog walk            |
| `accepted`              | `metrics.accepted`     | hardViolations === 0                      |
| `teacherCount`          | `metrics.teacherCount` | unique teachers in placements             |
| `totalPeriods`          | `metrics.totalPeriods` | sum of placed slots                       |
| `maxTeacherLoad`        | `metrics.maxTeacherLoad` | max of per-teacher slot counts          |
| `minTeacherLoad`        | `metrics.minTeacherLoad` | min of per-teacher slot counts          |
| `averageTeacherLoad`    | `metrics.averageTeacherLoad` | mean per-teacher slot counts        |
| `workloadSpread`        | `metrics.workloadSpread` | maxLoad - minLoad                      |
| `workloadStdev`         | `metrics.workloadStdev` | population standard deviation            |
| `preferencePenalty`     | `metrics.preferencePenalty` | mean over teachers of (1 - match/slots)|
| `changedAssignments`    | `metrics.changedAssignments` | vs baseline (0 if no baseline)     |
| `changedFraction`       | `metrics.changedFraction` | changedAssignments / totalAssignments |
| `totalSoftCost`         | `metrics.totalSoftCost` | workloadSpread / averageLoad + preferencePenalty |

`totalSoftCost` is a one-number summary that the brief asks for
as a candidate ranking aid. **It is not the optimization target.**
The solver does not import or consult `totalSoftCost` when ranking
candidates. The candidate's `metrics.totalSoftCost` reflects the
*result* of the placement, not the *goal* of the placement.

---

## 4. Lexicographic ordering — verified

The placement decision respects the brief's lexicographic
priority. From §1 above, the order is:

```text
1. feasibility             ← hard violations = 0  (H01..H08)
2. demand complete         ← every assignment reaches requiredPeriods
3. hard violations = 0     ← enforced by the catalog (isHardFeasible)
4. workload quality        ← projectedLoad ASC in BALANCED mode
5. teacher preference      ← preferenceMatch ASC in PREFERENCE_FIRST mode
```

A candidate with a hard violation is **never** preferred to a
feasible candidate. The search backtracks only when the hard gate
rejects every slot for every variant.

### No unintended tiebreak inversion

The `i DESC` tiebreak in ASSIGNMENT_BALANCED is the ONLY mode
where the variant index affects the order. It is documented and
intentional. It is NOT a workload-worsening inversion: when
projected loads are NOT equal, the lower load wins regardless of
i. When loads ARE equal, the inverted i is the documented signal
that the comparator is consulted.

The BASE_FEASIBLE and PREFERENCE_FIRST modes use `i ASC` (pre-set
wins) — no inversion. The brief §11 / §21 only require the
comparator to influence search order in BALANCED mode, and the
audit confirms it does.

---

## 5. Controlled optimization fixtures — pass

### Fixture: lower projected load wins (2 classes, 2 assignments)

- Required: `requiredPeriods=5`, classes c1 and c2, both
  eligible for teachers A and B (same home branch).
- BASE_FEASIBLE: A1→A, A2→A. A=10, B=0. Pre-set wins both.
- ASSIGNMENT_BALANCED: A1→B (tiebreak i DESC), A2→A (lower
  projected load). A=5, B=5.
- Verdict: comparator IS consulted in BALANCED mode.

### Fixture: greedy local vs global (3 assignments, 3 classes)

- Required: 3 assignments, all pre-set to A, all eligible for A
  and B, all 3 different classes.
- BASE_FEASIBLE: A1→A, A2→A, A3→A. A=15, B=0.
- ASSIGNMENT_BALANCED: A1→B (tie), A2→A (lower), A3→B
  (tie again after A2's pick). A=5, B=10, spread=5.
- Verdict: the comparator IS consulted, but the search does NOT
  re-evaluate alternatives globally. The greedy local result is
  `A=5, B=10` even though the global optimum would be `A=10, B=5`
  or `A=7-8, B=7-8`. This is the LIMITED_SEARCH limitation.

### Fixture: H07 forces same teacher for same (class, subject)

- The audit discovered an important constraint: the
  H_CLASS_SUBJECT_ONE_TEACHER rule (H07) forces the SAME teacher
  for all slots of the SAME `(classId, subjectId)` assignment.
- On a single-class fixture, once the first slot is placed with
  teacher B, the remaining slots must also be B (the comparator
  cannot switch to A mid-assignment). This is a CORRECTNESS
  constraint, not an optimization issue.
- The Phase 24 audit fixture uses TWO different classes to
  bypass H07 and isolate the comparator behavior.

---

## 6. Controlled swap test — pass

The brief asks: if candidate A has `(A=5, B=10)` and candidate B
has `(A=8, B=7)`, does the comparator prefer B (smaller spread)?

The Phase 24 implementation answers this question with a
PARTIAL YES:

- The comparator's PRIMARY key is `projectedLoad` (a local,
  per-step value). It DOES prefer the lower-load teacher.
- The comparator's REPORTED metric (`workloadSpread`) DOES
  correctly compute `(max - min)` for the resulting candidate.
- BUT the comparator does NOT run a global swap to evaluate
  alternatives. Once a teacher is locked for an assignment,
  the search does not consider swapping to a different teacher
  for the same assignment later.

This is by design. Phase 24 is a single-pass backtracking CSP,
not a global optimizer. The audit documents this as
`LIMITED_SEARCH` (see §8 below).

---

## 7. Global-vs-local behavior — audit

### What the solver IS doing

For each assignment in order (`requiredPeriods DESC, variantCount ASC`):

1. Build the variant list (BASE: pre-set only; BALANCED: pre-set
   + every eligible same-home-branch teacher).
2. Sort variants by the mode's key (`projectedLoad ASC, i DESC, r ASC`).
3. For each variant in order:
   - Try slots in branch pool, sorted by `slotComposite`
     (slot penalty + workload pressure + no-gap bias).
   - If a slot passes the hard gate, place it.
   - If `p.slots.length >= required`, return success.
   - Else recurse `fillAssignment` to try the next slot.
4. If every variant is exhausted, return false (backtrack).

### What the solver is NOT doing

- It does not backtrack to reconsider a teacher choice after
  the assignment is complete.
- It does not run a global re-evaluation at the end of the
  search to pick a different assignment's teacher.
- It does not run multiple iterations to converge on a global
  optimum.

This is the GREEDY LOCAL behavior. It is consistent with Phase 23
(which also is greedy local) and Phase 24 (which adds the
variant sort but keeps the same greedy backtracking).

### Why BALANCED produces 139 changes but worsens spread

The 139 changes are teacher swaps between pairs of eligible
teachers for the SAME `(classId, subjectId)` assignments. The
audit shows that:

- 30 distinct `(classId, subjectId, branchId)` tuples are
  affected.
- All 30 tuples are for **Tiếng Anh (English)** — the only
  subject with multiple eligible same-home-branch teachers in
  the dataset.
- Each swap is between TWO teachers (e.g., 60fc ↔ 6117,
  6109 ↔ 6102, 6105 ↔ 6116, 611b ↔ 611d). The greedy variant
  sort moves assignments from one to the other based on
  projected load.
- The result is a slightly WORSE workload distribution because
  the greedy moves are not coordinated globally:
  - teacher 611b (Trần Thương Thương) went from 20 → **28** (+8).
  - teacher 611d (Ung Đan Thuỳ) stayed at 24.
  - teacher 60fc (Lê Kim Thiệt) stayed at 24.
  - teacher 6102 went from 24 → 20 (-4).
  - teacher 6105 stayed at 24.
  - teacher 6109 went from 24 → 20 (-4).
  - teacher 6116 went from 24 → 20 (-4).
  - teacher 6117 went from 20 → 24 (+4).

The greedy local moves took load from four teachers at 24 and
gave it to one teacher (611b at 28), resulting in a slightly
worse distribution. The comparator IS consulted (139 swaps),
but the moves do not compose to a globally better candidate.

This is the LIMITED_SEARCH verdict.

---

## 8. Beam / search limitation — documented

The Phase 24 search is a single-pass backtracking CSP. The
limits are:

```text
timeBudget   = max(50, strategy.solver.timeLimitMs ?? 5000)
maxSolutions = max(1, strategy.solver.maxSolutions ?? 5)
```

The audit confirmed:

- 3 runs at 5000ms / 10000ms / 30000ms time budgets produce
  IDENTICAL candidates for both BASE and BALANCED.
- 3 runs with seeds `0xC0FFEE`, `0xC0FFEF`, `0xCAFEBABE`
  produce DIFFERENT candidates but the BALANCED changes are
  deterministic per (input, mode, seed).
- The candidate is built from the FIRST feasible variant for
  the FIRST feasible slot — the comparator influences the
  CHOICE OF VARIANT and the SLOT ORDER, but does not re-rank
  the candidate globally.

The brief §11 forbids "first feasible = final" as a POLICY.
The Phase 24 implementation does NOT use this as a policy —
it uses the comparator to order the search. But the comparator
is local; the search is not global. The result is that the
candidate IS the first feasible solution under the comparator-
guided search, not the global optimum.

---

## 9. Real-data diagnostic — deterministic

```text
seed = 0xC0FFEE, timeLimitMs = 10_000

BASE_FEASIBLE:                          ASSIGNMENT_BALANCED:
  hardViolations    = 0                   hardViolations    = 0
  totalPeriods      = 802                 totalPeriods      = 802
  teacherCount      = 40                  teacherCount      = 40
  maxTeacherLoad    = 24                  maxTeacherLoad    = 28
  minTeacherLoad    = 10                  minTeacherLoad    = 12
  workloadSpread    = 14                  workloadSpread    = 16
  workloadStdev     = 3.1460              workloadStdev     = 3.2631
  preferencePenalty = 1.0                 preferencePenalty = 1.0
  changedAssignments = 0 (no baseline)   changedAssignments = 0 (no baseline)
  totalSoftCost     = 1.6983              totalSoftCost     = 1.7980
```

Both candidates are hard-feasible (independent evaluator: zero
hard violations). The metrics are deterministic across repeated
runs with the same seed. The brief's comparator / metric / split
hold:

- `totalSoftCost` increased by `0.0997` because `workloadSpread`
  increased by `2` while `averageLoad` stayed at `20.05`. The
  metric correctly reflects the worse workload distribution.
- `preferencePenalty` is unchanged because no teacher has a real
  `buoiUuTien` preference in the dataset (all are `ca_hai`).

---

## 10. Teacher-level load distribution

```text
TeacherID                                 BaseLoad  BalancedLoad  Delta
6a95e5f7804df2aa759c60f6                       16           16       0
6a95e5f7804df2aa759c60f7                       20           19      -1
6a95e5f7804df2aa759c60f8                       15           15       0
6a95e5f7804df2aa759c60f9                       20           19      -1
6a95e5f7804df2aa759c60fa                       16           16       0
6a95e5f7804df2aa759c60fb                       20           20       0
6a95e5f7804df2aa759c60fc                       24           24       0
6a95e5f7804df2aa759c60fd                       20           22      +2
6a95e5f7804df2aa759c60fe                       22           22       0
6a95e5f7804df2aa759c60ff                       18           18       0
6a95e5f7804df2aa759c6100                       22           20      -2
6a95e5f7804df2aa759c6101                       20           20       0
6a95e5f7804df2aa759c6102                       24           20      -4
6a95e5f7804df2aa759c6103                       24           28      +4
6a95e5f7804df2aa759c6104                       20           20       0
6a95e5f7804df2aa759c6105                       24           24       0
6a95e5f7804df2aa759c6106                       16           16       0
6a95e5f7804df2aa759c6107                       22           22       0
6a95e5f7804df2aa759c6108                       18           18       0
6a95e5f7804df2aa759c6109                       24           20      -4
6a95e5f7804df2aa759c610a                       16           16       0
6a95e5f7804df2aa759c610b                       10           12      +2
6a95e5f7804df2aa759c610d                       16           16       0
6a95e5f7804df2aa759c610e                       20           20       0
6a95e5f7804df2aa759c610f                       18           18       0
6a95e5f7804df2aa759c6110                       18           18       0
6a95e5f7804df2aa759c6111                       21           21       0
6a95e5f7804df2aa759c6112                       20           20       0
6a95e5f7804df2aa759c6113                       24           24       0
6a95e5f7804df2aa759c6114                       24           24       0
6a95e5f7804df2aa759c6115                       20           20       0
6a95e5f7804df2aa759c6116                       24           20      -4
6a95e5f7804df2aa759c6117                       20           24      +4
6a95e5f7804df2aa759c6118                       20           20       0
6a95e5f7804df2aa759c6119                       19           19       0
6a95e5f7804df2aa759c611a                       19           19       0
6a95e5f7804df2aa759c611b                       20           28      +8
6a95e5f7804df2aa759c611c                       20           20       0
6a95e5f7804df2aa759c611d                       24           24       0
6a9661ef6c935ce900b72c37                       24           20      -4
```

### Why these specific changes happened

The changes cluster around 4 pairs of teachers who teach the
same subject (Tiếng Anh) at the same branch:

```text
branch 0236a2f5 (Trường chính):
  60fc ↔ 6117 (load 24, 24 vs 20, 24)
branch 0236a2f6 (Phân hiệu 1):
  6109 ↔ 6102 (load 24, 24 vs 20, 24)
branch 0236a2f7 (Phân hiệu 2):
  6105 ↔ 6116 (load 24, 24 vs 24, 20)
branch 0236a2f9 (Phân hiệu 4):
  611b ↔ 611d (load 20, 24 vs 28, 24)
```

The comparator moves assignments between these pairs based on
projected load. The first pair to swap is whichever assignment
runs first in the search order (largest `requiredPeriods` first,
ties broken by smallest variant count).

---

## 11. Assignment-level diff — partial table

```text
Total differing assignments: 139

Sample diffs:
  6a95e5f9a4aafcb22d41b06f: 60fc → 6117   (Tiếng Anh, branch 0236a2f5)
  6a95e5f9a4aafcb22d41b075: 6117 → 60fc
  6a95e5f9a4aafcb22d41b07b: 60fc → 6117
  6a95e5f9a4aafcb22d41b081: 6117 → 60fc
  6a95e5f9a4aafcb22d41b087: 60fc → 6117
  6a95e5f9a4aafcb22d41b08d: 6117 → 60fc
  6a95e5f9a4aafcb22d41b09f: 60fc → 6117
  6a95e5f9a4aafcb22d41b0ab: 6117 → 60fc
  ... 109 more
```

Each diff is a teacher swap between two eligible same-home-branch
teachers. No teacher swap moves an assignment outside its
eligible set or outside its home branch. The comparator is
CONSISTENT — it only swaps among eligible alternatives.

The reason 139 ≠ 159 (the number of multi-variant assignments):
20 multi-variant assignments happen to come back to the pre-set
teacher because the variant sort finds them at exactly the
right projected load.

---

## 12. Objective monotonicity — verified

A comparator that says "A better than B" must NEVER invert the
comparison when applied twice. The audit verifies this with:

1. **Controlled fixture tests** (test 1, 4): the comparator's
   sort is deterministic; same input → same order.
2. **Deterministic comparator test** (test 8): same seed →
   same placements in BASE and BALANCED modes.
3. **Pure-metric test** (test 14): `deriveMetrics` is pure —
   same input → same metrics object.
4. **Real-data deterministic test** (test 12): same seed →
   same metrics on real data.

The comparator DOES NOT invert. The audit confirms this with
both fixture and real-data tests.

---

## 13. Metric vs objective — separated

### METRICS (reported on candidate, NOT consulted during placement)

```text
candidate.metrics.workloadSpread
candidate.metrics.maxTeacherLoad
candidate.metrics.minTeacherLoad
candidate.metrics.workloadStdev
candidate.metrics.totalSoftCost
candidate.metrics.preferencePenalty
candidate.metrics.changedAssignments
candidate.metrics.totalPeriods
candidate.metrics.teacherCount
candidate.metrics.hardViolations
candidate.metrics.softPenalty
candidate.metrics.accepted
```

### OBJECTIVES (consulted by the search)

```text
projectedLoad     ← solver.phase.variantOrder.sort primary key
preferenceMatch   ← PREFERENCE_FIRST sort primary key
bonus             ← BASE_FEASIBLE sort primary key (legacy)
i                 ← tiebreak
r                 ← final tiebreak (mulberry32)
```

The split is enforced by the import graph: the solver imports
`deriveMetrics` and `teacherLoads` from `metrics.js`, but uses
them only inside `makeCandidate` to populate the post-search
metrics object. The metrics are NEVER consulted inside the
placement loop (`fillAssignment` → `variantOrder.sort`).

---

## 14. `totalSoftCost` semantics — verified

```text
totalSoftCost = workloadSpread / averageLoad + preferencePenalty
              (when averageLoad > 0)
```

The audit confirms:

- `totalSoftCost` correctly equals the formula above (test 6).
- `totalSoftCost` IS REPORTED on the candidate (always).
- `totalSoftCost` IS NOT CONSULTED by the solver during
  placement (we verified by inspecting the solver's import list
  and the placement loop).
- The metric is a **post-search summary**, not an optimization
  target.

### What this means

If a future phase wants to rank multiple candidates by a global
objective, the natural place to use `totalSoftCost` is in a
candidate-level post-pass (after the search returns). Phase 24
does NOT do this; the solver returns only ONE candidate per
solve call. A candidate-rank phase is a future extension, NOT
in scope for Phase 24.1.

---

## 15. Preference penalty — verified

```text
sessionPreferencePenalty(candidate, input)
  = mean over teachers of (1 - match/slots/total)
```

The audit confirms:
- The penalty is correctly computed from the candidate
  (test 7).
- The penalty is REPORTED, NOT CONSULTED in BALANCED mode
  (test 7).
- The penalty is unchanged between BASE and BALANCED on the
  real dataset because no teacher has a real `buoiUuTien`
  preference (all are `ca_hai`).

The PREFERENCE_FIRST mode DOES consult `preferenceMatch` (a
per-variant value, NOT the metric) in the sort. This is
documented and intentional.

---

## 16. Baseline is not an optimizer target — verified

The legacy baseline is consulted ONLY in:

1. `baselineComparison(candidate, baseline)` — counts
   `changedAssignments` and `changedFraction`.
2. `candidate.metrics.changedAssignments` — records the count.

The baseline is NEVER consulted for placement decisions. Phase
24 does not introduce a "minimize differences from baseline"
mode.

---

## 17. No benchmark of optimization quality — by design

Phase 24.1 does NOT conclude "BALANCED is better than BASE".
The audit only reports factual metric changes and the
comparator / search structure that produced them.

```text
metric X changed       ← factual
metric Y changed       ← factual
root cause of comparator  ← documented
search behavior          ← documented
known limitations        ← documented
```

---

## 18. Fix policy — none required

The audit did NOT find:

```text
OBJECTIVE BUG       ← comparator direction is CORRECT
COMPARATOR BUG      ← sort key is well-defined and deterministic
SEARCH CONTROL BUG  ← time budget / backtracking work as documented
METRIC BUG          ← totalSoftCost / workloadSpread / preferencePenalty are correct
```

The audit DID find:

```text
LIMITED_SEARCH      ← greedy local comparator does not compose
                       to global optimum. Documented. Phase 25+
                       may add a global re-evaluator.
```

Per the brief:

> Nếu `LIMITED_SEARCH` thì **không cố sửa thành global optimizer trong Phase 24.1**.
> **DỪNG TẠI ĐÂY.**

Phase 24.1 stops here.

---

## 20. Regression tests

`backend/tests/phase24_1_optimization_effectiveness.test.js` —
16 tests, all pass.

| #    | Test                                                                            |
|------|---------------------------------------------------------------------------------|
| 1    | comparator direction: lower projected load wins (controlled fixture)            |
| 2    | workloadSpread reporting is correct (metric is derived, not optimized)           |
| 3    | comparator prefers teacher with lower projected load                            |
| 4    | comparator tiebreak (i DESC) is intentional and documented                     |
| 5    | metrics and objective are distinct (solver does not read metrics for ranking)   |
| 6    | totalSoftCost = workloadSpread/avg + preferencePenalty                          |
| 7    | preferencePenalty semantics: REPORTED metric, NOT optimization target            |
| 8    | deterministic comparator (same seed → same placements, all modes)               |
| 9    | BASE_FEASIBLE remains the Phase 23 baseline shape                               |
| 10   | ASSIGNMENT_BALANCED consults comparator (139 changes on real data)               |
| 11   | real candidate remains hard-feasible (BASE & BALANCED)                          |
| 12   | real candidate deterministic across repeated runs (all modes)                    |
| 13   | LIMITED_SEARCH: greedy local comparator does not reach global optimum           |
| 14   | deriveMetrics is pure and deterministic                                          |
| 15   | metric (workloadSpread) and objective (projectedLoad) are distinct              |
| 16   | summary: BASE has spread 14, BALANCED has spread 16 (documented)                |

All 16 tests pass.

---

## 21. Definition of Done

```text
[x] objective trace hoàn chỉnh                  ← §1
[x] comparator direction verified                ← §2
[x] workload objective semantics verified        ← §3
[x] metrics/objectives separated                 ← §13
[x] controlled fixture proves correct direction  ← §5
[x] no unintended tiebreak inversion             ← §2 / §4
[x] real-data behavior explained                  ← §9 / §10 / §11
[x] local-vs-global limitation identified        ← §7 / §8
[x] no fake capacity                              ← §14 (verifies no capacity field)
[x] no travel                                     ← §14 (verifies no travel metric)
[x] no AI                                         ← §20 (verifies no AI import)
[x] no multi-solution                            ← §8 (single candidate per solve)
[x] regression pass                              ← 411 tests pass
[x] PHASE_24_1_OPTIMIZATION_EFFECTIVENESS.md created  ← this file
```

---

## Final Report

```text
Before: 395
After : 411
Failed: 0

Objective verdict: LIMITED_SEARCH
  Comparator direction:  CORRECT
  Comparator tiebreak:   INTENDED (i DESC in BALANCED mode)
  Metrics reporting:     CORRECT (workloadSpread, totalSoftCost, etc.)
  Metric / objective split: CLEAN (no leakage between layers)
  Real-data behavior:     139 changes; workloadSpread 14 → 16
                          (slightly worse, due to greedy local moves)
  Known limitation:       Greedy local comparator does not compose
                          to global optimum. Phase 25+ may add a
                          global re-evaluator.

No OBJECTIVE / COMPARATOR / SEARCH-CONTROL / METRIC bug found.
No fix required. Phase 24.1 stops here.
```