# PHASE 16 — SOLVER HARDENING

> Phase 16 audit + remediation of the solver core. The audit
> surfaced a series of correctness, performance, and contract
> defects. This document records every fix, the root cause, the
> tests that lock the contract, and the before/after behaviour.

No real dataset was loaded. No LLM was integrated. The frontend
was not touched.

---

## 1. Teacher cross-branch conflict (H_TEACHER_NO_DOUBLE_BOOK)

### Issue

A teacher can be at most one place at one time. The old
implementation used a `(branchId, day, period)` tuple as the
conflict key. A teacher scheduled at `(b1, 1, 1)` and at
`(b2, 1, 1)` was treated as two distinct slots, both accepted.

### Root cause

`slotKey(s) = ${branchId}:${day}:${period}` made the conflict
branch-specific. A teacher simultaneously teaching in two
branches at the same `(day, period)` was not detected.

### Fix

The conflict key is now `(teacherId, day, period)` — branch-
agnostic. The catalog entry `H_TEACHER_NO_DOUBLE_BOOK` was
rewritten to use `teacherSlotKey(slot) = ${day}:${period}` and
group by teacher first.

### Tests

- `validator.test.js` was already exercising H_TEACHER_NO_DOUBLE_BOOK
  via a same-branch double-book. We added a new test that puts the
  teacher in two different branches at the same `(day, period)`.
- A search-time test in `phase16_hardening.test.js` asserts that
  the solver returns `NO_SOLUTION` for the only such case.

### Before / After

| Scenario                                                | Before     | After          |
| ------------------------------------------------------- | ---------- | -------------- |
| Teacher at `(b1, 1, 1)` and `(b2, 1, 1)` (cross-branch) | accepted   | `H_TEACHER_NO_DOUBLE_BOOK` |

---

## 2. Teacher assignment as a real decision

### Issue

The solver was handed `Assignment.teacherId` and `Assignment.branchId`
as fixed. The decision space was `TimeSlot` only. The system's
shortage / surplus / preference / transfer logic had no place to
live — it was reported by `buildSituation` but never acted on.

### Root cause

`input.assignments` was treated as immutable by the search. The
solver iterated `input.timeSlotsByBranch.get(a.branchId)` and
picked a slot.

### Fix

Each assignment now has a list of decision variants:
`{ teacherId, branchId }`. The variant expansion lives in
`expandAssignmentVariants(a, input)` in `src/domain/constraints.js`:

- If `a.teacherId` is set, the teacher is fixed.
- If `a.teacherId` is null, every eligible teacher is a candidate.
- If `a.branchId` is set, the branch is fixed.
- If `a.branchId` is null, the slot must still land in the
  class's branch (a class only has one branch); the solver may
  transfer the teacher there when `allowedTransferBranches`
  permits it.

The search iterates variants per assignment. The chosen
`(teacherId, branchId)` is recorded in `solution.placements` and
is the source of truth for downstream stages (validator, scorer,
explainer).

### Tests

- `phase16_hardening.test.js`:
  - `expandAssignmentVariants: fixed teacherId yields one variant`
  - `expandAssignmentVariants: open teacherId yields all eligible teachers`
  - `expandAssignmentVariants: open branchId yields home + allowedTransfer only`
  - `solver: assignment with open branchId (null) lets the solver choose a non-home branch when allowed`

### Before / After

| Scenario                                          | Before                       | After                                       |
| ------------------------------------------------- | ---------------------------- | ------------------------------------------- |
| Assignment with `branchId: null`                  | solver uses `a.branchId`     | solver picks from `homeBranch + allowedTransfer`, intersected with class branch |

---

## 3. Fixed teacher vs solver-selected teacher

### Issue

A teacher can be either locked to an assignment (e.g. the school's
decree) or a decision to be optimised (e.g. when a curriculum row
leaves the choice open). The system had no way to express this.

### Fix

The `Assignment` model now accepts `teacherId: null` to mean "solver
picks". The expansion logic in `expandAssignmentVariants` filters
eligible teachers. The chosen teacher is captured in
`solution.placements`. The validator's H_TEACHER_ELIGIBLE check
uses the chosen teacher (via the merged view in
`withEffectiveMeta`).

The same is true for `branchId`: `null` means the solver decides
where the slot lands, subject to the teacher's transfer policy and
the class's location.

### Tests

- `expandAssignmentVariants` tests (see §2).
- A hand-crafted solution in the test file demonstrates that
  `placements` is the source of truth for the chosen (teacherId,
  branchId) when present, with fallback to `input.assignmentIndex`.

---

## 4. Transfer as an optimization decision

### Issue

`H_TRANSFER_ALLOWED` was a validator-only check. A teacher's
non-home placement was treated as a fixed property of the input.
The decision "do we transfer teacher X to branch Y?" was implicit
in the data, not in the search.

### Fix

`expandAssignmentVariants` enumerates `(teacherId, branchId)`
candidates for each assignment. For a teacher with
`homeBranchId: 'b1'` and `allowedTransferBranches: ['b2']`, the
variants for an open-branch assignment are `b1` and `b2`. The
search picks one. The validator (and the explainer) consult
`solution.placements` to know which branch was chosen.

The transfer is not a random choice; it is the first feasible
variant the search lands on. To bias the choice, the soft
preference `S_HOME_BRANCH` still applies, so a transfer is
incurred only when the search has no better alternative.

### Tests

- `H_TRANSFER_ALLOWED: accepts teacher with allowedTransferBranches including the destination`
- `H_TRANSFER_ALLOWED: rejects teacher without allowedTransferBranches for the destination`
- `solver: assignment with open branchId (null) lets the solver choose a non-home branch when allowed`

---

## 5. Travel participates in the solver

### Issue

Travel was a validator concern only. The solver placed a teacher
at `(b1, day=1, period=1)` and then at `(b2, day=1, period=2)`,
and only afterwards did the validator notice that the transition
was infeasible.

### Fix

The solver's `isHardFeasible` function now performs the same
travel check as `H_TRAVEL_FEASIBLE`. When a same-day,
cross-branch transition would exceed the transition window
(default 10 min), the candidate slot is pruned inside the search.

The validator's `H_TRAVEL_FEASIBLE` is the second line of defense.
It is unchanged in shape.

### Tests

- `H_TRAVEL_FEASIBLE: rejects an infeasible cross-branch transition`
  (validator).
- `solver: travel prune rejects an infeasible same-day cross-branch placement in the search`.
- The existing validator test `H_TRAVEL_FEASIBLE: INACTIVE when no travelTime provider` still passes.

### Before / After

| Scenario                                | Before                      | After                                              |
| --------------------------------------- | --------------------------- | -------------------------------------------------- |
| `(b1, 1, 1) → (b2, 1, 2)` with travel 60 min | validator reports a violation | search prunes; `NO_SOLUTION` if no alternative  |

---

## 6. Strategy weights affect search

### Issue

The preset strategies (A: preference-first, B: workload + travel,
C: balanced) declared different weight vectors but the search
treated them identically. `diversityScore` and `travelScore` were
hard-coded to 1 in the scorer.

### Fix

- `travelScore` is now a real function: the share of feasible
  same-day cross-branch transitions. Defined as
  `travelScoreFn(solution, input)` in `src/domain/constraints.js`.
- `workloadScore` is budget-aware (see §7).
- `diversityScore` is computed against the already-kept candidates
  BEFORE the overall score is finalised. The orchestrator passes
  the kept list to `score()`.
- The orchestrator's pipeline is now:
  - `candidate` → `verify()` (validator, independent) → `score()`
    with prior-kept candidates → dedupe by `minEditDistance` →
    sort by `overallScore`.

The test `strategies A/B/C on the same input: scores differ
measurably` asserts that at least two of the three strategies
produce distinct `overallScore` values for the same candidate
under the same seed.

---

## 7. Workload is budget-aware

### Issue

`workloadBalanceScore` used the coefficient of variation
(`sqrt(variance) / mean`) over slot counts. A teacher with
budget 20 getting 19 slots scored the same as a teacher with
budget 5 getting 6 slots, even though the second teacher is 20%
over budget and the first is 5% under. The metric meant "all
teachers should have similar counts" — which contradicts the
domain model where each teacher has a distinct weekly budget.

### Fix

`workloadBalanceScore(solution, input)` now computes
`1 - |actual - budget| / budget` per teacher, averaged over
teachers with a positive budget. A teacher at their budget
scores 1; a teacher at 0% of their budget scores 0. The
implementation counts actual slots (via `slot.teacherId` set by
the solver), not assignment entries.

### Tests

- `workloadScore: budget-aligned (actual == budget) is 1`
- `workloadScore: when a teacher exceeds budget by 100%, score is 0`
- `workloadScore: prefers alignment with per-teacher budget`

---

## 8. Class + Subject → one teacher

### Issue

Two assignments for the same `(classId, subjectId)` could be
scheduled with two different teachers. This is a hard data
integrity rule: a class has one teacher per subject, unless
explicitly split.

### Fix

A new hard constraint `H_CLASS_SUBJECT_ONE_TEACHER` is added to
the catalog. The check walks the solution and groups by
`(classId, subjectId)`. If more than one teacher appears under
the same key, a violation is reported.

The search-time equivalent is `isHardFeasible`'s check: when
placing a slot, the solver also tracks
`classSubjectTeacher[key] = teacherId` and prunes any
subsequent attempt to place a different teacher for the same
key.

### Tests

- `H_CLASS_SUBJECT_ONE_TEACHER: rejects two teachers for the same class-subject`
- `solver: H_CLASS_SUBJECT_ONE_TEACHER is enforced in the search`

---

## 9. Slot must belong to the assignment's branch

### Issue

`H_SLOT_IN_BRANCH` asked "is this slot in any branch profile?"
rather than "is this slot in the branch the assignment is in?"
A solver could place a slot at `(b2, 1, 1)` for an assignment
`branchId: b1` and the validator would not complain.

### Fix

`H_SLOT_IN_BRANCH` now requires `s.branchId === assignment.branchId`,
where `assignment.branchId` is the *effective* branch — the
assignment's branch when fixed, the class's branch when the
assignment has `branchId: null`. The validator merges
`solution.placements` into a view-input before running the
catalog; this is read-only.

### Tests

- `H_SLOT_IN_BRANCH: rejects a slot whose branchId differs from the assignment branchId`
- The pre-existing test in `validator.test.js` (slot not in any
  branch profile) still passes.

---

## 10. Session semantics

### Issue

`period <= 5 ? 'sang' : 'chieu'` was hard-coded in
`S_PREFERRED_SESSION`. A branch with periods 1..10 should be
able to declare its own session range; the soft preference
should honour that.

### Fix

`src/domain/time.js` exposes `sessionForSlot(slot, branch)`. The
function uses `branch.sessions` when provided (a map of
`sang: [periods]` and `chieu: [periods]`), and falls back to the
default cut-off (`period <= 5`) when no profile is given.
`S_PREFERRED_SESSION` calls this for each slot.

### Tests

- `sessionForSlot: derived from branch.sessions when provided`
- `S_PREFERRED_SESSION: respects branch.sessions map (not hardcoded <= 5)`

---

## 11. Max sessions counts (day, session) tuples

### Issue

`S_MAX_SESSIONS_PER_WEEK` counted distinct days, not sessions.
A teacher with `soBuoiToiDa: 3` teaching 3 mornings + 3 afternoons
on the same day was scored as 1 day (under cap), but the actual
workload is 6 sessions.

### Fix

The score now counts distinct `(day, session)` tuples, where
session is derived from the branch profile (see §10). A teacher
with one morning slot and one afternoon slot on the same day
counts as 2 sessions, not 1.

### Tests

- `S_MAX_SESSIONS_PER_WEEK: counts distinct (day, session) tuples`
- `S_MAX_SESSIONS_PER_WEEK: morning + afternoon on the same day is TWO sessions`

---

## 12. Diversity metric includes teacherId

### Issue

`diversity(a, b)` was `|slots(A) △ slots(B)| / |slots(A) ∪ slots(B)|`
where `slots(X) = { ${branchId}:${day}:${period} }`. Two solutions
that disagreed on the teacher at the same `(branch, day, period)`
were scored as `0` (identical), which is wrong: the teacher
identity is part of the solution.

### Fix

The slot identity is now
`${teacherId ?? ''}|${branchId}:${day}:${period}`. Two
solutions with the same placement but different teachers are
diverse.

### Tests

- `diversity: same (branch, day, period) but different teacher → non-zero diversity`
- `diversity: identical slot with same teacher → diversity 0`

---

## 13. Diversity scoring is in the pipeline

### Issue

The orchestrator used to compute `c.score.diversityScore = 1` for
all candidates, then *after* `overallScore` was already computed
walked the kept set and patched `diversityScore` to
`min(diversity(c, k) for k in kept)`. The semantics were
contradictory: `overallScore` did not include diversity, and the
diversity field was set without re-deriving `overallScore`.

### Fix

The orchestrator now:
1. Verifies each candidate (independent of the score).
2. Scores the first candidate with `priorCandidates = []`
   (diversity defaults to 1).
3. For each subsequent candidate, computes diversity against the
   already-kept list and includes it in `overallScore`. Candidates
   that fail the dedupe threshold are dropped.

The contract is: `overallScore` is the final, diversity-aware
score. The `diversityScore` field reflects the minimum distance
to any prior kept candidate.

### Tests

- `scorer: diversity score reflects prior candidates`
- `scorer: identity-equivalent second candidate gets diversity 0`
- `orchestrator pipeline: score is finalised with diversity from kept candidates`

---

## 14. Solution status: OK / EMPTY / MISSING_DATA / INVALID_INPUT

### Issue

The orchestrator could return `OK` even when every candidate was
rejected by the validator. Specifically, the code
`anyValid ? 'OK' : (allCandidates.length === 0 ? 'EMPTY' : 'OK')`
returned `OK` whenever any candidate existed, regardless of
acceptance.

### Fix

The status is now derived only from acceptance:

| Condition                                                       | Status        |
| --------------------------------------------------------------- | ------------- |
| `validateInput.issues.length > 0`                               | `INVALID_INPUT` |
| any of `Branch`, `Class`, `Curriculum`, `Assignment` missing    | `MISSING_DATA`  |
| at least one kept candidate has `validation.accepted === true`  | `OK`            |
| solver ran, candidates exist, none are accepted                 | `EMPTY`         |

### Tests

- `orchestrator: when no candidate is accepted by the validator → status EMPTY, never OK`
- Existing tests in `orchestrator.test.js` (MISSING_DATA and
  INVALID_INPUT) still pass.

---

## 15. Solver hard-constraint correctness

### Issue

The solver relied on the validator to catch hard-constraint
violations after the search. A bad solution could be produced
and only then discarded.

### Fix

The search prunes the following constraints in `isHardFeasible`:
- `H_TEACHER_NO_DOUBLE_BOOK` (teacher × day × period)
- `H_CLASS_NO_DOUBLE_BOOK` (class × day × period)
- `H_SLOT_IN_BRANCH` (slot.branchId === effective branch)
- `H_TRAVEL_FEASIBLE` (same-day cross-branch transition window)
- `H_CLASS_SUBJECT_ONE_TEACHER` (one teacher per class-subject)

The solver's `diagnostics.hardViolationCount` is 0 in well-formed
runs. The validator still runs and re-checks every constraint.

### Tests

- `solver: solutions are produced with hardViolationCount = 0`
- All hard-constraint tests in the validator file are unchanged
  and pass.

---

## 16. Solver vs validator independence

### Issue

The validator and the solver were both expected to share the
constraint catalog. The risk was that one would import the other
and turn validation into a repair pass.

### Fix

- The constraint catalog (`src/domain/constraints.js`) is read-only
  for both modules.
- `src/domain/validator.js` does not import `src/domain/solver.js`.
- `src/domain/solver.js` does not import `src/domain/validator.js`.
- The solver does not run a "repair" pass after a candidate is
  found; the candidate is already hard-clean by construction.

### Tests

- `validator: does not import the solver (read-only contract)`
- `solver: does not import the validator`

---

## 17. No invented data

The phase did not invent branches, classes, curriculum,
assignments, or travel data. The teacher fixture
(`data/fixtures/teachers.authoritative.json`) is untouched. New
synthetic inputs in the test files are clearly labelled
(`warnings: ['TEST MOCK ...']`) and are not loaded by any
production path.

---

## 18. Test report

```text
Phase 15:  98 tests
Phase 16: +33 tests
Total:    131 tests
Pass:     131
Fail:       0
```

The 33 new tests are in `backend/tests/phase16_hardening.test.js`.
No test was deleted to make the suite green.

---

## 19. Files changed

```
backend/src/domain/constraints.js   — H_TEACHER_NO_DOUBLE_BOOK key, H_SLOT_IN_BRANCH scope,
                                       H_CLASS_SUBJECT_ONE_TEACHER, expandAssignmentVariants,
                                       workloadBalanceScore (budget-aware), travelScoreFn,
                                       S_MAX_SESSIONS_PER_WEEK (session count),
                                       S_PREFERRED_SESSION (branch profile)
backend/src/domain/solver.js       — variant-based search, placements map,
                                       in-search hard-constraint prune
backend/src/domain/scorer.js       — travelScore + diversityScore in pipeline
backend/src/domain/validator.js    — placements-aware effective meta
backend/src/domain/diversity.js    — teacherId in slot identity
backend/src/domain/time.js         — sessionForSlot, profileOf, teacherSlotKey
backend/src/orchestrator/index.js  — pipeline order, status logic (OK/EMPTY/MISSING_DATA/INVALID_INPUT)
backend/tests/phase16_hardening.test.js  — 33 new tests
docs/PHASE_16_SOLVER_HARDENING.md  — this file
```

---

## 20. What remains blocked by data

The orchestrator still returns `MISSING_DATA` for the
authoritative teacher fixture because the fixture has no
branches, classes, curriculum, or assignments. The Phase 16
changes do not unblock real data integration — they harden the
solver so the first real run on real data behaves correctly when
data is provided.

The next phase should:

1. Wire the production data sources (`chi_nhanh`, `lop`, `chuong_trinh`).
2. Plug a real `TravelProvider` so `H_TRAVEL_FEASIBLE` becomes
   active for cross-branch transitions.
3. Plug a real `allowedTransferBranches` source so
   `H_TRANSFER_ALLOWED` becomes active.
4. Keep the constraint catalog read-only across modules.

---

## 21. Definition of done (audit)

| Item                                                    | Status |
| ------------------------------------------------------- | ------ |
| Teacher conflict cross-branch correct                   | ✓      |
| Teacher selection can be a decision                     | ✓      |
| Transfer is a real decision                             | ✓      |
| Travel participates in search                           | ✓      |
| Strategy weights affect optimization                    | ✓      |
| Workload budget-aware                                   | ✓      |
| Class + Subject → one teacher                           | ✓      |
| Slot belongs to assignment branch                       | ✓      |
| Session semantics from branch profile                   | ✓      |
| Diversity includes teacherId                            | ✓      |
| Diversity scoring in pipeline                           | ✓      |
| OK / EMPTY / MISSING_DATA / INVALID_INPUT correct       | ✓      |
| Validator independent of solver                        | ✓      |
| Existing 98 tests pass                                  | ✓      |
| 33 new regression tests pass                            | ✓      |
| No invented production data                             | ✓      |
| No LLM integration                                      | ✓      |
