# DATA CONTRACT

This document is the source of truth for **which data lives where**
and **which field names are canonical**.

---

## 1. Source of truth matrix

| Data                | Production source           | Test source                            | Phase-1 status |
| ------------------- | --------------------------- | -------------------------------------- | -------------- |
| Teacher             | `giao_vien` collection      | `data/fixtures/teachers.authoritative.json` | Provided    |
| Branch              | `chi_nhanh` collection      | `MISSING DATA`                         | Interface only |
| Class               | `lop` collection            | `MISSING DATA`                         | Interface only |
| Subject             | `constants/subjects.js`     | same                                   | Interface only |
| Curriculum          | derived / `chuong_trinh`     | `MISSING DATA`                         | Interface only |
| Assignment          | computed at runtime         | computed at runtime                    | Interface only |
| Schedule            | `tkb` collection            | in-memory only                         | Interface only |
| Travel              | `constants/travel.js` (TBD) | `MISSING CONFIGURATION`                | Interface only |
| Branch profile      | `chi_nhanh` collection      | `MISSING DATA`                         | Interface only |

If two sources exist for the same field, the production source wins.
Tests may use a fixture **only** when the production data is
unavailable, and the fixture is then considered authoritative
*for that test* but never promoted to production.

---

## 2. Authoritative teacher fixture

`data/fixtures/teachers.authoritative.json` contains the five
teachers from the brief. The file is **byte-identical** to the data
in the task:

- Field order preserved.
- Whitespace preserved.
- `__v`, `_id.$oid`, ISO dates preserved as in the source.
- `hoTen` casing preserved (`kim`, `thư`, `trinh`, `trâm`, `nản`).
- Empty strings for `email` and `soDienThoai` preserved.
- `nguyenVong` is **absent** for `thư`, `trâm`, and `nản` (per the
  second brief's authoritative data). Do not add it.
- The `updatedAt` for `nản` is the string `"2026-08-29T15:30:30.221Z"`
  (not a `$date` object). This is a quirk of the source data and is
  preserved.

The fixture is loaded as-is and the loader is required to accept
both shapes of `updatedAt` (object with `$date` and bare ISO string).

---

## 3. Loading rules

A loader reads either the fixture or a MongoDB collection and
returns a normalized in-memory `Teacher` shape (see `DOMAIN.md`).
The loader:

1. Maps `_id.$oid` (or string `_id`) to `id`.
2. Maps `chuyenMon[]` to `Specialization[]` with the same field names.
3. Maps `nguyenVong` (when present) to `Preference`. When absent,
   the field is `undefined`, not an empty object.
4. Coerces `updatedAt` and `createdAt` to `Date` objects; if parsing
   fails, surfaces a loader warning but does not fail the load.
5. Reports, for each loaded teacher, the set of missing optional
   fields. This set feeds the missing-data report.

The loader must not modify, sort, rename, normalize, clean or
deduplicate the source data.

---

## 4. Missing-data policy

For every field marked "no" under "Required" in `DOMAIN.md`, the
runtime must treat the absence as `null`/`undefined`/empty
collection and surface it in:

- the per-solution `missingData` block, and
- the system-wide `missingData` report produced during `preview`.

The system must not invent values to fill missing fields. Examples
that are explicitly forbidden:

- Auto-filling `email = "${hoTen}@example.com"`.
- Auto-filling `soDienThoai = "0000000000"`.
- Auto-filling `nguyenVong = { soBuoiToiDa: 4, buoiUuTien: 'ca_hai', thuNghi: [] }`
  for `thư`, `trâm`, or `nản`.
- Inventing a `homeBranchId` from any source.
- Inventing any Class, Subject, Curriculum or Branch for the
  purpose of "making the test pass".

When a missing field would block a hard constraint from being
evaluated, the system reports it as `UNRESOLVABLE` and the AI
strategy decides whether to:

- skip the affected entity (with an explicit `WHY_SKIPPED` reason),
  or
- fail the entire preview with a structured error.

---

## 5. Subject name matching

Subject matching is by **exact string equality** of `tenChuyenMon`
(teacher) vs. `Subject.name` (curriculum). Aliases are not used in
Phase 1.

If a Curriculum references a Subject name that no teacher has, the
Assignment is reported as `UNRESOLVABLE_DEMAND`.

---

## 6. Multi-tenancy / multi-school

The fixture has no Branch information. The first time the system
is run with real data, a Branch loader will be added in Phase 2+.

Until then, the `MISSING DATA` policy applies and the system
**must** fail loudly on Branch-dependent code paths rather than
guessing.

---

## 7. Versioning the contract

`SCHEDULING_DATA_CONTRACT.md` (this file) is the contract. Any
breaking change to a field name, type or required/optional flag
requires:

1. A new entry in a `CHANGELOG` block at the top of this file.
2. A migration step in the loader that converts old fixtures to
   the new shape.
3. A regression test that re-loads the previous fixture through
   the new loader and confirms the expected derived shape.
