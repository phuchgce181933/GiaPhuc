# PHASE 17 — SEARCH-TIME STRATEGY OBJECTIVES

> Phase 17 audit + remediation of how strategies influence the
> solver, how workload, no-gap, and session-diversity objectives
> participate in the search, and how the orchestrator surfaces an
> A/B/C comparison.
>
> Six concrete defects were raised:
>
> 1. Strategy phải thực sự ảnh hưởng search
> 2. objective no-gap phải được dùng
> 3. objective session-diversity phải được dùng
> 4. workload phải guide search chứ không chỉ score cuối
> 5. orchestration phải thật sự có khả năng thử A/B/C
> 6. kiểm tra diversity metric có đủ dùng cho TKB thực tế hay không
>
> This document records every fix, the root cause, the tests that
> lock the contract, and the before/after behaviour.
>
> No real dataset was loaded. No LLM was integrated. The frontend
> was not touched.

---

## 1. Strategy affects the search, not just the final score

### Issue

The preset strategies (A: preference-first, B: workload + travel,
C: balanced) declared different weight vectors and different
`objectives` switches. The search itself, however, was strategy-
agnostic: it only used `strategy.solver.timeLimitMs`,
`strategy.solver.maxSolutions`, and `strategy.diversification.seed`.
The `weights` only mattered when the scorer computed
`overallScore` at the end, and the `objectives` switches were
read by no code at all.

### Root cause

`solver.js` ignored `input.strategy.objectives` and used a single
slot ordering rule (`slotPenalty` plus a uniform random shuffle
of the variant list). The `weights` were consumed only by
`scorer.js` after the candidate was already produced.

### Fix

The solver now consults `strategy.objectives` at search time and
applies three soft bias functions to the slot pool:

- `teacherWorkloadPressure(teacherId, state)` — returns a value
  added to the slot's composite penalty. Positive when the
  teacher is over their budget, negative when under.
- `noGapBias(teacherId, slot, state)` — negative when the slot is
  adjacent to the teacher's existing same-day slots; positive
  when it would create a gap.
- `sessionDiversityBias(teacherId, slot, state)` — negative when
  the slot is in the OTHER session from the teacher's existing
  same-day slots; positive when it would cluster.

The variant list is also reordered when `balancedWorkload` is on:
the teacher with the most budget headroom gets a small bonus,
so the search tries the most "headroom-y" variant first.

The biases are HEURISTIC. They do not restrict the search; they
only reorder the pool so the first feasible solution is biased
toward the strategy's intent. The hard-constraint gate is
unchanged.

### Tests

- `PHASE 17 / 2.1 — solution carries the strategyId that produced it`
- `PHASE 17 / 2.2 — solver with balancedWorkload: false does not consult budget in search`
- `PHASE 17 / 2.3 — solver with balancedWorkload: true searches the same problem with budget awareness`
- `PHASE 17 / 2.4 — solver with noGapTeacherDay: true returns a solution with no-gap bias in the pool`
- `PHASE 17 / 2.5 — solver with sessionDiversity: true returns a solution with session-mix bias`
- `PHASE 17 / 2.6 — solver with all three objectives on still produces a valid solution (no regression)`

### Before / After

| Aspect                            | Before                          | After                                                                 |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `strategy.objectives.balancedWorkload` | ignored                         | reorders variant list, biases slot pool by teacher budget headroom     |
| `strategy.objectives.noGapTeacherDay`   | ignored                         | biases slot pool to prefer adjacent slots and penalise gap-creators   |
| `strategy.objectives.sessionDiversity`  | ignored                         | biases slot pool to prefer the OTHER session from existing slots      |
| `strategy.weights.noGap`               | undefined                       | clamped to [0, 3], consumed in `overallScore`                          |
| `strategy.weights.sessionDiversity`     | undefined                       | clamped to [0, 3], consumed in `overallScore`                          |

---

## 2. The `noGapTeacherDay` objective is now used

### Issue

`STRATEGY_A`, `STRATEGY_B`, and `STRATEGY_C` all declared
`objectives.noGapTeacherDay: true`. A function `noGapForTeacherDays`
existed in `constraints.js` and was re-exported by `scorer.js`,
but no code path called it. The objective was a dead switch.

### Root cause

The scorer wired only the SOFT preferences (preference,
workload, travel, transfer, diversity). The two new objectives
were not part of the score and not part of the search.

### Fix

Two changes:

1. `noGapForTeacherDays` is now called from `scorer.js`. The
   per-teacher-day contiguity of slots becomes the `noGapScore`
   field in the score breakdown, and `w.noGap * noGapScore` is
   added to `overallScore`.
2. The solver's slot pool is ordered by a composite penalty that
   includes the no-gap bias (see §1). When a teacher already has
   slots on day D, the solver prefers slots adjacent to those
   (period min(P)-1 or max(P)+1) and penalises slots that would
   create a one-period gap in the day.

### Tests

- `PHASE 17 / 1.3 — STRATEGY_A declares sessionDiversity: false; B and C declare true`
- `PHASE 17 / 2.4 — solver with noGapTeacherDay: true returns a solution with no-gap bias in the pool`
- `PHASE 17 / 3.1 — noGapScore is reported in the score breakdown`
- `PHASE 17 / 3.3 — overallScore includes the noGap weight`

### Before / After

| Scenario                                                  | Before                              | After                                                                          |
| --------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------ |
| `objective.noGapTeacherDay: true` declared                | declared but unused                 | biases slot pool, contributes to `overallScore`                                |
| `noGapForTeacherDays(…)` called from `scorer.js`          | never                               | every score call includes the per-teacher-day contiguity                       |
| Solution that places all 3 of t1's slots on day 1 contiguously | `noGapScore` undefined             | `noGapScore = 1`                                                               |

---

## 3. The `sessionDiversity` objective is now used

### Issue

Same as §2, but for `sessionDiversity`. Both `STRATEGY_B` and
`STRATEGY_C` declared `sessionDiversity: true`, but the code
never honoured it.

### Fix

A new function `sessionDiversityScore(solution, input)` was added
to `constraints.js`. The function computes, for each
teacher-day, the share of distinct sessions (sang/chieu) the
teacher has. A day with both sang and chieu scores 1; a day
with only one session scores 0; an empty day scores 1 (no
penalty). The mean over all teacher-days is the score.

This is wired into:
- The scorer: `w.sessionDiversity * sessionDiversityScore` is
  added to `overallScore`.
- The solver: when picking the next slot for a teacher on a day
  they already have slots in, the solver prefers slots in the
  OTHER session.

The two signals are intentionally orthogonal:
- `noGapScore` measures contiguity within a session
  (mornings: periods 1, 2, 3 contiguously).
- `sessionDiversityScore` measures mixing across sessions on the
  same day (morning + afternoon).

A real TKB benefits from both: a teacher's day is one block, but
that block spans the morning and afternoon of a single day.

### Tests

- `PHASE 17 / 2.5 — solver with sessionDiversity: true returns a solution with session-mix bias`
- `PHASE 17 / 3.2 — sessionDiversityScore is reported in the score breakdown`
- `PHASE 17 / 3.4 — overallScore includes the sessionDiversity weight`
- `PHASE 17 / 8.1 — sessionDiversityScore is 1 for a teacher with both sang and chieu on the same day`
- `PHASE 17 / 8.2 — sessionDiversityScore is 0 for a teacher with all-sang on the same day`
- `PHASE 17 / 8.3 — sessionDiversityScore is 1 for an empty solution (no penalty)`

### Before / After

| Scenario                                       | Before               | After                                                |
| ---------------------------------------------- | -------------------- | ---------------------------------------------------- |
| `objective.sessionDiversity: true` declared    | declared but unused  | biases slot pool, contributes to `overallScore`      |
| 1 morning + 1 afternoon on the same day        | `sessionDiversityScore` undefined | `sessionDiversityScore = 1`             |
| 2 mornings on the same day                     | `sessionDiversityScore` undefined | `sessionDiversityScore = 0`             |

---

## 4. Workload guides the search, not just the final score

### Issue

`workloadBalanceScore` lived in the scorer. The solver
considered only hard constraints when picking a slot; a
teacher's remaining budget headroom was not part of the
decision. A teacher who had already received their budget of
20 slots was just as likely to be selected for the next slot
as a teacher with 0 actual slots.

### Root cause

The solver had no notion of `actual[teacherId]`. The score
function had the per-teacher actual count, but by then the
search had already produced the candidate.

### Fix

The solver now tracks `workloadActual[teacherId]` (counted
through `currentState.placements`) and applies a workload
pressure bias to slot selection:

- When `objective.balancedWorkload` is on, the variant list is
  reordered so the teacher with the most budget headroom is
  tried first. The bonus is `BIAS.WORKLOAD_VARIANT_BONUS *
  min(5, budget / 5)`.
- For each candidate slot, a workload-pressure value is added
  to the composite penalty. The value is
  `over * BIAS.WORKLOAD_OVER - under * BIAS.WORKLOAD_UNDER`.
  This biases the search toward not over-shooting any single
  teacher's budget.

The biases are small integers (8 over, -2 under, -3 variant
bonus) so the hard constraints remain the dominant signal. The
search still finds diverse solutions; the first feasible
solution is now biased toward workload balance when the
strategy says so.

### Tests

- `PHASE 17 / 2.3 — solver with balancedWorkload: true searches the same problem with budget awareness`
- `PHASE 17 / 6.1 — solver with open teacherId and balancedWorkload: true emits a candidate`
- `PHASE 17 / 6.2 — workload bias in search does not crash on teachers with no budget`

### Before / After

| Scenario                                                          | Before                       | After                                                |
| ----------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------- |
| Two open-teacherId assignments, t1 budget 2, t2 budget 20         | search picks t1 first (or t2) with equal probability | search tries t2 first (variant bonus)            |
| t1 already has 21 slots, t1 budget 20                             | any next slot for t1 is fine | next slot for t1 has +8 penalty                      |
| t1 has 0 slots, t1 budget 20                                      | any next slot for t1 is fine | next slot for t1 has -2 nudge                        |

---

## 5. Orchestrator has a real A/B/C comparison

### Issue

The orchestrator's API accepted `options.strategies` and ran
each strategy in turn, but the response only carried the merged
`kept` set. There was no way to ask: "which strategy produced
the top candidate? what was the top score per strategy? did
strategy A beat strategy B?". The A/B/C contract was not in
the response.

### Root cause

The orchestrator's per-strategy state was discarded after each
strategy's candidates were pooled. The `comparison` block did
not exist.

### Fix

The orchestrator now:

1. Captures, for each strategy, the count of candidates
   produced, the count accepted by the validator, and the top
   score.
2. Adds a `comparison` block to the response with one entry per
   strategy.
3. Marks one entry with `winner: true` — the strategy whose
   top candidate has the highest `overallScore` (tie-break by
   accepted count).
4. Tags each solution with `strategyId` so callers can audit
   which strategy produced which kept candidate.
5. Attaches a `structuralDiversity` breakdown to each kept
   candidate (see §6).
6. Sorts the kept set by `overallScore` DESC, then by
   `structuralDiversity.overall` DESC, then by `strategyId` for
   stability.

The existing merge-and-dedupe behaviour is preserved: the
`requested` (1, 3, 5, 10) solutions are still the merged top-N
across strategies. The `comparison` block is an additional
audit layer.

### Tests

- `PHASE 17 / 5.1 — orchestrator response carries a `comparison` block`
- `PHASE 17 / 5.2 — comparison block identifies a winner`
- `PHASE 17 / 5.3 — each solution carries a strategyId`
- `PHASE 17 / 5.4 — each solution carries a structuralDiversity breakdown`
- `PHASE 17 / 5.5 — strategies A/B/C on the same input produce distinct top scores`

### Before / After

| Aspect                              | Before                                          | After                                                           |
| ----------------------------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `response.comparison`               | missing                                         | `[{ strategyId, candidatesProduced, accepted, topScore, winner? }]` |
| `response.solutions[].strategyId`   | `null` (assigned in solver)                     | set by the solver from `input.strategy.id`                      |
| `response.solutions[].structuralDiversity` | missing                                  | `{ teacherDay, sessionMix, overall }`                           |
| Final sort key                      | `overallScore` only                             | `overallScore`, then `structuralDiversity.overall`, then `strategyId` |
| `comparison.winner`                 | n/a                                             | one entry has `winner: true`                                    |

---

## 6. Diversity metric: structural diversity for real TKB

### Issue

`diversity(a, b)` was `|slots(A) △ slots(B)| / |slots(A) ∪ slots(B)|`
where `slots(X) = { ${teacherId ?? ''}|${branchId}:${day}:${period} }`.
This is the right metric for "are these two schedules
slot-by-slot different?", but it has two important gaps for
real TKB:

1. Two solutions that place the same set of slot identities but
   distribute t1's work differently (e.g., t1 has 4 slots on day
   1 in A, but 1 slot per day on days 1-4 in B) score 0 at the
   slot identity level. Real TKB care about this distinction.
2. Two solutions with different slot identities but identical
   "shape" (same teacher, same day counts, same session mix)
   can score high in slot diversity even though they look the
   same to a planner.

### Root cause

The slot-identity diversity is the dedupe gate (PHASE 16 §12).
It is a NECESSARY condition for two solutions to be considered
diverse, but it is not a SUFFICIENT condition for a real TKB
planner.

### Fix

A new function `structuralDiversity(a, b)` is added to
`diversity.js`. It returns a breakdown of the per-teacher
distributions of work between two solutions:

- `teacherDay` — how different are the day-count histograms
  per teacher? For each teacher, compute the sum of
  `|A_d - B_d|` over days, normalised by the max of the two
  slot counts. The mean over teachers is `teacherDay`.
- `sessionMix` — how different are the per-teacher sang/chieu
  splits? For each teacher, compute
  `|A.sang - B.sang| + |A.chieu - B.chieu|` normalised by the
  total slot count. The mean over teachers is `sessionMix`.
- `overall` — the weighted blend `0.6 * teacherDay + 0.4 *
  sessionMix`. Day distribution matters more for TKB (week
  structure) than session mix.

The slot identity diversity remains the dedupe gate. The
structural score is reported separately on each solution and
used as a TIE-BREAKER for the final sort.

### Tests

- `PHASE 17 / 4.1 — structuralDiversity is 0 for identical slot sets (even with different teachers)`
- `PHASE 17 / 4.2 — structuralDiversity is non-zero when teacher day distribution differs`
- `PHASE 17 / 4.3 — structuralDiversity is non-zero when session mix differs`
- `PHASE 17 / 4.4 — structuralDiversity is bounded in [0, 1]`
- `PHASE 17 / 4.5 — slot identity diversity is unchanged by structural diversity`
- `PHASE 17 / 7.1 — two solutions with same slot identity but different day distribution differ structurally`
- `PHASE 17 / 7.2 — same-day concentrated slot set has higher session-mix homogeneity`
- `PHASE 17 / 7.3 — structural diversity is reported for each kept candidate`

### Before / After

| Scenario                                                                  | Before                          | After                                                   |
| ------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| Two solutions with identical slot identity but different day distribution | slot diversity = 0, no signal   | slot diversity = 0, structural `teacherDay > 0`         |
| Two solutions with different slot identity but identical day pattern       | slot diversity high, no signal  | slot diversity high, structural `teacherDay ≈ 0`        |
| Tie-break two solutions with equal `overallScore`                         | by `strategyId` (arbitrary)     | by `structuralDiversity.overall` DESC, then `strategyId` |

---

## 7. Strategy schema extension

### Issue

`clampWeights` only knew about the original 5 weights
(`preference`, `workload`, `travel`, `transfer`, `diversity`).
The new weights were not declared in the strategy schema.

### Fix

`strategies.js` now declares `weights.noGap` and
`weights.sessionDiversity` for each preset. `clampWeights`
clamps all 7 weights to [0, 3].

| Preset                | preference | workload | travel | transfer | diversity | noGap | sessionDiversity |
| --------------------- | ---------- | -------- | ------ | -------- | --------- | ----- | ---------------- |
| `A_PREFERENCE_FIRST`  | 2.0        | 1.0      | 0.5    | 0.5      | 1.0       | 0.5   | 0.0              |
| `B_WORKLOAD_TRAVEL`   | 0.5        | 2.0      | 1.5    | 1.5      | 1.0       | 1.5   | 1.5              |
| `C_BALANCED`          | 1.0        | 1.0      | 1.0    | 1.0      | 1.0       | 1.0   | 1.0              |

### Tests

- `PHASE 17 / 1.1 — clampWeights handles noGap and sessionDiversity`
- `PHASE 17 / 1.2 — every preset declares weights.noGap and weights.sessionDiversity`
- `PHASE 17 / 1.3 — STRATEGY_A declares sessionDiversity: false; B and C declare true`

---

## 8. No invented data

The phase did not invent branches, classes, curriculum,
assignments, or travel data. The teacher fixture
(`data/fixtures/teachers.authoritative.json`) is untouched. New
synthetic inputs in the test files are clearly labelled
(`warnings: ['TEST MOCK ...']`) and are not loaded by any
production path.

---

## 9. Test report

```text
Phase 15:  98 tests
Phase 16: +33 tests
Phase 17: +31 tests
Total:    162 tests
Pass:     162
Fail:       0
```

The 31 new tests are in `backend/tests/phase17_search_objectives.test.js`.
No test was deleted to make the suite green.

---

## 10. Files changed

```
backend/src/domain/strategies.js   — weights.noGap, weights.sessionDiversity,
                                       clampWeights over all 7 keys
backend/src/domain/solver.js       — strategy.objectives drives workload / noGap /
                                       sessionDiversity biases; variant ordering;
                                       slot pool composite penalty
backend/src/domain/scorer.js       — noGapScore + sessionDiversityScore in the
                                       score breakdown, weight-consumed in
                                       overallScore
backend/src/domain/constraints.js  — sessionDiversityScore function; isolated
                                       single-slot noGap path (defensive)
backend/src/domain/diversity.js    — structuralDiversity breakdown (teacherDay,
                                       sessionMix, overall)
backend/src/orchestrator/index.js  — comparison block, winner mark, structural
                                       diversity tie-breaker, per-strategy
                                       audit; solution.strategyId
backend/tests/phase17_search_objectives.test.js — 31 new tests
docs/PHASE_17_SEARCH_OBJECTIVES.md  — this file
```

---

## 11. What remains blocked by data

The orchestrator still returns `MISSING_DATA` for the
authoritative teacher fixture because the fixture has no
branches, classes, curriculum, or assignments. The Phase 17
changes do not unblock real data integration — they make the
search, the scoring, the diversity, and the orchestrator's
A/B/C comparison HONEST about what they optimise, so the first
real run on real data behaves correctly when data is provided.

The next phase should:

1. Wire the production data sources (`chi_nhanh`, `lop`, `chuong_trinh`).
2. Plug a real `TravelProvider` so `H_TRAVEL_FEASIBLE` becomes
   active for cross-branch transitions.
3. Plug a real `allowedTransferBranches` source so
   `H_TRANSFER_ALLOWED` becomes active.
4. Run A/B/C comparisons on the first real dataset and inspect
   the `comparison` block to choose a winner.

---

## 12. Definition of done (audit)

| Item                                                    | Status |
| ------------------------------------------------------- | ------ |
| Strategy affects the search                             | ✓      |
| `noGapTeacherDay` objective is used                    | ✓      |
| `sessionDiversity` objective is used                    | ✓      |
| `balancedWorkload` objective guides the search          | ✓      |
| Workload pressure biases the search (not just the score)| ✓      |
| Orchestrator A/B/C `comparison` block                   | ✓      |
| Orchestrator `winner` is marked                         | ✓      |
| Each solution carries `strategyId`                      | ✓      |
| Each solution carries `structuralDiversity`             | ✓      |
| `noGapScore` in the score breakdown                     | ✓      |
| `sessionDiversityScore` in the score breakdown          | ✓      |
| `weights.noGap` and `weights.sessionDiversity`          | ✓      |
| `clampWeights` handles all 7 keys                       | ✓      |
| Slot identity diversity unchanged                       | ✓      |
| Structural diversity bounded in [0, 1]                  | ✓      |
| Existing 131 tests pass                                 | ✓      |
| 31 new regression tests pass                            | ✓      |
| No invented production data                             | ✓      |
| No LLM integration                                      | ✓      |
