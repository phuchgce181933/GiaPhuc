# AI STRATEGY

AI is **not** a database writer and **not** a heuristic generator.
In this system, AI plays three concrete roles:

1. **Analyze** the current data (shortage, surplus, conflicts) and
   surface a structured situation report.
2. **Choose** one of the registered strategies (weights + objective
   mix + diversification policy) and pass it to the solver.
3. **Explain** solver output using the structured `WHY_*` reasons
   produced by the solver/validator.

The AI never invents teacher data, class data, subject names, or
constraint values. The analysis it produces is derived from the
data loader output and from the solver's structured results.

---

## 1. Situation report

Before the first solve, the AI Strategy layer produces a structured
report. It is the only input the user sees before solutions are
generated. It has this shape:

```text
SituationReport {
  teachers:        TeacherSummary[]
  branches:        BranchSummary[]          // empty if MISSING
  shortage:        SubjectShortage[]        // demand - supply
  surplus:         SubjectSurplus[]         // supply - demand
  conflicts:       ConflictHint[]           // teachers who are the only option
  unresolvable:    Unresolvable[]            // assignments with no eligible teacher
  missingData:     MissingField[]           // per field, per teacher
}
```

`SubjectShortage` is computed per `(branch, subject)`:

```text
demand  = sum(Assignment.requiredPeriods where class.branchId = branch and subjectId = subject)
supply  = sum(t.workload for t in Teacher with homeBranch = branch and t eligible for subject)
shortage = max(0, demand - supply)
```

A teacher can contribute to another branch's supply via
`allowedTransferBranches`; this is reported separately as
`transferPotential`.

The report is **deterministic** given the loaded data. Two runs
with the same data produce the same report.

---

## 2. Strategy

A Strategy is a configuration object the AI layer hands to the
solver. It has this shape:

```text
Strategy {
  id:               string
  description:      string
  weights: {
    preference:     number
    workload:       number
    travel:         number
    transfer:       number
    diversity:      number
  }
  diversification: {
    mode:           'random_seed' | 'objective_mix' | 'solution_penalty'
    seed:           number | null
    minEditDistance: number  // minimum structural difference vs prior solutions
  }
  objectives: {
    noGapTeacherDay: boolean
    balancedWorkload: boolean
    sessionDiversity: boolean
  }
  solver: {
    timeLimitMs:    number
    populationSize: number
  }
}
```

### Default strategies (preset)

The system ships with three preset strategies. The AI can mix
them, mutate them, or pick the best one after evaluation.

**Strategy A — "Preference-first"**

```text
weights.preference = 2.0
weights.workload   = 1.0
weights.travel     = 0.5
weights.transfer   = 0.5
weights.diversity  = 1.0
diversification.mode = 'solution_penalty'
```

**Strategy B — "Workload + Travel"**

```text
weights.preference = 0.5
weights.workload   = 2.0
weights.travel     = 1.5
weights.transfer   = 1.5
weights.diversity  = 1.0
diversification.mode = 'objective_mix'
```

**Strategy C — "Balanced"**

```text
weights.preference = 1.0
weights.workload   = 1.0
weights.travel     = 1.0
weights.transfer   = 1.0
weights.diversity  = 1.0
diversification.mode = 'random_seed'
```

Strategies are deterministic given a seed. The AI layer can
generate new strategies by mutating a preset (clamp weights to
[0, 3], re-roll diversification mode, etc.).

---

## 3. Iterative loop

```text
loop:
  for strategy in strategies:
    candidates = solver.solve(input, strategy)
    for c in candidates:
      c.score = scorer.score(c)
      c.verified = validator.verify(c)
  best = pick(candidates, criterion=overallScore)
  nextStrategy = ai.mutate(strategy, best, situationReport)
```

The loop is bounded by:

- a maximum number of strategies (default 3, configurable 1/3/5/10),
- a wall-clock budget per strategy (default 5 s),
- a total wall-clock budget (default 30 s).

After the loop, the AI layer returns a ranked list of
`SolutionCandidate`s, deduplicated by the diversity metric
(see `OPTIMIZATION_INTERFACE.md`).

---

## 4. AI is bounded

The AI layer:

- **may not** add, remove or modify any teacher, class, subject,
  branch, curriculum or assignment record.
- **may not** invent new constraint values.
- **may not** mark a hard-violating solution as valid.
- **may not** skip the independent validator.
- **may not** write to MongoDB.

It can only:

- read the loader output,
- select/construct a `Strategy`,
- read the solver output (which is itself structured),
- produce `Explanation` text from structured `WHY_*` reasons.
