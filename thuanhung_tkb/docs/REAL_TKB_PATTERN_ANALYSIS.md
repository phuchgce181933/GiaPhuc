# REAL TKB PATTERN ANALYSIS

> Phase 18 §15 — the "one-color" structural inspection of the
> real dataset's output.
>
> **There is no schedule to inspect today.** The orchestrator
> refuses to invoke the solver on the authoritative dataset
> because the operator has supplied teacher data only; every
> other entity (`Branch`, `Class`, `Curriculum`, `Assignment`,
> `Travel`) is missing. This document therefore has two
> purposes:
>
> 1. **Audit today** — prove that the system is honestly
>    reporting "no schedule exists" and not silently emitting
>    a degenerate TKB from invented data.
> 2. **Future inspection template** — list the exact
>    histograms and pattern checks the validator would emit
>    the moment a real schedule exists, so the next phase can
>    fill them in without re-deriving the contract.

No code was written to fake patterns. No code was written to
synthesize a schedule. The validation infrastructure
(`src/domain/validator.js`, `src/domain/scorer.js`,
`src/domain/diversity.js`) is unchanged.

---

## 1. The five questions from §15

| Question                                                              | Answer today (no schedule)            |
| -------------------------------------------------------------------- | ------------------------------------- |
| Do same subjects always use same periods?                            | Not measurable — no placements.       |
| Do same teachers always use same patterns?                           | Not measurable — no placements.       |
| Do same classes have identical distributions?                        | Not measurable — no class timetable.  |
| Is morning/afternoon placement repetitive?                           | Not measurable — no placements.       |
| Are multiple solutions structurally different?                       | Not measurable — 0 solutions.         |

The diversity metric (`structuralDiversity.overall` and the
`teacherDay` / `sessionMix` components) is correctly
implemented and tested (`tests/diversity.test.js`); it has no
value to report today because there are no candidate
solutions to compare.

---

## 2. What the validator would emit once a schedule exists

The validator already exposes the histograms below; they are
populated per-candidate and surfaced through the orchestrator
response. They are listed here so the next phase can read them
straight off the response and pipe them into the inspection
table.

| Histogram                                  | Where it lives                            |
| ------------------------------------------ | ----------------------------------------- |
| `slotsByDay` (per teacher)                 | `validator.metrics.slotsByDay`            |
| `slotsByPeriod` (per teacher)              | `validator.metrics.slotsByPeriod`         |
| `distinctDaysUsedByTeacher`                | `validator.metrics.distinctDaysUsedByTeacher` |
| `slotsByBranchDayPeriod`                   | `validator.metrics.slotsByBranchDayPeriod` |
| `coverage`                                 | `validator.metrics.coverage`              |
| Per-teacher subject distribution            | `scorer.subjectsByTeacher`                |
| Per-class timetable                        | reconstructed by group-by `(classId, day, period)` |
| Sang/chieu split per teacher               | reconstructed by group-by `(teacherId, day)` |
| Free-period (gap) count per teacher-day     | reconstructed by group-by `(teacherId, day)` |
| Transfer count + branch-to-branch matrix   | reconstructed from per-slot `transfer` flag |

When the orchestrator returns `OK`, each of these is on the
response. Today, the orchestrator returns `MISSING_DATA`, so
none of these exist in the response.

---

## 3. "One-color" patterns to look for (template, not result)

A "one-color" TKB is one where many distinct roles collapse
into the same slot. The validator already classifies each
slot by `(branchId, day, period, classId, teacherId,
subjectId)`. The five patterns below are the ones Phase 18
§15 asks about; each can be detected directly from the
candidate's `placements` array.

#### 3.1 Same subject, same periods

```text
hist = group placements by subjectId → for each subject,
       compute the set of (day, period) it occupies;
       if any subject occupies the same set across ≥1 class,
       that subject is "same-period for multiple classes."
```

Symptom: a teacher concerned about pedagogical cadence would
flag this. It is **not** a hard violation; it is a soft
distribution observation. The scorer has no dedicated
subject-spread objective today; if a future phase wants one,
it would live next to the existing scorer (`src/domain/scorer.js`),
not as a hard constraint.

#### 3.2 Same teacher, same pattern

```text
for each teacher t, compute (subject→{day,period}) map;
      cluster teachers whose maps are equivalent.
```

Symptom: "teacher X has Tue-P3 always" → pattern lock.
Today, the workload objective
(`weights.workload` / `weights.balancedWorkload`) penalizes
the opposite (uneven spread). This pattern is therefore
already an indirect objective, but it is not yet scored as
"is the teacher's slots distribution too repetitive?". It
would live in `scorer.js` if added.

#### 3.3 Same class, identical distribution

```text
for each class c, compute its (day, period) set;
      cluster classes whose sets are equivalent.
```

Symptom: "class A and class B share exactly the same slots" →
the two classes are de-facto interchangeable for the solver.
This is **expected** in many real schedules (parallel classes
sharing the same off-period for the same subject). It is not
a violation. It is not a pattern that needs fixing.

#### 3.4 Repetitive sang/chieu placement

```text
for each teacher t, compute (sang/chieu) per day;
      if any teacher has the same (sang/chieu) for ≥4 days,
      flag as "session rhythm."
```

The corrected session-diversity semantic from Phase 17.1
(`sessionDiversityScore = 1 - splitDays / totalDays`) already
rewards compactness; a teacher doing the same session every
day scores 1 on compactness. No further scoring is required
to avoid "one-color session placement."

#### 3.5 Multiple solutions structurally different?

```text
diversity(A, B) = |slots(A) △ slots(B)| / |slots(A) ∪ slots(B)|
structuralDiversity(A, B).teacherDay = mean over teachers of
                                  |days(A) △ days(B)| / |days(A) ∪ days(B)|
structuralDiversity(A, B).sessionMix = mean over teachers of
                                  |sessions(A,t) △ sessions(B,t)|
structuralDiversity(A, B).overall = 0.6*teacherDay + 0.4*sessionMix
```

The orchestrator's diversity threshold is `0.15`
(`strategies[0].diversification.minEditDistance`). The
threshold is preserved from earlier phases; this phase does
not change it. If a future benchmark on real data proves it
too lax or too strict, that is a Phase 18 follow-up, not a
Phase 18 change.

---

## 4. Audit of today's behavior

A one-off probe (now removed) called the orchestrator with
`{ solutions: 1..3, strategies: ['A_PREFERENCE_FIRST',
'B_WORKLOAD_TRAVEL', 'C_BALANCED'] }` against the current
authoritative dataset. Every probe returned:

```text
status: 'MISSING_DATA'
solutions: 0
strategiesAttempted: 0
totalSolveMs: 0
```

There is no degeneracy to flag. The system did not produce a
fake TKB. There is nothing to "fix" because there is nothing
to inspect. This is the audit.

---

## 5. Naturalness check (today)

The Phase 18 §17 categories (`Hard violation`, `Soft
violation`, `Optimization weakness`, `Presentation issue`,
`Human preference`) are all **unobservable** today because
there is no schedule. The validator would emit `Hard
violation` via `verify(...)` and the scorer would emit
`Soft violation` via the corresponding `S_*` weights; both
paths return empty arrays on the current dataset because the
orchestrator short-circuits before the solver runs.

No business rule was added in this phase. No hard constraint
was promoted. No optimization problem was changed. The only
phase in which a near-rule was considered (Phase 17.1's
session-diversity semantic) was a **correction**, not an
addition; it removed a search-time bias that contradicted
existing objectives.

---

## 6. What the next phase will see

When the operator supplies `branches`, `classes`, `curriculum`
(and optionally `assignments`, `travel`), the orchestrator
will return `OK` with up to `N` solutions. The next phase will
be able to populate this document with:

- per-teacher timetable tables (5 teachers, one row per
  `(day, period)`),
- per-class timetable tables (one row per `(day, period)`),
- subject-by-period histogram (does any subject lock onto
  the same period for every class?),
- daily distribution histogram (does every teacher work the
  same number of days?),
- sang/chieu split per teacher,
- workload balance report (budget vs actual per teacher),
- transfer report (if `homeBranchId` is eventually supplied),
- travel report (if a travel matrix is supplied),
- preference satisfaction (satisfied / partially / not per
  teacher).

The exact data point is that the validator and scorer
already produce all of these fields; the JSON keys are listed
in §2. No code change is needed to populate them. The next
phase will not need to re-derive the contract.

---

## 7. Phase 18 audit conclusion

```text
TKB "một màu" today?       Unmeasurable (no TKB).
TKB produced this phase?    No.
Degenerate fallback used?   No (orchestrator refused solver).
Patterns to inspect?        Templates present (this §2 and §3).
Code added for fake patterns? No.
Code changed in this phase? No.
```

The structural / human-readable scan is intentionally empty
today; the template is in place for the moment the operator
supplies the missing sources. This is the correct Phase 18
artifact under the §15 brief: a pattern-analysis document
that exists, but is honest about what it can and cannot say
on the current dataset.