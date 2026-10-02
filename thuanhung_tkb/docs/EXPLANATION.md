# EXPLANATION

Every important decision in a solution carries a structured
`ExplanationEvent`. The AI layer turns these into human-readable
text in the preview UI. The AI does **not** invent explanations
on its own.

---

## 1. Reason codes

| Code                       | When emitted                                              |
| -------------------------- | --------------------------------------------------------- |
| `WHY_TEACHER_SELECTED`     | Solver picked a teacher for an assignment.               |
| `WHY_TEACHER_REJECTED`     | A teacher was eligible but not chosen.                   |
| `WHY_TRANSFERRED`          | A teacher is placed in a non-home branch.                |
| `WHY_SLOT_SELECTED`        | A specific `(day, period, branch)` was chosen.            |
| `WHY_PREFERENCE_VIOLATED`  | A soft preference was not satisfied.                      |
| `WHY_PREFERENCE_SATISFIED` | A soft preference was satisfied.                          |
| `WHY_SHORTAGE`             | An assignment could not be fully covered.                 |
| `WHY_UNRESOLVABLE`         | No eligible teacher exists for the assignment.           |
| `WHY_SKIPPED`              | A teacher / branch was skipped due to missing data.       |

---

## 2. Shape

```text
ExplanationEvent {
  code:        ReasonCode
  teacherId?:  string
  branchId?:   string
  assignmentId?: string
  factors:     string[]              // vocabulary is fixed; see §3
  detail?:     string                // short, structured; no free text
}
```

`detail` may only contain values derived from the structured
inputs (counts, day codes, period numbers, branch IDs). It may
not contain natural-language reasoning the AI composed.

---

## 3. Factor vocabulary

`factors` is a closed set of strings:

```text
SPECIALIZATION_MATCH
SPECIALIZATION_MISMATCH
BRANCH_MATCH                      // teacher on home branch
BRANCH_TRANSFER_ALLOWED
BRANCH_TRANSFER_PREFERRED
BRANCH_NOT_ALLOWED
TRAVEL_FEASIBLE
TRAVEL_INFEASIBLE
PREFERRED_SESSION
PREFERRED_DAY_OFF
PREFERRED_TRANSFER_BRANCH
WORKLOAD_UNDER
WORKLOAD_OVER
NO_ELIGIBLE_TEACHER
TIME_SLOT_AVAILABLE
TIME_SLOT_TAKEN_BY_TEACHER
TIME_SLOT_TAKEN_BY_CLASS
FIXED_DAY_OFF                    // future
DIVERSITY_PENALTY
```

The validator may add new codes, but a code outside this list is
rejected at the orchestrator boundary.

---

## 4. From structured to natural language

The AI layer (in `ExplanationService`) is a thin mapping from a
list of `ExplanationEvent`s to a localized string. The mapping
is a lookup table keyed by `code` plus `factors`. The AI does not
have permission to "rewrite" or "rephrase" a `detail` field — it
is rendered verbatim.

If a `code` is missing from the table, the UI shows the
structured `code` itself, not a hallucinated explanation.

---

## 5. No silent explanations

If the solver cannot produce a `WHY_TEACHER_SELECTED` event for an
assignment, the system surfaces that as a warning. The user must
not be shown a "looks good" verdict that hides a missing
explanation.
