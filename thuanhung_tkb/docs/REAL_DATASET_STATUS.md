# REAL DATASET STATUS

> Phase 15 — the per-entity readiness report.
>
> "READY" means the entity is present in the dataset the loader
> can see. It does **not** mean the dataset is sufficient for
> scheduling; that requires every entity below to be READY
> simultaneously. Every status in this document is derived from a
> `preview` call against the current load, not from optimistic
> assumptions.

---

## 1. Per-entity readiness

| Entity       | Status   | Source observed in this run                                                                                   |
| ------------ | -------- | ------------------------------------------------------------------------------------------------------------- |
| Teacher      | READY    | `data/fixtures/teachers.authoritative.json` — 5 records, byte-identical to the brief.                        |
| Branch       | MISSING  | No `branches` section in the loadable dataset. `branchesStatus === 'MISSING'`. `timeSlotsByBranch` is empty. |
| Class        | MISSING  | No `classes` section. `classes.length === 0`.                                                                 |
| Subject      | DERIVED  | Subjects are derived verbatim from `chuyenMon[].tenChuyenMon` of the 5 teachers (6 unique names). No external catalog is loaded. |
| Curriculum   | MISSING  | No `curriculum` section. `curriculum.length === 0`. `curriculumStatus === 'MISSING'`.                        |
| Assignment   | MISSING  | No `assignments` section and no curriculum to derive from. `assignments.length === 0`.                         |
| Travel       | MISSING  | No `travel` matrix supplied. `travelTime === null`. `travelStatus === 'MISSING_CONFIGURATION'`.               |

"READY" was not assigned to a row that only has an interface.
Every row reflects what the loader actually saw at runtime.

---

## 2. Per-teacher missing fields

The 5 teachers are loaded; their optional fields are reported
through `missingData` per the contract. The system does not
invent any of these.

| hoTen | missing fields                                                                                  |
| ----- | ----------------------------------------------------------------------------------------------- |
| kim   | `email` (empty), `soDienThoai` (empty), `homeBranchId` (absent)                                 |
| thư   | `email`, `soDienThoai`, `nguyenVong` (absent per second brief), `homeBranchId`                   |
| trinh | `email`, `soDienThoai`, `homeBranchId`                                                          |
| trâm  | `email`, `soDienThoai`, `nguyenVong` (absent per second brief), `homeBranchId`                   |
| nản   | `email`, `soDienThoai`, `nguyenVong` (absent per second brief), `homeBranchId`                   |

`kim`'s `nguyenVong` is `{ soBuoiToiDa: 4, buoiUuTien: 'ca_hai', thuNghi: [] }` and
`trinh`'s is `{ soBuoiToiDa: 4, buoiUuTien: 'chieu', thuNghi: [] }`. They are not
listed as missing.

---

## 3. Loader readiness

| Path                          | Status      | Notes                                                              |
| ----------------------------- | ----------- | ------------------------------------------------------------------ |
| Fixture loader (`fixture.js`) | READY       | Reads the teacher JSON byte-for-byte.                              |
| MongoDB loader                | INTERFACE   | Not implemented; the entry point emits a clear warning.            |
| JSON dataset loader (`dataset.js`) | READY   | Reads a single JSON file with the full `SchedulingInput`. Wired through `DATASET_PATH` env var. Tested with mock data. |

The dataset loader is the production path. It reads only what
the operator supplies; every absent section is reported as
`MISSING_DATA` rather than filled in.

---

## 4. Critical-missing check (drives orchestrator status)

The orchestrator refuses to invoke the solver when **any** of
the following are `MISSING`:

```text
Branch
Class
Curriculum
Assignment
```

(plus `Travel`, which is `INACTIVE` rather than blocking).
In the current run, all five are missing. Therefore:

```text
status:        MISSING_DATA
solutions:     0
strategiesAttempted: 0 (solver never called)
totalSolveMs:  0
```

This is the correct, contract-compliant behavior. It is not a
bug; it is the runtime saying "I cannot produce a meaningful
schedule without branches, classes, curriculum and assignments."

---

## 5. What is needed for a real run

The first real solver run on a real dataset needs:

1. A `branches[]` array — at least one branch with `schoolDays`
   and `periods`.
2. A `classes[]` array — at least one class per branch.
3. A `curriculum[]` array — `(classId, subjectId, requiredPeriods)`
   rows that the assignments can be derived from.
4. Optionally an `assignments[]` array — if the operator wants
   to override the auto-derivation.
5. Optionally a `travel` matrix — needed to enable the
   `H_TRAVEL_FEASIBLE` constraint; without it the constraint is
   `INACTIVE` and multi-branch transitions are not validated.

The teacher data is already sufficient. No other entity is.

---

## 6. What was **not** done

- No new branches, classes, subjects, curriculum or assignments
  were invented to make the solver run.
- The authoritative teacher fixture was not modified.
- The orchestrator, solver, validator, scorer, and explainer
  were not changed structurally for this phase.
- No production DB write was attempted.
- No fake AI call was made (preset strategies A/B/C were used;
  `AI_PROVIDER_NOT_CONFIGURED` is recorded in
  `FIRST_REAL_RUN_METRICS.json`).
