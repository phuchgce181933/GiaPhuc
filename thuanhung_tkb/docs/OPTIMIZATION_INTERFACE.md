# OPTIMIZATION INTERFACE

This document defines the contract the solver must implement. The
solver may be OR-Tools / CP-SAT, Timefold, or any other
constraint-programming or local-search engine. The contract is what
the rest of the system depends on; the engine is interchangeable.

---

## 1. Inputs

```text
SolverInput {
  teachers:        Teacher[]                 // normalized
  branches:        Branch[]                  // normalized; may be empty (MISSING DATA)
  classes:         Class[]                   // normalized; may be empty
  subjects:        Subject[]                 // normalized
  curriculum:      Curriculum[]              // class+subject+requiredPeriods
  assignments:     Assignment[]              // derived from teachers × curriculum
  timeSlotsByBranch: Map<branchId, TimeSlot[]>
  travelTime:      TravelProvider            // interface, may be null
  transferPolicy:  TransferPolicy
  options: {
    solutions:     number                    // 1, 3, 5, 10
    timeLimitMs:   number
    seed:          number | null
  }
}
```

A `TravelProvider` is an object with one method:

```text
travelTime(branchA, branchB, periodA) -> minutes | null
```

If `travelTime` is `null`, the input is rejected with
`MISSING_CONFIGURATION` (the provider was not registered).

---

## 2. Outputs

```text
SolverOutput {
  solutions: SolutionCandidate[]
  diagnostics: SolverDiagnostics
}

SolutionCandidate {
  id:               string
  strategyId:       string
  assignments:      Map<AssignmentId, TimeSlot[]>
  transfers:        TransferEvent[]
  score:            Score
  explanation:      ExplanationEvent[]
  diagnostics: {
    hardViolationCount: number
    preferenceHits:     number
    preferenceMisses:   number
    objectiveValues:    Record<string, number>
  }
}

Score {
  hardViolationCount:  number
  overallScore:        number
  preferenceScore:     number
  workloadScore:       number
  travelScore:         number
  transferScore:       number
  diversityScore:      number
}

SolverDiagnostics {
  strategiesAttempted: number
  totalSolveMs:        number
  warnings:            string[]
  unresolvable:        Unresolvable[]
}
```

The solver is responsible for filling `assignments`, `transfers`,
`score.preferenceScore` and `score.workloadScore`. The other scores
are computed by the scorer (see §3) and the diversity evaluator
(see §4).

---

## 3. Scorer

The scorer takes a `SolutionCandidate` plus the `SolverInput` and
returns a `Score`. It is **deterministic**.

```text
score(s, input) -> Score
```

It computes:

- `preferenceScore` — sum of satisfied soft preferences minus
  weighted miss penalties.
- `workloadScore` — penalize the variance between
  `teacher.daysUsed × periodsPerDay` and the desired spread.
- `travelScore` — penalize infeasible or long transitions.
  Infeasible transitions are a hard violation.
- `transferScore` — penalize transfers away from the home branch,
  weighted by `S_PREFERRED_TRANSFER`.
- `diversityScore` — only meaningful when there are prior
  candidates; computed against the most recent N candidates
  (default N = 3).
- `overallScore` — weighted sum as defined in `CONSTRAINTS.md`.

The scorer **must not** call into the AI. The AI only chooses
weights; the scoring math is a pure function of `(solution, input)`.

---

## 4. Diversity

Diversity is a metric, not a random salt. Two candidates are
"diverse" when they differ in at least `minEditDistance` slots
where "slot" means a `(teacherId, day, period, branchId)` tuple.

```text
diversity(A, B) = |slots(A) △ slots(B)| / (|slots(A) ∪ slots(B)|)
```

The solver is asked to produce up to `options.solutions`
candidates. After each candidate is produced, the next candidate's
search is biased away from it (via objective perturbation or
penalty term). The exact mechanism is solver-specific; the
contract is only that the candidates returned must satisfy:

```text
for i != j: diversity(C_i, C_j) >= diversification.minEditDistance
```

Default `minEditDistance` is 0.15. A run that cannot meet this
threshold reports `low_diversity` in `warnings` and returns
what it has.

---

## 5. Determinism

For a given `(input, strategy)`, the solver must be deterministic.
The `options.seed` is the only source of non-determinism the
caller controls. This makes results reproducible and testable.

---

## 6. Failure modes

The solver must return a structured failure, not throw:

| Failure code                  | Meaning                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `NO_SOLUTION`                 | No feasible solution in the time budget.                      |
| `INFEASIBLE_DEMAND`           | Demand cannot be met given teacher eligibility.               |
| `MISSING_CONFIGURATION`       | A required provider (e.g. TravelProvider) is not registered.  |
| `UNRESOLVABLE_ASSIGNMENT`     | An assignment has no eligible teacher.                        |
| `TIMEOUT`                     | Time limit reached. Partial candidates may be returned.       |

A partial result is acceptable; the orchestrator will decide
whether to retry with a different strategy or surface the failure
to the user.
