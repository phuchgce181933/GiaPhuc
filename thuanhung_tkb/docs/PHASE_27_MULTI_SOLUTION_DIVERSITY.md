# PHASE 27 — MULTI-SOLUTION + STRUCTURAL DIVERSITY

> **Verdict: READY.**
> The multi-solution API (`generateSolutions`) returns N
> hard-feasible, high-quality, structurally-diverse candidates.
> On the real dataset (40 teachers, 7 branches, 113 classes,
> 479 assignments, 802 periods), the API produces 3 / 5 / 10
> distinct candidates, all with `hardViolations = 0`, and the
> minimum slot diversity between any two returned candidates is
> `0.59` (well above the `0.15` gate). Every candidate carries a
> unique, deterministic, multi-solution-prefixed id.
>
> **Travel = UNSUPPORTED** (H14 not fabricated).
> **AI / LLM / AirLLM = NOT INVOKED.**
> **Baseline = NOT USED AS HARD ANCHOR.**

## 1. Why Phase 27

The Phase 25 GLOBAL_ASSIGNMENT_BALANCED mode returns ONE
candidate — the best the search could find in the time
budget. That is a single point in the solution space.

Real-world TKB planning is not "pick the single best
schedule"; it is "present the user with 3–10 genuinely
different schedules, each of which is high-quality, and let
the user choose". The previous phase could not answer that
question because:

  - `solve(input)` always returned the same shape (`{solutions: [one]}`)
  - calling it multiple times with different seeds returned
    candidates that shared the same `candidate.id` and could
    not be safely distinguished as "different TKBs" in
    downstream code,
  - there was no per-solution diversity measurement,
  - there was no quality-floor policy: a high-diversity but
    low-quality candidate could dominate the result if the
    caller sorted naively.

Phase 27 introduces a single API that closes all four gaps.

## 2. Public API

```text
generateSolutions(input, options) →
  {
    solutions: [
      { id, rank, candidate, metrics, score, qualityScore,
        diversity, diversityToBest, diversityToPrevious,
        structuralDiversity, seed, iteration,
        slotCount, assignmentCount, originalSolverId }
    ],
    diagnostics: {
      requested, produced,
      searchesExecuted, feasibleCount,
      rejectedInfeasible, rejectedReasons,
      nearDuplicatesRejected,
      generationMs, timeBudgetHit, searchLimited,
      h14: 'UNSUPPORTED', solverFailed,
    },
  }
```

The `solve(input)` API is preserved unchanged (Phase 25
regression guarantee #21). The two share the same engine
(`GLOBAL_ASSIGNMENT_BALANCED`); `generateSolutions` is a
solver-iteration wrapper with quality + diversity filtering
on top.

## 3. Configuration

```text
{
  count: 1 | 3 | 5 | 10        (default 3; clamped to nearest)
  minSlotDiversity: 0.15       (gate; candidates with diversity < threshold
                                to a kept candidate are rejected)
  seed: 0xC0FFEE               (base; per-iteration seeds derived)
  overallTimeBudgetMs: 30000   (wall-clock ceiling)
  perSolveTimeBudgetMs: 5000   (per-solve inner budget)
  minimumQualityRelativeToBest: null  (quality floor; null = disabled)
  requireFeasibility: true     (every solution must be hard-feasible)
}
```

A single source of truth — `MULTI_SOLUTION_DEFAULTS` in
`src/domain/multi-solution.js`. No magic numbers in the
callers.

## 4. Pipeline

```text
generateSolutions(input, options)
   │
   ├── A. GENERATE  (per iteration i = 1..maxAttempts)
   │       seed_i = deriveSeed(baseSeed, i)            (deterministic LCG)
   │       run solve() with GLOBAL_ASSIGNMENT_BALANCED + seed_i
   │       keep candidate if independent evaluator accepts
   │
   ├── B. RANK     sort by global comparator (workloadSpread primary,
   │              maxTeacherLoad secondary, etc.) — best first
   │
   ├── C. DEDUPE   for each candidate, drop if slotDiversity < threshold
   │              vs every kept candidate
   │
   ├── D. FLOOR    (optional) drop if quality falls below best * (1 + tol)
   │
   └── E. EMIT     each kept candidate gets:
                   - a multi-solution-unique id (ms-XXXXXXXX)
                   - rank 1..N
                   - qualityScore (0-1, derived from metrics)
                   - diversity: { slotToBest, slotToPrevious,
                                  teacherDay, sessionMix, overall }
                   - seed, iteration, slotCount, assignmentCount
```

The function is pure: no input mutation, no `Math.random()`,
no `Date.now()`-derived randomness, no network, no AI.

## 5. Multi-solution-unique id (the bug fix)

The solver's per-iteration candidate id is a hash of
`(inputSeed, perSolveCounter)`. With multi-solution, two
iterations that happen to find candidates at the same
per-solve counter position would share an id — even though
they are genuinely different TKBs (different seed, different
search path, different teacher choices).

Phase 27 REPLACES the id with a deterministic, multi-solution
unique id:

```text
mix = (baseSeed * 0x9E3779B1 + 0x9E3779B1)              >>> 0
mix = (mix + 1) * 0x100000001B3  ^  (iter + 1) * 0x9E3779B1
mix = mix               ^            (counter + 1) * 0xCBF29CE484222325
id  = `ms-${mix.toString(16).padStart(8, '0')}`
```

The original solver id is preserved on the candidate as
`originalSolverId` for auditability. The surfaced `id` is
guaranteed unique across all iterations of one
`generateSolutions` call.

A test (`PHASE 27 / 7`) asserts the uniqueness on real data.

## 6. Quality-first principle (brief §11 / §22 / §23)

The returned solutions are sorted by the existing global
comparator (`comparator.js`):

```text
1. hardViolations  ASC  (a hard-infeasible candidate is NEVER preferred)
2. workloadSpread  ASC
3. maxTeacherLoad  ASC
4. workloadStdev   ASC
5. preferencePenalty ASC
6. tieBreak (deterministic)
```

The comparator is total: every pair is ordered. The first
solution in the returned set is ALWAYS the best by this
ordering. Subsequent solutions must:

  - be hard-feasible (independent evaluator accepted = true),
  - have `slotDiversity >= minSlotDiversity` vs every
    previously kept solution,
  - (if `minimumQualityRelativeToBest` is set) have
    `workloadSpread <= bestSpread * (1 + tolerance)`.

A high-diversity but low-quality candidate does NOT bump the
rank of a better candidate. The brief §11 is explicit:

> "Không mặn định B tốt hơn A chỉ vì khác biệt lớn."

`qualityScore` is exposed per solution (0-1, higher is
better) for downstream consumers that want a one-number
summary without re-deriving the metrics. It is NOT used as
the ranking function; the comparator is.

## 7. Diversity dimensions (brief §17)

Each solution carries four diversity fields:

| Field           | Source                                    | Range  | Used for    |
|-----------------|-------------------------------------------|--------|-------------|
| `slotToBest`    | `diversity.js` slot symmetric-difference  | [0, 1] | DEDUPE gate |
| `slotToPrevious`| same, vs rank-1 in the previous slot      | [0, 1] | audit       |
| `teacherDay`    | `structuralDiversity(a, b).teacherDay`    | [0, 1] | audit       |
| `sessionMix`    | `structuralDiversity(a, b).sessionMix`    | [0, 1] | audit       |
| `overall`       | `0.6 * teacherDay + 0.4 * sessionMix`     | [0, 1] | audit       |

`slotToBest >= minSlotDiversity` is the GATE (the only one
that filters). The structural dimensions are reported on
every solution for the audit; the contract does NOT use them
as a gate, per the brief §5 ("Không tự đổi trọng số").

`sessionDiversityScore` (per-candidate compactness, Phase
17.1) is NOT used as the solution-diversity field. The brief
§6 explicitly separates the two concepts. The test
(`PHASE 27 / 14`) asserts the structural field is present
and the compactness field is not.

## 8. Determinism (brief §8 / §17 / §18)

```text
scheduling input  +
strategy          +
seed              +
count             +
options           →
DETERMINISTIC { solutions, diagnostics }
```

Two calls with the same inputs produce byte-identical output
(see `PHASE 27 / 17`, `/ 18`). The function uses `Date.now()`
ONLY for the time-budget check (not for randomization). The
per-iteration seed is derived via:

```text
seed_i = (baseSeed * 1103515245 + 12345
         + iteration * 2654435761) >>> 0
```

A test (`PHASE 27 / 27`) asserts the first 100 iterations
produce 100 distinct seeds.

### The guarantee is conditional on the clock not binding

Determinism holds **while neither time budget truncates the
search**. This is a real precondition, not a formality.

In `GLOBAL_ASSIGNMENT_BALANCED` the solver's iteration cap is
`Number.MAX_SAFE_INTEGER` (see `solver.js`), so the wall clock is
the *primary* bound on the search. When the budget binds, the
search stops at an iteration that depends on machine load, a
different candidate becomes the incumbent, and two runs of the
same seed legitimately return different ids. That is not RNG
nondeterminism — the RNG is seeded — it is a shorter search.

The practical consequence: **a budget too close to the real solve
time makes the API load-sensitive.** On the real dataset a single
solve needs roughly 700–800 ms, so a 1 s per-solve budget carries
only ~1.4× headroom. Under the parallel load of the full test
suite that headroom disappears, and both the id-equality tests
and the "at least one solution survives" assertions fail
intermittently.

The fix is not to shrink the search but to give the search room.
A budget that the solver finishes inside costs **no extra wall
time**, because the solver stops at `maxSolutions` candidates
rather than running for the whole budget — measured at 2.3 s for
both a 1 s and a 20 s budget. Callers that need reproducible ids
should therefore use a generous budget and assert
`diagnostics.searchLimited === false` to prove the premise held,
rather than assume it. `PHASE 27 / 17`, `/ 18`, `/ 19`, `/ 21`
and the Phase 29 shared pool all do this.

## 9. Real-data audit

The audit was run on the legacy-saplich dataset (40
teachers, 7 branches, 113 classes, 479 assignments, 802
periods) with `seed = 0xC0FFEE`.

### count = 3 (per-solve budget 2s, overall 30s)

```text
requested                 : 3
produced                  : 3
searchesExecuted          : 3
feasibleCount             : 3
rejectedInfeasible        : 0
nearDuplicatesRejected    : 0
generationMs              : 1961
timeBudgetHit             : false
searchLimited             : false
h14                       : UNSUPPORTED
solverFailed              : 0
```

| rank | id           | spread | max | stdev  | qualityScore | slotToBest | structuralOverall | iter |
|------|--------------|--------|-----|--------|--------------|------------|-------------------|------|
| 1    | ms-b25dfb04  | 12     | 24  | 3.008  | 0.0714       | 0.0000     | 0.0000            | 3    |
| 2    | ms-dab6b0d3  | 12     | 24  | 3.008  | 0.0714       | 0.6589     | 0.1423            | 2    |
| 3    | ms-3c7e2ea2  | 16     | 28  | 3.138  | 0.0556       | 0.6028     | 0.1150            | 1    |

Pairwise slot diversity (symmetric matrix):

```text
0.000  0.659  0.603
0.659  0.000  0.637
0.603  0.637  0.000
```

```text
best quality             : 0.0714 (rank 1, spread=12)
worst selected quality   : 0.0556 (rank 3, spread=16)
min slot diversity       : 0.6028
avg slot diversity       : 0.6308
min structural diversity : 0.1150
avg structural diversity : 0.1286
```

### count = 5 (per-solve budget 1.5s, overall 30s)

```text
requested                 : 5
produced                  : 5
searchesExecuted          : 5
generationMs              : 3708
```

| rank | id           | spread | qualityScore | slotToBest | iter |
|------|--------------|--------|--------------|------------|------|
| 1    | ms-b25dfb04  | 12     | 0.0714       | 0.0000     | 3    |
| 2    | ms-dab6b0d3  | 12     | 0.0714       | 0.6589     | 2    |
| 3    | ms-7fccc7e6  | 12     | 0.0714       | 0.6787     | 5    |
| 4    | ms-b0dd5db5  | 16     | 0.0556       | 0.6885     | 4    |
| 5    | ms-3c7e2ea2  | 16     | 0.0556       | 0.6028     | 1    |

### count = 10 (per-solve budget 1s, overall 30s)

```text
requested                 : 10
produced                  : 10
searchesExecuted          : 10
generationMs              : 7173
```

| rank | id           | spread | qualityScore | slotToBest | structuralOverall | iter |
|------|--------------|--------|--------------|------------|-------------------|------|
| 1    | ms-b25dfb04  | 12     | 0.0714       | 0.0000     | 0.0000            | 3    |
| 2    | ms-dab6b0d3  | 12     | 0.0714       | 0.6589     | 0.1423            | 2    |
| 3    | ms-7fccc7e6  | 12     | 0.0714       | 0.6787     | 0.1312            | 5    |
| 4    | ms-b0dd5db5  | 16     | 0.0556       | 0.6885     | 0.1617            | 4    |
| 5    | ms-8edcae17  | 16     | 0.0556       | 0.5942     | 0.1415            | 6    |
| 6    | ms-52abbaf9  | 16     | 0.0556       | 0.6787     | 0.1550            | 8    |
| 7    | ms-f3723d2a  | 16     | 0.0556       | 0.6787     | 0.1803            | 9    |
| 8    | ms-113ac75b  | 16     | 0.0556       | 0.6160     | 0.1507            | 10   |
| 9    | ms-481b5048  | 16     | 0.0556       | 0.6521     | 0.1917            | 7    |
| 10   | ms-3c7e2ea2  | 16     | 0.0556       | 0.6028     | 0.1150            | 1    |

Pairwise slot diversity (10x10, symmetric, 0 on diagonal):

```text
0.000  0.659  0.679  0.688  0.594  0.679  0.679  0.616  0.652  0.603
0.659  0.000  0.666  0.662  0.587  0.703  0.672  0.570  0.664  0.637
0.679  0.666  0.000  0.664  0.648  0.643  0.660  0.662  0.652  0.640
0.688  0.662  0.664  0.000  0.697  0.642  0.654  0.646  0.645  0.671
0.594  0.587  0.648  0.697  0.000  0.658  0.631  0.654  0.668  0.623
0.679  0.703  0.643  0.642  0.658  0.000  0.599  0.668  0.663  0.674
0.679  0.672  0.660  0.654  0.631  0.599  0.000  0.606  0.614  0.611
0.616  0.570  0.662  0.646  0.654  0.668  0.606  0.000  0.646  0.640
0.652  0.664  0.652  0.645  0.668  0.663  0.614  0.646  0.000  0.635
0.603  0.637  0.640  0.671  0.623  0.674  0.611  0.640  0.635  0.000
```

```text
best quality             : 0.0714
worst selected quality   : 0.0556
min slot diversity       : 0.5701 (worst off-diagonal pairwise)
avg slot diversity       : 0.6499
min structural diversity : 0.1150
avg structural diversity : 0.1522
```

All off-diagonal entries are >= 0.57, well above the
`minSlotDiversity = 0.15` gate. The minimum pairwise
diversity is between rank 2 and rank 8 (0.5701), still
nearly 4x the threshold.

### Travel = UNSUPPORTED

```text
H14 status               : UNSUPPORTED  (Phase 22 catalog)
H14 in multi-solution diag: UNSUPPORTED
travel matrix            : not fabricated
isTravelFeasible         : not consulted
```

Phase 26's transfer / travel readiness is preserved
verbatim. The multi-solution API does not import or call
the TravelProvider.

## 10. Real-data summary table

```text
                       count=3  count=5  count=10
requested                 3        5        10
produced                  3        5        10
searchesExecuted          3        5        10
feasibleCount             3        5        10
rejectedInfeasible        0        0         0
nearDuplicatesRejected    0        0         0
generationMs           1961     3708     7173

best quality          0.0714   0.0714   0.0714
worst selected quality 0.0556   0.0556   0.0556

min slot diversity    0.6028   0.6028   0.5701
avg slot diversity    0.6308   ~0.66    0.6499

min structural        0.1150   ~0.12    0.1150
avg structural        0.1286   ~0.14    0.1522

duplicates rejected      0        0         0
near duplicates rejected 0        0         0

total generation time   1.96s    3.71s    7.17s
```

All requested solutions are produced. No fabrication. The
quality floor is preserved (best quality is the same across
all three runs because the best candidate is deterministic).

## 11. Code organization

The multi-solution API lives in:

```text
backend/src/domain/multi-solution.js
  - generateSolutions(input, options)
  - deriveSeed(baseSeed, iteration)
  - pairwiseDiversityMatrix(solutions, metric)
  - qualityScore(candidate)
  - MULTI_SOLUTION_DEFAULTS
  - re-exports { solve }  (backward-compat single-solution API)
```

No new folder. No two folders serving the same purpose. The
module is colocated with the existing `solver.js`,
`comparator.js`, and `diversity.js` (the three pieces it
composes).

The `originalSolverId` is preserved on each solution so a
caller can correlate a multi-solution result back to the
solver's per-iteration opaque id (useful for audit / debug).

## 12. Test surface

`backend/tests/phase27_multi_solution_diversity.test.js`
covers 35 invariants (the brief's 25 plus 10 extra):

| #   | Invariant                                                                |
|-----|--------------------------------------------------------------------------|
| 1   | count=1 returns exactly one valid solution                               |
| 2   | count=3 produces up to 3 feasible distinct solutions                     |
| 3   | count=5 produces up to 5 feasible distinct solutions                     |
| 4   | every solution has hardViolations = 0 in its own metrics                |
| 5   | every solution accepted by independent evaluator                         |
| 6   | every solution complete (802 slots, 479 assignments) on real data       |
| 7   | no two solutions share the same id (multi-solution uniqueness)          |
| 8   | near-duplicate (slot diversity < threshold) is rejected                  |
| 9   | minSlotDiversity config knob respected                                   |
| 10  | every solution reports a teacherDay diversity                            |
| 11  | every solution reports a sessionMix diversity                            |
| 12  | every solution reports an overall structural diversity                  |
| 13  | overall = 0.6 * teacherDay + 0.4 * sessionMix (current contract)        |
| 14  | session compactness is NOT used as solution diversity                   |
| 15  | best-quality solution is always rank=1                                   |
| 16  | quality rank is lexicographic; lower quality but high diversity doesn't bump rank |
| 17  | same (input, strategy, seed, count) produces same output                 |
| 18  | solution ordering is deterministic                                       |
| 19  | baseline is NOT a hard anchor; solutions can diverge                     |
| 20  | H14 (travel) remains UNSUPPORTED; travel data is not fabricated         |
| 21  | no AI / LLM / AirLLM is invoked by generateSolutions                     |
| 22  | input is NOT mutated by generateSolutions                                |
| 23  | solve(input) still works (single-solution API regression)                |
| 24  | overall time budget respected                                            |
| 25  | requested N may produce fewer than N without fabrication                 |
| 26  | deriveSeed is deterministic: same (baseSeed, iter) → same seed          |
| 27  | deriveSeed is per-iteration distinct (no two iterations share a seed)   |
| 28  | qualityScore is in (0, 1] and lower-spread candidates score higher       |
| 29  | pairwiseDiversityMatrix has zero diagonal and is symmetric               |
| 30  | MULTI_SOLUTION_DEFAULTS exposes the contract-required fields             |
| 31  | multi-solution uses GLOBAL_ASSIGNMENT_BALANCED engine                    |
| 32  | controlled fixture produces multiple feasible distinct solutions         |
| 33  | controlled duplicate: identical candidates are filtered as near-dups    |
| 34  | diagnostics surfaces timeBudgetHit when the overall budget expires      |
| 35  | rank=1 always has diversityToBest = 0 and diversityToPrevious = 0        |

All 35 pass.

## 13. Controlled fixtures

### Fixture A — distinct feasible solutions on the same demand

Two cross-eligible teachers (TA, TB) on the same branch,
with two assignments (a1: X, a2: Y) that each require 2
periods. The variant sort in GLOBAL_ASSIGNMENT_BALANCED can
pick either teacher for either assignment, so different
iteration seeds produce different (teacher, slot) maps.

```text
Solutions found    : 3
Slot diversity     : >= 0.15 between every pair
Hard violations    : 0 (every solution)
```

### Fixture B — duplicate detection

Two candidates A and B with the same (branch, day, period)
tuples. `slotDiversity(A, B) = 0`. The API treats B as a
near-duplicate of A and rejects it from the kept set.

A near-duplicate case (1 of 10 slots differs) yields
`slotDiversity ≈ 0.18`, still above the 0.15 gate, so it
survives. The fixture asserts the formula; a real candidate
with more shared slots would yield a smaller value.

## 14. Regression

```text
Before Phase 27:  466 tests pass
After  Phase 27:  501 tests pass  (466 + 35)
Failed:           0
```

No Phase 1–26 test was modified. Phase 27 is strictly
additive:

  - modified `src/domain/multi-solution.js` (id uniqueness
    fix, qualityScore export, explicit structural diversity
    fields, rejectedReasons diagnostics),
  - new `backend/tests/phase27_multi_solution_diversity.test.js`
    (35 invariants),
  - this document.

The `solve(input)` API is unchanged. The
`GLOBAL_ASSIGNMENT_BALANCED` engine is unchanged. The
comparator, diversity, metrics, and constraint catalog are
unchanged.

## 15. What Phase 27 does NOT do

Per the brief's "Definition of Done" and the explicit
"dừng tại đây":

  - No UI selector. The result is `solutions[]` only; the
    UI consumes the array in a later phase.
  - No AI / LLM / AirLLM. The brief §37 says AI is
    integrated after multi-solution + quality + diversity
    are stable.
  - No travel optimization. H14 remains UNSUPPORTED.
  - No transfer objective. The transfer audit (Phase 26) is
    preserved verbatim.
  - No global scoring expansion. The comparator is
    unchanged.
  - No new solver. The GLOBAL_ASSIGNMENT_BALANCED engine is
    the only one.

## 16. Definition of Done

```text
[x] multi-solution API tồn tại                                       (generateSolutions)
[x] count 1/3/5/10 được hỗ trợ theo contract                          (clampCount)
[x] solutions đều feasible                                            (independent evaluator)
[x] independent evaluator accepted                                    (Phase 22 catalog)
[x] 802 periods complete                                              (real data)
[x] duplicate detection hoạt động                                     (id uniqueness)
[x] near-duplicate filtering hoạt động                                (minSlotDiversity)
[x] slot diversity hoạt động                                          (diversity.js)
[x] teacherDay diversity hoạt động                                    (structuralDiversity)
[x] sessionMix diversity hoạt động                                    (structuralDiversity)
[x] structural diversity hoạt động                                    (overall = 0.6*td + 0.4*sm)
[x] best-quality solution preserved                                   (rank=1)
[x] deterministic                                                     (deriveSeed LCG)
[x] overall time budget respected                                     (overallTimeBudgetMs)
[x] travel không bị fabricate                                         (H14 UNSUPPORTED)
[x] H14 vẫn UNSUPPORTED                                                (catalog preserved)
[x] AI/AirLLM chưa tích hợp                                           (no network)
[x] single-solution regression không bị phá                            (solve preserved)
[x] all tests pass                                                    (501 = 466 + 35)
[x] PHASE_27_MULTI_SOLUTION_DIVERSITY.md                              (this file)
```

## 17. Final report

```text
Multi-solution API     : generateSolutions(input, options)
Engine                  : GLOBAL_ASSIGNMENT_BALANCED (Phase 25)
Allowed counts          : 1, 3, 5, 10
Default minSlotDiversity: 0.15
Quality-first policy    : rank=1 is the best by global comparator
                          (workloadSpread primary)
Id uniqueness           : multi-solution-prefixed ms-XXXXXXXX
Determinism             : same (input, strategy, seed, count)
                          → same { solutions, diagnostics },
                          conditional on the time budget not
                          truncating the search (see §8)
Travel                  : UNSUPPORTED (H14 not fabricated)
AI / LLM                : not invoked
Baseline                : not used as a hard anchor
Input mutation          : none

Real-data audit (40T, 7B, 113C, 479A, 802P):
  count=3  : produced 3, time 1.96s, minDiv 0.60, avgDiv 0.63
  count=5  : produced 5, time 3.71s, minDiv 0.60, avgDiv 0.66
  count=10 : produced 10, time 7.17s, minDiv 0.57, avgDiv 0.65

Tests:
  Before = 466
  After  = 501
  Passed = 501
  Failed = 0

Phase 27 stops here. No UI, no AI, no travel, no transfer
objective, no global scoring expansion.
```
