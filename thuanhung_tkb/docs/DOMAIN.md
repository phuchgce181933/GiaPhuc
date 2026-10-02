# DOMAIN MODEL

This document defines every core entity. Field names match the
authoritative teacher fixture exactly. All other entities are
**master data** that will be supplied later — they are defined here
as interfaces, not as production data.

---

## 1. Teacher

**Source of truth:** `data/fixtures/teachers.authoritative.json`
(for tests) and the `giao_vien` collection (for production).

The Teacher model is the central entity. It owns specializations,
workload, preferences and transfer policy. A Teacher is **one** person
even if `chuyenMon` has multiple entries.

### Shape

| Field           | Type                  | Source field      | Required | Notes                                                                  |
| --------------- | --------------------- | ----------------- | -------- | ---------------------------------------------------------------------- |
| id              | string                | `_id.$oid`        | yes      | Stable identifier from MongoDB.                                       |
| hoTen           | string                | `hoTen`           | yes      | Stored value is preserved. Display casing is a UI concern.            |
| email           | string                | `email`           | no       | Empty string is a valid value. Do not invent one.                      |
| soDienThoai     | string                | `soDienThoai`     | no       | Same as `email`. Empty string is valid.                                |
| trangThai       | enum                  | `trangThai`       | yes      | Currently observed values: `active`. Extend only when source provides. |
| chuyenMon       | Specialization[]      | `chuyenMon`       | yes      | At least one entry.                                                    |
| nguyenVong      | Preference \| null    | `nguyenVong`      | no       | Absent in fixture for `thư`, `trâm`, and `nản` (per second brief). `null` is a valid value. |
| homeBranchId    | string \| null        | (future)          | no       | Not present in authoritative fixture. Treated as `MISSING_DATA`.      |

### Specialization (embedded)

| Field         | Type   | Source field      | Required | Notes                                                     |
| ------------- | ------ | ----------------- | -------- | --------------------------------------------------------- |
| tenChuyenMon  | string | `tenChuyenMon`    | yes      | Subject name. Used for matching. Case preserved.          |
| soTietTuan    | number | `soTietTuan`      | yes      | Per-subject periods per week. Integer >= 0.               |

### Preference (embedded, optional)

| Field         | Type            | Source field      | Notes                                                        |
| ------------- | --------------- | ----------------- | ------------------------------------------------------------ |
| soBuoiToiDa   | number          | `soBuoiToiDa`     | Max sessions per week. Soft constraint.                       |
| buoiUuTien    | enum            | `buoiUuTien`      | `sang` \| `chieu` \| `ca_hai`. Soft constraint.              |
| thuNghi       | number[]        | `thuNghi`         | Days off (1=Mon..7=Sun or 0=Sun..6=Sat — see SESSION model).  |

### Workload

Workload is computed at runtime by summing `soTietTuan` over the
teacher's `chuyenMon`. It is never stored as its own field. The unit
is "periods per week".

```text
kim.workload = 1 (Công nghệ) + 1 (Tin học) = 2
thư.workload = 4 (Tiếng Anh) = 4
trinh.workload = 1 (Mỹ thuật) = 1
trâm.workload = 1 (Âm nhạc) = 1
nản.workload = 2 (Giáo dục thể chất) = 2
```

### Eligibility

A Teacher is **eligible** to teach `(Class, Subject)` if and only if
there exists an entry in `chuyenMon` where `tenChuyenMon === Subject.name`.

```text
kim  → Công nghệ   = ELIGIBLE
kim  → Tin học     = ELIGIBLE
kim  → Toán        = NOT ELIGIBLE
thư  → Tiếng Anh   = ELIGIBLE
thư  → Mỹ thuật    = NOT ELIGIBLE
```

### Missing data

The fixture deliberately omits `email`, `soDienThoai`, `homeBranchId`
and (for `thư`, `trâm`, `nản`) `nguyenVong`. The system must accept these
as `null`/`undefined`/empty-array, never invent values, and surface
them in the missing-data report.

---

## 2. Branch

A Branch is a physical site (one school, one address).

| Field      | Type     | Required | Notes                                       |
| ---------- | -------- | -------- | ------------------------------------------- |
| id         | string   | yes      | Stable identifier.                          |
| name       | string   | yes      |                                             |
| address    | string   | no       |                                             |
| timeZone   | string   | no       | Default: system.                            |

**Status:** `MISSING DATA` in the project. Interface only.

---

## 3. Class

A Class belongs to a Branch and has a grade level.

| Field        | Type   | Required | Notes                                |
| ------------ | ------ | -------- | ------------------------------------ |
| id           | string | yes      |                                      |
| branchId     | string | yes      | Foreign key to Branch.               |
| name         | string | yes      |                                      |
| gradeLevel   | number | yes      | 1..12 (or whatever curriculum uses). |

**Status:** `MISSING DATA` in the project. Interface only.

---

## 4. Subject

Master data. Defined once. No per-tenant override.

| Field      | Type   | Required | Notes                                |
| ---------- | ------ | -------- | ------------------------------------ |
| id         | string | yes      |                                      |
| name       | string | yes      | Must match `chuyenMon[].tenChuyenMon`. |
| aliases    | string[] | no     | Optional normalization for matching. |

**Status:** `MISSING DATA` in the project. The system must accept
the name strings in the teacher fixture as canonical and match them
verbatim. No new subjects are invented.

---

## 5. Curriculum

A Curriculum is the mapping from `(Class, Subject)` to
`RequiredPeriodsPerWeek`. It is the source of demand.

| Field            | Type     | Required | Notes                              |
| ---------------- | -------- | -------- | ---------------------------------- |
| classId          | string   | yes      |                                    |
| subjectId        | string   | yes      |                                    |
| requiredPeriods  | number   | yes      | Integer >= 0.                      |

**Status:** `MISSING DATA` in the project. Interface only.

---

## 6. Assignment

An Assignment is the **input** to scheduling. It is the answer to:

> Which teacher is responsible for which class / subject, and how
> many periods per week?

| Field              | Type   | Required | Notes                                  |
| ------------------ | ------ | -------- | -------------------------------------- |
| id                 | string | yes      | Stable per generation.                 |
| classId            | string | yes      |                                        |
| subjectId          | string | yes      |                                        |
| teacherId          | string | yes      | Must satisfy eligibility.              |
| requiredPeriods    | number | yes      | Usually = `Curriculum.requiredPeriods`.|
| isFixedTransfer    | bool   | no       | Teacher is transferred for this.       |

Assignments are produced from the combination of **Curriculum** and
**Teacher eligibility** plus the current transfer policy. They are the
unit the solver operates on — one Assignment expands into
`requiredPeriods` schedule slots.

---

## 7. TimeSlot

A TimeSlot is `(day, period)` on a specific Branch.

| Field      | Type     | Notes                                       |
| ---------- | -------- | ------------------------------------------- |
| day        | number   | 1=Mon .. 7=Sun (or whichever the school uses). |
| period     | number   | 1..N (N is branch-configurable).            |
| branchId   | string   |                                             |

A Schedule is a set of assignments of TimeSlots to Assignments.
The solver chooses which TimeSlot each `Assignment.requiredPeriods`
slots take.

---

## 8. Session

A logical session within a day.

| Code       | Meaning                                 |
| ---------- | --------------------------------------- |
| `sang`     | Morning periods (configurable range).   |
| `chieu`    | Afternoon periods (configurable range). |
| `ca_hai`   | "Both" — no preference.                 |

The authoritative fixture uses `ca_hai` for `kim` and `chieu` for
`trinh`, `nản`. The values in source are preserved; normalization is
internal.

---

## 9. Schedule (output)

A Schedule is the solver's output: a map of `Assignment` -> ordered
list of TimeSlots.

```text
Schedule
 ├── SolutionId
 ├── assignments: Map<AssignmentId, TimeSlot[]>
 ├── transfers:   TransferEvent[]
 └── explanations: ExplanationEvent[]
```

---

## 10. Travel (interface)

```text
TravelTime(branchA, branchB, periodA) -> minutes | null
```

If a teacher has a slot at `branchA` in `periodA` and another at
`branchB` in `periodB`, the transition is feasible iff:

```text
available transition time (periodB.start - periodA.end) >= TravelTime(branchA, branchB)
```

**Status:** `MISSING CONFIGURATION`. No default times. Interface
only; the runtime must call into a registered provider and fall back
to `null` (infeasible) when missing.

---

## 11. TransferEvent

```text
TransferEvent {
  teacherId, fromBranchId, toBranchId,
  day, period, reasonCode, factors[]
}
```

A teacher may have multiple TransferEvents per Schedule, but two
transfers on the same day must respect the travel constraint above.
