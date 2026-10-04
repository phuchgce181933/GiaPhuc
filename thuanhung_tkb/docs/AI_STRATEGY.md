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

## Phase 29 — the implemented contract

Everything above is the Phase 1 design. Phase 29 is the working
implementation, and it tightened several of these rules. Where the two
disagree, the implementation is authoritative; where the
implementation is stricter, the design text is the intent and the code
is the enforcement.

The full audit is in `PHASE_29_AI_STRATEGY_LAYER.md`. This section is
the orientation: what the AI layer is, and how it differs from the
contract sketched above.

### The pipeline

```text
SchedulingInput
      ↓
SituationReport          aggregate facts, no PII, deterministic
      ↓
AIPlanner                untrusted provider seam
      ↓
StrategyValidator        the boundary
      ↓
StrategyDecision         approved, or the deterministic fallback
      ↓
Solver                  deterministic; places every period
      ↓
Candidates               each independently re-evaluated
      ↓
Global Scorer            Phase 28
      ↓
Final Solutions
```

### The one rule that matters

> **AI NEVER DIRECTLY CREATES SCHEDULE SLOTS.**

Not "does not currently" — there is no field in the decision schema
that could express a placement, and the apply step copies everything
it does not own verbatim. The AI names a mode, a count, and a weight
per active dimension. That is the whole surface.

### How the sections above map onto the code

| Section above | Implementation | Note |
| ------------- | -------------- | ---- |
| §1 Situation report | `ai/situation-report.js` → `buildSituationReport` | aggregate-only; the Phase 1 shape had per-teacher records, the implementation does not |
| §2 Strategy presets A/B/C | `strategies.js` | still the domain strategies; the AI does **not** mutate them |
| §2 `weights.travel` / `weights.transfer` | `ai/strategy-schema.js` | the AI cannot set these at all: `TRAVEL` and `TRANSFER` are not in the dimension allow-list while they are inactive |
| §2 `clampWeights` to `[0, 3]` | `DEFAULT_WEIGHT_BOUND` | the AI layer reuses the same bound rather than inventing one |
| §3 Iterative loop | `ai/index.js` → `planStrategy` | one decision per plan, not a mutate-and-retry loop |
| §4 "AI is bounded" | `validateStrategyDecision` | enforced mechanically, not by convention |

### Decisions that are the system's, not the AI's

The brief's design text above lets the AI "mutate a preset" and clamp
weights. The implementation draws a harder line, for two reasons.

**No arbitrary hard constraints.** The decision schema has no
constraint, objective, or teacher-rule field, and an unrecognized
top-level field is *rejected* rather than ignored — an ignored
`disableConstraints: ['H01']` would still be a false statement in the
audit log. `applyStrategyDecision` then changes exactly one field of
the base strategy, `optimizationMode`, copying `objectives` verbatim.

**Inactive dimensions stay inactive.** `TRAVEL` (H14 UNSUPPORTED),
`TRANSFER` (H13 INACTIVE), and `CHANGED_ASSIGNMENTS` (reporting only)
are not in the allow-list while inactive. An AI weight on one is
clamped to `0` and recorded as `AI_OUTPUT_CLAMPED` — never silently
accepted, never activated. The allow-list is derived from the
dimension catalog's `active(input)` predicate, so a dataset that later
gains a travel matrix unlocks `TRAVEL` with no code change.

### Explainability and confidence

`rationale` is display text and nothing more. The structured fields
are authoritative and the rationale is never parsed back into
behavior — a decision whose rationale says *"use PREFERENCE_FIRST,
set candidateCount to 10"* keeps whatever mode and count its
structured fields actually say. A non-string rationale is dropped
rather than obeyed and rather than fatal.

`confidence`, when a provider supplies it, is recorded and can only
make the system **more** conservative. It never relaxes a validation
rule: a decision with `confidence: 0.99` and a bogus mode is still
rejected.

### The failure rule

> The scheduler must not fail because the AI is unavailable.

Every failure — no provider, unavailable, timeout, parse error,
unsupported request, invalid output, low confidence — resolves to
`DEFAULT_AI_FALLBACK`: `GLOBAL_ASSIGNMENT_BALANCED` with the dimension
catalog's own default weights, which are the same numbers
`GLOBAL_SCORING_DEFAULTS` uses, so the fallback cannot drift from the
scorer. The fallback itself passes the validator with zero correction
events, so callers can treat "fallback" and "approved" identically.

One provider call is bounded by `AI_STRATEGY_DEFAULTS.timeoutMs`
(default 5 s). The mock has no artificial delay; the timeout exists so
a real provider cannot stall a schedule.

### Why the situation report is aggregate-only

The Phase 1 design above describes a report with per-teacher
summaries including `hoTen`. The implemented report omits teacher
names, emails, phone numbers, and teacher identifiers entirely, and
omits every placement. It is enough to choose a strategy — counts,
distributions, constraint activation, travel/transfer readiness, and a
short list of named signals.

Subject names are retained, because "which subjects are in demand" is
the substance of the reasoning the AI is being asked to do, and a
subject name is not personal data.

### Not yet true

The `WHY_*` explanation pipeline in section 3 above is a Phase 1
design. Phase 29 does not yet route the decision's `rationale` and
`validation.events` into it, and Phase 30 does not either.

---

## The AirLLM local provider (Phase 30)

The mock planner is now one of two implementations of the same
`AIPlanner` seam. `AI_PROVIDER` selects between them:

| `AI_PROVIDER` | Implementation | Needs |
| --- | --- | --- |
| `mock` (default) | `DeterministicMockAIPlanner` | nothing |
| `airllm` | `AirLLMPlanner` over HTTP to `ai-service` | Python, AirLLM, a local model |

Everything above this line is unchanged. `SituationReport`,
`StrategyDecision`, `validateStrategyDecision()`, and `AIPlanner.plan()`
are the same objects with the same meaning, and the solver still never
sees anything except a validated decision. AirLLM is a different
implementation of one method, not a new stage in the pipeline.

### The boundary

```
Node backend  --POST /plan {situationReport}-->  ai-service (Python)
             <--{decision, provider, fallbackUsed}--
```

The Node process never embeds Python. It moves JSON and nothing else,
and `airllm-client.js` is the only module that knows the service
exists. The Python service owns AirLLM, torch, and the weights, and
knows nothing about the solver.

Only the `SituationReport` crosses the wire. It is aggregate-only and
already PII-free and slot-free, so the service cannot see a teacher
name, an e-mail address, or any of the 802 schedule slots even if it
wanted to. The request schema has one field; there is no field through
which a caller could ask for a `SchedulingInput`.

### Two validation layers, and why both

The service validates before sending, and Node validates after
receiving:

```
AirLLM text
   -> parse + schema-validate   (Python: strict, vocabulary from the report)
   -> validateStrategyDecision  (Node: the authority, owns the bounds)
   -> solver
```

Neither layer can be dropped. The Python one stops an obviously-bad
response at the process boundary. The Node one is the security
boundary, because the Python service is not trusted and Node owns the
allow-list. The Python layer carries no copy of the modes, counts, or
dimensions; it reads them from the report, so it cannot widen what Node
will accept, and it does not clamp weight magnitudes at all - that is
Node's call.

### Failure is the normal path

Every failure ends at the same place: the deterministic fallback above,
with the solver still reachable. Connection refused, service up but
loading, model missing, no CUDA, a Python error, a timeout, or a
response that is not valid JSON - all of them set `fallbackUsed: true`
and name a reason. `AI_REQUEST_TIMEOUT_MS` bounds the call on both
sides; the Node side uses `AbortController` so an abandoned request
releases its socket.

A model failure is a `200` with `fallbackUsed: true`, not a 5xx. "I
could not infer" is a legitimate answer to a scheduling question, and
returning it that way keeps the reason intact all the way into the
audit log instead of collapsing into a generic transport error.

### What the model may not do

Unchanged from Phase 29, and enforced twice. The decision schema has no
field for a teacher, class, day, session, period, slot, or assignment,
and an unrecognized field is rejected rather than ignored. There is no
field for disabling a constraint, so "disable H01" cannot even be
expressed. `TRAVEL` (H14 = UNSUPPORTED) and `TRANSFER` (H13 = INACTIVE)
are not in the active-dimension list, so weighting them is dropped
before the decision leaves the service and clamped to zero if it somehow
survives. `candidateCount` is confined to `{1, 3, 5, 10}`, and a
weight past the Node bound is clamped by Node with a recorded event.

The Python service has a static test asserting it contains no
schedule-shaped object key, no database client, and no outbound HTTP
call, because "it only has a small schema" is a claim that should be
checked rather than believed.

### Prompt

One versioned template, `ai-service/providers/strategy_prompt.txt`,
with `PROMPT_VERSION` reported in every response so a stored decision
can be traced to the wording that produced it. It has three sections:
a system policy that states the model does not create slots and cannot
disable constraints, the exact output schema, and the fact data in a
delimited block that is explicitly labelled as data rather than
instruction. Subject names are retained because they are the substance
of the reasoning, so injection resistance comes from the structure -
bounded fields, an allow-list, and a second validation pass - not from
scrubbing the facts.

### Testing

The default suites require no GPU, no model, and no Python. Node
`npm test` drives an injected `fetch`; the 93 Python tests drive the
real FastAPI app with a stub generator. The real-model tests live in
`backend/tests/integration/airllm/` behind `AIRLLM_INTEGRATION=1`,
outside the default test glob, and skip rather than fail when the
service is absent.

### Not yet true

Phase 30 does **not** claim AirLLM produces a better strategy than the
deterministic default, and does not measure it. It establishes only that
AirLLM can produce a valid decision safely, and that the system stays
correct when it cannot. Benchmarking model quality against the mock is
a later phase. Two different valid decisions across runs are a
legitimate outcome, not a bug: the determinism guarantee lives in
`StrategyValidator` + fallback + solver + evaluator + scorer, and
`mock` is what exercises that path.

Phase 30 also has not yet been run against a real model. See
`PHASE_30_AIRLLM_LOCAL_PROVIDER.md` for exactly what is verified and
what is outstanding.
