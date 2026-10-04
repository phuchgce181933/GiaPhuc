# PHASE 31.1 — RUNTIME VERIFICATION

Two independent questions, answered separately.

| | Question | Answer |
|---|---|---|
| **A** | Is the test suite trustworthy? | **YES** — 660/660, **eight consecutive** full runs under CPU contention, 0 failures |
| **B** | Does AirLLM actually run and produce a real `StrategyDecision`? | **NO — BLOCKED.** Not attempted, because this host cannot run it. |

Part B being BLOCKED is not a defect in this phase. It is the honest
verdict, and the whole point of the phase is that a blocked runtime is
reported as blocked rather than simulated.

---

# A. Test stabilization

## A.1 What was actually wrong

Two tests asserted determinism over a **wall-clock**-bounded search:

| Test | Old assertion |
|---|---|
| `phase25_global_assignment_optimization.test.js` / 19 | two real 479-assignment `GLOBAL_ASSIGNMENT_BALANCED` solves at a 5 000 ms budget produce the identical `(assignmentId → teacherId)` map |
| `phase29_ai_strategy.test.js` / 25 | `solve()` with a 1 500 ms budget returns a candidate the evaluator accepts |

In `GLOBAL_ASSIGNMENT_BALANCED` the solver's iteration ceiling is
`Number.MAX_SAFE_INTEGER`, so **the wall clock is the only real bound**.
A wall clock is a property of the machine, not of the input. On a busy
host the search completes fewer iterations, fewer candidates are
compared, and a different candidate can become the incumbent.

This is not RNG nondeterminism — the search is a pure function of the
seed. It is a **shorter search**.

A **third** instance of the same defect was found while verifying the
fix, and is documented in A.2b.

## A.2 The defect, measured

`backend/_probe_determinism.mjs` reproduces the exact old assertion.
Against the **unmodified** solver, 16 busy workers on a 20-core host:

```
round 1: same=true  candA=24 candB=18  limitedA=true limitedB=true
round 2: same=false candA=19 candB=17  limitedA=true limitedB=true
round 3: same=true  candA=13 candB=13  limitedA=true limitedB=true
round 4: same=true  candA=15 candB=13  limitedA=true limitedB=true
DIVERGED 1/4
```

The `candA`/`candB` columns are the real evidence and they are the part
that does not depend on luck. Same input, same seed, same strategy —
**different amounts of work**:

```
round 1: candA=49 candB=32   <- 17 candidates of difference
```

The incumbent happens to coincide most of the time, which is why this
presented as an intermittent failure rather than a consistent one. The
work performed was never the same.

## A.2b The third instance: an empty pool, not a divergent one

`phase28_global_scoring_selection.test.js` / 23 built a 10-solution pool
with `perSolveTimeBudgetMs: 1000`. That is **less than the cost of one
complete solve** of this dataset on a loaded host, so the generator
could return zero candidates and the test failed on an empty pool:

```
not ok 23 - PHASE 28 / 23 — real 10-solution pool scores successfully
  error: 'the pool must contain at least one candidate'
```

Reproduced at **2 failures in 4 runs** under 16 workers, 0 in 4 on an
idle machine. The old comment in that file acknowledged the risk
("a heavily loaded machine may produce fewer than 10") but the actual
failure mode was worse than the comment claimed: **zero**, not "fewer
than 10". Fixed the same way — the pools are now iteration-bounded and
asserted non-truncated at their source, so every test in the file is
known to read a full pool. Verified 3/3 clean under the same load.

## A.3 The fix: a seed-stable search bound

`strategy.solver.maxSearchIterations` (new) bounds the search by an
**iteration count** rather than by elapsed time.

- Same `(input, seed, strategy)` ⇒ same amount of work ⇒ same
  incumbent, on any machine, at any load.
- The time budget is retained unchanged as a safety valve. It is no
  longer what makes results reproducible.
- Unset ⇒ pre-31.1 behavior exactly (wall clock only). No existing
  caller changed meaning.

Plumbed through `generateSolutions(input, { maxSearchIterations })` and
into the frozen `BENCHMARK_SOLVER_PROFILE`, so both benchmark arms
receive the identical bound and no per-arm override is possible.

## A.4 Two properties, kept apart

| | `DETERMINISTIC_SEARCH` | `TIME_BUDGETED_SEARCH` |
|---|---|---|
| bound | `maxSearchIterations: N` | `timeLimitMs` |
| decided by | the seed | the machine |
| byte-identical | **claimable** | **not claimable when the budget binds** |
| `searchLimited` | `false` | `true` if the clock bound |
| `searchStoppedBy` | `ITERATION_LIMIT` / `SEARCH_EXHAUSTED` / `SOLUTION_CAP` | `TIME_BUDGET` |

`searchLimited` now has one exact meaning: **true if and only if the
wall clock truncated the search.** A search that stopped on the
iteration limit, the solution cap, or exhaustion is complete with
respect to its own contract, is reproducible, and is *not* limited.

New diagnostics: `searchStoppedBy`, `iterationBound` (solver);
`searchStoppedBy[]`, `iterationBound` (generation).

## A.5 Tests

| File | Change |
|---|---|
| Phase 25 | 19 split into **19** (bounded 6-assignment fixture, byte-identical), **19b** (real 479 assignments, iteration-bounded, byte-identical), **19c** (binding budget — reports truncation, **no** identity claim), **19d** (stop-reason semantics). 26 and 7-quality comparisons made iteration-bounded. |
| Phase 27 | 17 / 18 / 19 use the iteration bound behind a shared `assertReproducible` premise check; **19b** added for the binding-budget case. `runReal` and the real-data solves in 3 / 9 / 21 / 23 / 31 / 32 bounded. |
| Phase 28 | All three real pools (3 / 5 / 10) iteration-bounded and asserted non-truncated **at their source**, so a short or empty pool fails once, at the fixture, instead of inside every test that reads it. |
| Phase 29 | Shared pool, test 25 and test 39 bounded via `FAST_STRATEGY` / `GEN_OPTS`; `FAST_STRATEGY` budget 1 500 ms → 30 000 ms **plus** the iteration bound. |
| Phase 30 | `SOLVE_OPTS` bounded; tests 20 and 21 assert the premise explicitly. |
| Benchmark | `BENCHMARK_SOLVER_PROFILE` gained `maxSearchIterations: 12`; `SOLVER_PROFILE_HASH` changes accordingly, so a profile edit stays detectable. |

Phase 25's fixture is 6 assignments / 3 cross-eligible teachers / 2
periods each — small enough to finish in milliseconds, large enough
that the GLOBAL engine really does compare candidates (asserted:
`completeCandidates > 1`, so the test cannot pass vacuously).

## A.6 The determinism contract

> **Determinism holds when, and only when, all four hold:**
>
> ```
> same input
> + same seed
> + same strategy
> + the search was not truncated by the wall clock
> ```
>
> When `searchStoppedBy === 'TIME_BUDGET'`, no byte-identical output is
> claimed, and the diagnostics say so.

Documented in the header of `src/domain/multi-solution.js` and at each
call site.

## A.7 Proof

`_probe_determinism.mjs` with `maxSearchIterations: 12`, 12 rounds,
same 16-worker load:

```
round  1: same=true candA=12 candB=12 msA=1203 msB=1749 stop=ITERATION_LIMIT
round  2: same=true candA=12 candB=12 msA=1833 msB=1808 stop=ITERATION_LIMIT
...
round 12: same=true candA=12 candB=12 msA=1798 msB=1778 stop=ITERATION_LIMIT
DIVERGED 0/12
```

**Wall time varied 1 203 → 1 861 ms (a 55 % spread) while every result
was identical.** That is the property: the work is seed-decided, and
elapsed time is now free to vary.

## A.8 Full-suite results

`npm test` (`node --test tests/*.test.js`), 16 busy workers running
throughout, **eight consecutive runs**:

| Run | Tests | Pass | Fail | Duration |
|---|---|---|---|---|
| 1 | 660 | 660 | 0 | 167.6 s |
| 2 | 660 | 660 | 0 | 167.5 s |
| 3 | 660 | 660 | 0 | 167.7 s |
| 4 | 660 | 660 | 0 | 167.7 s |
| 5 | 660 | 660 | 0 | 558.7 s |
| 6 | 660 | 660 | 0 | 894.1 s |
| 7 | 660 | 660 | 0 | 377.8 s |
| 8 | 660 | 660 | 0 | 349.3 s |

Runs 1–4 are the isolated Phase 25/27/29/30 work; runs 5–8 include the
Phase 28 pool fix. Durations vary by 2.5x because the load generator
was the variable under test — which is the point. The pass/fail count
does not move at all.

Python side, unchanged by this phase: `python -m pytest tests` →
**93 passed**.

Two failures observed during verification were **not** test defects and
were not "fixed":

- Three failures (`03d`, `22`, `3` in phase 30) appeared only because
  `AIRLLM_INTEGRATION=1` was still set in the shell after the
  benchmark run. The tests are correct: they refuse to run integration
  tests with the gate open. Clearing the variable restores 39/39.
- One `PHASE 28 / 23` failure led to the real Phase 28 fix in A.2b.

**Test count: 656 → 660.** The four new tests are Phase 25 / 19b, 19c,
19d and Phase 27 / 19b. No test was removed, skipped, retried, or
weakened.

---

# B. AirLLM environment

Verified on this host, 2026-10-04. Every value below was read from the
running service or from `pip`/`nvidia-smi`. **Nothing is guessed or
inferred.**

## B.1 Captured runtime metadata

`GET http://127.0.0.1:8077/health` → `200`:

| Field | Value | Source |
|---|---|---|
| `status` | `SERVICE_RUNNING` | service |
| `provider` | `airllm` | service |
| `modelLoaded` | `false` | service |
| `model` | `unconfigured` | service |
| `pythonVersion` | `3.12.10` | service |
| `pythonImplementation` | `CPython` | service |
| `platform` | `Windows` | service |
| `fastapiVersion` | `0.135.1` | service |
| **`airllmVersion`** | **`null`** | service |
| **`torchVersion`** | **`null`** | service |
| **`transformersVersion`** | **`null`** | service |
| **`cudaAvailable`** | **`false`** | service |
| `device` | `auto` (unresolved) | service |
| `dtype` | `auto` (unresolved) | service |

`GET /ready` → **`503`**, `state: SERVICE_RUNNING`, `ready: false`.

## B.2 Why it is blocked

| Requirement | Status | Evidence |
|---|---|---|
| Python environment | **present** | 3.12.10 (also 3.13.7) |
| FastAPI / uvicorn / pydantic | **present** | 0.135.1 / 0.42.0 / 2.12.5 |
| **AirLLM** | **ABSENT** | `pip show airllm` → not found |
| **torch** | **ABSENT** | `ModuleNotFoundError: No module named 'torch'` |
| **transformers** | **ABSENT** | not in `pip list` |
| **model checkpoint** | **ABSENT** | see below |
| GPU hardware | present | NVIDIA GeForce RTX 4060 Laptop GPU, 8188 MiB |
| Service listening | reachable once started | `127.0.0.1:8077` bound, `/health` 200 |

`modelReady` is **`false`** and cannot be anything else: with no model
configured and no torch to load it with, the service reports
`MODEL_ERROR` on any load attempt.

**Model checkpoint.** The only candidate on disk is
`~/.cache/huggingface/hub/models--TheBloke--vicuna-7B-1.1-HF`, and it
contains **no weights** — `config.json`, `tokenizer.model`,
`tokenizer_config.json`, `special_tokens_map.json`, nothing else. The
whole `hub` directory is 0.0 GB.

`cudaAvailable: false` deserves a note: the RTX 4060 **is** present, but
the service can only detect CUDA through torch, and torch is absent.
The reported value is the honest one, not a statement about the
hardware.

## B.3 `POST /plan`

Sent to the running service:

```json
{"decision": null, "provider": "airllm", "model": "unconfigured",
 "fallbackUsed": true, "failure": "AI_UNSUPPORTED_REQUEST",
 "validated": false, "state": "SERVICE_RUNNING", "remoteCodeUsed": false}
```

`/ready` afterwards: still `SERVICE_RUNNING`, `ready: false`.

The service behaved correctly — it refused a hand-assembled report
because the report must come from the Node `SituationReport` builder,
and it reported `fallbackUsed: true` rather than inventing a decision.
But this is **not** a Tier A smoke pass: no inference ran, and
`modelReady` was never true. Classified **`AIRLLM_RUNTIME_FAILURE`**
with cause `NO_MODEL_CONFIGURED` / `MODEL_STACK_NOT_INSTALLED` — i.e.
never reached inference, not an inference failure.

## B.4 Benchmark

`$env:AIRLLM_INTEGRATION=1; npm run benchmark`

```
· AI provider: airllm (AirLLMPlanner)
· Tier A: runtime smoke test
  BLOCKED — no AirLLM service is listening.
· Tier B: strategy quality benchmark
  AIRLLM_BENCHMARK_BLOCKED
Verdict: AIRLLM_BENCHMARK_BLOCKED
```

`docs/PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md` was rewritten from this
live run. Version fields read `not reported` rather than a guessed
value.

## B.5 Provider identity — the fallback is not mislabeled

| Arm | Runs | `bestGlobalScore` | validityRate | fallbackRate |
|---|---|---|---|---|
| DETERMINISTIC_FALLBACK | 5 | 0.7222 | n/a (consults no provider) | n/a |
| AIRLLM | 1 | **n/a** | **0.0 %** | **100.0 %** |

The AirLLM arm's score is `n/a`, not 0.7222. The two arms are not
collapsed, and the one AirLLM run is reported as a fallback, not as an
AI success. `sharedPoolGlobalScore` for the AirLLM arm is `n/a` while
the baseline median is `0.5000` — the shared yardstick is preserved
rather than substituting two independently normalized pools.

Verdict `INVALID`, separation `NOT_APPLICABLE`, and the report states
the reason: *"no valid AirLLM run produced a score; the comparison
cannot be made."*

## B.6 Why nothing was faked

Producing a Tier A PASS here would have required either a mock labelled
`airllm`, or a fabricated version stamp. Both were available and both
were rejected: the brief requires the opposite, and a benchmark that
reports a model that never ran is worse than no benchmark.

## B.7 What unblocks it

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# 1. torch matched to this host's CUDA (RTX 4060 -> cu124 wheel)
pip install torch --index-url https://download.pytorch.org/whl/cu124

# 2. the model runtime stack
pip install -r requirements-model.txt

# 3. an INSTRUCT checkpoint (a base model will not follow the format)
huggingface-cli download Qwen/Qwen2.5-1.5B-Instruct --local-dir D:\models\qwen2.5-1.5b-instruct
```

```powershell
# service
cd ai-service
$env:AIRLLM_MODEL_PATH = "D:\models\qwen2.5-1.5b-instruct"
$env:AIRLLM_DEVICE     = "cuda"
$env:AIRLLM_PRELOAD    = "1"
python -m app.main
```

```powershell
# verify BEFORE trusting any benchmark
curl http://127.0.0.1:8077/ready     # must be 200, ready: true
```

```powershell
# benchmark
cd backend
$env:AIRLLM_INTEGRATION = "1"
npm run benchmark
```

Then record the **actual** `airllmVersion`, `torchVersion`,
`transformersVersion`, `modelIdentifier`, `device`, `dtype` and
`cudaAvailable` the service reports into
`docs/PHASE_30_AIRLLM_LOCAL_PROVIDER.md`. Do not copy the versions
above — they are the ones that are *missing* here.

---

# C. Smoke test

**NOT RUN.** See B.2. `modelReady` cannot be true without torch,
AirLLM and weights, so there is nothing to smoke.

What will be required when it can run, and what the code already
enforces:

- `modelReady === true` — a process and an open port are not readiness.
  `/ready` returns 503 until the model is loaded.
- `fallbackUsed === false` and a valid `StrategyDecision` from
  `POST /plan` over a real `SituationReport`.
- `provider === 'airllm'` in the response, not merely in the Node
  config.

---

# D. Real benchmark

**NOT RUN.** `fallback × 5` completed; `AirLLM × 5` did not, and
repetitions were not trimmed to make the arms look comparable. The
report prints both counts and marks the missing cells `n/a`.

The frozen solver profile guarantees the comparison would be fair once
it can run: same `SchedulingInput`, same solver, same evaluator, same
scorer, same `candidateCount`, same time budget, and now the same
seed-stable `maxSearchIterations`. Only the `AIPlanner` differs.

`maxSearchIterations: 12` in the profile also removes a measurement
artefact that was present before this phase: with only a wall-clock
bound, a repetition that ran on a busy machine compared fewer
candidates and would have scored differently — a machine artefact
reported as an AI effect.

---

# E. Quality comparison

**INCONCLUSIVE / BLOCKED.** Not `BETTER`, not `EQUIVALENT`, not
`WORSE`.

| | Value |
|---|---|
| Best shared score — fallback | 0.5000 (median) |
| Best shared score — AirLLM | `n/a` |
| Workload spread — fallback | 12 |
| Workload spread — AirLLM | `n/a` |
| Workload stdev — fallback | 3.0079 |
| Workload stdev — AirLLM | `n/a` |
| `validityRate` | 0.0 % (0 valid of 1) |
| `fallbackRate` | 100.0 % |
| `AIRLLM_DECISION_EQUIVALENT` check | **not applicable** — no AI decision to hash |

The AI subsystem is **not** production-ready. Tier A has never passed
on this host. Everything asserted about the AI strategy layer so far is
asserted about the *decision boundary* — the validator, the fallback,
the audit log, the vocabulary — which is real and tested, and about
nothing about a model's output.

---

# F. Limitations

1. **No AirLLM execution has ever occurred on this host.** Every AI-path
   claim in Phases 29–31 is about the boundary, not about a model.
2. **The determinism fix is verified on one host** (20 logical cores,
   16-worker contention, Windows). The mechanism is host-independent by
   construction — the bound is a count, not a duration — but it has not
   been run on Linux CI.
3. **`DETERMINISTIC_SEARCH` and full search quality are different
   things.** Bounding to 12 iterations makes results reproducible; it
   does not make them *optimal*. Quality claims still rest on the
   time-budgeted path. The two are now separately named, and the
   5-second time-budgeted behaviour is preserved for exactly that
   reason.
4. **AirLLM declares no determinism guarantee** and the service exposes
   no generation seed, so even once running, the AI arm will vary
   across repetitions by sampling. The Node solver seed is unaffected:
   AI sampling cannot reach solver randomness.
5. **Nothing else moved.** No UI, no travel, no transfer optimization,
   no fine-tuning, no training, no H14 activation.

---

## Reproducing the stability claim

```powershell
cd backend
node _load.mjs 16 400        # 16 busy workers, background
npm test                      # expect 660 / 660
npm test                      # expect 660 / 660
```

```powershell
cd backend
node _probe_determinism.mjs 60000 12 12   # DETERMINISTIC_SEARCH -> 0/12
node _probe_determinism.mjs 5000  12 0    # TIME_BUDGETED control -> candidate counts differ
```

Both scripts are diagnostics. They live in `backend/` rather than
`tests/`, so `npm test`'s `tests/*.test.js` glob cannot pick them up.

## Artifacts

| File | What |
|---|---|
| `docs/PHASE_31_1_RUNTIME_VERIFICATION.md` | this document |
| `docs/PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md` | rewritten by the live `npm run benchmark`; `AIRLLM_BENCHMARK_BLOCKED` |
| `backend/src/domain/solver.js` | `maxSearchIterations`, `searchStoppedBy`, `iterationBound` |
| `backend/src/domain/multi-solution.js` | the determinism contract; bound plumbed through |
| `backend/src/benchmark/runner.js` | bound in the frozen solver profile |
| `backend/_probe_determinism.mjs` | reproduces the defect and the fix |
| `backend/_load.mjs` | CPU contention generator |
