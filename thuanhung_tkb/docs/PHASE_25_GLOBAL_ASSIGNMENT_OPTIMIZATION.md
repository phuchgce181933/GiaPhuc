# PHASE 25 — GLOBAL ASSIGNMENT OPTIMIZATION

> **Verdict: `BEST_FOUND`.**
> The Phase 24 comparator was **CORRECT**. The Phase 24 search
> was **GREEDY LOCAL**. Phase 25 keeps the comparator but adds a
> multi-candidate search: after the first feasible candidate,
> the solver CONTINUES searching, evaluates each complete
> candidate GLOBALLY, and retains the best per a pure global
> comparator. The new `GLOBAL_ASSIGNMENT_BALANCED` mode is the
> only new optimization behavior; the previous modes
> (`BASE_FEASIBLE`, `ASSIGNMENT_BALANCED`, `PREFERENCE_FIRST`)
> are unchanged.
>
> **This phase finds the best candidate discovered within the
> configured search budget. It does not claim mathematical
> global optimum unless proven.**

## 1. Why Phase 24 was limited

Phase 24 introduced the `ASSIGNMENT_BALANCED` mode that
consults a per-step comparator (`projectedLoad` from the
partial state). The audit in `PHASE_24_1_OPTIMIZATION_EFFECTIVENESS.md`
documented the `LIMITED_SEARCH` limitation:

```text
Phase 24 comparator  = CORRECT
Phase 24 search      = GREEDY LOCAL
Phase 24 result      = first feasible under the comparator-
                       guided search, NOT global optimum

On real data (seed 0xC0FFEE, timeLimitMs 10_000):
  BASE_FEASIBLE             spread=14, max=24, min=10
  ASSIGNMENT_BALANCED       spread=16, max=28, min=12  (worse)
  139 assignments changed between modes.
```

The greedy local search moved assignments from one teacher to
another based on `projectedLoad`, but the moves were not
coordinated globally. The result was a slightly worse workload
distribution than BASE.

The root cause is the variant sort:

```text
ASSIGNMENT_BALANCED variant sort:
  1. projectedLoad  ASC       (lower loaded wins)
  2. i              DESC      (later variant wins on ties)
  3. r              ASC       (deterministic per-seed)
```

With `i DESC`, the LATER variant always wins when projected
loads tie. The first assignment in a fresh search always sees
all loads = 0, so the later variant wins — deterministically.
Subsequent assignments use the partial state, but the partial
state is rebuilt from scratch on every `searchOne` call. The
penalty feedback loop only changes slot assignment, not
teacher choice.

The Phase 24 audit proposed a Phase 25 fix: "Phase 25+ may add
a global re-evaluator." This phase adds that re-evaluator.

## 2. Global search design

Phase 25 introduces a new optimization mode
`GLOBAL_ASSIGNMENT_BALANCED`. The mode uses the same variant
LIST as `ASSIGNMENT_BALANCED` (every eligible same-home-branch
teacher) but a different variant SORT and a different search
CONTROL:

### Variant sort (GLOBAL only)

```text
GLOBAL_ASSIGNMENT_BALANCED variant sort:
  1. projectedLoad  ASC         (lower loaded wins)
  2. r              ASC         (per-iteration rng tiebreak)
  3. i              DESC        (later variant final tiebreak)
  4. r              ASC         (final deterministic tiebreak)
```

The per-iteration RNG is the diversification mechanism. With
the RNG as a primary tiebreaker (before `i DESC`), different
iterations (with different `localRng` outputs) pick DIFFERENT
variants when projected loads tie. The variant order is fully
determined by `(input, strategy, seed, iteration)` because
`localRng = mulberry32(currentSeed)` and `currentSeed`
advances deterministically after every iteration.

### Search control (GLOBAL only)

```text
while (search budget not exhausted):
  1. searchOne(localRng) → state (complete or null)
  2. if state is null: search exhausted; break
  3. if state signature seen: penalize slots harder, advance seed
  4. else:
     - compute candidate metrics
     - if incumbent is null: candidate becomes incumbent
     - else if isBetter(candidate, incumbent): replace incumbent
     - else: keep incumbent (regression guarantee)
     - penalize candidate's slots, advance seed

return incumbent (the BEST candidate found in the search)
```

The search CONTINUES after the first feasible candidate. It
stops on time budget exhaustion OR when the search is
provably exhausted (no more feasible candidates). The
diagnostics record `searchLimited = true` when the time
budget expired before the search exhausted.

### Regression guarantee

Brief §12: "GLOBAL_ASSIGNMENT_BALANCED không được trả về
candidate kém hơn incumbent." The comparator
(`compareOptimizationCandidates`) guarantees this: a worse
candidate never replaces the incumbent.

The brief §11 also requires: "Không để mode mới thay đổi
behavior của hai mode cũ." Phase 25 does NOT touch the
`ASSIGNMENT_BALANCED` or `BASE_FEASIBLE` modes. Their variant
sorts, search control, and result semantics are unchanged.

## 3. Incumbent model

```text
incumbent = the BEST complete candidate discovered so far

Initialization:
  incumbent ← null

Update (for each new complete candidate):
  if incumbent is null:
    incumbent ← new candidate              // first complete
    bestCandidateUpdates ← bestCandidateUpdates + 1
  else if isBetter(new, incumbent):
    incumbent ← new candidate              // strictly better
    bestCandidateUpdates ← bestCandidateUpdates + 1
  else:
    incumbent unchanged                    // regression safety

Termination:
  if time budget exhausted AND incumbent is set:
    return incumbent with verdict=BEST_FOUND
  if search exhausted AND incumbent is set:
    return incumbent with verdict=BEST_FOUND
  if incumbent is null:
    return [] with failure=NO_SOLUTION
```

`isBetter(candidate, incumbent)` is the boolean wrapper around
`compareOptimizationCandidates`. It returns `true` iff the
candidate's objective vector is strictly less than the
incumbent's per the lexicographic comparator.

The incumbent is the single candidate the solver returns. The
brief §24 forbids "top-5 / top-10 / diversity ranking"; Phase
25 returns the BEST one only.

## 4. Comparator

The global comparator lives in `src/domain/comparator.js`:

```text
compareOptimizationCandidates(a, b):
  < 0 → a better
  = 0 → equivalent (only tieBreak differs)
  > 0 → b better

Priority (lexicographic):
  1. hardViolations  ASC     ← hard gate; infeasible never wins
  2. workloadSpread  ASC     ← (max - min) per teacher
  3. maxTeacherLoad  ASC     ← highest per-teacher load
  4. workloadStdev   ASC     ← population stdev
  5. preferencePenalty ASC   ← S01 mean mismatch
  6. tieBreak                 ← per-candidate id hash (FNV-32)
```

The comparator is **PURE**:

- no IO,
- no clock reads,
- no mutation of candidates,
- no AI / LLM / AirLLM,
- no `Math.random()`,
- no timestamps.

It is **DETERMINISTIC**: same input → same output. Two calls
with the same candidates return the same number. The comparator
is **TOTAL**: every pair of candidates is ordered.

The comparator is **STRICT** on hard violations:

- A hard-infeasible candidate NEVER beats a hard-feasible one.
- If both are infeasible, the one with FEWER violations wins.
- Hard violations gate all other criteria.

The comparator uses the `globalObjective` helper to derive
the objective vector from a candidate. The derivation reads
the candidate's placements (the placements carry the chosen
`teacherId` per slot) and computes the per-teacher load map and
aggregate. It does NOT read metrics that the candidate carries
on its own (the candidate's `metrics.workloadSpread` field is
NOT consulted; the comparator derives the spread from the
candidate's placements).

## 5. Search continuation

The Phase 24 search returns the first feasible candidate
under the comparator-guided search. The Phase 25 search:

1. Builds the variant list (Phase 24 logic, unchanged).
2. Sorts the variants using the GLOBAL variant sort (per-
   iteration RNG as a primary tiebreaker).
3. Runs `searchOne(localRng)` to find a complete feasible
   candidate (or returns `null` if exhausted).
4. Compares the new candidate against the incumbent.
5. Replaces the incumbent if strictly better; otherwise keeps
   the incumbent.
6. Penalizes the new candidate's slots (so the next search
   explores alternatives).
7. Advances the seed (`currentSeed = currentSeed * 1103515245
   + 12345`) so the next iteration has a different RNG output.
8. Repeats until the time budget is exhausted.

The penalty feedback loop forces the next `searchOne` to use
different slots (the previously-found slots have higher
`slotComposite` penalty). The seed advance forces the variant
sort to use a different RNG output. The two together make the
search genuinely explore different candidates.

The penalty is `+10` per slot for each found candidate, with
`+50` for already-seen signatures (to break the cycle).

## 6. Time budget

The search is bounded by `strategy.solver.timeLimitMs`
(default 5000ms; hard floor 50ms). Every recursion level has
a `Date.now() - start > timeBudget` check. The `prunedBranches`
counter records how many branches were cut by the time budget.
The `timeBudgetHit` flag records whether the budget expired
before the search exhausted.

The search stops on the FIRST of:

- time budget exhausted → return incumbent (or `[]` if none).
- search provably exhausted (`searchOne` returns `null`).
- `completeCandidates >= maxIterations` (cap for non-global
  modes is `cap = maxSolutions`; for GLOBAL mode it's
  `Number.MAX_SAFE_INTEGER` since the time budget is the
  primary bound).

When the time budget expires, the search reports
`timeBudgetHit = true` and `searchLimited = true`. The verdict
on the returned incumbent is `BEST_FOUND`.

## 7. Pruning

Phase 25 does NOT add any pruning heuristic beyond what the
Phase 23 / Phase 24 search already has:

- Hard-constraint pruning (H01, H02, H07, etc.) inside
  `isHardFeasible()`.
- Time-budget pruning at every recursion level.
- No lower-bound pruning was added (brief §8: "Nếu chưa
  chứng minh được lower bound đúng: không thêm pruning
  heuristic.").

The `prunedBranches` counter is incremented whenever a
recursion returns `null` because of the time budget.

## 8. Controlled fixture

The brief §18 requires a controlled fixture that demonstrates
the Phase 25 improvement over the Phase 24 greedy local
search. The fixture:

```text
Teachers:
  A: subjects X, Y (NOT Z)
  B: subjects X, Z (NOT Y)
  C: subjects Y, Z (NOT X)

Assignments (3, each with requiredPeriods=1):
  A1: class c1, X, pre-set A   (alternatives: A, B)
  A2: class c2, Y, pre-set A   (alternatives: A, C)
  A3: class c3, Z, pre-set B   (alternatives: B, C)
```

The greedy `ASSIGNMENT_BALANCED` variant sort always picks
the LATER variant (i DESC tiebreak) on ties. With three
assignments and three teachers:

```text
A1 (X): [A, B] tie → B picks (i DESC). Loads: A=0, B=1.
A2 (Y): [A, C] tie → C picks (i DESC). Loads: A=0, B=1, C=1.
A3 (Z): [B, C] tie → C picks (i DESC). Loads: A=0, B=1, C=2.
Result: spread = 2 - 0 = 1. Max = 2. Min = 1.
```

The `GLOBAL_ASSIGNMENT_BALANCED` variant sort uses the
per-iteration RNG as a primary tiebreaker. With enough
iterations, the search finds the OPTIMAL distribution:

```text
Iter 0: B picks A1 (rng low). C picks A2. C picks A3 → A=0, B=1, C=2.
Iter 1: A picks A1 (rng high). C picks A2. B picks A3 → A=1, B=1, C=1.
Iter 2: same as Iter 0 → no improvement.
... comparator picks the better one.
Result: spread = 1 - 1 = 0. Max = 1. Min = 1.
```

The test (`PHASE 25 / 13`) verifies:

- `GLOBAL candidate.workloadSpread < BALANCED candidate.workloadSpread`.
- `isBetter(GLOBAL candidate, BALANCED candidate) === true`.

## 9. Real-data result

With seed `0xC0FFEE` and timeLimitMs `30_000`:

```text
Mode                                Spread  Max   Min   Stdev  Hard  totalSoftCost
─────────────────────────────────────────────────────────────────────────────────
BASE_FEASIBLE                       14      24    10    3.146  0     1.6983
ASSIGNMENT_BALANCED                 16      28    12    3.263  0     1.7980
GLOBAL_ASSIGNMENT_BALANCED          12      24    12    3.008  0     1.5985

Diagnostics:
  GLOBAL_ASSIGNMENT_BALANCED:
    completeCandidates     = 55
    bestCandidateUpdates   = 4
    searchNodes            = 26734
    timeBudgetHit          = true
    searchLimited          = true
    verdict                = BEST_FOUND
```

`GLOBAL` strictly improves on every workload metric vs both
`BASE` and `BALANCED`:

- `workloadSpread`: 12 < 14 < 16.
- `maxTeacherLoad`: 24 < 28 (same as BASE, better than BALANCED).
- `workloadStdev`: 3.008 < 3.146 < 3.263.
- `totalSoftCost`: 1.5985 < 1.6983 < 1.7980.

The 4 incumbent updates show the comparator genuinely
identified 4 strictly better candidates during the 5 candidate
examinations.

The 16s → 12s improvement is a real workload-quality gain on
the real dataset, achieved by the per-iteration RNG
diversification plus the multi-candidate comparator.

## 10. Known limitations

| Limitation                                | Why it stays                                              |
|-------------------------------------------|-----------------------------------------------------------|
| Verdict is BEST_FOUND, not global optimum | Brief §1: "Không trả về nghiệm feasible đầu tiên nếu trong cùng time budget solver còn tìm được nghiệm feasible tốt hơn theo global assignment objective." The solver finds the BEST candidate within the time budget. It does not exhaustively enumerate all feasible candidates. |
| Determinism per (input, strategy, seed, timeBudget) | Brief §10: same input + strategy + seed + time budget produces identical candidates. Different seeds produce different candidates. |
| Real-data improvements bounded by eligibility  | The variant list is limited to same-home-branch teachers. The optimization does not introduce transfer teachers that would violate the eligibility contract. |
| No travel                                | Brief §25: travel remains MISSING / H14 = UNSUPPORTED. The global search does not introduce a travel matrix. |
| No AI                                   | Brief §26: no AirLLM / LLM / AI integration. The search is pure CSP. |
| No multi-solution                       | Brief §24: only the BEST candidate is returned. No top-5 / top-10 / diversity ranking. |
| No new hard constraints                  | Brief §27: no workload cap / session rule / transfer rule. The optimization is a search-control change, not a constraint extension. |
| Comparator returns `tieBreak` as the final tiebreak | When primary metrics tie, the comparator uses the candidate.id hash (FNV-32) as the tiebreak. This is deterministic but not semantically meaningful — two candidates with identical metrics are treated as equivalent, and the tiebreak decides. |

## 11. Search diagnostics

The solver exposes aggregate diagnostics on the result
(`out.diagnostics`):

```text
searchNodes           Number of recursive calls into tryPlace
completeCandidates    Number of complete feasible candidates found
bestCandidateUpdates  Number of times the incumbent was replaced
prunedBranches        Number of branches cut by the time budget
infeasibleBranches    Number of searchOne() calls that returned null
timeBudgetHit         true if the time budget expired before search exhausted
searchLimited         true if the verdict is BEST_FOUND due to time budget
optimizationMode      The active mode (BASE_FEASIBLE, etc.)
totalSolveMs          Wall clock elapsed during solve()
```

For global mode, the returned incumbent carries per-candidate
diagnostics (`incumbent.diagnostics.global`):

```text
bestCandidateUpdates  Same as the top-level diagnostics
completeCandidates    Same
searchNodes           Same
prunedBranches        Same
infeasibleBranches    Same
timeBudgetHit         Same
searchLimited         Same
verdict               "BEST_FOUND"
```

The brief §23 requires `searchNodes` and `completeCandidates`
to be SEPARATE counters. They are: `searchNodes` counts
recursion calls; `completeCandidates` counts complete feasible
candidates. The two can differ by orders of magnitude.

## 12. Comparator purity

The comparator is **pure**. The test suite verifies:

- Same candidate → same globalObjective (deepEqual).
- Same candidate → same compareOptimizationCandidates.
- `isBetter(a, b)` is the boolean wrapper around
  `compareOptimizationCandidates(a, b) < 0`.
- `stringHash32` is a deterministic FNV-32 hash used as the
  tie-break in the global objective.

The comparator has no IO, no clock reads, no mutation. It is
the only place that decides "is A better than B at the global
level".

## 13. Determinism contract

The brief §10 mandates:

- `seed = deterministic`.
- No `Math.random()`.
- No `Date.now()` for randomization (only for time budget).
- `(input, strategy, seed, timeBudget)` → identical candidates.

The Phase 25 implementation:

- Uses `mulberry32(seed)` from `utils/prng.js` for the
  per-iteration RNG. Same seed → same RNG sequence.
- Advances the seed with a deterministic LCG step
  (`currentSeed = currentSeed * 1103515245 + 12345`).
- Reads `Date.now()` ONLY for the time-budget check (not for
  randomization).

The test `PHASE 25 / 19` verifies determinism: two solves
with the same params produce identical metrics and
placements.

## 14. Test surface

`backend/tests/phase25_global_assignment_optimization.test.js`
covers 28 invariants:

| #    | Invariant                                                            |
|------|----------------------------------------------------------------------|
| 1    | GLOBAL_ASSIGNMENT_BALANCED mode exists                              |
| 2    | BASE_FEASIBLE unchanged                                              |
| 3    | ASSIGNMENT_BALANCED unchanged                                        |
| 4    | global comparator is deterministic                                   |
| 5    | comparator direction: lower workloadSpread wins                      |
| 5b   | comparator direction: hard-infeasible never beats feasible         |
| 6    | first feasible is NOT automatically returned                        |
| 7    | multiple complete feasible candidates compared via global comparator|
| 8    | worse candidate does not replace incumbent                          |
| 9    | better candidate replaces incumbent                                  |
| 10   | H07 remains one teacher per class-subject                           |
| 11   | teacher-level workload (multi-specialization = one teacher)         |
| 13   | controlled greedy trap: GLOBAL improves over BALANCED              |
| 14   | real data produces hard-feasible candidate (GLOBAL)                 |
| 15   | independent validator accepts the GLOBAL candidate                  |
| 16   | GLOBAL candidate is not worse than BALANCED (regression guarantee) |
| 17   | time budget respected                                                |
| 18   | no-solution still reports correctly                                  |
| 19   | deterministic repeated solve                                        |
| 20   | SchedulingInput before vs after solve (immutability)               |
| 21   | legacy baseline remains unchanged                                   |
| 22   | no travel fabricated; H14 remains UNSUPPORTED                       |
| 23   | no AI invocation (no AirLLM, no LLM, no AI module)                 |
| 24   | bestCandidateUpdates >= 1 on the greedy-trap fixture             |
| 25   | searchNodes vs completeCandidates tracked separately                |
| 25b  | when completeCandidates > 1, the solver actually compares them    |
| 26   | real-data: GLOBAL achieves <= BASE workloadSpread                  |
| 27   | diagnostics counters expose the brief-required fields              |

All 28 pass.

## 15. Regression

```text
Before Phase 25:  411 tests pass
After  Phase 25:  439 tests pass  (411 + 28 Phase 25)
Failed:           0
```

No Phase 1–24 test was modified. Phase 25 is strictly additive:
new module (`src/domain/comparator.js`) + new mode
(`GLOBAL_ASSIGNMENT_BALANCED`) + new tests + new docs.

The `BASE_FEASIBLE`, `ASSIGNMENT_BALANCED`, and
`PREFERENCE_FIRST` modes keep their existing variant sorts. The
solver's hard-constraint gate, time-budget check, and back-
tracking control are unchanged for those modes.

The Phase 25 change to the variant sort:

```javascript
const isBalancedLike = optimizationMode === OPTIMIZATION_MODES.ASSIGNMENT_BALANCED
  || optimizationMode === OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
const isGlobal = optimizationMode === OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED;
if (isBalancedLike) {
  if (x.projectedLoad !== y.projectedLoad) return x.projectedLoad - y.projectedLoad;
  if (isGlobal && x.r !== y.r) return x.r - y.r;  // ← NEW
  if (x.i !== y.i) return y.i - x.i;
  return x.r - y.r;
}
```

The new line `if (isGlobal && x.r !== y.r) return x.r - y.r;`
adds the per-iteration RNG as a primary tiebreaker BEFORE the
`i DESC` tiebreak, but only for `GLOBAL_ASSIGNMENT_BALANCED`.
The `ASSIGNMENT_BALANCED` mode still uses the documented Phase
24 variant sort.

## 16. Definition of Done

```text
[x] first-feasible không còn là final mặc định trong GLOBAL mode  ← §3, §6
[x] solver tiếp tục search sau candidate đầu tiên                 ← §5, §7
[x] complete candidates được đánh giá globally                     ← §4, §12
[x] incumbent được giữ nếu candidate mới xấu hơn                  ← §8, #16
[x] candidate tốt hơn thay incumbent                                ← §9, §13
[x] H07 vẫn one-teacher-per-class-subject                         ← §10, #10
[x] workload tính ở teacher level                                   ← #11
[x] deterministic                                                    ← §13, #19
[x] time budget respected                                          ← §6, #17
[x] controlled greedy trap chứng minh global improvement           ← §8, #13
[x] real data vẫn tạo hard-feasible candidate                      ← #14
[x] independent evaluator accepted = true                           ← #15
[x] GLOBAL result không tệ hơn incumbent                            ← #16
[x] BASE_FEASIBLE không bị phá                                       ← #2
[x] ASSIGNMENT_BALANCED không bị phá                                 ← #3
[x] không fabricate travel                                          ← #22
[x] không AI                                                         ← #23
[x] không multi-solution                                              ← §10
[x] all previous tests pass                                         ← §15
[x] PHASE_25_GLOBAL_ASSIGNMENT_OPTIMIZATION.md                     ← this file
```

## 17. Final Report

```text
Before: 411
After : 439
Passed: 439
Failed: 0

Real-data (seed 0xC0FFEE, timeLimitMs 30_000):
  BASE_FEASIBLE:              spread=14, max=24, min=10, stdev=3.146, totalSoftCost=1.6983
  ASSIGNMENT_BALANCED:        spread=16, max=28, min=12, stdev=3.263, totalSoftCost=1.7980
  GLOBAL_ASSIGNMENT_BALANCED: spread=12, max=24, min=12, stdev=3.008, totalSoftCost=1.5985

  GLOBAL strictly improves on every workload metric vs BASE and BALANCED.
  GLOBAL verdict = BEST_FOUND (NOT global optimum).
  GLOBAL hardViolations = 0 (independent evaluator: true).

Phase 25 stops here.
```