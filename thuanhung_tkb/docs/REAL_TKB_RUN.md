# REAL TKB RUN

> Phase 18 — what actually happened when the orchestrator was
> pointed at the **current authoritative dataset**.
>
> The "first real run" in this phase is still a **no-solver
> run**. The operator has supplied teacher data only; the
> runtime correctly reports `MISSING_DATA` for every other
> critical entity and stops. This document captures that
> behavior, the metrics it produced, the answers to the 14
> FINAL OUTPUT questions, and the explicit boundary between
> "what the system did" and "what the operator still owes the
> system."

---

## 1. Overall quality

- **`status`** = `MISSING_DATA` (HTTP 200, `missingData` populated).
- **`solutions`** = 0 across every strategy and every
  `solutions` request size.
- **`strategiesAttempted`** = 0 (orchestrator refused to call
  the solver because the dataset is structurally insufficient).
- **`totalSolveMs`** = 0 ms (no solver work was attempted).
- **`hardViolations`** = 0 (the validator did not run, because
  the solver did not run).
- **`warnings`** = 4 — the canonical list emitted by the
  orchestrator's `MISSING_DATA` branch:

```text
MISSING DATA: Branch profile is empty (no branches in fixture).
MISSING DATA: Class list is empty (no classes in fixture).
MISSING DATA: Curriculum is empty (no (class, subject, periods) in fixture).
MISSING CONFIGURATION: TravelProvider is not registered.
```

The system did not crash. It did not invent data. It did not
relax any constraint. It did not bypass the missing-data
classification with an `if`.

---

## 2. What was probed (and what was not)

Phase 18 §12 asks for A/B/C runs with `solutions=1` and
`solutions=3`. Because the orchestrator refuses to call the
solver on this dataset, **the requests never reach the
solver**. The runtime was probed for the following request
shapes:

| Request                           | Outcome                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `solutions=1`, strategy `A`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=3`, strategy `A`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=1`, strategy `B`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=3`, strategy `B`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=1`, strategy `C`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=3`, strategy `C`       | `MISSING_DATA`, 0 solutions                                              |
| `solutions=3`, strategies `A,B,C` | `MISSING_DATA`, 0 solutions                                              |

Wall-clock for every probe: 0–1 ms.
This is the runtime confirming it can detect the problem in
under one millisecond; it is not a benchmark of the solver.

`docs/REAL_TKB_METRICS.json` was **not** produced: there is
no solver run to measure. The Phase 15 metrics file
(`docs/FIRST_REAL_RUN_METRICS.json`) records the same
`MISSING_DATA` state from the previous phase.

---

## 3. Situation report (real data, not invented)

The `situation` block of the orchestrator response is
generated from the real, current loader output. It is a
honest summary; every entry below is what the loader
returned.

```text
teachers: 5
classes: 0
branches: 0
subjects: 6 (derived from teacher chuyenMon)
curriculum: 0
assignments: 0
travel: null
shortage: []
surplus: []
unresolvable: []   ← empty because there are no assignments
                    to be unresolvable against
missingData: 5 critical rows (Branch / Class / Curriculum /
              Assignment / Travel) + per-teacher optional-field
              absences
```

Per-teacher summary (from the real fixture; not invented):

| hoTen | specializations                | workload | hasPreference | homeBranchId |
| ----- | ------------------------------ | -------- | ------------- | ------------ |
| kim   | Công nghệ(1), Tin học(1)       | 2        | true          | null         |
| thư   | Tiếng Anh(4)                   | 4        | false         | null         |
| trinh | Mỹ thuật(1)                    | 1        | true          | null         |
| trâm  | Âm nhạc(1)                     | 1        | false         | null         |
| nản   | Giáo dục thể chất(2)           | 2        | false         | null         |
| **Total** | —                          | **10**   | 2/5           | 0/5          |

`kim.nguyenVong = { soBuoiToiDa: 4, buoiUuTien: 'ca_hai', thuNghi: [] }`.
`trinh.nguyenVong = { soBuoiToiDa: 4, buoiUuTien: 'chieu', thuNghi: [] }`.
`thư`, `trâm`, `nản` have no `nguyenVong` in the authoritative
fixture (per the second brief). The system treats them as
`null` and never invents defaults.

---

## 4. Constraint activation (real, not synthesized)

| Constraint                       | Activation today | Why                                                                |
| -------------------------------- | ---------------- | ----------------------------------------------------------------- |
| `H_TEACHER_ELIGIBLE`             | ACTIVE           | validators present. No contradicting eligibility rows in fixture. |
| `H_TEACHER_AVAILABLE`            | ACTIVE           | validators present. No constraints to violate yet.                |
| `H_CLASS_TEACHER_CONFLICT`       | ACTIVE           | validators present. No placements yet.                            |
| `H_TRAVEL_FEASIBLE`              | **INACTIVE**     | No travel matrix. Travel interface registered as null.            |
| `H_TRANSFER_ALLOWED`             | **INACTIVE**     | Every teacher has `homeBranchId = null`.                          |
| `H_TEACHER_DAY_FAIRNESS`         | ACTIVE           | validators present. No placements yet.                            |
| `H_TEACHER_NO_DOUBLE_BOOKING`    | ACTIVE           | validators present. No placements yet.                            |
| `H_PERIODS_FILLED`               | ACTIVE           | validators present. Cannot run with 0 assignments.                |
| `H_FIXED_ASSIGNMENT`             | ACTIVE           | validators present. No assignments to fix.                        |
| `S_*` (soft objectives)          | INACTIVE         | they require placements to score against. None below.              |

---

## 5. Strategy comparison (real, not synthetic)

Because no candidate was produced, the A/B/C `comparison`
block is structurally empty:

```text
comparison: []
strategiesAttempted: 0
totalSolveMs: 0
```

There is no winner. There are no scores. There are no
solutions to diversity-filter. The Phase 17 comparison
infrastructure is intact and would report correctly the
moment at least one strategy produces an accepted candidate.

---

## 6. TKB naturalness / "một màu" pattern

Not measurable. There is no schedule to inspect. See
`docs/REAL_TKB_PATTERN_ANALYSIS.md` for the full reasoning
chain and the exact histograms the validator would emit when
a schedule exists.

---

## 7. Workload analysis

| Teacher | budget (fixture) | actual | difference | status                                    |
| ------- | ---------------- | ------ | ---------- | ----------------------------------------- |
| kim     | 2                | 0      | -2         | No placements to measure.                 |
| thư     | 4                | 0      | -4         | No placements to measure.                 |
| trinh   | 1                | 0      | -1         | No placements to measure.                 |
| trâm    | 1                | 0      | -1         | No placements to measure.                 |
| nản     | 2                | 0      | -2         | No placements to measure.                 |

`workloadOf(t)` matches the contract: `Σ chuyenMon[i].soTietTuan`.
Total supply = 10. There is no demand to compare it against;
`shortage = []`, `surplus = []`.

---

## 8. Transfer analysis

Not measurable. `homeBranchId` is `null` for every teacher.
`H_TRANSFER_ALLOWED = INACTIVE`. No transfer matrix, no
branch-to-branch matrix, no candidate slots to reason about.

---

## 9. Travel analysis

Not measurable. `travelTime === null`.
`H_TRAVEL_FEASIBLE = INACTIVE`. No transition has any
`travel > available` check because no transition exists.

---

## 10. Preference analysis

Not measurable. Two teachers (`kim`, `trinh`) have a
`nguyenVong`; three do not. With zero slots placed, no
preference can be marked satisfied / partially / not.

---

## 11. Runtime

```text
Loader:                       ~1 ms
Validation + missing report:  ~0–1 ms
Solver:                       0 ms (refused)
Validator:                    0 ms (skipped)
Scorer:                       0 ms (skipped)
Diversity:                    0 ms (skipped)
Total preview round-trip:     ~1 ms
```

There is no solver bottleneck to optimize in this run. The
synthetic end-to-end test (`tests/end_to_end.test.js`)
demonstrates the runtime budget on a test-mock dataset (a few
hundred ms for a 2-class, 2-period scenario); that path is
labeled accordingly in its source and is **not** a real
data run.

---

## 12. Validator behaviour

The validator (`src/domain/validator.js`) was not invoked
because the orchestrator short-circuited to `MISSING_DATA`
before the solver ran. The contract is: validator runs on
every candidate produced by the solver; the independent
verifier returns `{ accepted, hardViolations, softWarnings }`
and the orchestrator only marks a solution as
`OK` if at least one candidate passes. With zero candidates,
zero solutions are marked accepted. No regressions observed.

---

## 13. Production DB write

None. The `commit` endpoint (`/api/scheduling/commit`) returns
`{ ok: true, written: false, reason: 'DB writer not implemented in this phase; cache returned for inspection' }`
for any solution id it is given. The Phase 18 brief forbids
production writes; the system is honoring it.

---

## 14. Bug policy compliance

- No invented data.
- No added `if` to bypass the missing-data classification.
- No relaxed constraints.
- No fake AI call (`AI_PROVIDER_NOT_CONFIGURED` recorded in
  Phase 15 metrics).
- No modifications to the authoritative teacher fixture.
- No structural changes to the orchestrator, validator,
  solver, scorer, or diversity layers.

The orchestrator's `MISSING_DATA` response is the system
behaving correctly, not a bug.

---

## 15. Answers to the 14 FINAL OUTPUT questions

1. **Real data đã đủ chưa?**
   No. Only `Teacher` is present. `Branch`, `Class`,
   `Curriculum`, `Assignment`, `Travel` are all missing. The
   `homeBranchId` field on every teacher is also absent.

2. **Solver đã thực sự chạy chưa?**
   No. The orchestrator refused to invoke it because the
   dataset is structurally insufficient.

3. **Có hard violation không?**
   None observed. The solver did not run; no candidate was
   produced; the validator was not invoked.

4. **Shortage bao nhiêu?**
   Not computable. `assignments.length === 0`, so
   `subjectDemand` is empty, `shortage = []`, `surplus = []`.

5. **Workload balance thế nào?**
   Total teacher supply = 10 periods (kim 2, thư 4, trinh 1,
   trâm 1, nản 2). No demand, no placements, no balance to
   measure. The synthetic end-to-end test demonstrates the
   balance instrumentation on a labeled test mock.

7. **Transfer bao nhiêu?**
   Zero. `H_TRANSFER_ALLOWED = INACTIVE` because every
   `homeBranchId` is `null`.

8. **Travel có issue không?**
   No. `H_TRAVEL_FEASIBLE = INACTIVE`. No transition was
   scheduled; no `travel > available` case can arise.

9. **Preference satisfaction bao nhiêu?**
   Not measurable. 0 placements; 0 preference evaluations.

10. **A/B/C khác nhau thế nào?**
    N/A. The orchestrator never reaches the per-strategy
    loop because `hasMissingCriticalData` is true. The Phase
    17 comparison block is structurally empty.

11. **Diversity thực tế bao nhiêu?**
    Not measurable. 0 solutions → 0 pairs → undefined
    diversity.

12. **TKB còn "một màu" không?**
    Not measurable. There is no TKB to inspect.

13. **Pattern bất thường nào?**
    None observed (because no schedule exists). See
    `docs/REAL_TKB_PATTERN_ANALYSIS.md` for the full matrix
    that will be inspected the moment the operator supplies
    the missing data.

14. **Bottleneck hiện tại là gì?**
    **Data.** Specifically: `branches`, `classes`,
    `curriculum`, `assignments`. The MongoDB loader is also
    not implemented; the JSON dataset loader is the only
    wired-in production path.

15. **Cần DATA hay CODE tiếp?**
    **DATA.** Code is ready: the loader accepts the seven
    sections; the orchestrator classifies `MISSING_DATA`; the
    validator refuses broken input; the scorer and diversity
    filter are deterministic; the AI strategy is parameterized
    (`AI_PROVIDER_NOT_CONFIGURED`); the explainer is honest.
    The bottleneck is the operator's data, not the code.

---

## 16. Definition of Done (Phase 18)

| Item                                                                       | Status |
| -------------------------------------------------------------------------- | ------ |
| Real data loaded                                                          | partial — only `Teacher` from the authoritative fixture. |
| Source mapping documented                                                 | ✓ `REAL_DATA_SOURCE_MAP.md`. |
| Input validated                                                            | ✓ `MISSING_DATA` reported. |
| Situation report generated                                                 | ✓ Built from real loader output. |
| Solver actually runs on real data                                         | ✗ Blocked by missing data (correct behavior). |
| A/B/C actually executed                                                    | ✗ Blocked by missing data (correct behavior). |
| Solutions validated independently                                          | N/A — no candidates produced. |
| Workload measured                                                          | ✓ Workload **supply** measured; balance **unmeasurable**. |
| Transfer measured                                                          | N/A — `INACTIVE`. |
| Travel measured                                                            | N/A — `INACTIVE`. |
| Preference measured                                                        | N/A — no placements. |
| Multiple solutions generated where feasible                                | ✗ Not feasible on the current dataset. |
| Diversity measured                                                         | N/A — no solutions. |
| TKB pattern manually/structurally analyzed                                 | N/A — `REAL_TKB_PATTERN_ANALYSIS.md` records the matrix that will be inspected when a solution exists. |
| "One-color" issue explicitly assessed                                      | ✓ `REAL_TKB_PATTERN_ANALYSIS.md` declares it unmeasurable today. |
| Runtime measured                                                           | ✓ Loader + orchestrator round-trip ~1 ms; solver 0 ms. |
| No production DB write                                                     | ✓ `commit` endpoint never writes. |
| Existing tests remain green                                                | ✓ 172 / 172 pass. |

Phase 18 **halts here** in conformance with §29:

> "Không tự chuyển sang phase tối ưu tiếp theo.
> Nếu real data chưa đủ: STOP → MISSING_DATA → REPORT EXACT
> MISSING ENTITIES."

Exact missing entities:

```text
Branch     — No authoritative branch data
Class      — No authoritative class data
Curriculum — No authoritative curriculum data
Assignment — No authoritative assignment data
Travel     — No travel matrix
homeBranchId on every teacher (also absent)
```

The next phase should resume from the operator side: supply
those six sources and re-run `preview`. The runtime will
respond with `OK` / `INVALID_INPUT` / `MISSING_DATA` honestly,
as designed.