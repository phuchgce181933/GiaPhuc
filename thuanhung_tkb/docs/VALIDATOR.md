# INDEPENDENT VALIDATOR

The validator is a **separate module** that re-checks every
solution the solver returns. It does not trust the solver. It
does not call into the AI. It is a pure function of
`(solution, input)`.

---

## 1. Contract

```text
verify(solution, input) -> ValidationReport
```

`ValidationReport`:

```text
{
  accepted:        boolean
  hardViolations:  HardViolation[]
  warnings:        string[]
  coverage: {
    totalAssignments:     number
    fullyScheduled:       number
    partiallyScheduled:   number
    notScheduled:         number
  }
  metrics: {
    distinctDaysUsedByTeacher: Record<teacherId, number>
    slotsByBranchDayPeriod:     Record<branchId, number>
  }
}
```

`HardViolation` is a structured object:

```text
{
  code:   string                       // 'H_TEACHER_NO_DOUBLE_BOOK', ...
  where:  { teacherId, day, period, branchId, assignmentId?, slotIndex? }
  detail: string                       // human-readable, no natural-language invention
}
```

---

## 2. Required checks

Each check is a function `() -> HardViolation[]`. The validator
runs them in order and aggregates.

| Check                          | Code                          | Notes                                    |
| ------------------------------ | ----------------------------- | ---------------------------------------- |
| Teacher double-booking         | `H_TEACHER_NO_DOUBLE_BOOK`    | One teacher, same `(day, period, branch)`. |
| Class double-booking           | `H_CLASS_NO_DOUBLE_BOOK`      | One class, two slots, same `(day, period)`. |
| Eligibility                    | `H_TEACHER_ELIGIBLE`          | Teacher's `chuyenMon` must contain the subject. |
| Assignment completeness        | `H_ASSIGNMENT_COMPLETE`       | `slots.length === requiredPeriods` for every assignment. |
| Slot in branch                 | `H_SLOT_IN_BRANCH`            | Every slot must be in `timeSlotsByBranch[branch]`. |
| Transfer allowed               | `H_TRANSFER_ALLOWED`          | Teacher on non-home branch must be in `allowedTransferBranches`. |
| Travel feasible                | `H_TRAVEL_FEASIBLE`           | Two consecutive slots on different branches must satisfy the travel provider. |
| No duplicate slot              | `H_NO_DUPLICATE_SLOT`         | Solver must not emit the same slot twice. |

If the relevant data is missing (e.g. no `allowedTransferBranches`
in the fixture), the corresponding check is `INACTIVE` and skipped.
The validator reports inactive checks in `warnings`.

---

## 3. Why independent

The validator's job is to catch solver bugs. It is implemented
**separately** from the solver. The two may share a small
constraint-catalog module (read-only), but the validator does
**not**:

- import the solver,
- call into the AI,
- relax any hard constraint,
- take heuristics from the solver.

The validator returns `accepted = false` on **any** hard
violation. The orchestrator will not commit a rejected solution
even if the AI argues for it.

---

## 4. Tests

Every `H_*` check has a dedicated test case built from the
authoritative fixture plus a synthetic input. The tests are
intentionally written against the public contract, not the
internal solver, so a future solver swap does not break them.
