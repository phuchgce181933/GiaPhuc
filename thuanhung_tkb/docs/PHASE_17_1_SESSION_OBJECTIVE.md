# PHASE 17.1 — CORRECT SESSION-OBJECTIVE SEMANTICS

> Phase 17.1 audit + remediation of the `sessionDiversity`
> objective. Phase 17 introduced three search-time biases to
> make the strategy affect the search, but one of them —
> `sessionDiversityBias` — was found to unintentionally push
> their schedule toward morning+afternoon on the same day. The
> matching `sessionDiversityScore` in the scorer rewarded the
> same anti-pattern.
>
> This document records the audit, the decision, the
> implementation, and the tests that lock the corrected
> semantics.
>
> No real dataset was loaded. No LLM was integrated. The
> architecture was not rewritten.

---

## 1. Problem

After Phase 17, the solver actively nudged a teacher toward
the OTHER session from their existing same-day slot:

```text
Teacher already has morning slot on Mon.
        ↓
sessionDiversityBias = -3  ← PUSH (strong)
        ↓
solver prefers afternoon slot on Mon
```

The matching score in `scorer.js` then rewarded this anti-pattern:

```text
Mon morning  + Mon afternoon = 1 morning + 1 chieu on the
                              same day → "mixed" day →
                              sessionDiversityScore = 1 (top)
```

This conflicted with several other objectives:

* `S_PREFERRED_SESSION`: a teacher who prefers morning should
  not be pushed toward afternoon.
* `S_MAX_SESSIONS_PER_WEEK`: morning + afternoon on the same
  day counts as 2 sessions (over the cap sooner).
* `noGapScore`: a 5-period gap between sang and chieu is the
  opposite of contiguity.
* Travel: a same-day cross-branch slot is more travel-heavy
  than a different-day slot.
* Teacher usability: a single block of 2 periods is more
  practical than 1 period at 8 AM and another at 1 PM.

---

## 2. Audit

The audit walked every consumer of `sessionDiversity`:

| Where                                | What it did                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `strategies.js` (declarations)       | `objectives.sessionDiversity: boolean` and `weights.sessionDiversity: number`. Three presets: A=0/false, B=1.5/true, C=1.0/true. |
| `solver.js` `sessionDiversityBias`   | Returned `SESSION_OTHER = -3` (strong PUSH) when the candidate slot was in the OTHER session from the teacher's existing same-day slot. Returned `SESSION_SAME = +1` (slight penalty) when the slot was in the SAME session. The result was added to the slot composite penalty → search preferred opposite session. |
| `constraints.js` `sessionDiversityScore` | Counted teacher-days with both sang and chieu. Returned `mixed / total`. A 1-sang + 1-chieu same day scored 1 for that day. |
| `scorer.js`                          | `w.sessionDiversity * sessionDiversityScore` was added to `overallScore` → scorer REWARDED split days. |
| `orchestrator/index.js`              | Just passed the score through. The A/B/C `comparison` block reported `topScore` per strategy. |
| `diversity.js` `structuralDiversity.sessionMix` | Per-teacher sang/chieu split between two solutions. This is SOLUTION-to-SOLUTION diversity (correctly separated from teacher quality). |

Conclusion: the search actively pushed toward opposite session;
the scorer rewarded split days. Both behaviors conflicted with
the other objectives.

---

## 3. Decision

Three corrections were applied. None of them is a new
business rule; each one removes a conflict with the existing
objectives.

### 3.1 The search no longer reads `sessionDiversity`

The bias `sessionDiversityBias` is REMOVED from the slot pool
ordering. The `BIAS.SESSION_OTHER` and `BIAS.SESSION_SAME`
constants are also removed. The `objectives.sessionDiversity`
switch in the strategy schema becomes a no-op in the search
(it is still consumed at scoring time, with the corrected
semantic below).

### 3.2 The score's semantic is inverted

`sessionDiversityScore(solution, input)` now measures
**session compactness**:

```text
score = 1 - splitDays / totalDays
```

* A teacher doing 1 morning + 1 morning on different days:
  0 split days → score = 1.
* A teacher doing 1 morning + 1 afternoon on the same day:
  1 split day → score = 0.
* A teacher doing 1 morning + 1 morning + 1 afternoon on the
  same day: 1 split day → score = 0.

The function name is kept (`sessionDiversityScore`) for API
stability. The field on `score` is also kept
(`score.sessionDiversityScore`). The `weights.sessionDiversity`
weight is consumed unchanged in `overallScore`.

### 3.3 Solution-level diversity is untouched

`structuralDiversity` in `diversity.js` remains responsible for
solution-to-solution diversity. Its two components are
`teacherDay` (per-teacher day-count distance) and `sessionMix`
(per-teacher sang/chieu split between two solutions). The first is
NEW (PHASE 17); the second is now correctly understood as
"solution-to-solution", not "teacher quality".

The two concepts are now cleanly separated:

| Concept                    | Lives in                       | Measures                                            |
| -------------------------- | ------------------------------ | --------------------------------------------------- |
| Per-teacher session QUALITY  | `constraints.js` `sessionDiversityScore` | Compactness of one teacher's week                 |
| Per-teacher session SHAPE   | `diversity.js` `structuralDiversity.sessionMix` | How different two solutions' teacher sessions are |

---

## 4. Important Distinction

* **TKB Quality** (one timetable): preference, workload, travel,
  transfer, compactness, no-gap, session preference, max
  sessions. The session-diversity concept now lives here as
  "compactness".
* **Solution Diversity** (multiple timetables): teacher
  assignment differences, slot identity differences, daily
  patterns. The structural-diversity concept lives here.

These two are now correctly separated. The session-diversity
bias at search time conflated them; the new semantics does not.

---

## 5. Implementation

### 5.1 `backend/src/domain/solver.js`

* Removed the `sessionDiversityBias` function.
* Removed `BIAS.SESSION_OTHER` and `BIAS.SESSION_SAME` from the
  `BIAS` table.
* Removed the `sessionDiversity` flag from the local
  `objectives` read.
* `slotComposite(teacherId, slot, currentState)` now composes
  only `slotPenalty + teacherWorkloadPressure + noGapBias`.
  No session-diversity term.
* Removed the unused `branchesById` precompute and
  `sessionForSlot` import.

### 5.2 `backend/src/domain/constraints.js`

* Rewrote `sessionDiversityScore(solution, input)`:
  * Old: `mixed / total` (1 when split, 0 when compact).
  * New: `1 - split / total` (1 when compact, 0 when split).
* Updated the docstring to call the new semantic
  "session compactness" and document the rationale.

### 5.3 `backend/src/domain/strategies.js`

* Added a header comment documenting the corrected semantic.
* Kept `objectives.sessionDiversity` and
  `weights.sessionDiversity` in the schema (API stability).
  `STRATEGY_A` still turns them off (`false` / `0`); `STRATEGY_B`
  and `STRATEGY_C` still turn them on. The semantic change is
  in the score, not in the schema.

### 5.4 `backend/src/domain/scorer.js`

* No code changes. The `sessionDiversityScore` field is still
  wired into `overallScore` via
  `w.sessionDiversity * sessionDiversityScore`. The semantic
  change is in the function, not in the wiring.

### 5.5 `backend/src/domain/diversity.js`

* No changes. The `sessionMix` component continues to measure
  solution-to-solution teacher session differences.

### 5.6 `backend/src/orchestrator/index.js`

* No changes. The A/B/C `comparison` block continues to report
  `topScore` per strategy. Strategies B and C still win when
  compactness is rewarded; A is indifferent.

---

## 6. Tests

### 6.1 Updated tests (3)

The three pre-existing tests in
`tests/phase17_search_objectives.test.js` that asserted the
OLD semantic were updated to assert the NEW (compactness)
semantic:

| Old name                                                          | New name                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `PHASE 17 / 3.2 — sessionDiversityScore is 1 for split day`       | `PHASE 17 / 3.2 — sessionDiversityScore (now compactness) is reported; split day = 0` |
| `PHASE 17 / 8.1 — sessionDiversityScore is 1 for sang+chieu`     | `PHASE 17.1 / 8.1 — sessionDiversityScore is 0 for split day (was 1)`   |
| `PHASE 17 / 8.2 — sessionDiversityScore is 0 for all-sang`       | `PHASE 17.1 / 8.2 — sessionDiversityScore is 1 for all-sang (was 0)`   |
| `PHASE 17 / 2.5 — solver with sessionDiversity returns mix bias`  | `PHASE 17.1 / 2.5 — solver with sessionDiversity still runs (no search effect)`. |

The 8.3 empty-solution test (`sessionDiversityScore = 1`) was
already aligned with the new semantic and needed no change.

### 6.2 New tests (10) in `tests/phase17_1_session_objective.test.js`

| Test | Purpose |
| ---- | ------- |
| `PHASE 17.1 / 1` | Afternoon candidate does NOT receive automatic positive score (compactness > mix) |
| `PHASE 17.1 / 2` | S_PREFERRED_SESSION preserves morning preference |
| `PHASE 17.1 / 3` | S_MAX_SESSIONS_PER_WEEK still counts (day, session) tuples |
| `PHASE 17.1 / 4` | Solver does not push toward opposite session when it forces cross-branch travel |
| `PHASE 17.1 / 5` | Solution-level diversity is preserved (structuralDiversity intact) |
| `PHASE 17.1 / 6` | Solver source no longer references session-diversity bias (regex on function definitions, not comments) |
| `PHASE 17.1 / 6.2` | sessionDiversityScore function still exists with corrected semantic |
| `PHASE 17.1 / 6.3` | Strategies still declare sessionDiversity in objectives and weights |
| `PHASE 17.1 / 7` | noGap and sessionCompactness are independent signals |
| `PHASE 17.1 / 8` | sessionDiversity false vs true produce the same search (slot identity) |

---

## 7. Before / After

### 7.1 Per-teacher schedule quality

| Scenario                                                                | Before                                | After                                                          |
| ----------------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------- |
| Teacher does Mon morning + Mon afternoon                                | `sessionDiversityScore = 1` (top score) | `sessionDiversityScore = 0` (penalty)                                 |
| Teacher does Mon morning + Tue morning                                  | `sessionDiversityScore = 0`            | `sessionDiversityScore = 1` (top score)                            |
| Teacher does Mon morning + Mon morning (contiguous)                     | `sessionDiversityScore = 0`            | `sessionDiversityScore = 1` (no penalty)                            |
| Solver choosing next slot for t1 (already has Mon morning, 5 options)  | prefers Mon afternoon                  | no bias; respects preferred session, travel, no-gap                 |

### 7.2 Strategy A/B/C semantics

| Strategy               | Before                              | After                                                          |
| --------------------- | ---------------------------------- | -------------------------------------------------------------- |
| A_PREFERENCE_FIRST    | `weights.sessionDiversity = 0` (off) | unchanged (off)                                              |
| B_WORKLOAD_TRAVEL     | `weights.sessionDiversity = 1.5` (rewards split days)   | `weights.sessionDiversity = 1.5` (rewards compactness)            |
| C_BALANCED            | `weights.sessionDiversity = 1.0` (rewards split days)   | `weights.sessionDiversity = 1.0` (rewards compactness)            |

The strategy SCHEMA is unchanged. Only the semantic of the
score consumed by `weights.sessionDiversity` is inverted.

### 7.3 Search-time behavior

| Aspect                                          | Before                                                   | After                            |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `objective.sessionDiversity: true`              | biases slot pool toward opposite session                 | no effect on the search          |
| `objective.sessionDiversity: false`             | no bias                                                  | no effect on the search          |
| `BIAS.SESSION_OTHER`                            | defined; `-3` per slot in opposite session               | removed                          |
| `BIAS.SESSION_SAME`                             | defined; `+1` per slot in same session                  | removed                          |

### 7.4 Solution-level diversity

| Aspect                                          | Before                                                   | After                            |
| ----------------------------------------------- | -------------------------------------------------------- | -------------------------------- |
| `diversity(a, b)`                               | slot-identity diversity (PHASE 16)                       | unchanged                        |
| `structuralDiversity(a, b).overall`             | `0.6 * teacherDay + 0.4 * sessionMix` (PHASE 17)        | unchanged                        |
| `structuralDiversity(a, b).teacherDay`          | per-teacher day-count distance                           | unchanged                        |
| `structuralDiversity(a, b).sessionMix`          | per-teacher sang/chieu split distance between two solutions | unchanged; correctly separated from term  |

---

## 8. Test report

```text
Phase 15:  98 tests
Phase 16: +33 tests
Phase 17: +31 tests
Phase 17.1: +10 tests (3 updated in place, 10 new)
Total:    172 tests
Pass:     172
Fail:       0
```

No test was deleted to make the suite green. The 3 tests that
asserted the OLD semantic were updated to assert the NEW
semantic (and re-labelled as PHASE 17.1).

---

## 9. Files changed

```
backend/src/domain/solver.js                        — removed sessionDiversityBias, SESSION_OTHER, SESSION_SAME
                                                       and the sessionDiversity objective read
backend/src/domain/constraints.js                 — inverted sessionDiversityScore: 1 - split/total
                                                       (compactness), updated comments
backend/src/domain/strategies.js                   — added header documenting the new semantic;
                                                       schema unchanged
backend/src/domain/scorer.js                       — no code change (semantic change lives in
                                                       constraints.js)
backend/src/domain/diversity.js                    — no change (correctly separated)
backend/src/orchestrator/index.js                  — no change
backend/tests/phase17_search_objectives.test.js    — 3 tests updated to assert compactness,
                                                       1 test renamed to reflect no-search-effect
backend/tests/phase17_1_session_objective.test.js    — 10 new tests for the corrected semantics
docs/PHASE_17_1_SESSION_OBJECTIVE.md               — this file
```

---

## 10. What remains blocked by data

The orchestrator still returns `MISSING_DATA` for the
authoritative teacher fixture because the fixture has no
branches, classes, curriculum, or assignments. The Phase 17.1
changes do not unblock real data integration — they correct the
semantics of one objective so the first real run on real data
will not silently push teachers toward fragmented schedules.

The next phase should:

1. Wire the production data sources (`chi_nhanh`, `lop`, `chuong_trinh`).
2. Plug a real `TravelProvider` so `H_TRAVEL_FEASIBLE` becomes
   active for cross-branch transitions.
3. Run A/B/C comparisons on the first real dataset and inspect
   the `comparison` block to choose a winner.
4. Consider adding `transferPenaltyScore` (an objective that
   tracks the share of slots that required a transfer) and
   `classDensityScore` (per-class slot concentration) — these
   are NOT new business rules; they are score functions derived
   from the existing model.

---

## 11. Definition of done (audit)

| Item                                                                | Status |
| ------------------------------------------------------------------- | ------ |
| `sessionDiversity` no longer rewards teacher fragmentation         | ✓      |
| Teacher session quality is separated from solution diversity        | ✓      |
| `S_PREFERRED_SESSION` still works                                   | ✓      |
| `S_MAX_SESSIONS_PER_WEEK` still works                              | ✓      |
| Travel interaction remains correct                                  | ✓      |
| Solution-level diversity (`structuralDiversity`) remains intact     | ✓      |
| Strategy schema (`objectives.sessionDiversity`, `weights.sessionDiversity`) preserved | ✓ |
| Solver source has no regex match on removed bias                    | ✓      |
| Existing 162 tests pass                                             | ✓      |
| 10 new regression tests pass                                        | ✓      |
| No invented production data                                         | ✓      |
| No LLM integration                                                  | ✓      |
| No architecture rewrite                                             | ✓      |