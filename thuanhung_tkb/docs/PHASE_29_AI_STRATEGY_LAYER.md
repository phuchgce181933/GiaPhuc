# Phase 29 — AI Strategy Layer

> **AI NEVER DIRECTLY CREATES SCHEDULE SLOTS.**
>
> AI selects a *strategy* for the existing deterministic solver. It
> never places a period, never picks a teacher for a class, and never
> relaxes a constraint.

## What this phase is

Phase 28 built the scoring and selection layer. Phase 29 inserts one
new seat above it, and wires that seat to a provider interface:

```
REAL SCHEDULING DATA
        ↓
SITUATION REPORT          aggregate facts, no PII, deterministic
        ↓
AI STRATEGY DECISION      proposed by an untrusted provider
        ↓
VALIDATE / CLAMP          the boundary; reject ⇒ fallback
        ↓
EXISTING SOLVER + SCORER  unchanged
        ↓
MULTIPLE FEASIBLE SOLUTIONS
```

The AI may decide exactly five things:

| Field              | Vocabulary                                    |
| ------------------ | --------------------------------------------- |
| `optimizationMode` | `BASE_FEASIBLE`, `ASSIGNMENT_BALANCED`, `PREFERENCE_FIRST`, `GLOBAL_ASSIGNMENT_BALANCED` |
| `candidateCount`   | `1`, `3`, `5`, `10`                           |
| `scoringWeights`   | one weight per **active** Phase 28 dimension  |
| `priorities`       | `LOW` / `MEDIUM` / `HIGH` emphasis annotation |
| `rationale`        | free text, **non-authoritative**              |

The AI may **not** decide a teacher, class, subject, day, session,
period, slot, assignment, or any database write. It has no vocabulary
for them: the decision schema has no such field, and an unrecognized
field is **rejected**, not ignored.

---

## Files

| File | Purpose |
| ---- | ------- |
| `backend/src/domain/ai/situation-report.js` | Deterministic, privacy-minimized `SituationReport`; FNV-1a hash; PII finder |
| `backend/src/domain/ai/strategy-schema.js` | Allow-list, `validateStrategyDecision`, `DEFAULT_AI_FALLBACK`, `applyStrategyDecision` |
| `backend/src/domain/ai/planner.js` | `AIPlanner` interface, `DeterministicMockAIPlanner`, failure providers |
| `backend/src/domain/ai/candidate-summary.js` | POST-SOLVE candidate facts (no placements) |
| `backend/src/domain/ai/index.js` | Orchestrator `planStrategy`, `recommendFromCandidates`, public surface |
| `backend/src/domain/dimension-catalog.js` | **New leaf module.** The Phase 28 dimension catalog, extracted |
| `backend/tests/phase29_ai_strategy.test.js` | 39 checks |
| `backend/tests/audit29.js` | Real-data simulation (read-only) |

### Why `dimension-catalog.js` was extracted

The dimension catalog is domain *vocabulary*: which quality axes
exist, which way they point, whether they are active. It lived inside
`global-scoring.js`, which imports `multi-solution.js` →
`solver.js`.

The AI layer must read that vocabulary **without** being able to
reach the solver (brief §36). An AI layer that can import
`solver.js` can reach search internals, and the boundary stops being
meaningful. So the catalog moved to a leaf module that imports only
`diversity.js`, and `global-scoring.js` re-exports it — its public
API is byte-for-byte unchanged.

The same reasoning moved the candidate-count vocabulary
(`1, 3, 5, 10`) from `multi-solution.js` into `strategies.js`, which
has no imports at all. `multi-solution.js` and the orchestrator now
read it from there instead of each carrying their own copy.

---

## 1. SituationReport

```js
SituationReport {
  version, hash,
  counts:          { teachers, branches, classes, subjects, assignments,
                     requiredPeriods, timeGridSlots },
  teacherWorkload: { teacherCount,
                     declared: { … },   // chuyenMon.soTietTuan — SUPPLY
                     demand:   { … } }, // assignment.teacherId — the real load
  specialization:  { distinctSubjects, entries: [{ subjectName, … }] },
  branchWorkload:  { branchCount, entries: [{ branchId, … }] },
  subjectDemand:   { subjectCount, entries: [{ subjectId, subjectName, … }] },
  preferenceCoverage: { teacherCount, teachersWithPreference, ratio, bySession },
  travelReadiness:     { supported, status, note },
  transferReadiness:   { active, status, note },
  constraintActivation:{ hard: [...], soft: [...], summary, aiMayDisable: false },
  dimensionAvailability:{ active: [...], inactive: [{ id, reason }] },
  actionSpace:     { optimizationModes, candidateCounts },
  candidateQuality, candidateDiversity,   // POST-SOLVE only
  signals: [...],
}
```

### Two workload views, on purpose

The first version reported only the curriculum-declared load
(`chuyenMon.soTietTuan`). On this dataset that is **1 for every
teacher**, so `workloadSpread` was always `0` and
`WORKLOAD_IMBALANCE_HIGH` was unreachable — a degenerate signal.

The report now carries both:

| View      | Source                      | Real data                    |
| --------- | --------------------------- | ---------------------------- |
| `declared`| `chuyenMon.soTietTuan`      | total 40, spread 0 — *not a load measure* |
| `demand`  | `assignment.teacherId`      | max 24, min 10, avg 20.05, spread 14, stdev 3.146 |

`demand` is the distribution the solver is trying to even out, so it
is the one a strategy decision should be based on. It also predicts
well: the pre-set spread is 14 and the best candidate the solver
reaches has spread 12.

The imbalance signal uses **relative** spread, `(max - min) / average`,
so it does not mean something different on a 5× larger school, plus
an absolute floor so a 2-period wobble on a huge school is not called
an imbalance.

### Determinism

Same `SchedulingInput` ⇒ byte-identical report.

- every emitted array is sorted by a total, content-derived key
  (never by `Map` insertion order, which is load-order dependent);
- every number comes from a pure fold over the input;
- no `Date.now()`, no `Math.random()`, no I/O.

The report carries `hash` (FNV-1a over a key-sorted serialization) so
the audit log can prove two runs saw the same situation **without
storing the situation**.

### Privacy / minimization

The report is aggregate-only. It deliberately omits:

- `teacher.hoTen`, `teacher.email`, `teacher.soDienThoai`
- per-teacher identifiers entirely — not even hashed ids
- branch names (institution names do not affect strategy choice)
- every schedule slot, placement, and assignment→teacher pair

It **retains subject names**, because "which subjects are in demand"
is the substance of the specialization/demand reasoning the AI is
being asked to do, and a subject name is not personal data.

`findPersonalData(report, input)` is exported so the test suite and
any future provider boundary reuse one implementation rather than
re-deriving the denylist. It performs both a structural key scan and
a value scan against the actual PII strings present in the input, so
a leak arriving under an innocuous key is still caught.

---

## 2. The validation boundary

`validateStrategyDecision(output, context)` treats the provider as an
**untrusted source of strings and numbers**. It is pure, never
mutates its arguments, and never throws for bad output — malformed
output is a `REJECT`, not an exception.

### Reject vs clamp

The split is about whether a value expresses a request the system
cannot honor, or an overshoot of one it can:

| Situation                                   | Action                    | Why |
| ------------------------------------------- | ------------------------- | --- |
| mode not in the enum                        | **REJECT** → fallback     | outside the action space |
| count not in `{1,3,5,10}`                   | **REJECT** → fallback     | outside the vocabulary |
| dimension id not in the catalog             | **REJECT** → fallback     | AI invented a new axis |
| any unrecognized **top-level field**        | **REJECT** → fallback     | see "no smuggling" below |
| weight `NaN` / `±Infinity` / non-number     | **REJECT** → fallback     | no usable intent; coercing is guessing |
| weight negative                             | **REJECT** → fallback     | not "a bit too much" — it inverts the axis |
| finite weight above `max`                   | **CLAMP** + event         | same intent, overshot |
| weight on an **inactive** dimension         | **CLAMP to 0** + event    | the domain forbids it; never activated |
| weight on a dimension the AI omitted        | catalog default + event   | the score must not divide by an accidental zero |
| every approved weight is `0`                | restore defaults + event  | global score would be 0/0 |
| rationale not a string                      | **DROP** + event          | non-authoritative; refusing to schedule over it is theatre |
| confidence outside `[0,1]`                  | **DROP** + event          | never reaches the solver |

Nothing is silently accepted. Every clamp produces an
`AI_OUTPUT_CLAMPED` event carrying `from`, `to`, and a human-readable
`detail`.

### No smuggling: unknown fields are rejected, not ignored

The decision schema has **no constraint, objective, or teacher-rule
field at all**. That alone would not be enough: an implementation
that quietly dropped `disableConstraints: ['H01']` would still be
writing a lie into the audit log. So `validateStrategyDecision`
rejects any unrecognized top-level field outright.

Test 17 pins this against `{ disableConstraints }`, `{ hardConstraints }`,
`{ ignore }`, `{ objectives }`, `{ relaxEligibility }`, and
`{ newConstraint }`.

`applyStrategyDecision` closes the second door: it copies the base
strategy's `objectives` **verbatim** and changes exactly one field,
`optimizationMode`. Even a future schema change could not let an AI
turn an objective off, because the apply step never reads objectives
from the decision.

### Weight bounds

`[0, 3]` per dimension, matching the bound `clampWeights` already
applies to domain strategy weights in `strategies.js` — so the AI
cannot request a magnitude the rest of the system already considers
out of range. Bounds are part of the allow-list, which is built from
the catalog and the input **outside** the AI.

### The allow-list

```js
buildAllowList(input) => {
  modes, counts, weightBounds, allowedDimensions,
  blockedDimensions, decisionFields, priorityLevels
}
```

Deeply frozen. The provider sees it through the report's
`actionSpace` as information; it cannot obtain a reference and mutate
it, and no provider output can extend it — a decision that *claims* to
extend the action space is rejected as an unknown field.

`allowedDimensions` is derived from the catalog's `active(input)`
predicate, so a dataset that later gains a travel matrix
automatically unlocks `TRAVEL` with no code change here.

### Fallback

`DEFAULT_AI_FALLBACK` is `GLOBAL_ASSIGNMENT_BALANCED`, count `3`, with
weights read from the dimension catalog's own `defaultWeight` — the
same source `GLOBAL_SCORING_DEFAULTS.weights` is built from, so the
fallback **cannot drift** from the scorer's defaults. Test 27 asserts
equality field by field.

`fallbackDecision(input)` returns a decision that passes
`validateStrategyDecision` with zero events, so callers can treat
"fallback" and "approved" identically.

---

## 3. Failure handling

| Condition                     | `failure.kind`          |
| ----------------------------- | ----------------------- |
| no planner supplied           | `AI_UNAVAILABLE`        |
| planner is not a planner      | `AI_UNAVAILABLE`        |
| planner throws `AIProviderError` | its own kind         |
| planner throws anything else  | `AI_INVALID_OUTPUT`     |
| planner never settles         | `AI_TIMEOUT`            |
| output is not a plain object  | `AI_INVALID_OUTPUT`     |
| output violates the schema    | `AI_INVALID_OUTPUT`     |
| confidence below `minConfidence` | `AI_INVALID_OUTPUT` (`LOW_CONFIDENCE`) |

**None of these can fail a schedule the deterministic path could have
produced anyway.** Every row resolves to the same fallback.

The timeout is a real race (`AI_STRATEGY_DEFAULTS.timeoutMs`, default
5 s). The timer is deliberately **not** `unref`-ed: when a provider
never settles, that timer is the only pending handle, and unref-ing it
lets Node exit before the race resolves. It is always cleared in a
`finally`, so it cannot outlive the call.

Confidence can only make the system **more** conservative. It never
relaxes any rule — a decision with `confidence: 0.99` and a bogus mode
is still rejected (test 33).

---

## 4. Providers

```js
class AIPlanner {
  get name() { … }
  async plan(situationReport) { … }   // → raw decision object
}
```

The provider is handed **only** the report. It receives no
`SchedulingInput`, no candidates, no solver, no catalog mutators, and
no database handle — so it cannot reach `solver.js` even indirectly.

Phase 29 ships `DeterministicMockAIPlanner`, a fixed rule table over
the report's signals:

| Rule | Condition | Mode |
| ---- | --------- | ---- |
| `NO_WORK_TO_DO` | no assignments or no teachers | `BASE_FEASIBLE` |
| `WORKLOAD_IMBALANCE` | relative spread ≥ 0.25 and spread ≥ 3 | `GLOBAL_ASSIGNMENT_BALANCED`, workload axes highest |
| `PREFERENCE_COVERAGE` | strong preference coverage, workload acceptable | `ASSIGNMENT_BALANCED`, preference raised |
| `DEFAULT` | anything else | `GLOBAL_ASSIGNMENT_BALANCED`, catalog defaults |

It is **not** a language model and is not presented as one. It is
deterministic: no clock, no randomness, no I/O, no reference to the
input. Its output only ever names active dimensions, so it
structurally cannot weight `TRAVEL` on this dataset.

Failure providers exist so the fallback paths are tested rather than
assumed: `createUnavailablePlanner`, `createHangingPlanner`,
`createParseErrorPlanner`, `createUnsupportedRequestPlanner`,
`createInvalidOutputPlanner`, `createStaticPlanner`.

**AirLLM, `LocalLLM`, and every other runtime are Phase 30.** No
dependency was added, and no backend source imports a model runtime
(test 29 enforces both).

---

## 5. Integration boundary

```
SchedulingInput
      ↓
SituationReport
      ↓
AIPlanner
      ↓
StrategyValidator
      ↓
StrategyDecision          ← the only thing the AI influenced
      ↓
Solver
      ↓
Candidates
      ↓
Global Scorer (Phase 28)
      ↓
Final Solutions
```

`applyDecisionToInput` returns a **new** top-level object with a new
`strategy`. The heavy collections are shared by reference — they are
read-only to the solver (Phase 23/25 guarantee) and copying them per
call would be a large, pointless allocation on a 479-assignment
input. Test 23 plans against a deep-frozen strategy twice and asserts
byte-identity afterward.

### One real gap this phase had to close

`generateSolutions` hard-codes
`optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED'` on every iteration.
That is correct for Phase 27 — whose premise is "GLOBAL is the only
engine" — and Phase 27's tests assert it.

But it means an AI `optimizationMode` decision is **silently
discarded** on the multi-solution path: the AI could ask for
`ASSIGNMENT_BALANCED` and generation would run GLOBAL anyway. That
would make this phase's central claim hollow for the path the product
actually uses.

`generateSolutions` therefore gained an **opt-in**
`respectStrategyMode` option, **default `false`**, so every existing
call keeps byte-identical behavior. When enabled, the mode comes from
`input.strategy.optimizationMode`, validated against the enum, with an
unrecognized mode falling back to GLOBAL rather than reaching the
solver. The engine actually used is reported in
`diagnostics.optimizationMode`, so an audit can never be misled.
Test 39 pins both halves.

### Two timing modes

- **PRE-SOLVE** (primary, brief §19): report → decision → solve. This
  is what Phase 29 implements.
- **POST-SOLVE** (brief §18): formalized but deliberately minimal.
  `recommendFromCandidates(candidates)` returns a **pointer** to one
  candidate plus a rationale. It does not re-solve, does not rescore,
  and does not touch the candidates — it cannot be used to bypass the
  Phase 28 scorer or the independent evaluator.

---

## 6. Audit log

```js
audit {
  provider,          // e.g. "DeterministicMockAIPlanner"
  inputSummaryHash,  // 8 hex chars — the input, by reference only
  decision,          // the approved decision
  validation: { status, reason, events },
  fallbackUsed,
  rationale,
  failure,           // or null
}
```

It answers *"why did the system choose this strategy?"* without
storing the report, the raw provider output, or any teacher data
(test 35). `inputSummaryHash` is enough to prove two runs saw the same
situation. Timing is returned in a sibling `timing` object, outside
the audit, so the log itself stays deterministic.

---

## 7. Real-data simulation

`node tests/audit29.js` — read-only, no network, no model.

```
--- 1. SituationReport ---
  build time              : 10 ms
  hash                    : 8ce3075a
  teachers / branches     : 40 / 7
  classes / subjects      : 113 / 6
  assignments / periods   : 479 / 802
  time-grid cells         : 210

  pre-set load  max/min   : 24 / 10
  pre-set load  avg       : 20.05
  pre-set load  spread    : 14  (relative 0.698254)
  pre-set load  stdev     : 3.146
  declared (chuyenMon)    : total 40, spread 0 (not a load measure)
  preference coverage     : 40/40 (ratio 1)
  travel / transfer       : UNSUPPORTED / INACTIVE
  hard constraints        : 9 active / 4 inactive / 1 unsupported
  soft constraints        : 4 active / 4 inactive
  AI may disable          : false
  active dimensions       : MAX_TEACHER_LOAD, PREFERENCE, SLOT_DIVERSITY,
                            STRUCTURAL_DIVERSITY, WORKLOAD_BALANCE, WORKLOAD_STDEV
  blocked dimensions      : CHANGED_ASSIGNMENTS (REPORTING_ONLY)
                            TRANSFER (H13 = INACTIVE)
                            TRAVEL (H14 = UNSUPPORTED)
  signals                 : PREFERENCE_COVERAGE_STRONG, SPECIALIZATION_BROAD,
                            TRANSFER_INACTIVE, TRAVEL_UNAVAILABLE,
                            WORKLOAD_IMBALANCE_HIGH
  personal-data findings  : 0
  deterministic rerun     : YES (identical hash)
```

### Mock AI decision, accepted unchanged

```
  provider                : DeterministicMockAIPlanner
  validation status       : ACCEPTED
  fallback used           : false
  approved mode           : GLOBAL_ASSIGNMENT_BALANCED
  approved candidateCount : 5
  approved weights        : WORKLOAD_BALANCE=1  MAX_TEACHER_LOAD=0.8
                            WORKLOAD_STDEV=0.6  PREFERENCE=0.2
                            STRUCTURAL_DIVERSITY=0.4  SLOT_DIVERSITY=0.2
  priorities              : WORKLOAD_BALANCE=HIGH  MAX_TEACHER_LOAD=HIGH
                            WORKLOAD_STDEV=MEDIUM   PREFERENCE=LOW
                            STRUCTURAL_DIVERSITY=LOW  SLOT_DIVERSITY=LOW
  correction events       : 0
  report build / AI call  : 10 ms / 0 ms
```

The mock reads `WORKLOAD_IMBALANCE_HIGH` and weights the workload axes
highest — which is the correct deterministic reading of a dataset
whose pre-set spread is 14 against an average load of 20.

### Failure matrix — every path falls back

| Case | fallback | kind |
| ---- | -------- | ---- |
| no provider at all | yes | `AI_UNAVAILABLE` |
| provider unavailable | yes | `AI_UNAVAILABLE` |
| provider never responds | yes | `AI_TIMEOUT` |
| provider parse error | yes | `AI_PARSE_ERROR` |
| provider unsupported request | yes | `AI_UNSUPPORTED_REQUEST` |
| provider invalid output | yes | `AI_INVALID_OUTPUT` |
| not a provider object | yes | `AI_UNAVAILABLE` |

### DEFAULT vs MOCK_AI

| metric | MOCK_AI | DEFAULT |
| ------ | ------- | ------- |
| requested mode | `GLOBAL_ASSIGNMENT_BALANCED` | `GLOBAL_ASSIGNMENT_BALANCED` |
| engine actually used | `GLOBAL_ASSIGNMENT_BALANCED` | `GLOBAL_ASSIGNMENT_BALANCED` |
| fallback used | false | true |
| candidateCount | 5 | 3 |
| candidates produced | 5 | 5 |
| best globalScore | 0.9510 | 0.9234 |
| best qualityScore | 0.0714 | 0.0714 |
| best workloadSpread | 12 | 12 |
| best maxTeacherLoad | 24 | 24 |
| min slot diversity | 0.6028 | 0.6028 |
| min structural div | 0.1150 | 0.1150 |

**This is a pipeline demonstration, not a quality claim.** The mock
is a fixed rule table, not a model. Phase 29 makes **no** claim that
it produces better timetables, and the two rows land on identical
workload metrics because both resolve to the same engine with
different emphasis. The rows exist to show that a different, valid,
AI-chosen strategy travels the whole pipeline and changes what the
scorer is asked to rank.

### End-to-end verification

```
  solve() mode             : GLOBAL_ASSIGNMENT_BALANCED
  hard violations          : 0
  independent accepted     : true
  complete candidates      : 5
  search nodes             : 2400
  time budget hit          : false
  workloadSpread           : 12
  maxTeacherLoad           : 24
  workloadStdev            : 3.041
  changedAssignments       : 0 (reporting only)
```

POST-SOLVE report facts (5/0 feasible, workloadSpread 12–16,
maxTeacherLoad 24–28, stdev 3.008–3.138) also carry **zero**
personal-data findings.

### Guarantees, as measured

```
  AI direct slot generation  : NO
  AI constraint override     : NO
  external call              : NO
  input mutated              : NO
  AI quality improvement     : NOT YET MEASURED
```

---

## 8. Tests

`backend/tests/phase29_ai_strategy.test.js` — 39 checks, all passing.

The 30 required by the brief are numbered `01`–`30` in the brief's own
order. `31`–`39` are additional guards:

| # | Guard |
| - | ----- |
| 31 | the allow-list is frozen and lives outside the AI |
| 32 | an all-zero weight vector is replaced so the global score stays defined |
| 33 | a low-confidence decision falls back; confidence never relaxes other rules |
| 34 | **the AI layer never imports the solver** (static import-graph check) |
| 35 | the audit log explains the decision without storing the report or PII |
| 36 | the report gains candidate statistics only in POST-SOLVE mode |
| 37 | the post-solve recommendation names a candidate without altering it |
| 38 | the mock and the default differ, and the difference reaches the solver |
| 39 | the AI-chosen mode reaches generation, and the default is unchanged |

Test 34 is the architectural one: it reads the `domain/ai/` sources,
extracts every relative import, and fails if any resolves to
`solver.js`, `multi-solution.js`, or `global-scoring.js`. It also
asserts `dimension-catalog.js` imports exactly one module, so the leaf
property cannot rot.

Test 28 is both static and dynamic: it scans for network APIs **and**
makes `globalThis.fetch` throw before running a plan.

---

## 9. Regression

No pre-existing test was modified to pass. The two refactors this
phase made — extracting the dimension catalog, and centralizing the
candidate-count vocabulary — are behavior-preserving, and the
`respectStrategyMode` option defaults to the previous behavior.

```
Before: 533
After : 572
Passed: 572
Failed: 0
```

---

## 10. Definition of Done

- [x] SituationReport exists
- [x] deterministic
- [x] no unnecessary PII
- [x] AIPlanner interface exists
- [x] StrategyDecision schema exists
- [x] allowed optimization modes bounded
- [x] allowed dimensions bounded
- [x] weight bounds enforced
- [x] candidate count bounded
- [x] inactive dimensions cannot be activated
- [x] hard constraints cannot be disabled
- [x] AI output validated
- [x] fallback exists
- [x] timeout/failure handling exists
- [x] mock AI provider exists
- [x] real SchedulingInput simulation works
- [x] solver consumes validated strategy
- [x] solver remains independent from AI internals
- [x] candidates remain validator-checked
- [x] input remains immutable
- [x] no AirLLM
- [x] no external LLM
- [x] all regression tests pass
- [x] `PHASE_29_AI_STRATEGY_LAYER.md`

---

## 11. Not done, deliberately

- No AirLLM, no model download, no GPU/CUDA setup, no external API.
- No claim that AI improves timetable quality. `AI quality
  improvement = NOT YET MEASURED`; Phase 30 benchmarks a real local
  LLM against the deterministic default.
- No UI. `StrategyDecision`, `validation.events`, and `audit` are
  shaped to be displayable, but nothing renders them yet.
- No database persistence. The audit log is an in-memory object.
- `POST-SOLVE` is an interface and a pointer, not a re-ranking engine.
