# SCHEDULING_DATA_CONTRACT.md

> Authoritative data contract for the `thuanhung_tkb` AI-assisted
> multi-school timetable optimization system.
>
> This file is the source of truth for the **shape** of every piece
> of data the system reads or writes. It is intentionally
> implementation-agnostic: it does not name a database driver, an
> ORM, or a wire format.

---

## 1. Authoritative sources

| Entity    | Production collection | Test fixture                                |
| --------- | --------------------- | ------------------------------------------- |
| Teacher   | `giao_vien`           | `data/fixtures/teachers.authoritative.json` |
| Branch    | `chi_nhanh`           | (missing — see §3)                          |
| Class     | `lop`                 | (missing — see §3)                          |
| Subject   | (constants file)      | (same)                                      |
| Curriculum| derived               | (missing — see §3)                          |
| Schedule  | `tkb`                 | (in-memory only)                            |
| Transfer  | `transfer_log`        | (in-memory only)                            |
| Travel    | (constants file)      | (missing — see §3)                          |

---

## 2. Teacher contract

```text
Teacher {
  id:           string                  // from _id.$oid
  hoTen:        string                  // "kim" / "thư" / "trinh" / "trâm" / "nản"
  email:        string                  // "" allowed
  soDienThoai:  string                  // "" allowed
  trangThai:    "active" | string       // observed value: "active"
  chuyenMon:    Specialization[]
  nguyenVong?:  Preference              // optional
  homeBranchId?: string                 // optional, MISSING in fixture
}

Specialization {
  tenChuyenMon: string                  // "Công nghệ", "Tin học", ...
  soTietTuan:   number                  // integer >= 0
}

Preference {
  soBuoiToiDa:  number                  // integer >= 0
  buoiUuTien:   "sang" | "chieu" | "ca_hai"
  thuNghi:      number[]                // day codes 1..7
}
```

The fixture is canonical. Field order, casing, and the
"updatedAt is sometimes a string, sometimes an object" quirk are
preserved.

---

## 3. Missing-data policy

| Field            | Status (fixture)  | Runtime behavior on absence                            |
| ---------------- | ----------------- | ------------------------------------------------------ |
| `email`          | empty string      | treated as `""`; not a blocker                         |
| `soDienThoai`    | empty string      | treated as `""`; not a blocker                         |
| `nguyenVong`     | missing for `thư`, `trâm`, `nản` (per second brief) | treated as `undefined`; soft preferences skipped; reported in `missingData` |
| `homeBranchId`   | missing           | treated as `undefined`; transfer constraints `INACTIVE`; reported in `missingData` |
| Branch            | n/a (no fixture)  | `INACTIVE`; `H_TRANSFER_ALLOWED` skipped              |
| Class             | n/a               | no Curriculum, no Assignment; preview reports empty demand |
| Subject catalog   | n/a               | subject names are taken verbatim from `chuyenMon[].tenChuyenMon` |
| Curriculum        | n/a               | `INFEASIBLE_DEMAND` reported for any class needing teaching |
| Travel provider   | n/a               | `MISSING_CONFIGURATION`; `H_TRAVEL_FEASIBLE` skipped   |

The system must not invent any of the above to "make the test
pass". Inventing data is a contract violation.

---

## 4. Loader contract

```text
load(source) -> LoaderOutput

LoaderOutput {
  teachers:    Teacher[]
  missing:     MissingField[]
  warnings:    string[]
}

MissingField {
  entity:     "teacher" | "branch" | "class" | "subject" | "curriculum" | "travel"
  entityId:   string
  field:      string
  reason:     "absent_in_source" | "invalid_type" | "parse_error"
}
```

A loader is a **pure** function from the source to `LoaderOutput`.
It must:

- accept the fixture byte-for-byte,
- not modify the source,
- emit one `MissingField` per (entity, field) pair that is absent
  in the source,
- never fill in defaults that the source did not declare.

---

## 5. Solver input/output contract

Defined in `OPTIMIZATION_INTERFACE.md`. Recap:

- `SolverInput` carries the normalized model.
- `SolverOutput` carries a list of `SolutionCandidate` plus
  diagnostics. No candidate is returned without a `Score` and a
  `ValidationReport` attached by the orchestrator.

---

## 6. Commit contract

A `POST /api/scheduling/commit` accepts a `solutionId` from a
previous preview. The handler:

1. Looks the solution up in the in-memory preview cache.
2. Re-runs the validator. If a hard violation is now reported
   (e.g. data changed since preview), the commit returns 409.
3. Writes the schedule documents and transfer events in a single
   transaction.
4. Returns the new `tkb` state.

The commit handler does not call the AI, does not re-run the
solver, and does not take a new strategy.

---

## 7. Versioning

Changes to this document are append-only. Each change adds a row
to the changelog at the top of this file and bumps the contract
version. The loader is responsible for accepting both the
previous and the new shape during a deprecation window.
