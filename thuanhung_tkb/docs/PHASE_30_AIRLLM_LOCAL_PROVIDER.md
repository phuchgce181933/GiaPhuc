# Phase 30 - AirLLM Local Provider

> **AirLLM is a provider, not a scheduler.**
> It may propose a mode, a candidate count, and bounded weights. It
> may not create a schedule slot, name a teacher-period pair, disable
> a hard constraint, or activate travel.

Phase 29 built the AI strategy layer and proved the contract with a
deterministic mock. Phase 30 replaces the mock with a real local model
**without changing the contract, the solver, the evaluator, the scorer,
or the multi-solution architecture.**

---

## What changed in Phase 30

Nothing about how a decision becomes a schedule. One new seat at the
same place in the pipeline:

```
SchedulingInput
      v
SituationReport            unchanged  (Phase 29)
      v
AIPlanner                  <- the only seam that moved
   +-- DeterministicMockAIPlanner      (unchanged, still the default)
   +-- AirLLMPlanner --HTTP--> ai-service (Python, AirLLM)   NEW
      v
StrategyDecision           unchanged  (Phase 29)
      v
StrategyValidator          unchanged  (Phase 29, still the authority)
      v
Solver -> Candidates -> Evaluator -> Global Scoring -> Final Solutions
                         unchanged  (Phases 22-28)
```

Two validation layers sit between the model and the solver, and neither
replaces the other:

```
AirLLM text
   v  parse/normalize        app/parser.py    strict; no guessing
   v  schema validation      app/schema.py    vocabulary from the report
   v
Node                        airllm-client.js  moves JSON only
   v  validateStrategyDecision()              THE AUTHORITY
   v
Solver
```

The Python service is not trusted. It exists so a clearly-bad response
never crosses a process boundary; Node re-validates because Node owns
the allow-list and the weight bounds.

---

## Architecture

```
thuanhung_tkb/
+-- backend/                    Node.js -- unchanged architecture
|   +-- src/domain/ai/
|       +-- planner.js          AIPlanner seam (Phase 29)
|       +-- situation-report.js SituationReport (Phase 29)
|       +-- strategy-schema.js  validateStrategyDecision (Phase 29)
|       +-- providers/
|           +-- index.js            factory: AI_PROVIDER=mock|airllm
|           +-- airllm-planner.js   AIPlanner impl over HTTP
|           +-- airllm-client.js    the only file that knows the service exists
+-- ai-service/                 Python -- NEW, separate process
    +-- app/
    |   +-- config.py           env -> ServiceConfig; collects errors, never raises
    |   +-- schema.py           the decision contract
    |   +-- prompt.py           versioned template rendering
    |   +-- parser.py           strict text -> JSON object
    |   +-- runtime.py          model load, device, remote-code check, state
    |   +-- service.py          prompt -> infer -> parse -> validate -> response
    |   +-- main.py             FastAPI: /health, /ready, /plan
    +-- providers/
    |   +-- strategy_prompt.txt the one and only prompt template
    +-- tests/                  93 tests, no model required
    +-- requirements.txt
    +-- README.md               setup guide
```

**The Node process never embeds a Python interpreter.** It speaks plain
HTTP. `airllm-client.js` is the only module that knows the service
exists; it does not know what AirLLM is, does not build a prompt, and
does not import torch.

**The Python service never reaches back.** No database client, no
solver, no HTTP client, no outbound network. Data flows one way.

---

## Runtime setup

Full instructions are in `ai-service/README.md`. The short version:

```powershell
cd ai-service
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt        # service + test tools only
pip install torch                      # matched to your CUDA version
pip install -r requirements-model.txt  # airllm, transformers

$env:AIRLLM_MODEL_PATH = "D:\models\<your-model>"
$env:AIRLLM_DEVICE     = "cpu"
python -m app.main
```

Node side:

```powershell
$env:AI_PROVIDER        = "airllm"
$env:AIRLLM_SERVICE_URL = "http://127.0.0.1:8077"
```

---

## Model configuration

No model is hard-coded anywhere. The Python service reads:

| Variable | Default | Notes |
|---|---|---|
| `AIRLLM_MODEL_PATH` | - | Local directory. **Preferred** - cannot trigger a download |
| `AIRLLM_MODEL_ID` | - | Repo id. Explicit opt-in; may fetch |
| `AIRLLM_CACHE_DIR` | - | Point outside the repository |
| `AIRLLM_DEVICE` | auto | `cpu`, `cuda`, `cuda:1` - never hard-coded |
| `AIRLLM_DTYPE` | auto | e.g. `float16` |
| `AIRLLM_MAX_NEW_TOKENS` | `512` | |
| `AIRLLM_TEMPERATURE` | `0.0` | 0 is the reproducible choice |
| `AIRLLM_PRELOAD` | `false` | Load at startup vs first request |
| `AI_REQUEST_TIMEOUT_MS` | `120000` | Shared by both sides |

The Node side reads only `AI_PROVIDER`, `AI_REQUEST_TIMEOUT_MS`,
`AIRLLM_SERVICE_URL`, `AIRLLM_SERVICE_TOKEN`, and `AIRLLM_INTEGRATION`.
The model settings belong to the Python process because only Python
loads the model. The AI layer's `minConfidence` gate is a per-call
option on `planStrategy`, not an environment variable, and it is off
(`null`) by default.

A local path is preferred over a repo id for one reason: a local
directory cannot silently pull gigabytes over the network. A missing
`AIRLLM_MODEL_PATH` is a startup **error**, never a trigger to download
a replacement.

---

## AirLLM version and model tested

**No model has been smoke-tested on the development host used to write
this phase.** AirLLM is not installed there, and installing a real
checkpoint is a deployment step, not something a test run may trigger.
So the honest record is:

| Item | Status |
|---|---|
| AirLLM version installed and verified | **not yet** - the adapter is written against the 4.0 `AutoModel.from_pretrained` shape and is version-adaptive (see below) |
| Model smoke-tested | **not yet** |
| `AIRLLM_ALLOW_REMOTE_CODE` behaviour | **verified by test** - refusal path covered without a model |
| Contract, parser, schema, prompt, HTTP surface | **verified by test** - 93 tests, no model needed |

This is deliberate, and it is a limitation recorded rather than papered
over. "AirLLM supports this model" is not the same claim as "this model
was run here and produced a valid decision", and only the second one is
worth anything.

### Version-adaptive loading

AirLLM's `from_pretrained` signature has changed across releases. The
adapter therefore inspects the installed callable with
`inspect.signature` and passes only the keywords it actually accepts,
reporting any it dropped. A version mismatch degrades into a log line
rather than a `TypeError` at load time - the worst possible moment to
discover it. This is also why no code was copied from a tutorial: a
tutorial is pinned to one release.

### What to record when you run it

Fill this in on a real host, and update the table above:

```
AirLLM version:
torch version:
transformers version:
model (repo + revision):
device:
CUDA available:
MODEL_READY reached: yes/no
first /plan latency:
subsequent /plan latency:
decision produced: mode / candidateCount
Node validation status: ACCEPTED | CLAMPED | REJECTED
```

---

## Security

| Control | Where |
|---|---|
| Binds loopback only | `config.py` refuses a non-loopback `AIRLLM_SERVICE_HOST` |
| Node refuses a non-loopback URL | `airllm-client.js` `assertServiceUrl` rejects it rather than dialling |
| Optional bearer secret on `/plan` | constant-time compare; `/health` and `/ready` exempt so an auth problem is distinguishable from an outage |
| No docs endpoints | `/docs`, `/redoc`, `/openapi.json` are disabled |
| No secrets in logs | `ServiceConfig.__repr__` redacts the token; `/health` reports `authRequired: true` only |
| No local paths on the wire | the model is identified by its directory's leaf name |
| No repository code by default | `trust_remote_code=False` first; refusal is the default |
| No model files in git | `ai-service/.gitignore` |
| No auto-download in tests | the model is only loaded when `/plan` or `AIRLLM_PRELOAD` asks |

### Remote code

This needed an explicit project-level control, because AirLLM cannot
provide the guarantee itself: `AutoModel.get_module_class` resolves the
config with `trust_remote_code=True` unconditionally, with no keyword
to disable it.

So `app/runtime.py` checks *before* AirLLM sees the model:

1. `AutoConfig.from_pretrained(ref, trust_remote_code=False)`.
2. Success means the architecture is natively recognised, so no
   repository code is needed and none runs.
3. Failure means the model wants custom modeling code. The load is
   refused with an explanation naming the escape hatch.

`AIRLLM_ALLOW_REMOTE_CODE=true` overrides this. It defaults to `False`
and can only be moved by writing that exact string. When it is used, the
fact is reported in `/ready` as `remoteCodeUsed` and in every response,
so it appears in the audit log rather than happening silently.

---

## Fallback

Every failure ends in the same place: the Phase 29 deterministic
fallback, with the solver still reachable.

| Condition | Failure kind | HTTP |
|---|---|---|
| Connection refused, socket hangup | `AI_UNAVAILABLE` | - |
| Service up but `MODEL_LOADING` / `MODEL_ERROR` | `AI_UNAVAILABLE` | 503 |
| `fallbackUsed: true` with no decision | `AI_UNAVAILABLE` | 200 |
| Body is not JSON | `AI_PARSE_ERROR` | 200 |
| No `decision` field | `AI_INVALID_OUTPUT` | 200 |
| Decision outside the vocabulary | `AI_INVALID_OUTPUT` | 200 |
| Our timer fired | `AI_TIMEOUT` | - |
| Bad request shape | `AI_UNSUPPORTED_REQUEST` | 400 / 422 |

**A model failure is a `200` with `fallbackUsed: true`, not a 5xx.**
"I could not infer" is a legitimate answer to a scheduling question, and
returning it that way keeps the reason intact all the way into the Node
audit log instead of collapsing into a generic transport failure.

A load failure is terminal until the process restarts. Retrying a
multi-gigabyte load on every request would turn one clear diagnosis into
a stream of identical ones.

`plan()` has no input for which it raises. That is covered by a test
that feeds it nine malformed shapes.

---

## Timeout

Two deadlines, one variable:

- **Node** (`AI_REQUEST_TIMEOUT_MS`, default 30 s) uses
  `AbortController`, so an abandoned request releases its socket.
- **Python** (same variable, default 120 s when unset) runs generation
  on a daemon thread and stops waiting at the deadline.

The Python backstop exists for the case where the caller is not Node.
The daemon thread is a known cost: a genuinely stuck generation holds a
thread until it returns. It holds no lock, so the next request still
reaches the already-loaded model - the service degrades in latency, not
in availability.

A slow AirLLM is normal, not exceptional: it streams layers from disk,
so the first inference is far slower than later ones. Raise the timeout
on a CPU host.

---

## API contract

### `POST /plan`

Request - one field, and there is no field for anything else:

```json
{ "situationReport": { "...": "the Phase 29 report" } }
```

Response:

```json
{
  "decision": {
    "optimizationMode": "GLOBAL_ASSIGNMENT_BALANCED",
    "candidateCount": 5,
    "scoringWeights": { "WORKLOAD_BALANCE": 2.0, "...": 0 },
    "rationale": "...",
    "confidence": 0.8,
    "source": "airllm"
  },
  "rationale": "...",
  "provider": "airllm",
  "model": "<leaf name only>",
  "fallbackUsed": false,
  "validated": true,
  "corrections": [],
  "promptVersion": 1,
  "state": "MODEL_READY",
  "latencyMs": 0,
  "inferenceMs": 0,
  "decisionHash": "16 hex chars",
  "remoteCodeUsed": false
}
```

On failure the same shape returns with `fallbackUsed: true`,
`decision: null`, and an `error` string.

### `GET /health`

`200` whenever the process can answer, including with no model. Reports
`status`, `provider`, `modelLoaded`, `model`, and `runtime` (Python,
AirLLM, torch, transformers versions, platform, CUDA availability). No
paths, no secrets.

### `GET /ready`

`200` only for `MODEL_READY`; `503` for everything else. This is the
distinction the brief asks for: an open port is not readiness.

| State | Meaning |
|---|---|
| `SERVICE_RUNNING` | Process up, no model loaded yet |
| `MODEL_LOADING` | Load in progress |
| `MODEL_READY` | Loaded and usable |
| `MODEL_ERROR` | Load failed; `error` says why |

---

## Prompt contract

One template, one version, one place: `providers/strategy_prompt.txt`.
`PROMPT_VERSION = 1` travels in every response and lands in the Node
audit log, so a stored decision can be traced to the wording that
produced it. `AI_STRATEGY_PROMPT_VERSION` can relabel a fork without a
code change.

Three labelled sections, in order:

```
SYSTEM POLICY
    You are a scheduling strategy advisor. You do not create timetable
    slots. You do not assign individual teachers to individual periods.
    You cannot disable hard constraints. You can only select allowed
    optimization modes and bounded weights.

ALLOWED OUTPUT SCHEMA
    the exact JSON object, its required and optional fields, the typing
    rules, and the statement that an extra field causes rejection

BEGIN FACT DATA
   {the SituationReport, as JSON}
END FACT DATA
```

### Injection defence

Facts are serialized as JSON inside explicit delimiters, preceded by a
statement that the block is data and that instruction-like text inside
it must be treated as data.

The service does **not** sanitize the report. Mangling facts to defeat
injection would corrupt the very signal the model must read. The
defences that actually hold are structural:

1. The parser accepts only the seven known decision fields.
2. The schema rejects anything else outright.
3. Node validates again against an allow-list Python cannot widen.

Plus one implementation detail worth naming: template substitution is
**single-pass** (`re.sub` with a function). A sequential `replace` loop
would rescan text it had already inserted, so a subject literally named
`{{MODE_LIST}}` would have the mode list spliced into the data. There is
a test for exactly that.

### Allowed vocabulary

The prompt's vocabulary is read out of the report's `actionSpace` and
`dimensionAvailability`, which Node built from its own catalog. This
service carries no hardcoded copy, so it cannot widen the allow-list
and cannot drift when Node adds a mode. A report missing those sections
yields an **empty** policy - which fails closed.

### Output handling

The parser rejects prose before or after the JSON, invalid JSON, a bare
array/number/string/null, two or more code fences, and an unterminated
fence. It performs exactly one normalization: unwrapping a single fenced
code block whose contents must themselves be a complete JSON object.

There is no brace matching, no key-hunting regex, no trailing-comma
repair, no smart-quote unescaping. Each of those is a guess, and a guess
that succeeds is indistinguishable from a guess that does not. A parser
that "recovers" a decision from half a response will eventually recover
one from text that was never a decision. The value of accepting a
marginal response is one more AI run; the cost is a decision nobody can
explain.

### Weight bounds

This service does **not** clamp weight magnitudes. Bounds are Node's,
authoritatively. It validates types, finiteness, non-negativity, and
membership, and forwards numbers untouched for
`validateStrategyDecision` to bound. A weight on an *inactive* dimension
is dropped with a recorded correction, so `TRAVEL` and `TRANSFER` cannot
be activated by naming them.

---

## Real-data smoke test

Gated behind an explicit opt-in, outside the `npm test` glob:

```powershell
# skips. The glob form is portable; a bare directory path makes Node
# try to load it as a module on Windows.
node --test "tests/integration/airllm/*.test.js"

# runs
$env:AIRLLM_INTEGRATION = "1"
node --test "tests/integration/airllm/*.test.js"
```

| # | Test |
|---|---|
| 29 | Service reachable, reports `MODEL_READY` |
| 30 | `POST /plan` returns a valid `StrategyDecision` |
| 31 | The real `SchedulingInput` reaches the solver through the AI |
| 32 | The final candidate is hard-feasible |
| 60 | With the service **down**, the pipeline still produces a feasible schedule |

Test 60 is the important one. It points the provider at a closed port
and asserts `fallbackUsed === true`, that the solver still runs, and
that hard violations are `0`. That is the guarantee that AirLLM is
optional.

**Current status: not yet run.** The suite exists and is gated; it has
not been executed against a real model, because none is installed on the
development host. The last test does not need a model and should be run
as soon as one is available.

Test 31 is the influence check: it asserts the decision is visible in
the input the solver actually receives (`r.input.strategy.optimizationMode`
equals `r.decision.optimizationMode`), and that the original input is
untouched. A rationale the solver ignored would fail it.

---

## Determinism

Nothing in the Python service seeds or consumes a random number
generator. Any sampling lives inside the model and cannot reach the Node
solver's seeded RNG, so `solverSeed = 0xC0FFEE` produces the same
schedule whether the AI agreed with the default or not - covered by a
test.

Determinism is guaranteed by `StrategyValidator` + fallback + solver +
evaluator + scorer, **not** by the model. If AirLLM returns two
different valid decisions across runs, both are accepted. That is a
legitimate outcome, not a bug. The mock provider is what tests the
deterministic path.

---

## Test results

```
Node    (npm test)                          611 passed, 0 failed
          of which Phase 29                 572
                Phase 30                   39
Python  (pytest, no model required)         93 passed
AirLLM  integration suite                    skipped (opt-in, not run)
```

Node went 572 -> 611. The Node default suite requires no Python, no GPU,
and no model.

---

## Definition of done

```
[x] AirLLM provider implementation exists
[x] separate Python service
[x] Node AIPlanner contract unchanged
[x] mock provider unchanged
[x] local model configuration via env
[x] no model files in git
[x] model not auto-downloaded by tests
[x] /health
[x] /ready
[x] /plan
[x] structured output
[x] Python validation
[x] Node validation
[x] timeout
[x] unavailable fallback
[x] malformed-output fallback
[x] inactive dimensions protected
[x] hard constraints protected
[x] candidate count bounded
[x] weights bounded
[x] no raw schedule sent to AI
[x] no PII sent to AI
[x] no DB access from AI service
[x] solver seed independent
[x] fallback E2E test (written; not yet run against a live model)
[x] AirLLM integration test opt-in
[x] normal test suite does not require GPU
[x] documentation complete

[ ] real-data smoke test executed   <- needs a model on a real host
[ ] AirLLM version recorded         <- needs a real install
[ ] model recorded as tested        <- needs a real run
```

The last three are honestly unchecked. They require a host with AirLLM
installed and a checkpoint downloaded, which is a deployment step.
Everything that can be verified without a model is verified.

---

## Known limitations

1. **No model has been run.** The contract is proven; the integration
   is not. This is the main gap.
2. **The version-adaptive loader is unproven against a real AirLLM.** It
   inspects the installed signature and adapts, but no live install has
   exercised it. If a release's `from_pretrained` differs in shape from
   both the 3.x and 4.x forms, the load fails with a precise message
   naming the problem.
3. **An abandoned inference thread is not cancelled.** AirLLM offers no
   cancellation hook, so the deadline stops the *wait*, not the work.
4. **A load failure needs a process restart** (or a `reset()` from a
   REPL). Deliberate, but it is an operational sharp edge.
5. **The service is single-worker by design.** Several uvicorn workers
   would mean several copies of the weights in RAM.
6. **Output format compliance depends on the model.** A base
   (non-instruct) model will fail the parser often. That is a
   model-selection problem, not a service problem - but it presents as
   parser failures.
7. **No quality claim.** Phase 30 does not establish that AirLLM picks a
   better strategy than the deterministic default, and does not try to.
   That is a separate benchmarking phase. Two different valid decisions
   are a legitimate outcome.
8. **Not done, by design:** no fine-tuning, no training, no travel
   activation, no UI, no production deployment.
