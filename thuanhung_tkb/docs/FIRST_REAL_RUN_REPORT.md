# FIRST REAL RUN REPORT

> Phase 15 — what actually happened when the orchestrator was
> pointed at the current dataset.
>
> **The "first real run" in this phase is a no-solver run.** The
> dataset is not sufficient to schedule; the runtime correctly
> reports `MISSING_DATA` and stops. This document captures that
> behavior, the metrics it produced, and the questions it
> answers.

---

## 1. Overall quality

- **`status`** = `MISSING_DATA` (HTTP 200 with a structured
  `missingData` array).
- **`solutions`** = 0 (the solver was not invoked).
- **`strategiesAttempted`** = 0 across all three strategies
  (`A_PREFERENCE_FIRST`, `B_WORKLOAD_TRAVEL`, `C_BALANCED`).
- **`totalSolveMs`** = 0 ms (no time spent in the solver).
- **`hardViolations`** = 0 (the validator did not run, so this
  is "0 because the solver did not run", not "0 because the
  schedule was clean").

The system did not crash. It did not invent data. It did not
relax any constraint.

---

## 2. Preference satisfaction

Not measurable. There are 0 placed slots, so no soft preference
can be evaluated. The dataset is too small.

What the loader does report:

| Teacher | `nguyenVong`                                              | `homeBranchId` |
| ------- | --------------------------------------------------------- | -------------- |
| kim     | `{ soBuoiToiDa: 4, buoiUuTien: 'ca_hai', thuNghi: [] }`   | `null`         |
| thư     | `null`                                                    | `null`         |
| trinh   | `{ soBuoiToiDa: 4, buoiUuTien: 'chieu', thuNghi: [] }`    | `null`         |
| trâm    | `null`                                                    | `null`         |
| nản     | `null`                                                    | `null`         |

`thư`, `trâm`, `nản` have no `nguyenVong` in the authoritative
fixture (per the second brief). The system treats them as
`null` and never invents defaults.

---

## 3. Workload balance

Per-teacher workload from the authoritative fixture:

| hoTen | specializations                | workload |
| ----- | ------------------------------ | -------- |
| kim   | Công nghệ(1), Tin học(1)       | 2        |
| thư   | Tiếng Anh(4)                   | 4        |
| trinh | Mỹ thuật(1)                    | 1        |
| trâm  | Âm nhạc(1)                     | 1        |
| nản   | Giáo dục thể chất(2)           | 2        |
| **Total** | —                          | **10**   |

`workloadOf(t) = Σ chuyenMon[i].soTietTuan`. This is a runtime
computation; it is never stored. The fixture's authoritative
totals match the contract.

`S_BALANCED_WORKLOAD` and `S_HOME_BRANCH` are `INACTIVE` in
this run because:

- There are 0 assignments, so there is nothing to balance.
- Every `homeBranchId` is `null` (no branch data), so
  `S_HOME_BRANCH` is `INACTIVE`.

---

## 4. Transfer

Not measurable. There are 0 transfers because there are 0
placements. `H_TRANSFER_ALLOWED` is `INACTIVE` because no
teacher has an `allowedTransferBranches` array.

---

## 5. Travel

`travelTime === null`. `H_TRAVEL_FEASIBLE` is `INACTIVE` and
the validator reports it in `inactiveConstraints` if a
solution ever runs.

The dataset loader accepts a `travel.matrix` entry. The
`makeTravelProvider(matrix)` factory wraps it. No travel
matrix was supplied for this run, so the constraint stayed
`INACTIVE`.

---

## 6. Diversity

With 0 solutions across all 3 strategies, the diversity matrix
is undefined. The metric
`|slots(A) △ slots(B)| / |slots(A) ∪ slots(B)|` is well-defined
in code; the runtime did not produce a pair of solutions to
measure.

`S_DIVERSITY_FROM_PRIOR` is `INACTIVE` for the same reason.

---

## 7. Pattern analysis ("TKB một màu")

Not measurable. There is no schedule to inspect. The metrics
that would normally live here are:

- **Daily distribution** — `slotsByDay` histogram per teacher.
- **Period distribution** — `slotsByPeriod` histogram.
- **Subject distribution** — same subject clustering on the
  same day.
- **Teacher workload pattern** — total slots per teacher, vs
  their `budget(t)`.
- **Free-period pattern** — gap count per teacher-day.
- **Session distribution** — `sang`/`chieu`/`ca_hai` counts.

All of these are reported by the validator in `metrics` once a
solution exists. In this run, none of them are produced.

The synthetic end-to-end test
(`tests/end_to_end.test.js`) demonstrates the metrics
plumbing: it produces a small schedule and the validator
fills `coverage`, `metrics.distinctDaysUsedByTeacher`, and
`metrics.slotsByBranchDayPeriod`. The test runs are not a
real run; they are a TEST MOCK DATA fixture labeled
accordingly.

---

## 8. Runtime

The actual times for the missing-data path:

| Step                                    | Time (ms) |
| --------------------------------------- | --------- |
| Loader (fixture)                        | ~10       |
| Orchestrator (validation + reporting)   | ~5        |
| Solver                                  | 0 (skipped) |
| Validator                               | 0 (skipped) |
| Scorer                                  | 0 (skipped) |
| Diversity                               | 0 (skipped) |
| Total round-trip for `preview`          | ~15       |

There is no solver bottleneck to optimize in this run. The
synthetic end-to-end test (which does invoke the solver)
spends a few hundred ms on a 2-class, 2-period scenario.

---

## 9. Bottleneck

The bottleneck is **data**, not code. The orchestrator's
contract and the solver's contract are aligned; the validator
is independent; the AI strategy is parameterized. The reason
the system cannot produce a real solution is the absence of
branches, classes, curriculum and assignments.

The next step is data, not code:

1. Provide a JSON dataset file (or a MongoDB collection) with
   `branches`, `classes`, `curriculum` and (optionally)
   `assignments` and `travel`.
2. Set `DATASET_PATH` (or `MONGODB_URI` once the Mongo loader
   is built) and re-run `preview`.
3. The system will then report `OK` (with solutions) or
   `INVALID_INPUT` (with the broken-reference list) or
   `MISSING_DATA` again (with the still-missing list).

---

## 10. Answers to the FINAL OUTPUT questions

1. **Real data đã đủ chưa?** — No. Only Teacher is READY.
   Branch, Class, Curriculum, Assignment, Travel are MISSING.
2. **Solver có chạy được không?** — No. The orchestrator
   refuses to call it because critical entities are missing.
3. **Có hard violation không?** — None observed; the solver
   was not run.
4. **Còn shortage bao nhiêu?** — Not computable. There is no
   demand, so `shortage` is `[]` and `surplus` is `[]`. The
   `subjectDemand` map is empty.
5. **Transfer hoạt động thế nào?** — Not exercised. No
   teacher has a `homeBranchId` or `allowedTransferBranches`,
   so `H_TRANSFER_ALLOWED` is `INACTIVE`.
6. **Travel constraint đã có dữ liệu chưa?** — No. The travel
   matrix is not supplied. `H_TRAVEL_FEASIBLE` is `INACTIVE`.
7. **Preference satisfaction bao nhiêu?** — Not measurable.
   No slots placed.
8. **Các solution khác nhau bao nhiêu?** — Not measurable.
   0 solutions.
9. **TKB có còn pattern "một màu" không?** — Not measurable.
   No schedule to inspect.
10. **Bottleneck hiện tại là gì?** — Data. Specifically:
    branches, classes, curriculum, assignments. Code is
    ready; the dataset is not.
11. **Bước tiếp theo cần data hay cần code?** — **Data.** The
    loader, orchestrator, validator, solver, scorer, and AI
    strategy are all in place. They are not the bottleneck.

---

## 11. Bug policy compliance

The system did not fall back to invented data, did not relax
any constraint, did not insert a `if` to bypass the missing
data, and did not fake an AI call. This is the only correct
behavior under the Phase 15 contract.
