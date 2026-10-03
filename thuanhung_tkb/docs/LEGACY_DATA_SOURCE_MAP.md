# LEGACY DATA SOURCE MAP

> Phase 19 — the operator-facing map from each legacy MongoDB
> collection to the corresponding entity in the new project.
>
> The raw BSON files are preserved at
> `data/source/legacy-saplich/`; the loader is a sibling of the
> existing `loader/fixture.js` and `loader/dataset.js`, namely
> `backend/src/loader/legacy-saplich/`. This document records
> the contract for each mapping; the implementation lives in
> `normalize.js`.

---

## 1. Mapping (collection → entity)

| Legacy collection       | New domain entity                 | Implementation                        |
| ----------------------- | --------------------------------- | ------------------------------------- |
| `branches`              | `Branch`                          | `normalizeBranch`                     |
| `blocks`                | `Block`                           | `normalizeBlock`                      |
| `subjects`              | `Subject`                         | `normalizeSubject`                    |
| `teachers`              | `Teacher`                         | `normalizeTeacher`                    |
| `classes`               | `Class`                           | `normalizeClass`                      |
| `blocksubjects`         | `Curriculum` (normalized layer)   | `normalizeBlockSubject`               |
| `assignments`           | `HistoricalAssignment`            | `normalizeAssignment`                 |
| `schedules`             | `HistoricalScheduleMetadata`      | `normalizeSchedule`                   |
| `scheduleslots`         | `HistoricalScheduleSlot`           | `normalizeScheduleSlot`               |
| `transferlogs`          | `TransferHistory`                 | `normalizeTransferLog`                |
| `parttimeassignments`   | `PartTimeAssignment`              | `normalizePartTimeAssignment`         |

---

## 2. Per-entity field map

### 2.1 Branch

| Legacy field   | New field      | Notes                                              |
| -------------- | -------------- | -------------------------------------------------- |
| `_id`          | `id`           | ObjectId → hex string                              |
| `code`         | `code`         | e.g. `PHC`, `PH1`, …, `PH6`                        |
| `name`         | `name`         | e.g. `Trường chính`, `Phân hiệu 1`                |
| `description`  | `description`  | free text                                          |
| `isActive`     | `isActive`     | boolean                                            |
| `createdAt`    | `createdAt`    | Date → ISO 8601                                    |
| `updatedAt`    | `updatedAt`    | Date → ISO 8601                                    |

### 2.2 Block

| Legacy field  | New field     |
| ------------- | ------------- |
| `_id`         | `id`          |
| `code`        | `code`        |
| `name`        | `name`        |
| `order`       | `order`       |
| `description` | `description` |
| `isActive`    | `isActive`    |
| `createdAt`   | `createdAt`   |
| `updatedAt`   | `updatedAt`   |

### 2.3 Subject

| Legacy field  | New field      |
| ------------- | -------------- |
| `_id`        | `id`           |
| `code`        | `code` (e.g. `MT`, `TA`, `GDTC`, `TH`, `AN`, `CN-TH`) |
| `name`        | `name`        |
| `description` | `description` |
| `isActive`    | `isActive`    |
| `createdAt`   | `createdAt`   |
| `updatedAt`   | `updatedAt`   |

CN-TH has `isActive = false`. Preserved as-is.

### 2.4 Teacher

| Legacy field                | New field                   |
| --------------------------- | --------------------------- |
| `_id`                       | `id`                        |
| `code`                      | `code`                      |
| `name`                      | `name`                      |
| `email`                     | `email` (kept as `""`)      |
| `phone`                     | `phone` (kept as `""`)      |
| `branch`                    | `branch`                    |
| `specializations[]`         | `specializations[]`         |
| `standardWorkload`          | `standardWorkload`          |
| `partTimeWorkload`          | `partTimeWorkload`          |
| `teachingWorkload`          | `teachingWorkload`          |
| `maxSessionsPerWeek`        | `maxSessionsPerWeek`        |
| `preferredSession`          | `preferredSession`          |
| `fixedDayOff`               | `fixedDayOff`               |
| `allowedTransferBranches[]` | `allowedTransferBranches[]` |
| `transferPriority[]`        | `transferPriority[]`        |
| `preferredTransferBranches[]` | `preferredTransferBranches[]` |
| `preferredGrades[]`         | `preferredGrades[]`         |
| `isActive`                  | `isActive`                  |
| `createdAt`                 | `createdAt`                 |
| `updatedAt`                 | `updatedAt`                 |

Specializations are eligibility, not assignment.

### 2.5 Class

| Legacy field      | New field         |
| ----------------- | ----------------- |
| `_id`             | `id`              |
| `name`            | `name`            |
| `code`            | `code`            |
| `block`           | `block`           |
| `branch`          | `branch`          |
| `homeroomTeacher` | `homeroomTeacher` (always `null` in this dump) |
| `isActive`        | `isActive`        |
| `createdAt`       | `createdAt`       |
| `updatedAt`       | `updatedAt`       |

Branch is taken from `classes.branch` (not inferred from class name).

### 2.6 Curriculum (from blocksubjects)

| Legacy field       | New field          |
| ------------------ | ------------------ |
| `_id`              | `id`               |
| `block`            | `block`            |
| `subject`          | `subject`          |
| `periodsPerWeek`   | `periodsPerWeek`   |
| `academicYear`     | `academicYear`     |
| `isActive`         | `isActive`         |
| `createdAt`        | `createdAt`        |
| `updatedAt`        | `updatedAt`        |

### 2.7 HistoricalAssignment

| Legacy field             | New field                |
| ------------------------ | ------------------------ |
| `_id`                    | `id`                     |
| `class`                  | `class`                  |
| `subject`                 | `subject`                |
| `teacher`                | `teacher`                |
| `branch`                 | `branch`                 |
| `requiredPeriods`        | `requiredPeriods`        |
| `assignedPeriods`        | `assignedPeriods`        |
| `shortage`               | `shortage`               |
| `shortageReason`         | `shortageReason`         |
| `status`                 | `status`                 |
| `academicYear`           | `academicYear`           |
| `semester`               | `semester`               |
| `note`                   | `note`                   |
| `isTransferred`          | `isTransferred`          |
| `transferredAt`          | `transferredAt`          |
| `transferredFromTeacher` | `transferredFromTeacher` |
| `createdAt`              | `createdAt`              |
| `updatedAt`              | `updatedAt`              |

These rows are surfaced to the orchestrator under
`assignments[]` with `baselineAssignment = true`. They are NOT
hard fixed assignments; the solver retains the right to
re-optimize teacher selection.

### 2.8 HistoricalScheduleMetadata (from schedules)

| Legacy field              | New field                |
| ------------------------- | ------------------------ |
| `_id`                     | `id`                     |
| `name`                    | `name`                   |
| `academicYear`            | `academicYear`           |
| `semester`                | `semester`               |
| `branch`                  | `branch`                 |
| `status`                  | `status`                 |
| `completedAssignments`    | `completedAssignments`   |
| `totalAssignments`        | `totalAssignments`       |
| `hardConstraintViolations`| `hardConstraintViolations` |
| `statistics`              | `statistics`              |
| `note`                   | `note`                   |
| `createdAt`              | `createdAt`              |
| `updatedAt`              | `updatedAt`              |
| (synthetic)              | `isHistoricalMetadata`  |

`isHistoricalMetadata` is added so consumers can tell this
record apart from ground truth. The summary fields
(`completedAssignments`, `statistics.totalSlots`) are
preserved verbatim and are NOT used as input to the solver.

### 2.9 HistoricalScheduleSlot

| Legacy field          | New field         |
| -------------------- | ----------------- |
| `_id`                | `id`              |
| `day`                | `day`             |
| `session`            | `session`         |
| `period`             | `period`          |
| `class`              | `class`           |
| `subject`            | `subject`         |
| `teacher`            | `teacher`         |
| `assignment`         | `assignment`      |
| `slotType`           | `slotType`        |
| `status`             | `status`          |
| `academicYear`       | `academicYear`    |
| `semester`           | `semester`        |
| `createdAt`          | `createdAt`       |
| `updatedAt`          | `updatedAt`       |

Imported as the `legacyBaseline.scheduleSlots[]` bundle. NOT
injected into the solver.

### 2.10 TransferHistory

| Legacy field             | New field                |
| ------------------------ | ------------------------ |
| `_id`                    | `id`                     |
| `assignment`             | `assignment`             |
| `fromTeacher`            | `fromTeacher`            |
| `toTeacher`              | `toTeacher`              |
| `fromBranch`             | `fromBranch`             |
| `toBranch`               | `toBranch`               |
| `scope`                  | `scope`                  |
| `status`                | `status`                |
| `failureReason`          | `failureReason`          |
| `periodsTransferred`     | `periodsTransferred`     |
| `affectedSlots[]`        | `affectedSlots[]`        |
| `teacherSessionsBefore`  | `teacherSessionsBefore`  |
| `teacherSessionsAfter`   | `teacherSessionsAfter`   |
| `teacherWorkloadBefore`  | `teacherWorkloadBefore`  |
| `teacherWorkloadAfter`   | `teacherWorkloadAfter`   |
| `transferScore`          | `transferScore`          |
| `rollbackable`           | `rollbackable`           |
| `note`                   | `note`                   |
| `executedBy`             | `executedBy`             |
| `createdAt`              | `createdAt`              |
| `updatedAt`              | `updatedAt`              |

Failure reasons are preserved verbatim. They are domain
artifacts (intelligence about why past transfers failed), not
hard constraints on the new solver.

### 2.11 PartTimeAssignment

| Legacy field  | New field    |
| ------------- | ------------ |
| `_id`         | `id`         |
| (full record) | `raw`        |

The collection is empty in the source. The mapper still
exists so the loader never crashes if a future dump carries
records; new fields would be added explicitly.

---

## 3. From NORMALIZED to SCHEDULING MODEL

`buildSchedulingModel(normalized)` projects the normalized
layer into the existing `SchedulingInput` contract. The
projection rules are:

1. **Teachers**: only `isActive === true` teachers are
   surfaced to `scheduling.teachers[]`. The 2 inactive
   teachers remain in `normalized.teachers` for audit.
2. **Specializations**: every teacher's `specializations[]`
   is intersected with `subjectIds`. Subjects that no longer
   exist in the dump are dropped.
3. **Curriculum**: rows whose `subject` is inactive are
   excluded from `scheduling.curriculum[]` and surfaced in
   `scheduling.excludedCurriculum[]` for the audit. The 24
   raw blocksubjects records remain in `normalized.curriculum`.
4. **Assignments**: all 479 historical assignments become
   `scheduling.assignments[]` with `baselineAssignment = true`.
5. **Travel**: `scheduling.travelTime` is `null`,
   `scheduling.travelStatus` is `MISSING_CONFIGURATION`. No
   matrix is invented.
6. **schoolDays / periods**: the legacy dump does not carry
   these on branches; the scheduling model uses minimal
   defaults (`[1..6]` and `[1..5]`). These defaults match the
   contract shape; the orchestrator will surface them through
   `validateInput` if needed.
8. **Workload**: workload is computed by the solver per the
   existing contract (per teacher). `teachingWorkload` from
   the source is preserved in `legacyBaseline.teacherWorkloadSnapshot`
   for comparison.

---

## 4. What is NEVER touched

- `null` values: kept distinct from `[]`, missing, and `""`.
- Email / phone: empty strings in source stay empty strings.
- `homeBranchId` (`teacher.branch`): null stays null when
  the source has it null.
- `isActive` flags: never flipped.
- `teachingWorkload` vs. assignment-derived workload: both
  are preserved separately.
- Schedule summary: 403 / 479 / 671 / 802 are not reconciled
  silently; the summary is historical metadata.

---

## 5. Layered structure reminder

```text
RAW (data/source/legacy-saplich/*.bson)
        │
        ▼ readRawDump()
NORMALIZED DOMAIN (src/loader/legacy-saplich/normalize.js)
        │
        ├─ buildSchedulingModel() ───► SCHEDULING MODEL (SchedulingInput)
        │                              (consumed by orchestrator)
        │
        └─ buildLegacyBaseline() ──► LEGACY BASELINE
                                       (audit only — never injected into solver)
```

The orchestrator only sees the SCHEDULING MODEL. The legacy
baseline is exposed by the import result for future
comparison work; it is NEVER passed to the solver.