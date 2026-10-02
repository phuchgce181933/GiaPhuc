# CONSTRAINTS

Constraints are the rules the solver must respect (hard) or prefers
to respect (soft). Objectives are weighted soft constraints that
contribute to the score.

---

## 1. Hard constraints

A solution with **any** hard violation is **rejected** by the
independent validator. The solver must never return a solution
with a hard violation; the validator exists as a second line of
defense.

| ID                           | Description                                                                  |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `H_TEACHER_NO_DOUBLE_BOOK`   | A teacher cannot have two assignments in the same `(day, period, branch)`.   |
| `H_CLASS_NO_DOUBLE_BOOK`     | A class cannot have two subjects in the same `(day, period)`.                 |
| `H_TEACHER_ELIGIBLE`         | Every assignment's teacher must be eligible for the subject.                  |
| `H_ASSIGNMENT_COMPLETE`      | Every assignment must receive exactly `requiredPeriods` slots.               |
| `H_SLOT_IN_BRANCH`           | Every placed slot must be a valid TimeSlot of the assignment's branch.       |
| `H_TRAVEL_FEASIBLE`          | Two consecutive slots on different branches for the same teacher are feasible iff `available_transition_time >= travel_time`. |
| `H_TRANSFER_ALLOWED`         | A teacher assigned to a non-home branch must be in `allowedTransferBranches`. |
| `H_DAY_HARD_OFF`             | (Future) a teacher with a hard day-off cannot be placed on that day.         |
| `H_NO_DUPLICATE_SLOT`        | The solver does not emit two slots with the same `(assignmentId, timeSlotId)`.|

Notes:

- The fixture has no teacher with `phanHieu` or transfer policy, so
  `H_TRANSFER_ALLOWED` and `H_TRAVEL_FEASIBLE` will be in
  `INACTIVE` state (no constraints emitted) until those fields are
  populated. They must not be removed — they are placeholders for
  real data.
- `H_DAY_HARD_OFF` is `INACTIVE` in Phase 1 because the fixture
  uses soft day-off only.

---

## 2. Soft preferences

Soft preferences do not invalidate a solution. They contribute to
the score. A solution that satisfies more soft preferences
generally scores higher, but a solution that satisfies fewer can
still be selected if it is the best under the configured weights.

| ID                          | Field                                  | Soft version                          |
| --------------------------- | -------------------------------------- | ------------------------------------- |
| `S_MAX_SESSIONS_PER_WEEK`   | `nguyenVong.soBuoiToiDa`               | Teacher's count of distinct days used <= soBuoiToiDa. |
| `S_PREFERRED_SESSION`       | `nguyenVong.buoiUuTien`                | `sang`/`chieu`/`ca_hai`. Prefer the matching session; do not refuse the others. |
| `S_PREFERRED_DAY_OFF`       | `nguyenVong.thuNghi`                   | Avoid scheduling on listed days.      |
| `S_HOME_BRANCH`             | `Teacher.homeBranchId`                 | Prefer the home branch.               |
| `S_PREFERRED_TRANSFER`      | `Teacher.preferredTransferBranches`    | Prefer listed branches.               |
| `S_NO_GAP_TEACHER_DAY`      | (objective)                            | Avoid free periods between two teaching periods on the same day. |
| `S_BALANCED_WORKLOAD`       | (objective)                            | Spread teaching load across weekdays. |
| `S_SESSION_DIVERSITY`       | (objective)                            | Don't over-cluster same subject on the same day. |
| `S_DIVERSITY_FROM_PRIOR`    | (objective)                            | New solutions should differ from previously generated ones. |

---

## 3. Objectives

Objectives are weighted aggregations of soft constraints. The
weights are set by the AI Strategy (see `AI_STRATEGY.md`).

A score is built from these components:

```text
overallScore = w_pref * preferenceScore
             + w_work * workloadScore
             + w_travel * travelScore
             + w_transfer * transferScore
             + w_diversity * diversityScore
             - w_violation * hardViolationCount
```

All weights are non-negative. The penalty on hard violations is
effectively infinite (a hard violation rejects the solution), but
the term is kept in the formula so partial-evaluation is well
behaved.

---

## 4. Default weights (Strategy A)

| Component   | Weight |
| ----------- | ------ |
| preference  | 1.0    |
| workload    | 1.0    |
| travel      | 1.0    |
| transfer    | 1.0    |
| diversity   | 1.0    |

This is the balanced default. Other strategies live in
`AI_STRATEGY.md`.

---

## 5. Inactive vs missing

| State        | Meaning                                                                 |
| ------------ | ----------------------------------------------------------------------- |
| `ACTIVE`     | Constraint is emitted and enforced.                                     |
| `INACTIVE`   | Constraint is defined but not emitted because its data is missing.      |
| `MISSING`    | The constraint itself has not been designed yet.                        |

A constraint in `INACTIVE` state must not silently degrade. The
system must report which constraints are inactive in the preview
response and why.
