# SCHEDULING MODEL

This document defines the time and place abstraction that the solver
operates on. It is deliberately minimal: a `(day, period, branch)`
tuple plus a small amount of metadata.

---

## 1. Day

A Day is an integer 1..7.

The default mapping is ISO:

```text
1 = Monday
2 = Tuesday
3 = Wednesday
4 = Thursday
5 = Friday
6 = Saturday
7 = Sunday
```

A Branch may declare which days are "school days" (e.g. 1..6 for
Mon–Sat, 1..5 for Mon–Fri). The solver only considers school days.

**Status:** `MISSING DATA` for production. The fixture does not
declare school days. Interface only.

---

## 2. Period

A Period is an integer 1..N within a day.

A Branch defines the list of periods, e.g.:

```text
[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
```

Each period belongs to a **Session** (see §3) and has a start/end
time used for travel feasibility.

**Status:** `MISSING DATA` for production. The fixture does not
declare periods. Interface only.

---

## 3. Session

A Session groups periods within a day.

| Code     | Meaning     | Default period range (placeholder) |
| -------- | ----------- | ---------------------------------- |
| `sang`   | Morning     | periods 1..5                       |
| `chieu`  | Afternoon   | periods 6..10                      |
| `ca_hai` | No pref.    | any                                |

The exact cut-off is **branch-configurable** and is part of the
branch profile, not the solver. The codes come from
`nguyenVong.buoiUuTien` in the authoritative fixture. The fixture
uses `ca_hai` (kim) and `chieu` (trinh); `thư`, `trâm`, and `nản` have
no `nguyenVong` at all.

**Status:** Codes are fixed by the fixture. Ranges are
`MISSING DATA`.

---

## 4. TimeSlot

```text
TimeSlot {
  branchId: string,
  day:      number,   // 1..7
  period:   number,   // 1..N
}
```

Two TimeSlots are equal iff all three fields are equal.

A Branch has a finite set of valid TimeSlots:

```text
slots(branch) = (branch.schoolDays) × (branch.periods)
```

The solver never creates a TimeSlot outside that set.

---

## 5. Assignment vs. Schedule Slot

Important distinction:

- An **Assignment** says *what* must be scheduled
  (`class, subject, teacher, requiredPeriods`).
- A **Schedule Slot** is one of the `requiredPeriods` placements
  decided by the solver.

So one Assignment with `requiredPeriods = 4` yields four Schedule
Slots, each with a distinct TimeSlot.

---

## 6. Day-off (`thuNghi`)

`nguyenVong.thuNghi` is `number[]` of day codes (1..7). It is a
**soft** preference. The solver tries to avoid placing the teacher's
slots on those days but does not refuse to place them.

A teacher with `thuNghi = []` (all teachers in the fixture) has no
fixed day off. They still benefit from being scheduled on the same
days (subject to constraints and preferences).

---

## 7. Spread / no-gap

The system supports a soft objective "no gap in teacher day" (a
teacher should not have a free period between two teaching periods
on the same day, when avoidable). It is **not** a hard constraint.

It is a weighted objective controlled by AI strategy.

---

## 8. Workload as a per-teacher weekly budget

For each teacher `t`:

```text
budget(t) = sum(chuyenMon[i].soTietTuan for i in t.chuyenMon)
```

The solver tries to place exactly `budget(t)` slots for `t` across
the week. If demand (sum of `Assignment.requiredPeriods` for which
`t` is the assigned teacher) differs from `budget(t)`, the system
reports it as a **shortage** (demand > budget) or **surplus**
(demand < budget) and it shows up in the score and the missing-data
report.

`budget` is computed at runtime. It is never stored.

---

## 9. Multi-school model

A Schedule is computed across multiple Branches. Branches share
the same teacher pool. A teacher can appear in two or more
branches in the same day if and only if the travel constraint is
satisfied.

Branch interactions are part of the same model — not a separate
post-pass.
