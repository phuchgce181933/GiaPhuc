# REAL DATA SOURCE MAP

> Phase 18 — the operator-facing map of where each piece of
> authoritative scheduling data is expected to come from.
>
> **Status of this phase**: the operator has supplied **one** of
> the seven sources (the teacher fixture). The other six are
> absent. The orchestrator already reports `MISSING_DATA`
> for every entity that is not present. This document
> therefore records the **contract** the loader and validator
> expect; it does **not** enumerate MongoDB collection names,
> because no production source has been wired up in this
> repository. The MongoDB loader is still an explicit
> interface-only stub.

---

## 1. What the orchestrator accepts today

The orchestrator selects a loader in this order
(`backend/src/loader/index.js`):

```text
1. MONGODB_URI set          → MongoDB loader
                               (NOT IMPLEMENTED in this phase;
                                returns an empty model with a
                                warning. The operator is told to
                                use DATASET_PATH or the fixture.)
2. DATASET_PATH set         → JSON dataset loader
                               (reads one file the operator
                                provides; the loader does not
                                invent any field.)
3. fallback                 → authoritative teacher fixture
                               (existing behavior).
```

The current repository ships only option (3). No `.env` file
is committed; the loader falls back to the teacher fixture.

---

## 2. Per-entity source map

The columns below describe the **shape** the loader and
validator expect from each source. Collection / table name is
left as `OPERATOR_SUPPLIED` because the production source has
not been wired into this repository; the Phase 14 audit
(`docs/REAL_DATA_READINESS.md`) used the working repository
suggestions (`giao_vien`, `chi_nhanh`, `lop`, `chuong_trinh`,
…) but this phase follows the Phase 18 rule: **do not guess
collection names if the real source has not been provided.**

| Entity        | Required? | Loader path today                                | Source collection / file                                       | Required fields                                                                 | Optional fields                                                | Mapping (raw → SchedulingInput)                                                            | Missing-data behavior                                                                                          |
| ------------- | --------- | ------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Teacher       | YES       | fixture (default), dataset, mongodb (interface)  | `OPERATOR_SUPPLIED` (MongoDB) or teacher fixture file          | `id`, `hoTen`, `chuyenMon[]`                                                    | `email`, `soDienThoai`, `nguyenVong`, `homeBranchId`           | none                                                                            | Empty array → `MISSING_DATA { entity: 'Teacher' }`; per-teacher optional-field absence surfaced in `missingData`. |
| Branch        | YES       | dataset (mongodb interface only)                  | `OPERATOR_SUPPLIED` (MongoDB) or `branches[]` in dataset JSON   | `id`, `name`, `schoolDays[]`, `periods[]`                                       | -                                                              | none                                                                   | Empty array → `MISSING_DATA { entity: 'Branch' }`; orchestrator refuses solver.                                 |
| Class         | YES       | dataset (mongodb interface only)                  | `OPERATOR_SUPPLIED` (MongoDB) or `classes[]` in dataset JSON    | `id`, `branchId` (FK → Branch), `name`, `gradeLevel`                             | -                                                              | none                                                                   | Empty array → `MISSING_DATA { entity: 'Class' }`. Broken FK → `INVALID_INPUT invalid_reference`.               |
| Subject       | YES       | derived (from teacher specializations ∪ dataset) | derived                                                         | `id`/`name`                                                                     | `aliases`                                                      | none                                  | Curriculum references an unknown subject → `INVALID_INPUT invalid_reference`.                                |
| Curriculum    | YES       | dataset (mongodb interface only)                  | `OPERATOR_SUPPLIED` (MongoDB) or `curriculum[]` in dataset JSON | `classId`, `subjectId`, `requiredPeriods` (integer ≥ 0)                          | -                                                              | none                                                            | Empty array → `MISSING_DATA { entity: 'Curriculum' }`; solver skipped.                                          |
| Assignment    | YES       | dataset OR auto-derived from curriculum           | `OPERATOR_SUPPLIED` (MongoDB) or `assignments[]` in dataset     | `id`, `classId`, `subjectId`, `teacherId` (FK), `branchId` (FK), `requiredPeriods` | -                                                              | auto-derive `id: 'auto-<classId>-<subjectId>'`, `teacherId = first eligible`, `branchId = classRec.branchId` | Empty after derivation → `MISSING_DATA { entity: 'Assignment' }`. Ineligible teacher → `INVALID_INPUT unresolvable_demand`. |
| Travel        | OPTIONAL  | dataset (`travel.matrix`) OR `nullTravelProvider` | `OPERATOR_SUPPLIED` (MongoDB) or `travel.matrix` in dataset JSON | `{ bA: { bB: minutes } }` shape, provider interface                              | -                                                              | none                                                         | Absent → `MISSING_DATA { entity: 'Travel' }`; `H_TRAVEL_FEASIBLE = INACTIVE`. No travel time invented.        |
| Transfer      | OPTIONAL  | per-teacher `allowedTransferBranches[]`           | teacher fixture, dataset, or `OPERATOR_SUPPLIED`               | none (purely optional)                                                          | `allowedTransferBranches[]`                                    | none                                       | Absent → `H_TRANSFER_ALLOWED = INACTIVE`. No branch ever marked as preferred transfer destination.              |

---

## 3. Source-of-truth rules that apply to every row

- **Source of truth is operator-supplied.** The loader never
  inserts a row the operator did not provide.
- **No two folders serve the same purpose** (per `AGENTS.md`).
  MongoDB loaders, when built, must live next to the existing
  `loader/fixture.js` and `loader/dataset.js`, not in a new
  parallel directory.
- **Normalization is in memory.** Raw rows from Mongo or
  from a JSON file are never mutated. The loader maps each
  raw row to the contract shape and discards the original.
- **Validation is structural.** A broken FK is `INVALID_INPUT`,
  not `MISSING_DATA`. The orchestrator refuses to invoke the
  solver on `INVALID_INPUT`; it never invents a row to make
  the FK resolve.
- **Subject catalog is derived, not invented.** `Subject` is
  the union of teacher `chuyenMon[].tenChuyenMon` and any
  explicit `subjects[]` provided. The loader never adds a
  subject the operator did not list.

---

## 4. Why collection names are not listed

Phase 18 rule:

> "Không được tự đoán tên collection nếu source thực tế chưa
> được cung cấp." (Do not guess collection names if the real
> source has not been provided.)

The MongoDB loader in this repository is still the
interface-only stub from earlier phases
(`loader/index.js` line `MongoDB loader is not implemented in
this phase. Use DATASET_PATH or the fixture.`). Wiring a
production collection requires the operator to confirm the
namespace; until that is provided, the contract above is the
authoritative map.

If a JSON dataset file is supplied, the loader reads the keys
`teachers`, `branches`, `classes`, `subjects`, `curriculum`,
`assignments`, `travel` (with `matrix` underneath). All keys
are optional; an absent key is treated as `MISSING_DATA`.

---

## 5. What is needed for a real run

A real run requires the operator to supply **one of**:

1. A JSON dataset file with `branches`, `classes`,
   `curriculum` (and optionally `assignments`, `travel`),
   reached via `DATASET_PATH`. The file is the operator's
   responsibility; the loader does not invent rows.
2. A MongoDB connection plus a confirmed collection name,
   reached via `MONGODB_URI`. The MongoDB loader is not
   implemented yet.

With either path, the seven sections above map 1-to-1 onto
the loader interface, and the validator emits
`MISSING_DATA` for any critical entity that is still absent.

---

## 6. Snapshot of what is actually present today

```text
teachers.authoritative.json  → 5 records
branches                     → 0
classes                      → 0
subjects                     → 6 derived (Công nghệ, Tin học,
                              Tiếng Anh, Mỹ thuật, Âm nhạc,
                              Giáo dục thể chất)
curriculum                   → 0
assignments                  → 0 (no curriculum to derive from)
travel                       → 0
```

Workload summary (verified by `tests/workload.test.js`):

| hoTen | specializations                   | workload |
| ----- | -------------------------------- | -------- |
| kim   | Công nghệ(1), Tin học(1)        | 2        |
| thư   | Tiếng Anh(4)                    | 4        |
| trinh | Mỹ thuật(1)                     | 1        |
| trâm  | Âm nhạc(1)                      | 1        |
| nản   | Giáo dục thể chất(2)            | 2        |
| **Total** | -                            | **10**   |

The teacher fixture is **immutable**; the loader is
byte-faithful (`tests/fixture.test.js`); the casing of `kim`,
`thư`, `trinh`, `trâm`, `nản` is preserved (including the
`n` with a combining diacritic in `nản`); no teacher has a
`homeBranchId`, so `H_TRANSFER_ALLOWED = INACTIVE`.

---

## 7. What Phase 18 did not do

- Did not invent a `Branch` (`branch-A`, `branch-B`, …) or a
  `Class` (`class-1A`, `class-1B`, …) to make the solver run.
- Did not invent curriculum rows for the 6 derived subjects.
- Did not invent a travel matrix between branches.
- Did not add a synthetic assignment to force the validator to
  accept the empty model.
- Did not modify the authoritative teacher fixture.
- Did not modify the loader, orchestrator, validator, solver,
  scorer, or diversity code in any way.
- Did not add new tests; there were no real-data regressions
  to lock in.
- Did not commit any schedule to production storage.

The runtime correctly refuses the solver today; the
documentation above is the operator-facing map of what the
loader expects the moment the operator decides to supply
production data.