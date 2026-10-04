# CONSTRAINT SPECIFICATION

> Phase 22 — formal catalog of every constraint the scheduler
> enforces, the data fields each one depends on, the missing-data
> behavior, and the activation status against the real dataset.
>
> Scope: catalog only. The catalog is read-only. The evaluator
> (see `PHASE_22_CONSTRAINT_AUDIT.md`) is the function that
> applies this catalog to a candidate.
>
> Authoritative source: `backend/src/domain/constraints/`
>   - `catalog.js` — the catalog
>   - `evaluator.js` — the independent evaluator
>   - `index.js` — public surface
>
> This document is the contract that the solver (Phase 23+)
> MUST respect. No constraint may be added, removed, or
> re-classified without updating this document AND the
> catalog in the same change.

---

## 1. Constraint anatomy

Every constraint in the catalog has the same shape:

```text
{
  id,         // H01..H14, S01..S08
  code,       // H_CLASS_NO_DOUBLE_BOOK, ...
  name,       // one-line label
  category,   // HARD | SOFT
  severity,   // BLOCKING | PENALTY
  description,// long-form description (used in audit)
  active,     // (input) => boolean    data-driven activation
  evaluate,   // (candidate, input) => Violation[]
}
```

`active(input)` decides whether the constraint is
**ACTIVE**, **INACTIVE**, or **UNSUPPORTED**:

| Status        | Meaning                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| `ACTIVE`      | All required data is present; the constraint is enforced.                            |
| `INACTIVE`    | A required data field is missing; the constraint is defined but not emitted.         |
| `UNSUPPORTED` | A hard dependency (e.g. travel matrix) is missing; the constraint is parked.          |

A constraint is never silently dropped. The audit document
records every INACTIVE / UNSUPPORTED entry with the reason
(`data_dependency_missing`).

`evaluate(candidate, input)` returns a list of violations.
The violation schema is:

```text
{
  constraintId,
  code,
  severity,    // 'BLOCKING' | 'PENALTY'
  entityType,  // 'class' | 'teacher' | 'assignment' | 'slot' | ...
  entityIds,   // string[]
  message,
  penalty,     // 0 for hard; positive for soft
}
```

---

## 2. Hard constraints

| ID  | Code                          | Name                          | Status (real data) | Missing-data behavior   | Description                                                                              |
| --- | ----------------------------- | ----------------------------- | ------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| H01 | `H_CLASS_NO_DOUBLE_BOOK`      | Class no double booking       | ACTIVE             | n/a (always on)         | A class cannot have two slots at the same (day, period).                                 |
| H02 | `H_TEACHER_NO_DOUBLE_BOOK`    | Teacher no double booking     | ACTIVE             | n/a (always on)         | A teacher cannot have two slots at the same (day, period). Branch-agnostic.              |
| H03 | `H_TEACHER_ELIGIBLE`          | Subject eligibility            | ACTIVE             | n/a (always on)         | The assignment's teacher must be eligible for the subject.                               |
| H04 | `H_SLOT_IN_BRANCH`            | Slot in class branch          | ACTIVE             | n/a (always on)         | Every placed slot must be in the class's branch.                                         |
| H05 | `H_ASSIGNMENT_COMPLETE`       | Demand fulfillment            | ACTIVE             | n/a (always on)         | Every assignment must receive exactly `requiredPeriods` slots.                            |
| H06 | `H_SLOT_VALID`                | Slot validity                 | ACTIVE             | n/a (always on)         | Every placed slot must carry a valid (branchId, day, period) on the branch profile.       |
| H07 | `H_CLASS_SUBJECT_ONE_TEACHER` | Assignment identity           | ACTIVE             | n/a (always on)         | A (classId, subjectId) pair maps to a single teacher.                                    |
| H08 | `H_ACTIVE_ENTITY`             | Active entities only          | ACTIVE             | n/a (always on)         | The candidate cannot reference inactive teachers / subjects.                             |
| H09 | `H_WORKLOAD_CAPACITY`         | Workload capacity             | **INACTIVE**       | see placeholder gate    | A teacher's scheduled periods ≤ their capacity. See placeholder gate below.              |
| H10 | `H_MAX_SESSIONS_PER_WEEK`     | Max sessions per week         | ACTIVE             | field missing → INACTIVE | Distinct (day, session) count ≤ `nguyenVong.soBuoiToiDa`.                               |
| H11 | `H_FIXED_DAY_OFF`             | Fixed day off                 | **INACTIVE**       | field missing → INACTIVE | Teacher cannot be scheduled on `nguyenVong.thuNghi`.                                     |
| H12 | `H_PREFERRED_SESSION`         | Preferred session (hard)      | **INACTIVE**       | contract says SOFT      | Listed under hard for catalog completeness. The current domain contract makes this SOFT. |
| H13 | `H_TRANSFER_ALLOWED`          | Transfer permission           | **INACTIVE**       | field missing → INACTIVE | Teacher only on non-home branch iff in `allowedTransferBranches`.                        |
| H14 | `H_TRAVEL_FEASIBLE`           | Travel feasibility            | **UNSUPPORTED**    | no travel matrix        | Cross-branch transitions must be feasible. Today no travel matrix exists.               |

### H09 placeholder gate

The legacy dump does NOT carry per-subject workload. The
scheduling model fills `chuyenMon[].soTietTuan = 1` for every
entry — a placeholder, not a real budget. With every teacher
at budget 1, this constraint would fire on every assignment
whose `requiredPeriods > 1`. That is a placeholder artefact,
not a real capacity signal.

Activation: H09 is **ACTIVE** only when at least one teacher
carries `chuyenMon[].soTietTuan > 1` (a real per-subject
workload). Until then, H09 is **INACTIVE**. The same gate
applies to S04.

### H12 — why the hard variant is INACTIVE

`nguyenVong.buoiUuTien` is declared by every active teacher
(40/40), but the domain contract treats it as a **SOFT**
preference. The hard variant (H12) is listed in the catalog
for completeness; today it is **always INACTIVE** because the
contract does not promote the preference to hard. The soft
variant is S01.

### H14 — Travel

`travelTime` is `null` in the SchedulingInput. The legacy
dump does not carry a travel matrix. H14 is parked as
**UNSUPPORTED**. The catalog never invents a matrix; the
entry's `active()` predicate returns `false` when
`travelTime` is null. A future `TravelProvider` can plug in
without changing the constraint architecture.

---

## 3. Soft constraints

| ID  | Code                          | Name                          | Status (real data) | Missing-data behavior   | Description                                                                              |
| --- | ----------------------------- | ----------------------------- | ------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| S01 | `S_PREFERRED_SESSION`         | Teacher preferred session     | ACTIVE             | field missing → INACTIVE | Penalty when slots fall outside `nguyenVong.buoiUuTien`.                                 |
| S02 | `S_MAX_SESSIONS_PRESSURE`     | Max sessions pressure         | ACTIVE             | field missing → INACTIVE | Soft pressure when (day, session) count exceeds `soBuoiToiDa`.                            |
| S03 | `S_PREFERRED_DAY_OFF`         | Preferred day off (soft)      | **INACTIVE**       | field missing → INACTIVE | Penalty proportional to share of `thuNghi` days on which the teacher is scheduled.        |
| S04 | `S_WORKLOAD_BALANCE`          | Workload balance              | **INACTIVE**       | see placeholder gate    | Mean per-teacher deviation from the budget. Same gate as H09.                            |
| S05 | `S_TRANSFER_PREFERENCE`        | Transfer preference           | **INACTIVE**       | field missing → INACTIVE | Penalty when placed on a non-preferred transfer branch.                                 |
| S06 | `S_PREFERRED_GRADE`           | Preferred grade               | **INACTIVE**       | field missing → INACTIVE | Penalty when assigned a class outside `preferredGrades`.                                 |
| S07 | `S_SESSION_COMPACTNESS`       | Session compactness           | ACTIVE             | n/a (always on)         | Penalty for teacher-days spanning BOTH sang and chieu.                                   |
| S08 | `S_TEACHER_DAY_CONCENTRATION` | Teacher-day concentration     | ACTIVE             | n/a (always on)         | Penalty for teacher-days with non-contiguous period blocks.                              |

S07 keeps the same semantic as Phase 17.1's
`sessionDiversityScore`: "compactness", not "diversity".
A teacher-day with both sang and chieu is split → penalty.
A teacher-day with only sang OR only chieu pays no penalty.
The name changed from "session diversity" to "session
compactness" to remove the ambiguity.

S08 uses **unique** periods to measure concentration. A
teacher with two slots at the same (day, period) is not
"more concentrated" — duplicates come from cross-assignment
overlaps, not from contiguous teaching.

---

## 4. Categorical totals

| Category   | Total | ACTIVE | INACTIVE | UNSUPPORTED |
| ---------- | ----: | -----: | -------: | ----------: |
| HARD       |    14 |      9 |        4 |           1 |
| SOFT       |     8 |      4 |        4 |           0 |
| **total**  |    22 |     13 |        8 |           1 |

INACTIVE / UNSUPPORTED constraints are reported in the
audit, not in the violation set. The solver (Phase 23+) does
not need to know about INACTIVE constraints; the catalog
guards them off.

---

## 5. Data-driven activation

Activation is computed by walking `input.teachers`,
`input.subjects`, `input.branches`, `input.assignments`, and
`input.travelTime`. The activation predicates are:

```text
H09  ACTIVE ⇔ ∃ teacher t : t.chuyenMon[].soTietTuan > 1
S04  ACTIVE ⇔ same as H09
H10  ACTIVE ⇔ ∃ teacher t : t.nguyenVong.soBuoiToiDa > 0
S02  ACTIVE ⇔ same as H10
H11  ACTIVE ⇔ ∃ teacher t : t.nguyenVong.thuNghi.length > 0
S03  ACTIVE ⇔ same as H11
S01  ACTIVE ⇔ ∃ teacher t : t.nguyenVong.buoiUuTien ∉ {null, 'ca_hai'}
H13  ACTIVE ⇔ ∃ teacher t : t.allowedTransferBranches.length > 0
S05  ACTIVE ⇔ ∃ teacher t : t.preferredTransferBranches.length > 0
S06  ACTIVE ⇔ ∃ teacher t : t.preferredGrades.length > 0
H14  ACTIVE ⇔ input.travelTime != null
       (when null, status = UNSUPPORTED, not INACTIVE)
```

All other constraints are always ACTIVE.

The predicates are pure functions of the input. They never
read the candidate. They never fabricate data.

---

## 6. Aggregate result

The evaluator returns:

```text
{
  hard:        { violated: boolean, violations: Violation[] },
  soft:        { penalty: number,    violations: Violation[] },
  inactive:    [{ constraintId, reason }],
  unsupported: [{ constraintId, reason }],
  constraintStatuses: { [id]: 'ACTIVE' | 'INACTIVE' | 'UNSUPPORTED' },
  summary: {
    totalHardViolations: number,
    totalSoftPenalty:    number,
    accepted:            boolean,   // strictly: !hard.violated
    reasons:             string[],  // top hard reasons
  },
}
```

`accepted` is **strictly** determined by `hard.violated`. A
candidate with any hard violation is rejected regardless of
soft score. This is a hard guardrail, not a hint. The
gating helper is `isAccepted(evaluation)`.

---

## 7. Determinism

The evaluator is deterministic. Same input + same candidate
= same result. There is no LLM, no randomness, no
temperature, no clock dependency in the catalog. The
contract is:

```text
evaluateCandidate(c, i) === evaluateCandidate(c, i)
```

The negative test `PHASE 22 / N24` enforces this.

---

## 8. Independence

The evaluator does not import:
- the solver (`domain/solver.js`)
- the AI strategy (`domain/strategies.js`)
- the orchestrator (`orchestrator/index.js`)
- the scorer (`domain/scorer.js`)
- the explainer (`domain/explain.js`)
- the diversity helpers (`domain/diversity.js`)
- the fixture / dataset loaders
- any randomness (`utils/prng.js`)

The catalog and evaluator live under
`backend/src/domain/constraints/` and are reachable only
through `index.js`.

The Phase 1 `domain/constraints.js` (the legacy validator
path) is **preserved** for backward compatibility with the
existing `validate.js` and `validator.js`. The new module
sits beside it. No code outside the new module depends on
the new module yet (Phase 23+ will wire the solver to it).

---

## 9. Definition of Done (catalog side)

* [x] 14 hard + 8 soft constraints defined
* [x] Every entry has id, code, name, category, severity, description
* [x] Every entry has `active(input)` and `evaluate(candidate, input)`
* [x] Data-driven activation for every data-dependent entry
* [x] Placeholder gate (H09, S04) detects `soTietTuan = 1`
* [x] Travel constraint is UNSUPPORTED, not invented
* [x] Session compactness keeps the Phase 17.1 semantic
* [x] Document written: `docs/CONSTRAINT_SPECIFICATION.md`
* [x] Audit document written: `docs/PHASE_22_CONSTRAINT_AUDIT.md`

The catalog is now the authoritative specification. The
solver, when it appears, must consult it.
