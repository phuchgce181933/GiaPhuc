# PHASE 22 — CONSTRAINT AUDIT

> Phase 22 builds a structured, independent constraint catalog
> and evaluator. This audit applies the catalog to the real
> dataset and to the legacy baseline. The audit is read-only.
> No fixture, no baseline, no source data is modified.
>
> Code under audit:
>   - `backend/src/domain/constraints/catalog.js`
>   - `backend/src/domain/constraints/evaluator.js`
>   - `backend/src/domain/constraints/index.js`
>   - `backend/tests/phase22_constraints.test.js`
>
> Documentation:
>   - `docs/CONSTRAINT_SPECIFICATION.md` — the catalog
>     contract (H01–H14, S01–S08)
>   - `docs/PHASE_22_CONSTRAINT_AUDIT.md` — this document

---

## 1. Real-data activation table

| ID  | Code                          | Category | Status (real data) |
| --- | ----------------------------- | -------- | ------------------ |
| H01 | `H_CLASS_NO_DOUBLE_BOOK`      | HARD     | ACTIVE             |
| H02 | `H_TEACHER_NO_DOUBLE_BOOK`    | HARD     | ACTIVE             |
| H03 | `H_TEACHER_ELIGIBLE`          | HARD     | ACTIVE             |
| H04 | `H_SLOT_IN_BRANCH`            | HARD     | ACTIVE             |
| H05 | `H_ASSIGNMENT_COMPLETE`       | HARD     | ACTIVE             |
| H06 | `H_SLOT_VALID`                | HARD     | ACTIVE             |
| H07 | `H_CLASS_SUBJECT_ONE_TEACHER` | HARD     | ACTIVE             |
| H08 | `H_ACTIVE_ENTITY`             | HARD     | ACTIVE             |
| H09 | `H_WORKLOAD_CAPACITY`         | HARD     | **INACTIVE**       |
| H10 | `H_MAX_SESSIONS_PER_WEEK`     | HARD     | ACTIVE             |
| H11 | `H_FIXED_DAY_OFF`             | HARD     | **INACTIVE**       |
| H12 | `H_PREFERRED_SESSION`         | HARD     | **INACTIVE**       |
| H13 | `H_TRANSFER_ALLOWED`          | HARD     | **INACTIVE**       |
| H14 | `H_TRAVEL_FEASIBLE`           | HARD     | **UNSUPPORTED**    |
| S01 | `S_PREFERRED_SESSION`         | SOFT     | ACTIVE             |
| S02 | `S_MAX_SESSIONS_PRESSURE`     | SOFT     | ACTIVE             |
| S03 | `S_PREFERRED_DAY_OFF`         | SOFT     | **INACTIVE**       |
| S04 | `S_WORKLOAD_BALANCE`          | SOFT     | **INACTIVE**       |
| S05 | `S_TRANSFER_PREFERENCE`        | SOFT     | **INACTIVE**       |
| S06 | `S_PREFERRED_GRADE`           | SOFT     | **INACTIVE**       |
| S07 | `S_SESSION_COMPACTNESS`       | SOFT     | ACTIVE             |
| S08 | `S_TEACHER_DAY_CONCENTRATION` | SOFT     | ACTIVE             |

Counts:

| Category   | Total | ACTIVE | INACTIVE | UNSUPPORTED |
| ---------- | ----: | -----: | -------: | ----------: |
| HARD       |    14 |      9 |        4 |           1 |
| SOFT       |     8 |      4 |        4 |           0 |
| **total**  |    22 |     13 |        8 |           1 |

---

## 2. Data dependencies

The legacy dump carries the following per-teacher data:

| Field                            | Teachers with field |
| -------------------------------- | ------------------: |
| `chuyenMon[].soTietTuan > 1`     |                   0 |
| `chuyenMon[].soTietTuan` (any)   |                  40 |
| `nguyenVong.soBuoiToiDa`         |                  40 |
| `nguyenVong.thuNghi`             |                   0 |
| `nguyenVong.buoiUuTien`          |                  40 |
| `allowedTransferBranches`        |                   0 |
| `preferredTransferBranches`      |                   0 |
| `preferredGrades`                |                   0 |
| `travelTime` (input level)       |                   0 |

Implications:

- **H09, S04** — placeholder gate fires. The dump projects
  `chuyenMon[].soTietTuan = 1` everywhere, so neither the
  hard capacity check nor the soft balance check is
  enforceable. Both stay INACTIVE.
- **H11, S03** — `thuNghi` is empty for every teacher. The
  hard "no day off" and the soft "preferred off" both stay
  INACTIVE.
- **H13, S05** — no transfer policy data. The transfer
  constraint and the soft transfer preference both stay
  INACTIVE.
- **S06** — no `preferredGrades`. The soft preferred-grade
  constraint stays INACTIVE.
- **H14** — `travelTime` is `null`. H14 is **UNSUPPORTED**
  (parked, never fabricated). This is the most important
  INACTIVE in the catalog: the travel matrix simply does
  not exist in the source data and the system never
  invents one.

ACTIVE constraints (13/22) have everything they need.

---

## 3. `tenChuyenMon` semantic check (Phase 22 §29)

The brief required verifying whether `tenChuyenMon` was being
forced to carry a subject id instead of a subject name.

```text
chuyenMon[].tenChuyenMon values in the real dataset:
  'Mỹ thuật', 'Tiếng Anh', 'Âm nhạc', 'Tin học',
  'Giáo dục thể chất'
```

**Status: correct semantic, no change needed.** The field
carries the actual subject name, not a hex id. The
eligibility check (`domain/eligibility.js`) prefers the
explicit `eligibleSubjectIds[]` first, then falls back to a
name-based match against `tenChuyenMon`. The two projections
are:

- `eligibleSubjectIds[]` — solver-friendly list of subject
  ids. The new constraint catalog consults this first.
- `chuyenMon[].tenChuyenMon` — Vietnamese name field. The
  legacy fallback path. The value is the name.

No source-data change. No projection change. No test change.

---

## 4. Legacy baseline evaluation

The legacy baseline is `legacyBaseline.scheduleSlots` (802
historical slots). `evaluateBaseline()` converts the slots
to the canonical candidate shape (day string → day number,
branch derived from class) and runs the evaluator. The
baseline is **read-only** — we never modify it and we never
promote it to a target.

The Phase 22 §27 invariant holds: the baseline is evaluated
to know what historical imperfections it carries, not to
treat them as goals.

| Constraint          | Violations |
| ------------------- | ---------: |
| H01 (class double)  |         83 |
| H02 (teacher double)|        252 |
| H04 (slot in branch) |          0 |
| H06 (slot validity) |          0 |
| **Total hard**      |    **335** |

| Constraint          | Penalty |
| ------------------- | ------: |
| S01 (pref session)  |   35.00 |
| S07 (compactness)   |    0.00 |
| S08 (concentration) |    0.00 |
| **Total soft**      | **35.00** |

`accepted: false` — the historical baseline carries 335
real class/teacher double-bookings. These are real
imperfections in the historical data, not artefacts of the
catalog.

The baseline carries **zero** H04 / H06 violations because
`evaluateBaseline()` derives the branch from the class and
the day number from the slot's `day` string. The catalog
never invents data; the conversion uses the assignment's
`classId` → `branchId` mapping that the SchedulingInput
already provides.

---

## 5. What was NOT changed (Phase 22 invariants)

* No source-data change. The legacy BSON dump and the
  `data/source/legacy-saplich/` folder are untouched.
* No normalized-data change. `normalize.js` is untouched.
* No projection change. `scheduling-model.js` is untouched.
  (Phase 21 already fixed the `tenChuyenMon` and
  `curriculum.classId` projections.)
* No validator / orchestrator / solver / AI / scorer
  change. `domain/constraints.js` (the legacy validator
  path) is preserved for backward compatibility.
* No baseline promotion. The legacy baseline stays a
  baseline; assignments still carry `baselineAssignment:
  true`; no `fixedAssignment` flag exists.
* No travel fabrication. `travelTime` stays `null`. H14
  stays UNSUPPORTED.
* No solver optimization. The brief is explicit: Phase 22
  does NOT tune weights, MRV, LCV, or any strategy.
* No `tenChuyenMon` rewrites. The field carries the right
  semantic already.

---

## 6. What WAS changed

| File                                                 | Change |
| ---------------------------------------------------- | ------ |
| `backend/src/domain/constraints/catalog.js` (new)    | 14 hard + 8 soft constraints with activation predicates, evaluators, and a structured violation schema. |
| `backend/src/domain/constraints/evaluator.js` (new)  | `evaluateCandidate(c, i)` and `evaluateBaseline(b, i)`. Pure, deterministic, no imports of solver / AI / scorer / explainer. |
| `backend/src/domain/constraints/index.js` (new)      | Public surface — re-exports the catalog and the helpers. |
| `backend/tests/phase22_constraints.test.js` (new)    | 30 negative tests covering catalog shape, every hard constraint, every soft constraint, data-driven activation, determinism, baseline evaluation, and the no-fake-travel invariant. |
| `docs/CONSTRAINT_SPECIFICATION.md` (new)             | Authoritative catalog contract. |
| `docs/PHASE_22_CONSTRAINT_AUDIT.md` (this document)  | Real-data audit + baseline evaluation report. |
| `docs/00_INDEX.md`                                   | Index updated. |

---

## 7. Regression report

```text
Phase 21 baseline: 299 tests
Phase 22 final:    329 tests
   (299 existing + 30 new Phase 22 constraint tests)
Passed: 329
Failed: 0
```

All 299 pre-existing tests continue to pass without
modification. The 30 new tests cover the catalog shape (5),
hard-constraint violation detection (10), soft-constraint
behavior (1), data-driven activation (3), determinism (1),
baseline evaluation (1), aggregate shape (1), travel
inactive invariant (1), and additional coverage
(inactive subject, real-data placeholder gate, complete
valid candidate).

---

## 8. Travel — explicit no-fabrication statement

The constraint catalog **does not invent a travel matrix**.
Today, `travelTime` is `null`. H14 is `UNSUPPORTED`. The
evaluator's audit object records:

```text
unsupported: [{ constraintId: 'H14', reason: 'data_dependency_missing' }]
```

A future `TravelProvider` can plug into the catalog
without changing the constraint architecture: H14's
`active()` predicate already keys off `input.travelTime`,
and the evaluator's `checkTransition` is already
provider-agnostic. The constraint is parked, not
removed.

---

## 9. Definition of Done

* [x] constraint catalog hoàn chỉnh (14H + 8S)
* [x] hard constraints formalized
* [x] soft constraints formalized
* [x] missing-data activation rõ ràng (every entry has
      `active(input)`)
* [x] travel vẫn INACTIVE (UNSUPPORTED); không fake matrix
* [x] evaluator độc lập solver (no solver / AI / scorer
      imports)
* [x] evaluator deterministic (N24 asserts `a == b`)
* [x] negative tests đầy đủ (30 tests)
* [x] baseline evaluation chạy được (335 hard, 35.0 soft)
* [x] baseline không thành fixed assignment (read-only)
* [x] tenChuyenMon không mang semantic sai
* [x] `docs/CONSTRAINT_SPECIFICATION.md` viết
* [x] `docs/PHASE_22_CONSTRAINT_AUDIT.md` viết
* [x] tất cả test cũ vẫn pass (299/299)
* [x] phase22 tests pass (30/30)

---

## 10. Stop here.

Phase 22 stops at the constraint model. No solver tuning.
No AI / AirLLM. No strategy. No benchmark vs. legacy
baseline. The catalog is the contract; the evaluator is
the gate. Phase 23+ will produce candidates that the
catalog accepts.
