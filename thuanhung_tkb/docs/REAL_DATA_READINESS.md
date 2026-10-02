# REAL DATA READINESS

> Phase 14 — auditing the implementation against `DOMAIN.md`,
> `SCHEDULING_MODEL.md`, `DATA_CONTRACT.md`, and the
> `SCHEDULING_DATA_CONTRACT.md`; documenting the readiness of each
> data source; codifying the no-invention rule and the
> `MISSING_DATA` / `INVALID_INPUT` contract.

This document does not introduce new business logic. It is the
audit trail: which data sources are present, which are missing,
how each one is loaded, normalized, validated, and what the
runtime does when a piece is absent.

---

## 1. Audit findings

Cross-referencing the implementation with the Phase 1 contracts
surfaced one discrepancy:

| # | Document says                                          | Implementation does                              | Action                                  |
| - | ------------------------------------------------------ | ------------------------------------------------ | --------------------------------------- |
| 1 | `validateInput` returns `{ issues, missing }` and the orchestrator must refuse the solver only on `issues`. | The orchestrator still consumed a non-existent `validation.ok` flag, so the empty fixture was incorrectly classified as `INVALID_INPUT` instead of `MISSING_DATA`. | Fixed `orchestrator/index.js` — uses `issues.length > 0` as the only `INVALID_INPUT` trigger. `missing` is reported as `MISSING_DATA` and the solver is skipped. |

All other audited behavior matches the documented contracts.
The authoritative teacher fixture is loaded byte-for-byte; the
solver, validator, scorer, diversity filter and explainer all
share the constraint catalog via a read-only module; the AI
strategy layer only mutates the strategy presets, never the data.

---

## 2. Authoritative data

| File                                                | Status      | Notes                                         |
| --------------------------------------------------- | ----------- | --------------------------------------------- |
| `data/fixtures/teachers.authoritative.json`         | **immutable** | The 5 teachers (`kim`, `thư`, `trinh`, `trâm`, `nản`). Source of truth for all tests. Must not be sorted, renamed, normalized, capitalized, deduplicated, or "completed" in any way. |

### Untouched-by-implementation rules

- The loader (`src/loader/fixture.js`) reads the file with
  `JSON.parse` and never mutates the result.
- `normalizeTeacher` (`src/domain/teacher.js`) maps the raw
  record to the contract shape. It does not invent fields; it
  surfaces the absence of `nguyenVong`, `email`,
  `soDienThoai`, `homeBranchId` via `teacherMissingFields`.
- The `updatedAt` quirk (string for `nản`, `$date` object for
  everyone else) is preserved as-is by the loader; nothing
  coerces one to the other.

---

## 3. Real data sources — readiness

The system accepts each data source through a dedicated section
of `validateInput`. A row in the table below applies to the
**production** path (MongoDB collection) and the **test** path
(loader). When a source is `MISSING_DATA`, the runtime must
**never** fall back to invented values; it must report
`MISSING_DATA` in the preview response and skip the solver.

### 3.1 Teacher

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | `giao_vien` collection (loader stub: `MongoDB loader is not implemented in this phase. Use the fixture.`) |
| Source (test)        | `data/fixtures/teachers.authoritative.json`                     |
| Schema               | see `SCHEDULING_DATA_CONTRACT.md §2`                            |
| Required fields      | `id`, `hoTen`, `chuyenMon[]`                                    |
| Optional fields      | `email`, `soDienThoai`, `nguyenVong`, `homeBranchId`            |
| Loader               | `src/loader/fixture.js` → `normalizeTeacher`                    |
| Normalization        | `_id.$oid` → `id`; `chuyenMon[]` preserved; `nguyenVong` null when absent |
| Validation           | `validateInput §1` — duplicate id, missing `hoTen`, empty `chuyenMon[]` |
| Missing-data behavior | Loader reports the absent optional fields; runtime treats them as `null`/`undefined`; `homeBranchId=null` makes `H_TRANSFER_ALLOWED` `INACTIVE` |

### 3.2 Branch

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | `chi_nhanh` collection                                         |
| Source (test)        | `MISSING DATA` (the fixture has no branch records)              |
| Schema               | `id` (req), `name` (req), `schoolDays[]` (req), `periods[]` (req) |
| Loader               | none yet — interface only                                       |
| Normalization        | `slotsForBranch(branch)` derives the slot set                   |
| Validation           | `validateInput §2` — every loaded branch must have `id`, `schoolDays[]`, `periods[]` |
| Missing-data behavior | When empty, `MISSING_DATA { entity: 'Branch', reason: 'No authoritative branch data' }` is added; the orchestrator classifies this as `MISSING_DATA` and the solver is skipped. |

### 3.3 Class

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | `lop` collection                                               |
| Source (test)        | `MISSING DATA` (no class records in the fixture)                |
| Schema               | `id` (req), `branchId` (req), `name` (req), `gradeLevel` (req)  |
| Loader               | none yet — interface only                                       |
| Validation           | `validateInput §3` — `branchId` must exist in `branches`; otherwise `invalid_reference` |
| Missing-data behavior | Same as Branch.                                                |

### 3.4 Subject

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | derived from teacher `chuyenMon` and any explicit subject collection |
| Source (test)        | derived verbatim from the fixture's `chuyenMon[].tenChuyenMon`  |
| Schema               | `id`/`name` (req), `aliases` (opt)                              |
| Validation           | `validateInput §4` — `id` and `name` both required and unique; matching is by exact string |
| Missing-data behavior | The runtime never invents subjects. When a Curriculum references a subject that no teacher has, `INFEASIBLE_DEMAND` is reported. |

### 3.5 Curriculum

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | `chuong_trinh` collection (or derived)                         |
| Source (test)        | `MISSING DATA` (no records in the fixture)                      |
| Schema               | `classId` (req), `subjectId` (req), `requiredPeriods` (req, integer >= 0) |
| Loader               | none yet — interface only                                       |
| Validation           | `validateInput §5` — both `classId` and `subjectId` must exist  |
| Missing-data behavior | When empty, `MISSING_DATA { entity: 'Curriculum' }`; solver skipped. |

### 3.6 Assignment

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | derived from `Curriculum × Teacher eligibility` at runtime      |
| Source (test)        | derived the same way (the synthetic end-to-end test builds them explicitly) |
| Schema               | `id`, `classId`, `subjectId`, `teacherId`, `branchId`, `requiredPeriods` |
| Validation           | `validateInput §6` — all FKs must resolve, `requiredPeriods` must be a non-negative integer, and the teacher must be **eligible** for the subject (`unresolvable_demand` otherwise) |
| Missing-data behavior | When empty, `MISSING_DATA { entity: 'Assignment' }`; solver skipped. |

### 3.7 Travel

| Aspect               | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| Source (prod)        | `data/config/travel.js` (TBD; interface only)                  |
| Source (test)        | `MISSING CONFIGURATION` (no provider registered)                |
| Schema               | `TravelProvider.travelTime(branchA, branchB, periodA) → minutes \| null` |
| Loader               | `src/domain/travel.js` — `makeTravelProvider`, `nullTravelProvider` |
| Validation           | `H_TRAVEL_FEASIBLE` is `INACTIVE` when `input.travelTime` is falsy; the validator records this in `inactiveConstraints` |
| Missing-data behavior | `MISSING_DATA { entity: 'Travel' }`; `H_TRAVEL_FEASIBLE` is `INACTIVE`. The solver will still place a teacher across branches on the same day only if the rest of the data permits it; the validator will silently skip the feasibility check. |

---

## 4. The no-invention rule

The system **must not** fabricate any of the following to make a
test pass or to "complete" a record:

- `email` / `soDienThoai` for any teacher
- `nguyenVong` for `thư`, `trâm`, `nản`
- `homeBranchId` for any teacher
- a `Branch` (`branch-A`, …) or `Class` (`class-1A`, …) or
  `Subject` ("Toán", "Tiếng Việt", …) intended to look like
  production data

The only exception is **test mock data** that lives **inside the
test file**, is **clearly labeled** as such
(`warnings: ['TEST MOCK DATA: ...']` or `'TEST MOCK'`), and is
**never** loaded as production input. The `end_to_end.test.js`
and `benchmark.test.js` synthetic inputs follow this rule.

---

## 5. Status response contract

The orchestrator returns one of four statuses:

| Status           | When it fires                                                | Caller behavior                    |
| ---------------- | ------------------------------------------------------------ | ---------------------------------- |
| `OK`             | At least one accepted solution was produced.                 | Show solutions.                    |
| `EMPTY`          | All strategies ran, no candidate was returned by the solver. | Show explanation; offer retry.     |
| `MISSING_DATA`   | `validateInput.missing` lists critical entities (`Branch` / `Class` / `Curriculum` / `Assignment` / `Travel`). | Surface the structured list; do not let the user click "Generate" again without supplying data. |
| `INVALID_INPUT`  | `validateInput.issues` is non-empty (broken references, missing required fields where they are supposed to be present, ineligible teacher for a subject, etc.). | The caller is using the API wrong; surface the `invalidInput` array as actionable error messages. |

The system never crashes on a `MISSING_DATA` situation; it never
silently falls back to a relaxed constraint; it never invents
values to mask the absence.

---

## 6. Pre-scheduler validation

`src/domain/validate.js` is the single source of truth for what
counts as an `INVALID_INPUT`. It returns two lists:

```text
{ issues: ValidationIssue[], missing: { entity, reason }[] }
```

- `issues` → the user is at fault (broken FK, missing required
  field, ineligible teacher).
- `missing` → the data is not present (no branches, no
  curriculum, no travel matrix). These are not errors; they are
  honest reports.

The orchestrator (and only the orchestrator) decides what to do
with each. The solver is invoked only when `issues.length === 0`.

The validator is **not** a heuristic. It is a structural check.
Hard constraints that depend on it (e.g. `H_TEACHER_ELIGIBLE`)
remain in the validator and remain independent of the orchestrator.

---

## 7. Regression test matrix (locked in)

These tests are the safety net for Phase 14. They must stay green
regardless of any future change to the orchestrator or the
solver.

| Concern                                                | Test file                                  |
| ------------------------------------------------------ | ------------------------------------------ |
| Authoritative fixture byte-loadable                    | `tests/fixture.test.js`                    |
| Casing preserved (`kim`, `thư`, `trinh`, `trâm`, `nản`) | `tests/fixture.test.js`                    |
| `email` and `soDienThoai` are `""`                     | `tests/fixture.test.js`                    |
| `nguyenVong` is `null` for `thư`, `trâm`, `nản`        | `tests/preferences.test.js`                |
| `kim` is one teacher with workload 2                   | `tests/workload.test.js` (Phase 14)        |
| `kim` eligible for `Công nghệ` and `Tin học`, not `Toán` | `tests/eligibility.test.js`                |
| `preview` on the empty fixture → `MISSING_DATA`         | `tests/orchestrator.test.js`               |
| `preview` on a broken model → `INVALID_INPUT`          | `tests/validate.test.js` (Phase 14)        |
| Synthetic end-to-end → ≥1 accepted solution            | `tests/end_to_end.test.js`                 |
| Multi-strategy benchmark → different scores            | `tests/benchmark.test.js`                  |

---

## 8. Open follow-ups (not Phase 14 work)

These are **not** in scope for Phase 14. They are listed here so
that the next phase can pick them up without re-deriving the
contract.

- MongoDB loaders for `chi_nhanh`, `lop`, `chuong_trinh`.
- `TravelProvider` registration and a real `data/config/travel.js`.
- The `commit` step that writes to the `tkb` and `transfer_log`
  collections. The orchestrator today returns the cached
  solution with `written: false`.

---

## 9. What Phase 14 delivered

1. **One discrepancy fixed** — the orchestrator now consumes
   `validateInput` correctly (`issues` → `INVALID_INPUT`,
   `missing` → `MISSING_DATA`).
2. **A single source of truth for missing-data reporting** — the
   `dedupeMissing` helper guarantees the loader output and the
   validator output appear exactly once in the preview response.
3. **Regression coverage** — new tests lock in the
   teacher-multi-specialization invariant and the
   `INVALID_INPUT` short-circuit. The authoritative fixture is
   not touched.
4. **This document** — every data source's readiness state is
   explicit. Inventing data is now both a code rule and a
   documented policy.
