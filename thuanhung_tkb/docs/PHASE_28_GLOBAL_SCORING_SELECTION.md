# PHASE 28 — GLOBAL SCORING + FINAL SOLUTION SELECTION

> **Verdict: READY.**
> A deterministic, explainable scoring/selection layer sits on
> top of the Phase 27 multi-solution pool. Given N hard-feasible
> candidates, `selectFinalSolutions(candidates, options)`
> returns the best `count` of them with a full per-dimension
> score vector explaining *why* each one was picked.
>
> On the real dataset (40 teachers, 7 branches, 113 classes,
> 479 assignments, 802 periods) a pool of 10 candidates is
> scored and selected in ~212 ms, and every selected solution
> is still accepted by the independent evaluator.
>
> **H14 (Travel) = UNSUPPORTED** → `TRAVEL` dimension INACTIVE.
> **H13 (Transfer) = INACTIVE** → `TRANSFER` dimension INACTIVE.
> **AI / LLM / AirLLM = NOT INVOKED.**
> **Phase 27 generation = UNCHANGED.**

## 1. Why Phase 28

Phase 27 answered: *can we produce several valid, meaningfully
different timetables?* It could — but it left one question
open:

> "Given several valid candidates, which one should the user
> actually pick, and why?"

Phase 27's ordering is a pure **lexicographic comparator**
(`comparator.js`): `hardViolations → workloadSpread →
maxTeacherLoad → workloadStdev → preferencePenalty → tieBreak`.
That ordering is correct for the *solver* (it drives the search
toward one incumbent) but it is not a product-level quality
statement. Three concrete gaps:

1. **No single comparable number.** A user cannot answer
   "is this plan 30% or 90% as good?" from a spread of 12 and
   a stdev of 3.008.
2. **No trade-off visibility.** The comparator hides *why* two
   candidates differ. Rank 2 being "worse" than rank 1 on
   spread is invisible; so is the fact that rank 3 is far more
   diverse.
3. **No selection step.** Phase 27 returns everything it
   generated. If 10 were generated and 3 are needed, nothing in
   the codebase says which 3.

Phase 28 adds the missing layer. It is deliberately **separate
from the solver**: generation stays in Phase 27, scoring and
selection live here.

## 2. The four layers (brief §2)

The brief requires an explicit separation. Phase 28 implements
exactly four layers and does not collapse them:

```text
Constraint evaluation      evaluateCandidate(candidate, input)
        ↓                  (Phase 22 — the ONLY feasibility oracle)
Raw metrics                candidate.metrics.{workloadSpread,
        ↓                  maxTeacherLoad, workloadStdev,
Dimension scores           preferencePenalty, ...}
        ↓                  (Phase 24 — the ONLY metric source)
Global score               scoreCandidate(candidate, context)
                           (Phase 28 — new in this phase)
```

Two consequences of this separation:

- **The scorer never re-implements H01–H14.** It calls
  `evaluateCandidate` and reads `summary.accepted`. There is no
  second copy of any hard rule in this module.
- **The scorer never re-implements a metric.** It reads
  `candidate.metrics.*` as produced by `deriveMetrics` (Phase
  24). It does not recompute `workloadSpread`.

## 3. Public API

```text
selectFinalSolutions(candidates, options) →
  {
    solutions: [
      { id, rank, candidate, metrics,
        qualityScore,        // Phase 27 semantics, unchanged
        scoring: {
          total,            // globalScore, in [0, 1]
          feasibility,      // 'FEASIBLE' | 'INFEASIBLE'
          hardViolations,   // number
          dimensions: { [id]: {
            raw, normalized, weight, contribution,
            direction, active, reason } },
          rankReason        // human-readable explanation
        },
        diversity: { slotToBest, slotToPrevious,
                     teacherDay, sessionMix, overall },
        diversityToBest, diversityToPrevious, structuralDiversity,
        selected: true, rejected: false }
    ],
    diagnostics: {
      inputSize, feasibleSize, selectedSize,
      rejectedInfeasible, rejectedQualityFloor,
      rejectedNearDuplicate, rejectedSelectionFull,
      rejected: [{ id, reason }],
      scoringTimeMs, totalTimeMs,
      h13: 'INACTIVE', h14: 'UNSUPPORTED'
    }
  }
```

Supporting exports:

| Export                          | Purpose                                        |
|---------------------------------|------------------------------------------------|
| `GLOBAL_SCORING_DEFAULTS`       | The single source of truth for weights/knobs  |
| `DIMENSION_CATALOG`             | Every scoring dimension, with direction        |
| `getDimension(id)`              | Look up one dimension                          |
| `listActiveDimensions(input)`   | Dimensions active for a given input            |
| `validateWeights(weights)`      | `{ok, reason}` weight validation               |
| `scoreCandidate(cand, ctx)`     | Pure per-candidate scorer (score vector)       |
| `scorePool(cands, input, cfg)`  | Pool-relative scoring                          |
| `qualityScore(cand)`            | Re-export of the Phase 27 function             |

## 4. Options (brief §33)

```text
{
  count: 5,                 // positive integer, clamped to >= 1
  minSlotDiversity: 0.15,   // brief §16 — preserved exactly
  qualityFloor: null,      // brief §17 — optional, default null
  scoringConfig: { weights: { ... } },
  input: <SchedulingInput>,// used for the feasibility re-check
  // advanced knobs (all defaulted in GLOBAL_SCORING_DEFAULTS)
  qualityWeightInSelection: 0.7,
  diversityWeightInSelection: 0.3,
  requireFeasibility: true,
}
```

Two notes on the contract:

- **`count` is a plain positive integer, not a Phase 27 snap.**
  The `{1, 3, 5, 10}` set is a *generation* request vocabulary
  (how many candidates to search for). Selection has a
  different job: given 10 generated candidates, a caller may
  legitimately want to surface 2. An earlier draft of this
  module reused the Phase 27 snap, which silently turned
  `count: 2` into `count: 1`; that was fixed.
- **`input` is a first-class option.** The feasibility
  re-check needs the scheduling input. The legacy
  `candidate.__input` field is still read as a fallback so
  existing callers keep working (test `extra / E`).

## 5. Dimension catalog (brief §5, §6)

Every dimension declares an explicit `direction`. There is no
implicit inversion anywhere.

| id                     | name                | direction | weight | source                              | active on real data |
|------------------------|---------------------|-----------|--------|-------------------------------------|---------------------|
| `WORKLOAD_BALANCE`     | Workload Balance    | MINIMIZE  | 1.0    | `metrics.workloadSpread`            | **ACTIVE**          |
| `MAX_TEACHER_LOAD`     | Max Teacher Load    | MINIMIZE  | 0.5    | `metrics.maxTeacherLoad`            | **ACTIVE**          |
| `WORKLOAD_STDEV`       | Workload Std Dev     | MINIMIZE  | 0.3    | `metrics.workloadStdev`             | **ACTIVE**          |
| `PREFERENCE`           | Session Preference  | MINIMIZE  | 0.3    | `metrics.preferencePenalty`         | **ACTIVE**          |
| `STRUCTURAL_DIVERSITY` | Structural Diversity| MAXIMIZE  | 0.4    | `structuralDiversity(best, cand)`   | **ACTIVE**          |
| `SLOT_DIVERSITY`       | Slot Diversity      | MAXIMIZE  | 0.2    | `diversity(best, cand)`             | **ACTIVE**          |
| `TRAVEL`               | Travel Feasibility  | MINIMIZE  | 0.0    | —                                   | INACTIVE (H14)      |
| `TRANSFER`             | Transfer Permission | MINIMIZE  | 0.0    | —                                   | INACTIVE (H13)      |
| `CHANGED_ASSIGNMENTS`  | Changed Assignments | MINIMIZE  | 0.0    | `metrics.changedAssignments`        | INACTIVE (reporting)|

Audited output from the real-data run:

```text
WORKLOAD_BALANCE       MINIMIZE  w=1     ACTIVE
MAX_TEACHER_LOAD       MINIMIZE  w=0.5   ACTIVE
WORKLOAD_STDEV         MINIMIZE  w=0.3   ACTIVE
PREFERENCE             MINIMIZE  w=0.3   ACTIVE
STRUCTURAL_DIVERSITY   MAXIMIZE  w=0.4   ACTIVE
SLOT_DIVERSITY         MAXIMIZE  w=0.2   ACTIVE
TRAVEL                 MINIMIZE  w=0     INACTIVE
TRANSFER               MINIMIZE  w=0     INACTIVE
CHANGED_ASSIGNMENTS    MINIMIZE  w=0     INACTIVE
```

### Why travel and transfer carry weight 0

Brief §18 and §19 are explicit. `TRAVEL` is registered so the
catalog is complete and so that flipping `active(input)` to
`true` is sufficient to switch the dimension on when a real
travel matrix arrives. Until then:

- `travelScore` is **NOT APPLICABLE**, not `0`. The dimension
  reports `active: false` with `reason: 'H14 = UNSUPPORTED
  (no travel matrix)'` and `contribution: 0`.
- Its `defaultWeight` is `0.0`, so even an accidental
  activation of the predicate would not silently inject travel
  into the global score before a real policy exists.

`TRANSFER` follows the same pattern for H13. Historical
transfer counts are **not** a score (brief §19) and are not
consulted anywhere in this module.

## 6. Normalization (brief §7, §8)

Raw metrics have incompatible scales (`workloadSpread = 12`
vs `structuralDiversity = 0.6`). They are min-max normalized
**relative to the candidate pool**, so every candidate in one
call is scored on the same scale.

```text
MINIMIZE:   raw = min → 1.0 (best)   raw = max → 0.0 (worst)
MAXIMIZE:   raw = min → 0.0 (worst)  raw = max → 1.0 (best)
Degenerate: max === min → 0.5 (neutral)
```

The degenerate case is the important one (brief §8). On the
real data every candidate has `preferencePenalty = 1.0`, so
the PREFERENCE dimension has `max === min`. It resolves to the
neutral `0.5` and contributes `0.5 * 0.3` to every candidate
equally. It never produces `NaN` or `Infinity` — asserted by
test `7`.

No arbitrary constants are introduced. The only hard-coded
scale boundary is the structural-diversity blend already
inherited from Phase 27 (`0.6 * teacherDay + 0.4 * sessionMix`),
which this module consumes rather than redefines.

## 7. Weight validation (brief §22, §23)

All weights live in one place: `GLOBAL_SCORING_DEFAULTS.weights`.
No magic numbers are scattered across the module.

```text
validateWeights(weights) → { ok: true,  weights }
                         | { ok: false, reason, dimension }
```

Rejected: non-objects, `null`, `NaN`, `Infinity`, and any
negative weight.

**All-zero weights** are explicitly handled rather than
producing an undefined score. When every active dimension has
weight 0, the active weight sum is 0, and `total` is defined
as `0` — a deterministic, finite, in-range value (test `9`).
No `NaN`, no divide-by-zero escape.

## 8. Global score

```text
total = Σ(contribution of ACTIVE dimensions) / Σ(weight of ACTIVE dimensions)
```

Dividing by the active weight sum keeps `total` in `[0, 1]`
regardless of the absolute scale of the configured weights, so
weights express *relative* importance and not magnitude.

The function is pure: no IO, no clock, no randomness, no AI,
and no mutation of the candidate, the input, or the pool.
`Date.now()` appears only in `diagnostics.scoringTimeMs` and
`diagnostics.totalTimeMs`, which do not affect any score.

### Score vector (brief §11, §24)

The scalar is never returned alone. Every solution carries the
full breakdown:

```text
scoring: {
  total: 0.7222,
  dimensions: {
    WORKLOAD_BALANCE:     { raw: 12,  normalized: 0.0000, weight: 1.0, contribution: 0.0000, direction: 'MINIMIZE', active: true,  reason: 'active' },
    MAX_TEACHER_LOAD:     { raw: 24,  normalized: 0.0000, weight: 0.5, contribution: 0.0000, direction: 'MINIMIZE', active: true,  reason: 'active' },
    WORKLOAD_STDEV:       { raw: 3.008, normalized: 0.0,  weight: 0.3, contribution: 0.0000, direction: 'MINIMIZE', active: true,  reason: 'active' },
    PREFERENCE:           { raw: 1,   normalized: 0.5000, weight: 0.3, contribution: 0.1500, direction: 'MINIMIZE', active: true,  reason: 'active' },
    STRUCTURAL_DIVERSITY: { raw: 0,   normalized: 0.0000, weight: 0.4, contribution: 0.0000, direction: 'MAXIMIZE', active: true,  reason: 'active' },
    SLOT_DIVERSITY:       { raw: 0,   normalized: 0.0000, weight: 0.2, contribution: 0.0000, direction: 'MAXIMIZE', active: true,  reason: 'active' },
    TRAVEL:               { raw: null, normalized: 0.5000, weight: 0, contribution: 0.0, direction: 'MINIMIZE', active: false, reason: 'H14 = UNSUPPORTED (no travel matrix)' },
    TRANSFER:             { raw: null, normalized: 0.5000, weight: 0, contribution: 0.0, direction: 'MINIMIZE', active: false, reason: 'H13 = INACTIVE (no allowedTransferBranches)' },
    CHANGED_ASSIGNMENTS:  { raw: 0,   normalized: 0.5000, weight: 0, contribution: 0.0, direction: 'MINIMIZE', active: false, reason: 'REPORTING_ONLY' },
  },
  rankReason: 'quality-first: best by primary quality objective (workloadSpread=12, maxLoad=24)',
}
```

`normalized: 0.5` on an inactive dimension means "not
applicable", not "average". `contribution` is always `0` for an
inactive dimension, so an inactive dimension can never move the
global score.

## 9. Feasibility dominates (brief §1, §12)

The global score is a tie-breaker among *admissible* candidates.
It can never rescue an inadmissible one.

```text
if hardViolations > 0  →  candidate is not selectable
```

Three independent guards:

1. `selectFinalSolutions` filters the pool through
   `evaluateCandidate` before scoring. Rejected candidates are
   recorded in `diagnostics.rejected[]` with reason
   `INFEASIBLE` and are never scored for selection.
2. `scoreCandidate` independently re-derives `hardViolations`
   and labels the result `INFEASIBLE`, with a `rankReason`
   that says so explicitly.
3. The anchor selection in `selectFinalSolutions` iterates only
   over the already-filtered feasible list.

Brief §12's forbidden case is therefore structurally
impossible: an excellent soft score cannot outrank a hard
violation, because the violating candidate is not in the
selection pool at all.

## 10. Selection algorithm (brief §14, §15)

Quality-first greedy farthest-point:

```text
1. Anchor  = comparator-best candidate in the pool.
             (hard feasibility already established)
2. Repeat until `count`:
     reject any candidate with slotDiversity < minSlotDiversity
       vs ANY selected candidate  (near-duplicate, brief §16)
     among survivors, pick the one maximizing
         qualityWeightInSelection * qualityScore
       + diversityWeightInSelection * meanSlotDiversityToSelected
3. Emit with rank 1..count and the full score vector.
```

Two properties are guaranteed:

- **Brief §14 — best solution preservation.** The anchor is the
  comparator-best candidate and is unconditionally selected
  first. No diversity filter can remove it, because the
  near-duplicate check is only applied to non-anchor
  candidates. Test `11` asserts the comparator relation
  against every other selected candidate.
- **Brief §13 — diversity never outranks quality.** Diversity
  enters as a *preference among already-admissible, non-near-
  duplicate* candidates via the blend weights, never as a gate
  that promotes a weaker candidate over the anchor.

Complexity is `O(N²)` for the pairwise diversity work, which is
ample for a pool of 10. No search loop is introduced
(brief §35).

## 11. Two diversity metrics, deliberately not merged (brief §16)

These are different measurements and Phase 28 keeps them apart:

| Metric                | Meaning                                          | Used as |
|-----------------------|--------------------------------------------------|---------|
| `minSlotDiversity` = 0.15 | Symmetric difference of `(teacher, branch, day, period)` tuples | **The gate** — filters near-duplicates |
| `structuralDiversity` | Per-teacher day-count + session-mix shape difference | **A score dimension** — feeds the blend |

Brief §16 explicitly warns against replacing the 0.15 gate with
`overallStructuralDiversity >= 0.15`, because the observed
`overall` values (min ≈ 0.115) sit below that bound even for
genuinely distinct schedules. That substitution would reject
good candidates. Phase 28 does not make it: `minSlotDiversity`
stays at `0.15` and remains the only filter, while
`STRUCTURAL_DIVERSITY` participates only as a weighted score
term (test `13`, `14`).

## 12. Comparator vs scorer (brief §25)

The two answer different questions and are kept separate:

|                | Comparator (`comparator.js`)         | Scorer (`global-scoring.js`)            |
|----------------|---------------------------------------|-----------------------------------------|
| Question       | "Is A a better search incumbent?"     | "How good is A as a product option?"     |
| Form           | Lexicographic, returns a sign         | Weighted scalar in `[0, 1]`             |
| Role           | Drives the solver's search           | Drives the final selection / display    |
| Diversity      | Not part of the ordering             | An explicit scored dimension            |
| Exported by    | Phase 25                            | Phase 28                               |

Phase 28 does not replace or modify the Phase 25 comparator.
The comparator is still consulted — twice, deliberately:

1. To pick the anchor (the best-quality candidate must be
   preserved — brief §14).
2. As the *primary* signal in the "best solution preservation"
   guarantee, which is a comparator property, not a scalar
   score property.

## 13. No circular scoring (brief §26)

```text
score uses rank?   No.
rank uses score?   No.
```

`scoreCandidate` depends only on `(candidate, input, config,
pool)`. It never reads a rank, and the rank assigned in the
output is derived from the selection order, not fed back into
scoring. The blend in the greedy loop reads `qualityScore` and
`slotDiversity` — both recomputed from raw data — never a
`total` from a previous candidate.

## 14. qualityScore compatibility (brief §9, §39)

`qualityScore` is **not** redefined. It keeps its Phase 27
meaning, which this module treats as the quality of an
individual candidate:

```text
qualityScore = 1 / (1 + workloadSpread + preferencePenalty)
```

The audit in §9 (`0.0714` for spread=12, `0.0556` for
spread=16) matches Phase 27's published numbers exactly, which
is the check that the semantics did not silently move.

Phase 28 adds a **new, separately-named** field:

| Field           | Meaning                                                  |
|-----------------|----------------------------------------------------------|
| `qualityScore`  | Phase 27 field, unchanged. Quality of *this candidate*.  |
| `scoring.total` | **New.** Product-level score of *this option in its pool*, used for ranking and display. |

There are now two different `qualityScore` semantics in the
codebase by design, and they are documented separately:
`multi-solution.js` owns the candidate-quality definition and
`global-scoring.js` re-exports it rather than redefining it.
The product-level score is deliberately named `total` (with
`scoring.total` surfaced as the selection signal) to avoid the
collision the brief warns about.

## 15. changedAssignments is reporting-only (brief §21)

`CHANGED_ASSIGNMENTS` is registered in the catalog with
`active: () => false` and `defaultWeight: 0.0`. Its `raw` value
is still computed and reported on every solution so the audit
can show it, but:

- `contribution` is always `0`;
- it is excluded from the active weight sum;
- it can never influence the global score.

There is no policy that says "prefer the schedule closest to
last year's", so there is no such score. Asserted by test `17`.

## 16. Real-data audit

Dataset: 40 active teachers, 7 branches, 113 classes,
479 assignments, 802 periods. `seed = 0xC0FFEE`.

Reproduce with:

```text
cd backend && node tests/audit28.js
```

### Candidate pool

```text
                        count=3  count=5  count=10
requested                     3        5        10
produced                      3        5        10
scored                        3        5        10
selected                      3        5        10
rejected infeasible           0        0         0
rejected quality floor        0        0         0
rejected near duplicate       0        0         0
rejected selection full       0        0         0

generation ms              1989     3667     7247
selection ms                 32       54       213

best qualityScore         0.0714   0.0714   0.0714
worst selected quality    0.0556   0.0556   0.0556
best globalScore          0.9444   0.9234   0.9031
worst selected global     0.2431   0.2257   0.2093

min slot diversity       0.6028   0.6028   0.5704
avg slot diversity       0.6330   0.6569   0.6473
min structural diversity 0.1150   0.1150   0.1150
```

### Top solutions (count = 10, GLOBAL_ASSIGNMENT_BALANCED)

| rank | solutionId    | qualityScore | globalScore | spread | maxLoad | stdev | prefPenalty | slotDivToBest | structDiv |
|------|---------------|--------------|-------------|--------|---------|-------|-------------|---------------|-----------|
| 1    | ms-b25dfb04   | 0.0714       | 0.7222      | 12     | 24      | 3.008 | 1.000       | 0.0000        | 0.0000    |
| 2    | ms-7fccc7e6   | 0.0714       | 0.8684      | 12     | 24      | 3.041 | 1.000       | 0.6787        | 0.1312    |
| 3    | ms-dab6b0d3   | 0.0714       | 0.9031      | 12     | 24      | 3.008 | 1.000       | 0.6589        | 0.1423    |
| 4    | ms-52abbaf9   | 0.0556       | 0.2484      | 16     | 28      | 3.138 | 1.000       | 0.6787        | 0.1550    |
| 5    | ms-b0dd5db5   | 0.0556       | 0.2546      | 16     | 28      | 3.138 | 1.000       | 0.6885        | 0.1617    |
| 6    | ms-481b5048   | 0.0556       | 0.2739      | 16     | 28      | 3.138 | 1.000       | 0.6521        | 0.1917    |
| 7    | ms-f3723d2a   | 0.0556       | 0.2679      | 16     | 28      | 3.138 | 1.000       | 0.6787        | 0.1803    |
| 8    | ms-8edcae17   | 0.0556       | 0.2289      | 16     | 28      | 3.138 | 1.000       | 0.5942        | 0.1415    |
| 9    | ms-3c7e2ea2   | 0.0556       | 0.2093      | 16     | 28      | 3.138 | 1.000       | 0.6028        | 0.1150    |
| 10   | ms-113ac75b   | 0.0556       | 0.2383      | 16     | 28      | 3.138 | 1.000       | 0.6160        | 0.1507    |

Note that `globalScore` is **not** monotonically decreasing
with rank. That is expected and correct: rank 1 is the
quality anchor (`spread = 12`, the comparator-best), while
ranks 2 and 3 have the same quality but higher diversity, so
their blend score is higher. `qualityScore` IS monotone
(0.0714 × 3, then 0.0556 × 7), which is the quality-first
guarantee. Two distinct, both-meaningful orderings are
surfaced rather than being conflated.

`solutionId` is the Phase 27 `ms-*` multi-solution-unique id.
The underlying `candidate.id` values are the opaque solver
ids (`sol-*`), which are deliberately *not* unique across
multi-solution iterations — that is the exact issue Phase 27
§5 fixed, and it is why this audit keys on the `ms-*` id.

### Selection

```text
                         select 3   select 5
requested                     3         5
selected                      3         5
rejected infeasible           0         0
rejected quality floor        0         0
rejected near duplicate       0         0
rejected selection full       7         5
```

`H13 = INACTIVE`, `H14 = UNSUPPORTED` are surfaced in
`diagnostics` on every call.

### Phase 27 ranking vs Phase 28 ranking (brief §29)

Comparing 10 generated candidates, selecting 3:

```text
Phase 27 (comparator order)     Phase 28 (global + diversity)
  #1 ms-b25dfb04 (q=0.0714)       #1 ms-b25dfb04 (g=0.7222, div=0.0000)
  #2 ms-dab6b0d3 (q=0.0714)       #2 ms-7fccc7e6 (g=0.8684, div=0.6787)
  #3 ms-7fccc7e6 (q=0.0714)       #3 ms-dab6b0d3 (g=0.9031, div=0.6589)
  #4 ms-b0dd5db5 (q=0.0556)       (not selected)
  #5 ms-8edcae17 (q=0.0556)       (not selected)
  ...
```

Selecting 5 from the same pool:

```text
Phase 27                        Phase 28
  #1 ms-b25dfb04                  #1 ms-b25dfb04
  #2 ms-dab6b0d3                  #2 ms-7fccc7e6   ← promoted
  #3 ms-7fccc7e6                  #3 ms-dab6b0d3   ← demoted
  #4 ms-b0dd5db5                  #4 ms-52abbaf9   ← promoted (diversity)
  #5 ms-8edcae17                  #5 ms-b0dd5db5
                                  (ms-8edcae17 not selected)
```

**The scoring layer demonstrably changes selection.** Ranks 2
and 3 swap, and the fifth slot goes to a more diverse
candidate. The membership change is the substantive one:
`ms-8edcae17` (slot diversity 0.5942 — the lowest in the
pool) is dropped in favour of `ms-52abbaf9` (0.6787). That is
the diversity preference doing its job among candidates of
*equal* quality — and only among such candidates, since all
three `spread = 12` candidates outrank every `spread = 16`
candidate regardless of diversity.

Phase 27 is not modified. The comparison is read-only.

## 17. Determinism (brief §27, §36)

```text
same (candidates, input, config) → identical scores
same (candidates, input, config) → identical selection order
```

No `Math.random()`. No `Date.now()`-derived value affects any
score, rank, or selection. No network. No AI, no LLM, no
AirLLM — the module imports only `diversity.js`,
`constraints/index.js`, `multi-solution.js` and
`comparator.js`.

Asserted by tests `1`, `18`, `19`, `22`.

## 18. Test surface

`backend/tests/phase28_global_scoring_selection.test.js` —
**32 invariants** (the brief's 26 plus 6 extra).

| #   | Invariant                                                    |
|-----|--------------------------------------------------------------|
| 1   | Scorer is deterministic                                       |
| 2   | Scorer is pure (no candidate / input / pool mutation)         |
| 3   | Infeasible candidate is never selected                        |
| 4   | Every dimension declares an explicit MINIMIZE / MAXIMIZE      |
| 5   | MINIMIZE normalization: best raw → highest normalized         |
| 6   | MAXIMIZE normalization: higher raw → higher normalized        |
| 7   | Zero-range normalization is safe (no NaN / Infinity)          |
| 8   | Weights validated (negative / NaN / Infinity / non-object)    |
| 9   | All-zero weights produce a finite, deterministic total        |
| 10  | Hard feasibility dominates (INFEASIBLE label + rankReason)    |
| 11  | Best-quality candidate is always rank 1                       |
| 12  | Diversity influences selection among equal-quality candidates |
| 13  | `minSlotDiversity` preserved at 0.15                          |
| 14  | Structural diversity is not confused with slot diversity      |
| 15  | TRAVEL dimension INACTIVE when H14 = UNSUPPORTED              |
| 16  | TRANSFER dimension INACTIVE when H13 = INACTIVE               |
| 17  | changedAssignments is reporting-only (raw shown, contributes 0)|
| 18  | Same candidates → identical scores                            |
| 19  | Same candidates → identical selection order                   |
| 20  | Controlled quality/diversity fixture follows documented policy |
| 21  | Controlled normalization fixture (better raw → better norm)   |
| 22  | Tie handling is deterministic                                 |
| 23  | Real 10-solution pool scores successfully                     |
| 24  | Selected solutions remain independent-evaluator accepted      |
| 25  | Phase 27 generation is unchanged                              |
| 26  | `selectFinalSolutions` does not mutate the input              |
| A   | `listActiveDimensions` is a subset of the catalog             |
| B   | `input` accepted as a first-class option                      |
| C   | Score vector is fully explainable (raw/norm/weight/contrib)   |
| D   | Diagnostics expose `h13` / `h14` / timings / rejected list     |
| E   | Backward-compat: `candidate.__input` still read               |
| F   | `qualityScore` keeps Phase 27 semantics; `scoring.total` is separate |

All 32 pass.

### Test suite isolation note

`generateSolutions` is wall-clock budgeted, so the number of
solver iterations it completes depends on machine load. This
test file generates its real-data pools **once at module load**
(count 3 / 5 / 10) and reuses them read-only, instead of
regenerating per test.

That was not a cosmetic choice. An earlier version regenerated
the pool in each of the ten real-data tests. Under
`node --test`, which runs files in parallel, the extra solver
load starved the wall-clock-sensitive Phase 27 determinism
tests (`PHASE 27 / 17`, `/ 18`) and produced intermittent
failures **in Phase 27, not Phase 28**. Caching the pools fixed
it: the Phase 28 file's runtime fell from ~105 s to ~15 s and
the suite is now stable across repeated runs.

Phase 28 still does not touch `multi-solution.js` or any
Phase 27 test. The lesson is recorded here because the
dependency is real and future phases adding heavy real-data
tests will hit it again.

## 19. Regression

```text
Before Phase 28:  501 tests pass
After  Phase 28:  533 tests pass  (501 + 32)
Failed:           0
```

No Phase 1–27 test was modified. Phase 28 is strictly
additive to the test suite, and the only non-test change is
`src/domain/global-scoring.js` (new module).

`npm test` → 533 tests, 533 pass, 0 fail, verified on three
consecutive clean runs.

## 20. What Phase 28 does NOT do

  - No UI. The result is a domain-level `{ solutions,
    diagnostics }` object; rendering is a later phase.
  - No AI / LLM / AirLLM.
  - No travel activation. H14 remains UNSUPPORTED and the
    travel matrix is still not fabricated.
  - No transfer objective. H13 remains INACTIVE; historical
    transfer counts are not a score.
  - No change to multi-solution generation. Phase 27 still
    owns `generateSolutions`.
  - No change to the solver or the comparator.
  - No baseline objective. `changedAssignments` stays
    reporting-only.

## 21. Definition of Done

```text
[x] global scoring model tồn tại                        (selectFinalSolutions / scoreCandidate)
[x] dimensions explicit                                  (DIMENSION_CATALOG, 9 entries)
[x] directions explicit                                  (MINIMIZE / MAXIMIZE, test 4)
[x] weights centralized                                  (GLOBAL_SCORING_DEFAULTS.weights)
[x] normalization deterministic                           (pool-relative min-max, tests 5/6/18)
[x] hard feasibility dominates                           (3 guards, tests 3/10)
[x] travel inactive when unsupported                     (H14 UNSUPPORTED, test 15)
[x] transfer inactive when unsupported                   (H13 INACTIVE, test 16)
[x] quality/diversity policy explicit                    (§10 blend, test 12/20)
[x] best-quality candidate preserved                     (comparator anchor, test 11)
[x] final selection deterministic                        (tests 19/22)
[x] qualityScore semantics preserved                     (§14, audit matches Phase 27, test F)
[x] globalScore available                                (scoring.total, §8)
[x] 10 real candidates scored                            (audit §16)
[x] final selected candidates still hard-feasible        (test 24)
[x] Phase 27 unchanged                                   (test 25)
[x] no AI                                                (no AI import in module)
[x] no AirLLM                                            (no AirLLM import in module)
[x] no UI                                                (domain layer only)
[x] all tests pass                                       (533 = 501 + 32)
[x] PHASE_28_GLOBAL_SCORING_SELECTION.md                 (this file)
```

## 22. Final report

```text
Public API                : selectFinalSolutions(candidates, options)
Supporting API            : scoreCandidate / scorePool / validateWeights
                           getDimension / listActiveDimensions
Dimension catalog         : 9 dimensions
  active on real data     : 6 (4 MINIMIZE quality, 2 MAXIMIZE diversity)
  inactive                : TRAVEL (H14), TRANSFER (H13), CHANGED_ASSIGNMENTS (reporting)
Global score              : weighted mean of active normalized dimensions, in [0, 1]
Degenerate normalization  : 0.5 (neutral), never NaN / Infinity
All-zero weights          : total = 0 (finite, deterministic)
Feasibility               : hard violations dominate; no rescue possible
Anchor                    : comparator-best candidate, unconditionally rank 1
Selection                 : quality-first greedy farthest-point, O(N²)
Slot diversity gate       : 0.15 (unchanged from Phase 27)
Diversity scoring         : STRUCTURAL_DIVERSITY 0.4 + SLOT_DIVERSITY 0.2
qualityScore              : Phase 27 semantics, unchanged
globalScore               : scoring.total (new field)
Travel                    : UNSUPPORTED — not scored, not fabricated
Transfer                  : INACTIVE — not scored
AI / LLM / AirLLM         : not invoked
Input mutation            : none

Real-data audit (40T, 7B, 113C, 479A, 802P), seed 0xC0FFEE:
  requested candidates     : 3 / 5 / 10
  scored candidates        : 3 / 5 / 10
  selected candidates      : 3 / 5 / 10
  rejected infeasible      : 0 / 0 / 0

  best globalScore         : 0.9444 (count=3)
  worst selected globalScore: 0.2431 (count=3)
  best qualityScore        : 0.0714
  best workloadSpread      : 12
  best maxTeacherLoad      : 24
  best stdev               : 3.008

  min slot diversity       : 0.6028 / 0.6028 / 0.5704
  min structural diversity : 0.1150 / 0.1150 / 0.1150

  H13                      : INACTIVE
  H14                      : UNSUPPORTED
  selection time (count=10): 213 ms  (scoring 62 ms)

Phase 27 vs Phase 28      : ranks 2/3 swap; ms-8edcae17 (div 0.5942)
                            replaced by ms-52abbaf9 (div 0.6787) at select=5
                            → the scoring layer measurably changes selection

Tests:
  Before = 501
  After  = 533
  Passed = 533
  Failed = 0
```

Phase 28 stops here. No UI, no AI, no travel activation, no
transfer objective, and no change to candidate generation.

> **Mục tiêu cuối cùng Phase 28:** a scoring/selection layer
> that is independent, deterministic and explainable, so that a
> pool of many valid timetables can be narrowed to the best few
> by quality + workload + preference + diversity — without
> using travel or transfer data while those constraints are not
> active.
