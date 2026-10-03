# PHASE 19 — LEGACY DATA INGESTION

> Phase 19 — import the MongoDB dump of the old project
> (`saplich`) into the new `thuanhung_tkb` project. The goal
> is **traceable, audit-friendly ingestion**, not solver
> optimization. The architecture, domain model, validator,
> orchestrator, and AI strategy remain unchanged. The brief is
> explicit: data only, no new business rules, no solver
> comparison yet.
>
> Three layers are produced:
>
> ```text
> RAW  →  data/source/legacy-saplich/  (BSON files preserved verbatim)
> NORMALIZED  →  src/loader/legacy-saplich/normalize.js
> SCHEDULING MODEL  →  src/loader/legacy-saplich/scheduling-model.js
> ```
>
> The legacyBaseline (§26 of the brief) is exposed alongside
> the scheduling model so future phases can compare new solver
> outputs against the historical record without mutating it.

---

## 1. Source

```text
MongoDB dump
database  = saplich
path      = E:\saplich\exports\saplich-mongodb-2026-10-03T04-39-54-129Z\saplich
copied to = e:\GiaPhuc\thuanhung_tkb\data\source\legacy-saplich\
mongo      = 8.0.34
tool      = mongodump 100.17.0
```

The dump consists of 11 collections plus a `prelude.json`
(metadata about the source server). All 22 files (11 `.bson`
+ 11 `.metadata.json`) are preserved verbatim under
`data/source/legacy-saplich/`. The new project does not depend
on MongoDB being installed; it reads the BSON files directly
using the `bson` npm package.

---

## 2. Inventory (post-import, real counts)

| Collection             | Expected | Actual | Match | Notes                                                     |
| ---------------------- | -------- | ------ | ----- | --------------------------------------------------------- |
| branches               | 7        | 7      | ✓     | PHC, PH1, PH2, PH3, PH4, PH5, PH6                         |
| blocks                 | 5        | 5      | ✓     | K1..K5                                                    |
| subjects               | 6        | 6      | ✓     | 5 active + 1 inactive (CN-TH)                              |
| teachers               | 42       | 42     | ✓     | 40 active + 2 inactive                                    |
| classes                | 113      | 113    | ✓     | all active; homeroomTeacher = null on every record        |
| blocksubjects          | 24       | 24     | ✓     | 21 active rows + 3 rows referencing the inactive CN-TH    |
| assignments            | 479      | 479    | ✓     | all `academicYear=2025-2026, semester=1`                  |
| schedules              | 1        | 1      | ✓     | single historical metadata record                         |
| scheduleslots          | 802      | 802    | ✓     | one per assignment×assignedPeriods                        |
| transferlogs           | 4175     | 4175   | ✓     | 3626 SUCCESS + 549 FAILED, all `scope=auto`               |
| parttimeassignments    | 0        | 0      | ✓     | empty; preserved as empty in normalized layer             |

All counts match the expected inventory in §3 of the brief.

---

## 3. Normalization (collection → entity)

The mapping is implemented in
`backend/src/loader/legacy-saplich/normalize.js`. ObjectId
values become their hex string. Dates become ISO 8601 strings.
The mapper never renames fields implicitly; field renames are
explicit per entity. `null`, `[]`, missing, and `""` are
distinct — the runtime never treats them as the same value.

| Legacy collection       | New domain entity        | Notes                                                                                                       |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `branches`              | `Branch`                 | `code`, `name`, `description`, `isActive`. schoolDays/periods are derived from contract defaults.            |
| `blocks`                | `Block`                  | `code`, `name`, `order`.                                                                                    |
| `subjects`              | `Subject`                | `code`, `name`, `isActive`. CN-TH is `isActive=false`.                                                       |
| `teachers`              | `Teacher`                | All legacy fields preserved. `name`, `email`, `phone`, `branch`, `specializations[]`, `standardWorkload`, `partTimeWorkload`, `teachingWorkload`, `maxSessionsPerWeek`, `preferredSession`, `fixedDayOff`, `allowedTransferBranches[]`, `transferPriority[]`, `preferredTransferBranches[]`, `preferredGrades[]`, `isActive`. |
| `classes`               | `Class`                  | `name`, `code`, `block`, `branch`, `homeroomTeacher` (kept `null` everywhere).                               |
| `blocksubjects`         | `Curriculum` (normalized)| `block`, `subject`, `periodsPerWeek`, `academicYear`, `isActive`.                                            |
| `assignments`           | `HistoricalAssignment`   | `class`, `subject`, `teacher`, `branch`, `requiredPeriods`, `assignedPeriods`, `shortage`, `isTransferred`, `transferredAt`, `transferredFromTeacher`, `academicYear`, `semester`. |
| `schedules`             | `HistoricalScheduleMetadata` | marked `isHistoricalMetadata=true` to signal it is NOT ground truth.                                       |
| `scheduleslots`         | `HistoricalScheduleSlot` | `day`, `session`, `period`, `class`, `subject`, `teacher`, `assignment`, `slotType`, `status`.              |
| `transferlogs`          | `TransferHistory`        | `assignment`, `fromTeacher`, `toTeacher`, `fromBranch`, `toBranch`, `scope`, `status`, `failureReason`, `affectedSlots[]`, etc. |
| `parttimeassignments`   | `PartTimeAssignment`     | collection is empty; preserved as 0 records; no synthetic data added.                                        |

---

## 4. Integrity (per §23)

Reference integrity is computed in
`backend/src/loader/legacy-saplich/integrity.js`. Three
buckets per reference:

```text
valid      present, points to an entity that exists
absent     null or undefined (legitimate in the source)
broken     present, but does NOT resolve to any entity
```

`null` is **not** a broken reference (the brief explicitly
preserves `null` semantics).

```text
valid references              19 944
absent references              2 303   (legitimate nulls in source)
broken operational references     0
orphan historical references    731   (transferlogs.assignment → deleted assignment ids)
```

### 4.1 Per-entity reference breakdown

| Entity / reference                      | valid | absent | broken |
| --------------------------------------- | ----- | ------ | ------ |
| teacher → branch                        | 42    | 0      | 0      |
| teacher → specializations               | 42    | 0      | 0      |
| teacher → allowedTransferBranches       | 0     | 0      | 0      |
| teacher → preferredTransferBranches     | 65    | 0      | 0      |
| class → block                           | 113   | 0      | 0      |
| class → branch                          | 113   | 0      | 0      |
| curriculum → block                      | 24    | 0      | 0      |
| curriculum → subject                    | 24    | 0      | 0      |
| assignment → class                      | 479   | 0      | 0      |
| assignment → subject                    | 479   | 0      | 0      |
| assignment → teacher                    | 479   | 0      | 0      |
| assignment → branch                     | 479   | 0      | 0      |
| scheduleSlot → class                    | 802   | 0      | 0      |
| scheduleSlot → subject                  | 802   | 0      | 0      |
| scheduleSlot → teacher                  | 802   | 0      | 0      |
| scheduleSlot → assignment               | 802   | 0      | 0      |
| transferLog → assignment (orphan OK)    | 3444  | (counted as 731 orphan, see below) | 0 |
| transferLog → fromTeacher               | 2338  | 1837   | 0      |
| transferLog → toTeacher                 | 4175  | 0      | 0      |
| transferLog → fromBranch                | 3709  | 466    | 0      |
| transferLog → toBranch                  | 4175  | 0      | 0      |

### 4.2 Orphan historical references (kept, not deleted)

```text
transferlogs.assignment pointing to assignment ids that
no longer exist in the assignments collection:  731 records
```

These are intentional (per the brief): the logs are history
and are not deleted. They are marked as orphan in the audit
but **not** flagged as broken.

---

## 5. Scheduling readiness

The scheduling model produced by
`scheduling-model.js` is itself a valid `SchedulingInput`
shape and is accepted by the existing orchestrator without
modification.

```text
data ready:        YES (active teachers, branches, classes,
                       subjects, curriculum, assignments)
travel ready:      NO  (no travel matrix in the dump)
solver runnable:   YES (no INVALID_INPUT, no critical MISSING_DATA;
                       H_TRAVEL_FEASIBLE remains INACTIVE;
                       H_TRANSFER_ALLOWED remains ACTIVE)
```

The orchestrator will classify this as `OK` (with solutions)
or `EMPTY` (no feasible placement) — neither as
`MISSING_DATA`. Travel-dependent soft objectives are
deactivated per the existing contract.

---

## 6. Historical anomalies (the seven required by §27)

Each anomaly is preserved as-is. No silent fix.

### 6.1 schedules summary does not match detail

```text
schedules[6aaa6a47b0b2b4d17f6a938e]:
  completedAssignments = 403   (legacy summary)
  totalAssignments     = 479   (legacy summary)
  statistics.totalSlots = 671   (legacy summary)
  scheduleslots.length = 802   (current ground truth)
```

The single record in `schedules` is **historical metadata**,
not ground truth. We surface it under
`HistoricalScheduleMetadata` with
`isHistoricalMetadata=true` so no consumer can mistake it for
authoritative current data.

### 6.2 teacher.teachingWorkload ≠ assignment-derived workload

```text
41 teacher(s) have teachingWorkload (legacy denormalized)
   ≠ assignment-derived. Source is preserved; derived is recomputed.
```

The legacy `teachingWorkload` field is denormalized and
inconsistent with the `assignments` table. It is preserved
verbatim in `legacyBaseline.teacherWorkloadSnapshot`. The
scheduling model derives workload fresh from assignments;
neither value overwrites the other.

### 6.3 CN-TH is inactive but still present in blocksubjects

```text
3 curriculum row(s) reference the inactive subject CN-TH.
The raw 24 blocksubjects records are preserved.
The scheduling model excludes those 3 rows from
scheduling.curriculum and surfaces them under
scheduling.excludedCurriculum.
```

CN-TH was not deleted, not merged into TH, not made active.

### 6.4 35 transferred assignments lack `transferredFromTeacher`

```text
35 transferred assignment(s) have transferredFromTeacher=null
(kept as-is in source; logged for audit).
```

No synthetic value was inserted.

### 6.5 transferlogs has orphan assignment references

```text
731 transfer log entries reference assignment ids that no
longer exist in the assignments collection.
```

Intentionally kept. Logs are history; they are not deleted
to "fix" orphan references. They are marked
`orphanHistorical = true` in the audit.

### 6.6 parttimeassignments is empty

```text
parttimeassignments.bson: 0 records.
```

No synthetic part-time data was added.

### 6.7 travel matrix is missing

```text
travel matrix: absent from source (H_TRAVEL_FEASIBLE remains
INACTIVE in the scheduling model).
```

No travel time was invented; the orchestrator continues to
report `H_TRAVEL_FEASIBLE = INACTIVE` and the cross-branch
travel feasibility check is skipped exactly as documented in
Phase 14.

---

## 7. Storage layout

```text
data/source/legacy-saplich/                  ← raw, byte-faithful
├── prelude.json
├── branches.bson            + .metadata.json
├── blocks.bson              + .metadata.json
├── subjects.bson            + .metadata.json
├── teachers.bson            + .metadata.json
├── classes.bson             + .metadata.json
├── blocksubjects.bson       + .metadata.json
├── assignments.bson         + .metadata.json
├── schedules.bson           + .metadata.json
├── scheduleslots.bson       + .metadata.json
├── transferlogs.bson        + .metadata.json
└── parttimeassignments.bson + .metadata.json

backend/src/loader/legacy-saplich/           ← NORMALIZED + SCHEDULING MODEL
├── raw-reader.js            (BSON → JS objects)
├── normalize.js             (raw → NORMALIZED DOMAIN)
├── integrity.js             (reference checks + anomalies)
├── scheduling-model.js       (NORMALIZED → SchedulingInput)
├── legacy-baseline.js       (NORMALIZED → legacyBaseline)
└── index.js                 (loadFromLegacySaplich entry point)

backend/tests/phase19_legacy_ingestion.test.js  (49 tests)

docs/PHASE_19_LEGACY_DATA_INGESTION.md  (this file)
docs/LEGACY_DATA_SOURCE_MAP.md          (collection → entity map)
```

---

## 8. Bug policy compliance

- No data was renamed or re-cased.
- No email / phone was invented.
- No `homeBranchId` was filled in for teachers.
- No travel time was invented.
- No preference was invented.
- No teacher was flipped from inactive → active or vice versa.
- No record was deleted (orphan transfer logs, inactive
  teachers, inactive CN-TH rows in curriculum, all kept).
- No legacy `teachingWorkload` was overwritten by derived
  values, and vice versa.
- No historical assignment was turned into a hard fixed
  assignment. They are imported as `baselineAssignment`
  rows; the orchestrator retains the right to re-optimize.

---

## 9. Test summary

```text
Before: 172 tests
After : 221 tests
Passed: 221
Failed:   0
```

The new tests live in
`backend/tests/phase19_legacy_ingestion.test.js`:

- 24 inventory / integrity assertions corresponding to the 24
  checks in §24 of the brief (counts, sums, slot integrity,
  CN-TH preservation, transfer count, academic-year coverage).
- 25 structural / layer assertions covering the BSON reader,
  the normalizer, the scheduling-model extractor, the
  integrity checker, the legacy baseline, and the source
  path. These guard against regressions in each layer of
  the import pipeline.

No existing test was modified. The 172 pre-existing tests
still pass.

---

## 10. Final report

### IMPORT STATUS

```text
branches               = 7
blocks                 = 5
subjects               = 6
teachers               = 42
classes                = 113
blocksubjects          = 24
assignments            = 479
schedules              = 1
scheduleslots          = 802
transferlogs           = 4175
parttimeassignments    = 0
```

### REFERENCE CHECK

```text
valid operational references          = 19 944
absent references (legitimate nulls)  =  2 303
broken operational references         =      0
orphan historical references          =    731
```

### SCHEDULING READINESS

```text
data ready:       YES
travel ready:     NO   → TRAVEL_DATA_MISSING (H_TRAVEL_FEASIBLE = INACTIVE)
solver runnable:  YES
```

### Historical anomalies

All seven anomalies listed in §27 of the brief are observed
and recorded. None were silently fixed. See §6 above for the
full audit.

### Tests

```text
Before: 172 tests
After : 221 tests
Passed: 221
Failed:   0
```

**DỪNG TẠI ĐÂY** theo Phase 19 §30. Solver optimization and
comparison against the legacy baseline are NOT performed in
this phase. They will be a future phase.