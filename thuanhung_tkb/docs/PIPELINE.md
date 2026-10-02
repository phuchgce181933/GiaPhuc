# PIPELINE

End-to-end flow of a single `preview` call. Every step is a
distinct module. The output of one step is the input of the next.

```text
[ Database / Fixture ]
        |
        v
   1. Data Loader           --> Normalized in-memory model
        |
        v
   2. AI Situation Report   --> SituationReport
        |
        v
   3. AI Strategy Picker    --> Strategy[]
        |
        v
   4. Solver                --> SolutionCandidate[]
        |                            (one per strategy; capped at options.solutions)
        v
   5. Independent Validator --> ValidationReport[] (one per candidate)
        |
        v
   6. Scorer                --> Score[]
        |
        v
   7. Diversity Filter      --> dedup'd SolutionCandidate[]
        |
        v
   8. Explanation Builder   --> localized strings per candidate
        |
        v
   9. Preview Response      --> returned to caller; NO DB write
        |
        v
[ User picks a candidate ]
        |
        v
   10. Commit                --> writes chosen candidate to DB
```

---

## 1. Data Loader

Pure function from the configured source (fixture or MongoDB) to
the normalized in-memory model. Reports `missingData`. Does not
modify the source.

## 2. AI Situation Report

Reads the normalized model. Produces a `SituationReport`. This is
deterministic. No AI call needed; this stage is the *output* of
analysis, not the analysis itself.

## 3. AI Strategy Picker

Selects or constructs one or more `Strategy` objects. May use
preset strategies (A/B/C) or mutate them based on the
SituationReport. Bounded by `options.solutions` (1/3/5/10).

## 4. Solver

For each Strategy, runs the solver and collects
`SolutionCandidate`s. May return partial results on `TIMEOUT`.

## 5. Independent Validator

Re-checks every candidate. Rejects any with hard violations. The
rejected candidates are kept in the response (with `accepted: false`)
so the user can see why.

## 6. Scorer

Computes the `Score` for each accepted candidate. Pure function of
`(candidate, input)`. Deterministic.

## 7. Diversity Filter

Sorts candidates by `overallScore`, then walks the list keeping a
candidate iff it differs from every kept candidate by at least
`diversification.minEditDistance`. If the result has fewer than
`options.solutions` candidates, the user is told.

## 8. Explanation Builder

Maps `ExplanationEvent[]` per candidate to localized text using a
lookup table. Catches unknown codes and surfaces them.

## 9. Preview Response

```text
PreviewResponse {
  situation:           SituationReport
  solutions:           SolutionCandidate[]        // ordered by overallScore
  diagnostics:         SolverDiagnostics
  warnings:            string[]
  missingData:         MissingField[]
}
```

This is the response of `POST /api/scheduling/preview`. It is
**read-only** with respect to MongoDB.

## 10. Commit

```text
POST /api/scheduling/commit
{
  solutionId:  string                  // the candidate chosen by the user
}
```

The commit handler:

1. Re-loads the solution from the preview cache (in-memory).
2. Re-runs the validator. If it now reports a hard violation
   (because data changed between preview and commit), the commit
   fails.
3. Writes the schedule to the `tkb` collection in the canonical
   shape (one document per `(branch, class, day, period)` row).
4. Writes `TransferEvent`s to a `transfer_log` collection.
5. Returns the new state.

The commit handler does not re-run the solver. It does not call
the AI. The solution was already chosen by the user.
