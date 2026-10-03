# PHASE 20 — ORCHESTRATOR DRY-RUN AUDIT

> Phase 20 — full pipeline verification, from RAW legacy data
> to the orchestrator input contract. **No optimization.**
> **No solver run.** **No domain contract change.** **No
> data invention.**
>
> This document is the audit report. The numbers below come
> from `backend/src/loader/legacy-saplich/verify.js` running
> against the legacy-saplich import result. The audit code
> is **read-only**; it never mutates the data.

```text
RAW LEGACY DATA
      ↓ (raw-reader.js, normalize.js)
NORMALIZED DOMAIN
      ↓ (scheduling-model.js)
SCHEDULING MODEL
      ↓ (validateInput, orchestrator.preview)
ORCHESTRATOR INPUT
```

The audit walks this pipeline in order, asserts invariants at
each hop, and probes the orchestrator's pre-scheduler
validation.

---

## 1. Traceability (§2 of the brief)

Every entity ID in the scheduling model is traceable to the
source legacy record. No IDs are invented. No records are
silently dropped. No records are duplicated.

| Entity       | Source | Scheduling | In source only | In scheduling only | Match |
| ------------ | ------ | ---------- | -------------- | ------------------ | ----- |
| teachers     | 42     | 40         | 0 active       | 0                  | ✓     |
| branches     | 7      | 7          | 0              | 0                  | ✓     |
| classes      | 113    | 113        | 0              | 0                  | ✓     |
| subjects     | 6      | 6          | 0              | 0 (catalog)        | ✓     |
| assignments  | 479    | 479        | 0              | 0                  | ✓     |

The 2 source teachers not in scheduling are the 2 inactive
teachers (`isActive=false`). They are preserved in
`normalized.teachers` for audit. Per the brief, the active
scheduling candidate pool contains the 40 active teachers
only.

The 1 source subject not in the "active subset" of the
scheduling catalog is `CN-TH` (`isActive=false`). It is
preserved in the scheduling catalog and in the normalized
layer. No demand references it (see §4 below).

---

## 2. Teachers (§3)

```text
source active teachers     = 40
scheduling candidates      = 40
inactive teachers in sched = 0
active source in sched     = 40 (all)
hoTen mismatches           = 0
email mismatches           = 0
phone mismatches           = 0
homeBranch mismatches      = 0
```

* Inactive teachers do NOT leak into the active scheduling
  pool.
* `hoTen`, `email`, `soDienThoai`, `homeBranchId` are
  preserved EXACTLY (no casing change, no diacritic
  normalization, no whitespace trimming beyond what
  `normalizeTeacher` already does).
* `specializations[]` is **eligibility**, not assignment. The
  projection maps source `teacher.specializations[]` (subject
  ids) into `teacher.chuyenMon[].tenChuyenMon` (subject names)
  by joining through `subjects[]`. A teacher's eligibility is
  never auto-promoted to an assignment.

---

## 3. Workload (§4)

| Source              | Derived from assignments | Scheduling budget |
| ------------------- | ------------------------ | ----------------- |
| `teachingWorkload`  | Σ(assignedPeriods)       | Σ(soTietTuan)     |
| 39 of 40 active teachers disagree between source and derived. The other 1 happens to agree. | | |

The brief is explicit: do NOT overwrite source. The audit
shows:

* `legacy teachingWorkload` is preserved in
  `normalized.teachers[i].teachingWorkload` and in
  `legacyBaseline.teacherWorkloadSnapshot`.
* `derived assignment workload` is recomputed by the audit
  and exposed in `audit.workload.rows[i].derived`. It is the
  number of `assignedPeriods` summed across all assignments
  per teacher.
* `schedulingBudget = Σ chuyenMon[].soTietTuan` is what the
  orchestrator's `workloadOf(teacher)` returns. It is used
  by the orchestrator's `workloadBalanceScore` only.

The three values are stored in three different fields; none
overwrites another. The mismatch count (39 / 40) is reported
in `audit.workload.legacyMismatches` for visibility.

---

## 4. Branches (§5)

```text
branches in source        = 7
branches in scheduling    = 7
missing in scheduling     = 0
inferred from name/code   = 0
```

* No branch ID is invented.
* No branch is inferred from class name, teacher name, or
  code. The branch on every entity is read from the explicit
  source field:
  * `classes.branch`
  * `teachers.branch`
  * `assignments.branch`
  * `transferlogs.fromBranch`, `transferlogs.toBranch`
  * `teachers.allowedTransferBranches[]`,
    `teachers.preferredTransferBranches[]`

Each branch in the scheduling model carries a default slot
grid (6 school days × 5 periods = 30 slots) because the
legacy dump does not carry `schoolDays` / `periods` per
branch. The defaults are derived; the IDs and names are
preserved. The orchestrator can refine the slot grid later
without touching the source data.

---

## 5. Classes (§6)

```text
classes in source         = 113
classes in scheduling     = 113
class.branch mismatches   = 0
```

* Branch on every class is read from `classes.branch`, never
  inferred from class name.
* All 113 classes are active. None are dropped.

---

## 6. Subjects (§7)

```text
source subjects           = 6
source active subjects    = 5  (AN, GDTC, MT, TA, TH)
source inactive subjects  = 1  (CN-TH, isActive=false)
scheduling catalog        = 6  (CN-TH kept in catalog for reference)
effective demand subjects = 5  (no assignment / no curriculum row uses CN-TH)
```

`CN-TH` is preserved in:

* `data/source/legacy-saplich/subjects.bson` (RAW)
* `normalized.subjects[]` (audit-visible)
* `scheduling.subjects[]` (catalog)

`CN-TH` is **NOT** used by any:

* `normalized.historicalAssignments[]` (audit verified)
* `normalized.curriculum[]` of an active row
* `scheduling.curriculum[]`
* `scheduling.assignments[]`

The 3 RAW blocksubjects rows that reference CN-TH are
preserved in `normalized.curriculum[]` and surfaced under
`scheduling.excludedCurriculum[]` (count = 3). They are
excluded from the scheduling demand because CN-TH is
inactive.

---

## 7. Curriculum (§8)

| Metric                                     | Value |
| ------------------------------------------ | ----- |
| raw `blocksubjects` rows                   | 24    |
| active rows in `normalized.curriculum`     | 24    |
| rows referencing the inactive CN-TH        | 3     |
| rows in `scheduling.curriculum`            | 21    |
| rows in `scheduling.excludedCurriculum`    | 3     |
| derived-from-source (not hard-coded 21)    | true  |

The number 21 is **derived** by filtering out rows whose
`subject` is an inactive subject. The audit asserts that
`audit.curriculum.effectiveSource === schedulingActive`
(`21 === 21`) so the value is not a hard-coded constant.

### KNOWN ISSUE — curriculum `classId` is a block id (§10)

The brief is explicit that the curriculum field should be
`classId`, but the legacy `blocksubjects` schema uses `block`
(one of 5 grade groups K1..K5), not a class id. The current
scheduling-model projection stores the block id in
`curriculum[].classId` so the field name satisfies the
contract, but the value is a **block id, not a class id**.

The orchestrator's `validateInput` reports this as 21
`invalid_reference` issues (one per active curriculum row).
The audit surfaces the count: 21, all of which resolve to
valid block ids, but none resolve to valid class ids.

**This is a known projection bug. Phase 20 documents it;
Phase 21+ must address it.** The fix is to either (a)
introduce a block-to-class expansion in the scheduling
model, or (b) introduce a separate `block` field on the
curriculum shape and let the orchestrator fan it out at
runtime. The choice is a future phase's decision.

---

## 8. Demand (§9)

| Metric                                  | Value |
| --------------------------------------- | ----- |
| assignments                             | 479   |
| requiredPeriods sum                     | 802   |
| assignedPeriods sum                     | 802   |
| shortage sum                            | 0     |
| effective scheduling subjects           | 5     |
| classes with at least one assignment    | 113   |
| inactive subject used by an assignment  | 0     |

The demand is derived from the 479 source assignments. The
audit does NOT adjust the sum to make it equal 802; it
reports the actual sum, which happens to be 802 because the
source data is consistent.

### Subject breakdown

| Subject | Code | Demand (periods/week) | Class count |
| ------- | ---- | --------------------- | ----------- |
| AN      | Âm nhạc                | 113 | 113 |
| GDTC    | Giáo dục thể chất      | 113 | 113 |
| MT      | Mỹ thuật                | 113 | 113 |
| TA      | Tiếng Anh               | 226 | 113 |
| TH      | Tin học                 | 280 | 70  |
| (CN-TH  | Công nghệ, Tin học      |   0 | 0) inactive — not used |

The class count and period count are read directly from
`assignments`; they are not inferred. TH reaches 280
periods/week across 70 classes (≈4 periods/class); TA is
226/113 (≈2/class); the others are 1/class. CN-TH is
deliberately excluded.

---

## 9. Assignment semantic (§10)

```text
scheduling assignments           = 479
baselineAssignment === true      = 479
baselineAssignment === false     = 0
baselineAssignment missing       = 0
broken class references         = 0
broken subject references       = 0
broken teacher references       = 0
broken branch references        = 0
class.branch !== assignment     = 0
teacher-ineligible-for-subject   = 0  (in source data)
```

* Every assignment has a valid `classId`, `subjectId`,
  `teacherId`, `branchId`.
* `class.branch === assignment.branchId` for every
  assignment (no cross-branch assignment leak).
* At the source-data level, the teacher is eligible for the
  subject they are assigned to (per `teacher.specializations[]`
  intersection with `assignment.subject`).
* `baselineAssignment === true` for every assignment. This
  is **NOT** a hard fixed assignment. The orchestrator
  retains the right to re-optimize teacher selection. The
  flag exists for analysis, warm-start, and explainability.

### KNOWN ISSUE — orchestrator's eligibility check mismatches at projection level

The scheduling model projects:

* `assignment.subjectId` = the source subject id (a 24-char
  hex string).
* `teacher.chuyenMon[].tenChuyenMon` = the subject name
  (e.g. `Mỹ thuật`).

The orchestrator's `validateInput` runs:

```js
teacher.chuyenMon.some(s => s.tenChuyenMon === a.subjectId)
```

`tenChuyenMon` is a name; `subjectId` is an id; the comparison
never matches. The validator therefore reports
`unresolvable_demand` for every assignment: 479 issues, one
per assignment. Sample:

```text
teacher PHAN THỊ THỦY DUYÊN is not eligible for 6a95e5f7804df2aa759c60f1
```

This is a **known projection bug** in
`backend/src/loader/legacy-saplich/scheduling-model.js`. The
fix is to project `tenChuyenMon` to the subject id (or vice
versa) so the eligibility check sees the same id namespace.
Phase 20 documents the bug. Phase 21+ must fix it.

The bug is at the **projection** level. The source data is
correct: the audit's own `audit.assignments.teacherIneligible`
is `0` when checked against the source `teacher.specializations[]`
(subject ids) and `assignment.subject` (subject id).

---

## 10. Schedule slots (§11)

| Metric                                          | Value |
| ----------------------------------------------- | ----- |
| total slots                                     | 802   |
| assignment slot-count mismatches                | 0     |
| duplicate class/day/session/period              | 0     |
| duplicate teacher/day/session/period            | 0     |
| slot subject mismatch vs assignment subject     | 0     |
| slot teacher mismatch vs assignment teacher     | 0     |

Ground truth is `scheduleslots`, NOT the `schedules`
summary record. The summary record says
`completedAssignments=403, totalAssignments=479,
statistics.totalSlots=671` and is a **legacy snapshot**, not
authoritative. The audit uses `scheduleslots` (802 records)
as the only source of truth for slot-level invariants.

---

## 11. Transfer semantics (§12)

```text
transferred assignments                = 87
  ... with transferredFromTeacher null = 35   (preserved; not auto-filled)
transfer logs                          = 4175
  SUCCESS                              = 3626
  FAILED                               = 549
  scope=auto                           = 4175
  orphan assignment references         = 731   (preserved; not deleted)
failure reasons observed               = ADJACENT_SLOT_AT_BRANCH
                                        SAME_SESSION_AT_MAIN_BRANCH
                                        SPECIALIZATION_MISMATCH
                                        TEACHER_CONFLICT
```

* `isTransferred`, `transferredAt`, `transferredFromTeacher`
  are preserved verbatim on every assignment.
* 35 transferred assignments have
  `transferredFromTeacher=null`. No value was synthesized.
* 731 transfer logs reference assignment ids that no longer
  exist in `assignments`. They are not deleted; they are
  marked `orphanHistorical` in the integrity audit.
* Failure reasons are preserved verbatim. They are domain
  evidence (intelligence about why past transfers failed);
  they are NOT hard constraints on the new solver.

---

## 12. Teacher transfer eligibility (§13)

| Field                      | Source | Scheduling |
| -------------------------- | ------ | ---------- |
| `branch` (home branch)     | 42 present, 0 null | 40 present, 0 null |
| `allowedTransferBranches[]`| 0 present, 42 empty | 0 present, 40 missing |
| `preferredTransferBranches[]` | 40 present, 2 empty | not in scheduling |

* `allowedTransferBranches[]` is **empty for every source
  teacher**. The orchestrator's `H_TRANSFER_ALLOWED`
  constraint is therefore **INACTIVE** in the current
  scheduling model. The 87 transferred assignments are not
  validated against a transfer-allow-list.
* `preferredTransferBranches[]` is preserved on 40 source
  teachers but is not projected into the scheduling model
  today (the contract does not surface it). It remains in
  `normalized.teachers` for a future phase to wire in.

The brief says: do NOT auto-fill. We do not.

---

## 13. Preferences (§14)

| Field                       | Source value | Source null | Source empty | In scheduling?       |
| --------------------------- | ------------ | ----------- | ------------ | -------------------- |
| `maxSessionsPerWeek`        | 42           | 0           | 0            | nguyenVong.soBuoiToiDa |
| `preferredSession`          | 35           | 7           | 0            | nguyenVong.buoiUuTien   |
| `fixedDayOff`               | 0            | 42          | 0            | nguyenVong.thuNghi (= []) |
| `preferredGrades`           | 0            | 0           | 42 (empty)   | NOT_IN_SCHEDULING      |
| `preferredTransferBranches` | 40           | 0           | 2 (empty)    | NOT_IN_SCHEDULING      |
| `transferPriority`          | 0            | 0           | 42 (empty)   | NOT_IN_SCHEDULING      |

* `maxSessionsPerWeek` and `preferredSession` are projected
  into `nguyenVong` and reach the orchestrator.
* 7 teachers have `preferredSession=null`. The audit counts
  them; the scheduling model maps them to `ca_hai` (no
  preference). The legacy value (`null`) is preserved in
  `normalized.teachers[i].preferredSession`.
* `fixedDayOff`, `preferredGrades`, `preferredTransferBranches`,
  `transferPriority` are preserved in the source but not
  promoted to the scheduling model. The contract has no
  fields for them today.

---

## 14. Session model (§15)

| Branch | schoolDays | periods | slots |
| ------ | ---------- | ------- | ----- |
| (all 7) | [1..6]   | [1..5]  | 30 each |

Preferred-session distribution across the 40 active teachers:

```text
sang (morning)        = 0
chieu (afternoon)     = 35
ca_hai (no preference)= 5
(no nguyenVong)       = 0
```

A teacher with `chieu` preference will be scored by
`S_PREFERRED_SESSION` against the sang/chieu split of their
assigned slots. The `period` is a period number, not a
session; the session is derived from the branch profile
(default `period <= 5 → sang`, `period > 5 → chieu`).

---

## 15. Travel readiness (§16)

```text
travelTime                       = null
travelStatus                    = MISSING_CONFIGURATION
H_TRAVEL_FEASIBLE               = INACTIVE
schedulingAssignmentBranchPairs = 35  (unique class/teacher branch combinations)
transferHistory.fromBranch set   = 3709
transferHistory.toBranch set     = 4175
```

* The legacy dump has no travel matrix. We do not invent one.
* `H_TRAVEL_FEASIBLE` is INACTIVE; cross-branch travel
  feasibility is not enforced today. The brief's
  "TRAVEL_DATA_MISSING" status is implicit in
  `travelStatus === 'MISSING_CONFIGURATION'`.
* The scheduling model already carries the
  `(assignment.branchId, class.branch, teacher.branch)` tuples
  that a future `TravelProvider` would consume. The data
  shape is ready; the provider is not.

---

## 16. Orchestrator dry-run (§17)

```text
status                  = INVALID_INPUT
strategiesAttempted     = 0
solutionsProduced       = 0
totalSolveMs            = 0
threw                   = null (no exception)
```

Pre-scheduler validation result:

```text
issuesByCode     = { invalid_reference: 21, unresolvable_demand: 479 }
issuesByEntity   = { assignment: 479, curriculum: 21 }
missingByEntity  = { Travel: 1 }   // legitimate — no travel matrix
```

The single `missing` (`Travel`) is the legitimate one: the
legacy dump has no travel matrix. It is **not** a
loader-induced error.

The 500 `issues` are **all** caused by two projection bugs in
`backend/src/loader/legacy-saplich/scheduling-model.js`
(§7 and §9 above). The source data is correct; the
projection to the scheduling-model contract is wrong in two
places.

| Issue | Count | Root cause | Source data | Fix location |
| ----- | ----- | ---------- | ----------- | ------------ |
| `invalid_reference` on `curriculum.classId` | 21 | block id stored where class id is expected | correct (block ids) | scheduling-model.js |
| `unresolvable_demand` on `assignment` | 479 | subject id compared against subject name | correct (matching namespaces) | scheduling-model.js |

The orchestrator's `INVALID_INPUT` status is the **correct**
response to a malformed scheduling model. Phase 20 surfaces
the issues; Phase 21+ must fix the projection so the
orchestrator accepts the input.

---

## 17. What the brief said to verify (and where it lives)

| Brief section | Audit module | Result |
| ------------- | ------------ | ------ |
| §2 Traceability        | `verifyTraceability`            | ✓ |
| §3 Teachers            | `verifyTeachers`                | ✓ |
| §4 Workload            | `verifyWorkload`                | ✓ (mismatch reported) |
| §5 Branches            | `verifyBranches`                | ✓ |
| §6 Classes             | `verifyClasses`                 | ✓ |
| §7 Subjects            | `verifySubjects`                | ✓ (CN-TH preserved) |
| §8 Curriculum          | `verifyCurriculum`              | ✓ + 1 known issue |
| §9 Demand              | `verifyDemand`                  | ✓ |
| §10 Assignment         | `verifyAssignments`             | ✓ + 1 known issue |
| §11 Schedule slots     | `verifyScheduleSlots`           | ✓ |
| §12 Transfers          | `verifyTransfers`               | ✓ |
| §13 Transfer eligibility | `verifyTransferEligibility`   | ✓ (INACTIVE in scheduling) |
| §14 Preferences        | `verifyPreferences`             | ✓ |
| §15 Session model      | `verifySessionModel`            | ✓ |
| §16 Travel readiness   | `verifyTravelReadiness`         | ✓ |
| §17 Dry-run orchestrator | `dryRunOrchestrator`         | surfaced 2 known issues |

---

## 18. Definition of done (Phase 20)

| Item | Status |
| ---- | ------ |
| RAW → NORMALIZED → SCHEDULING MODEL → ORCHESTRATOR INPUT pipeline walked | ✓ |
| Source data preserved (no mutation by the audit) | ✓ |
| ID stability asserted (no new IDs) | ✓ |
| 40 active teachers, no inactive leak | ✓ |
| 7 branches, no inference | ✓ |
| 113 classes, no inference | ✓ |
| 6 subjects, CN-TH preserved and excluded from demand | ✓ |
| 24 raw blocksubjects, 21 in active curriculum | ✓ |
| 479 assignments, 802 required / 802 assigned / 0 shortage | ✓ |
| 87 transferred assignments, 35 with null `transferredFromTeacher` | ✓ |
| 4175 transfer logs, 3626 SUCCESS / 549 FAILED, 731 orphan | ✓ |
| Travel = MISSING, H_TRAVEL_FEASIBLE = INACTIVE | ✓ |
| 48 phase-20 tests pass | ✓ |
| 269 / 269 total tests pass | ✓ |
| No domain contract change | ✓ |
| No source-data change | ✓ |
| No business-data change | ✓ |
| No solver run, no benchmark | ✓ |
| 2 known projection issues documented (not fixed) | ✓ |

---

## 19. Path forward (Phase 21+ candidates, NOT in scope here)

Two projection bugs surfaced by the audit need a future
phase. They are both in
`backend/src/loader/legacy-saplich/scheduling-model.js`:

1. **Curriculum `classId` is a block id.** The fix is to
   either (a) project to a `(blockId, classIds[])` map and
   let the orchestrator fan it out, or (b) introduce a
   `curriculumBlockId` field on the contract shape.
   Decision: future phase.

2. **Teacher `chuyenMon[].tenChuyenMon` is a name while
   `assignment.subjectId` is an id.** The fix is to project
   `tenChuyenMon` to the subject id (matching the existing
   eligibility check), or to project `subjectId` to the
   subject name (matching the existing `tenChuyenMon`
   shape). Decision: future phase.

After the projection is fixed, the orchestrator's pre-scheduler
validation should report `0` issues, and the dry-run should
proceed to call the solver (status `OK` or `EMPTY`).

Phase 20 does not run the solver. Phase 20 is
`VERIFY + AUDIT + TRACE + TEST + DOCUMENT`, and that is what
this document is.

---

## 20. Test report

```text
Before phase 19: 172 tests
After  phase 19: 221 tests   (+49 in tests/phase19_legacy_ingestion.test.js)
After  phase 20: 269 tests   (+48 in tests/phase20_orchestrator_audit.test.js)
Pass:            269
Fail:              0
```

The 172 pre-existing tests still pass. No existing test was
modified by phase 19 or phase 20.