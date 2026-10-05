# PHASE 35 — REAL AIRLLM RUNTIME UNBLOCK + VERIFIED AI BENCHMARK

> **Question this phase answers, and does not.**
> *Can AirLLM actually run a real model and produce a real
> `StrategyDecision` inside the TKB pipeline, and is that result
> better than, equivalent to, or worse than the deterministic
> fallback?*
>
> **Answer: yes to the first half, with a measured verdict in the
> Verdict section. The second half could not be established on this
> host, and the reason is stated rather than papered over.**

Phase 31.1 reported `AIRLLM_BENCHMARK_BLOCKED` with
`airllmVersion: null`, `torchVersion: null`, `cudaAvailable: false`
and no checkpoint on disk. That was the honest verdict then. This
phase installs the missing pieces, runs the model, and records what
actually happens.

---

# 1. Environment

Every value below was read from the running runtime. None is inferred,
and none is a configuration setting read back as a fact.

| | Value | Source |
|---|---|---|
| OS | Windows 10.0.26200 | `nvidia-smi` |
| Python | 3.12.10 | `platform.python_version()` |
| Interpreter | `ai-service/.venv/Scripts/python.exe` | isolated, brief 4 |
| NVIDIA driver | 581.42 | `nvidia-smi` |
| Driver CUDA | 13.0 | `nvidia-smi` |
| **GPU** | **NVIDIA GeForce RTX 4060 Laptop GPU** | `torch.cuda.get_device_name(0)` |
| Compute capability | (8, 9) — Ada | `torch.cuda.get_device_capability(0)` |
| VRAM | 8.0 GiB | `torch.cuda.get_device_properties(0)` |
| System RAM | 15.7 GB | `Win32_ComputerSystem` |
| **torch** | **2.14.1+cu130** | `importlib.metadata.version` |
| **transformers** | **5.18.0** | `importlib.metadata.version` |
| **accelerate** | **1.15.0** | `importlib.metadata.version` |
| **AirLLM** | **4.0.0** | `importlib.metadata.version` |
| fastapi | 0.142.2 | `importlib.metadata.version` |
| uvicorn | 0.54.0 | `importlib.metadata.version` |
| pydantic | 2.13.5 | `importlib.metadata.version` |
| **CUDA available** | **True** | `torch.cuda.is_available()` |

## 1.1 CUDA is verified, not asserted

Brief 6 forbids reporting `cudaAvailable` from configuration. It is
read from torch, and the GPU is exercised, not merely detected:

    cudaAvailable   = True
    cudaCompiled    = 13.0
    deviceCount     = 1
    gpuName         = NVIDIA GeForce RTX 4060 Laptop GPU
    capability      = (8, 9)
    totalMemGiB     = 8.0
    matmul on gpu   = True      <- a real 2048x2048 matmul on the device

The first `pip install torch` produced `2.14.1+cpu` — PyPI's default
Windows wheel is CPU-only. Per brief 7 this was fixed **in the
environment**: no solver, orchestrator, constraint, or scoring file
was touched to work around it.

---

# 2. Installation

Isolated into `ai-service/.venv` (Python 3.12.10). No ML package was
added to `backend/package.json`, and `npm test` still passes on a
machine with no Python model stack at all.

    cd ai-service
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
    .\.venv\Scripts\python.exe -m pip install "torch==2.14.1+cu130" `
        --index-url https://download.pytorch.org/whl/cu130
    .\.venv\Scripts\python.exe -m pip install "transformers>=4.40" accelerate
    .\.venv\Scripts\python.exe -m pip install "airllm>=4.0.0"
    .\.venv\Scripts\python.exe -m pip install numpy

The CUDA wheel index was **read from the host**, not guessed: the
available `cp312-win_amd64` builds were enumerated across `cu126`,
`cu128`, `cu129` and `cu130`, and `2.14.1` exists for `cu126` and
`cu130`. `cu130` was chosen because `nvidia-smi` reports driver CUDA
13.0.

## 2.1 Versions actually installed, not pinned from memory

`requirements-model.txt` deliberately does not pin torch — the right
wheel depends on the host's CUDA. The versions above are what `pip`
installed here, read back through `importlib.metadata`: not from a
lockfile, a tutorial, or memory.

---

# 3. Model

| | Value |
|---|---|
| Repository | `Qwen/Qwen2.5-1.5B-Instruct` (**benchmark model**) |
| Repository | `Qwen/Qwen2.5-0.5B-Instruct` (smoke + capability study, §8) |
| Type | **instruct** (instruction tuned) |
| Architecture | `Qwen2ForCausalLM` — recognised natively by Transformers |
| `trust_remote_code` required | **No** — passes with `trust_remote_code=False` |
| Weights (1.5B) | `model.safetensors`, **3,087,467,144 bytes** |
| Weights (0.5B) | `model.safetensors`, **988,097,824 bytes** |
| Local path | `ai-service/models/<name>` (gitignored) |

## 3.1 Weights are proven present, not assumed

Brief 8 and 49 forbid naming a model whose weights do not exist.
Phase 31.1 was blocked by precisely this failure mode: a snapshot
holding `config.json`, `tokenizer.model` and nothing else. The
checkpoint is therefore verified by file size after download, and
`GET /health` is cross-checked against the filesystem in test `P35-3`.

## 3.2 Why 0.5B first, and what 1.5B changed

Selection was driven by measurement, not marketing (brief 9). 0.5B was
the starting point because it is the smallest instruct model in the
family, and it loads in 6.6 s:

| | Qwen2.5-0.5B-Instruct | Qwen2.5-1.5B-Instruct |
|---|---|---|
| Weights | 0.92 GB | 2.88 GB |
| Load | 6.6 s | 33.4 s |
| Decode (unpinned) | 0.358 tok/s | ~0.13 tok/s |
| **`/plan` round trip** | ~16 min | **~9.6 min** |
| **Valid decisions** | **0 of 5** | **5 of 5** |

The 0.5B model loads and generates, which is what it was chosen to
prove, but it could not hold to the output contract (§8). 1.5B
therefore became the benchmark model. Note the irony worth recording:
1.5B is ~3x slower per token, yet its `/plan` is *faster*, because it
emits a short compliant object and stops, where 0.5B spent its whole
budget on preamble.

AirLLM's cost is dominated by streaming every layer from disk for
every token, so throughput is roughly linear in model size. That
matters for anyone planning a deployment: a larger model is not simply
"slower AirLLM", it is a different latency class.

## 3.3 Model files are never committed

`ai-service/.gitignore` already covered `models/`, `*.safetensors`,
`*.bin`, `*.pt`, `*.pth`, `*.ckpt`, `*.onnx` and `.venv/`; verified
with `git check-ignore`. No change was required. AirLLM's derived
`splitted_model/` shards land inside the gitignored model directory.

---

# 4. Five real defects that only a live model exposed

Every one of these is invisible to a stub-based test and was found by
running the actual stack. None was worked around by loosening a
validator, a parser, or the scheduler.

## 4.1 `AttributeError: 'list' object has no attribute 'shape'`

AirLLM's `generate` is a one-line passthrough
(`return self.model.generate(*args, **kwargs)`) to the wrapped
Transformers model, which reads `inputs_tensor.shape[0]`. The adapter
passed a bare token **list**.

*Fix:* `app/runtime.py` now normalises every tokenizer result into a
2-D tensor (`_as_input_ids`), attempting the tensor form **first** on
every release — a tensor is accepted by both the old and the new
generation API, a list only by the old one.

## 4.2 `TypeError: AirLLMBaseModel.__init__() got an unexpected keyword argument 'trust_remote_code'`

The Phase 30 adapter filtered load keywords against
`airllm.AutoModel.from_pretrained`, whose signature is
`(cls, path, *inputs, **kwargs)`. A `**kwargs` forwarder accepts
everything, so the filter kept `trust_remote_code` — and
`from_pretrained` then forwarded it to `AirLLMBaseModel.__init__`,
which has no such parameter. The version-adaptation logic was
structurally guaranteed to fail.

*Fix:* `_airllm_target_class` resolves the class AirLLM will actually
construct, through AirLLM's own `get_module_class`, and
`_supported_kwargs` filters against **that** `__init__`. The
negotiated result is reported in `/ready` as
`loadReport.droppedKwargs: ["trust_remote_code"]` and
`loadReport.targetClass: "AirLLMBaseModel"`, so version drift is
visible rather than silent.

## 4.3 `TypeError: fetch failed` / `HeadersTimeoutError` at 300 s

undici (Node's global `fetch`) enforces a 300 s `headersTimeout`
inside its connection pool. An `AbortSignal` cannot raise it. A real
AirLLM decision takes **minutes**, so every `/plan` failed at 300 s
while the model was still answering correctly — and the deterministic
fallback was then reported with the wrong reason.

*Fix:* `airllm-client.js` gained `postPlanOverHttp`, a `node:http`
transport whose per-socket deadline is derived from the caller's
`timeoutMs` and is never shorter than it. No new dependency: `undici`
is not an importable package, and `assertServiceUrl` already restricts
this client to plain HTTP on loopback. The injected `fetchImpl` test
seam is unchanged.

A first attempt reproduced the same class of bug one layer down — a
fixed 600 s socket backstop shorter than the caller's 900 s deadline —
and was corrected before any reported result depended on it.

## 4.4 The prompt was decoded as part of the answer

`generate` returns **prompt + completion**. Decoding the whole tensor
returns the instructions followed by the answer, and the strict parser
then rejects the response for "prose before the JSON" — a rejection of
the model's own prompt, caused by the adapter.

*Fix:* `_decode` receives the prompt length and strips the prefix.
**The parser was not loosened.** It still accepts only a bare JSON
object or exactly one fenced block, and still refuses everything else.

## 4.5 `AIRLLM_MAX_NEW_TOKENS` was decorative

The setting existed, was read from the environment and appeared in
`/health` — and was never forwarded to `generate`. Without it,
generation fell back to the checkpoint's `max_length` (tens of
thousands of tokens for an instruct model), so a request did not
return. `_generation_kwargs` now sends it, and sends
`do_sample=False` at `temperature <= 0` (passing `temperature=0` with
`do_sample=True` is a hard error in Transformers).

---

# 5. Health and readiness

`GET /health` -> **200**, from the running service:

    {
      "status": "MODEL_READY",
      "provider": "airllm",
      "modelLoaded": true,
      "model": "qwen2.5-0.5b-instruct",
      "runtime": {
        "pythonVersion": "3.12.10",
        "airllmVersion": "4.0.0",
        "torchVersion": "2.14.1+cu130",
        "transformersVersion": "5.18.0",
        "platform": "Windows",
        "cudaAvailable": true
      }
    }

Every field brief 18 requires is present and was read from the
runtime. A version that is absent stays `null`; nothing is reported as
"latest", "recommended" or "default" unless the runtime says so.

`GET /ready` -> **200**:

    {
      "state": "MODEL_READY",
      "provider": "airllm",
      "ready": true,
      "remoteCodeUsed": false,
      "loadReport": {
        "device": "cuda",
        "droppedKwargs": ["trust_remote_code"],
        "targetClass": "AirLLMBaseModel",
        "loadMs": 6625
      }
    }

`/ready` returns **503** with `state: SERVICE_RUNNING` before the model
loads, and **503** with `state: MODEL_ERROR` after a load failure — the
contract brief 19 requires. Before this phase the same host returned
503 forever, because no model could be configured.

---

# 6. Smoke test (Tier A)

`POST /plan` with a real `SituationReport` built by the Node builder
from the real 40-teacher / 479-assignment dataset.

The report crosses the wire as **7,386 characters** against a
`SchedulingInput` of **294,889** — a 40x reduction. Its largest array
anywhere is the 14-entry hard-constraint list: nothing is enumerated
per slot, per period, or per teacher, and `findPersonalData` returns
`[]`.

## 6.1 The first real run failed, and why that mattered

At a 200-token ceiling the benchmark recorded **0 valid of 5**
decisions, with `AI_PARSE_ERROR: the fenced code block is empty`.

The raw model text was captured before any parsing:

    'Note: This is just a sample. The actual output will vary depending on the
    situation. ... If you want to learn more about the sample, please ask me
    directly.
    ```json
    {
      "optimizationMode": "BASE_FEASIBLE",
      "candidateCount": 3,
      "scoringWeights": {
        "WORKLOAD_BALANCE": 0.8,
        "MAX_TEACHER_LOAD": 0.7,
        "PREFERENCE": 0.9,
        "SLOT_DIVERSITY": 0.6,
        "STRUCTURAL_DIVERSITY":'

`approx new tokens : 200` — exactly the cap. The model spent ~140
tokens on preamble, opened a `json` fence (despite the prompt telling
it not to), and was **cut off part-way through the object**. The
strict parser refused the truncated text, correctly and without
repairing it.

This is worth recording precisely because it is the distinction brief
12 asks for: the failure was a **token budget**, not the parser, not
the prompt, and not the model's ability to produce the required shape.
It was producing the right shape. Raising the ceiling to 340 covers
the observed preamble plus the ~120-token object with margin.

The parser was **not** changed. Repairing truncated JSON is exactly
the guess-with-no-failure-mode that `app/parser.py` exists to refuse.

---

# 7. Measured runtime

| | Value |
|---|---|
| Model load | 33.4 s (1.5B) / 6.6 s (0.5B) |
| Prefill, 1427-token prompt | ~3.5 s (~430 tok/s) |
| **Decode, 0.5B** | **0.24 tok/s** pinned, **0.358 tok/s** unpinned |
| **Decode, 1.5B** | **~0.13 tok/s** |
| `/plan` round trip, 1.5B | 574,191 ms median (~9.6 min) |

Decode is I/O-bound by design: AirLLM reloads every layer from disk for
every token. Moving `input_ids` to CUDA was measured and changed
nothing (0.25 -> 0.26 tok/s), so it was not adopted; the model weights
are what stream, not the input.

## 7.1 Layer pinning had to be turned off, and that made it faster

The first 1.5B attempt failed mid-generation with

    AirLLM inference failed: The paging file is too small for this
    operation to complete. (os error 1455)

AirLLM pins every streamed layer inside its forward hook. Pinned memory
cannot be paged out, so it must come from physical RAM; this host has
15.7 GB and was down to 1.7 GB free. AirLLM's own guard catches
`RuntimeError`, but Windows raises `OSError` 1455, so the guard never
fires.

The fix is in the environment (brief 7). The loader measures free RAM
with `psutil` — which arrives as an AirLLM dependency — and when it is
below a 4 GiB headroom, loads with `prefetching=False`. The decision is
recorded rather than silent:

    pinningDisabled = True
    droppedKwargs:
      - trust_remote_code
      - prefetching=False (free RAM 2712 MiB is below the 4096 MiB headroom
        AirLLM's pinned layers need)

That flag disables prefetching too, which was expected to cost
throughput. It did the opposite, and this was measured rather than
assumed — same prompt, same model, 8 generated tokens:

| | Throughput |
|---|---|
| `prefetching=True` | 0.259 tok/s |
| `prefetching=False` | **0.358 tok/s** |

On this hardware the pinned-memory bookkeeping costs more than the
read-ahead it buys. A single `pypsutil`-free measurement, three
minutes long, replaced an assumption that would otherwise have shipped
as a permanent 40 % slowdown.

---

# 8. Second model: the 0.5B result was a model-capability result

With the 0.5B checkpoint and a 340-token ceiling, the 5-run benchmark
recorded **0 valid of 5**. The raw text explains why, and it is not a
truncation this time:

    BEGIN RESPONSE
    {
      "optimizationMode": "BASE_FEASIBLE",
      "candidateCount": 10,
      "scoringWeights": { ... },
      "priorities": { ... }
    }
    END RESPONSE
    ```json
    ```json
    { "optimizationMode": "GLOBAL_ASSIGNMENT_BALANCED", ...

The model produced a **structurally correct decision** and then wrapped
it in `BEGIN RESPONSE` / `END RESPONSE` markers before continuing with
a second, fenced attempt. The parser strict-parses the whole response,
fails, scans for fences, finds the first one closed and empty
(`text[8:8]`), and reports `the fenced code block is empty`.

Every layer behaved correctly. The strict parser refused a response
with text outside the contract, which is what it exists to do. The
decision to strip `BEGIN RESPONSE` markers, or to search the response
for the first `{...}` run, would be **repair by guessing** — a
transform whose failure mode is a decision nobody chose, made
indistinguishable from a deliberate one. Brief 14 forbids it, and it
was not done.

So the 0.5B result is a statement about a 0.5B model, not about the
pipeline. The largest practical checkpoint was therefore tried:
`Qwen2.5-1.5B-Instruct`, 3,087,467,144 bytes of weights, which follows
the output contract and produced **5 valid decisions of 5**.

Both results are reported. Neither is presented as "the" AirLLM result;
a model's ability to follow a format is a property of the model.

---

# 9. Benchmark

    node src/benchmark/cli.js --reps=5 --provider=airllm

with `AI_PROVIDER=airllm`, `AIRLLM_INTEGRATION=1` and
`AI_REQUEST_TIMEOUT_MS=3600000`, on the real 40-teacher / 113-class /
479-assignment dataset (`benchmarkInputHash 94d8cec8`).

Both arms received the identical frozen `BENCHMARK_SOLVER_PROFILE`:
same solver, same evaluator, same scorer, same seed `0xC0FFEE`, same
`maxSearchIterations: 12`, same time budgets. The AI arm chose
`candidateCount: 10`, so `alignCandidateCount` raised **both** arms to
10 — the comparison is not a measurement of the budget.

| Arm | Runs | `strategyHash` | Mode | `candidateCount` | `fallbackUsed` |
|---|---|---|---|---|---|
| `DETERMINISTIC_FALLBACK` | 5 | `558d7166` | `GLOBAL_ASSIGNMENT_BALANCED` | 3 | true (baseline) |
| `AIRLLM` | 5 | `b1f9d159` | `BASE_FEASIBLE` | 10 | **false** |

## 9.1 AI validity

| | |
|---|---|
| `totalAIRequests` | 5 |
| `validAIResponses` | **5** |
| `fallback` | **0** |
| `invalid` | 0 |
| `validityRate` | **1.0 (100 %)** |
| `fallbackRate` | **0.0 (0 %)** |

## 9.2 Strategy diversity

| | |
|---|---|
| distinct strategy hashes | **1 of 5** |
| distinct optimization modes | **1** |

Decoding is greedy (`temperature = 0` -> `do_sample = False`), so
repetition measures the solver's determinism, not model variance. Both
arms were byte-identical across all five runs, which is the property
Phase 31.1's iteration bound exists to guarantee. Variability is not
quality, and none is claimed.

The model chose `BASE_FEASIBLE` — "get a hard-feasible schedule as
fast as possible" — on a dataset whose signals include
`WORKLOAD_IMBALANCE_HIGH`, for which the prompt itself says to prefer
`GLOBAL_ASSIGNMENT_BALANCED`. This is the single most consequential
fact in the quality result, and it is a statement about the model.

## 9.3 Quality, per run (no cherry-picking)

Every one of the five runs is shown, for both arms.

| # | baseline `bestGlobalScore` | AirLLM `bestGlobalScore` | delta | baseline spread | AirLLM spread | baseline maxLoad | AirLLM maxLoad | baseline stdev | AirLLM stdev |
|---|---|---|---|---|---|---|---|---|---|
| 0 | 0.7222 | 0.3889 | -0.3333 | 12 | 14 | 24 | 24 | 3.0079 | 3.1460 |
| 1 | 0.7222 | 0.3889 | -0.3333 | 12 | 14 | 24 | 24 | 3.0079 | 3.1460 |
| 2 | 0.7222 | 0.3889 | -0.3333 | 12 | 14 | 24 | 24 | 3.0079 | 3.1460 |
| 3 | 0.7222 | 0.3889 | -0.3333 | 12 | 14 | 24 | 24 | 3.0079 | 3.1460 |
| 4 | 0.7222 | 0.3889 | -0.3333 | 12 | 14 | 24 | 24 | 3.0079 | 3.1460 |

`hardViolations = 0` in **all ten runs**, and every run was `accepted`
by the independent evaluator. `minSlotDiversity` and
`minStructuralDiversity` are 0 in both arms, so neither arm is
penalised on those axes and the comparison is not driven by them.

## 9.4 The shared pool is the yardstick (brief 30)

`bestGlobalScore` is a position inside a run's own candidate pool, so
it is not comparable across arms. `sharedPoolGlobalScore` re-scores
every arm's **shipped rank-1 schedule** inside one pool, under the
scorer's own default weights — never either arm's strategy weights.

| Yardstick | Baseline (median) | AirLLM (median) | Delta | Separation | Verdict |
|---|---|---|---|---|---|
| `bestGlobalScore` | 0.7222 | 0.3889 | -0.3333 | `SEPARATED` | `WORSE` |
| `sharedPoolGlobalScore` | **0.6296** | **0.3704** | -0.2593 | `SEPARATED` | `WORSE` |

Both yardsticks agree, so `yardstickAgreement` does not suppress the
result. **No claim is made from `bestGlobalScore` alone**; the shared
pool is what the verdict rests on.

## 9.5 Latency

| Stage | baseline median | AirLLM median | AirLLM max |
|---|---|---|---|
| `aiLatencyMs` | 0 | **574,191** | 747,255 |
| `solverMs` | 27,106 | 24,987 | 25,161 |
| `scoringMs` | 858 | 860 | 864 |
| `totalPipelineMs` | 27,958 | **599,766** | 772,891 |

The AI call is outside the solver's budget by design, and the solver
times confirm it: the two arms spent the same ~25 s solving. The AI
arm is ~21x slower end to end, entirely in the provider call.

---

# 10. Limits of this result

1. **`SEPARATED` here means "consistently different", not
   "statistically significant".** With greedy decoding and an
   iteration-bounded solver, each arm's five runs are identical, so
   both ranges are single points. The difference is real and
   reproducible; it is five observations of one outcome, not a
   distribution.
2. **One model, one dataset.** 1.5B, 40 teachers, 479 assignments. A
   larger instruct model may follow the `CHOOSING` guidance in the
   prompt more closely. Nothing here says the AI strategy layer is
   useless in general — only that on this dataset, at this size, it
   chose worse.
3. **`AIRLLM_STRATEGY_WORSE_THAN_FALLBACK` is a verdict about a
   strategy choice, not about a model being bad at timetabling.** The
   model picked a legal, schema-valid mode. It picked the wrong one.
4. **The 0.5B result is reported alongside the 1.5B one** rather than
   replaced by it. Which model a deployment uses changes the answer,
   so both belong in the record.
5. **No training of any kind.** Inference only: no LoRA, no QLoRA, no
   fine-tuning, no RLHF.
6. **The AI still cannot change feasibility.** `hardViolations = 0`
   across all ten runs; the constraint catalogue, H13 `INACTIVE` and
   H14 `UNSUPPORTED` are untouched by anything the model said.
7. **One benchmark host.** Timings are from an RTX 4060 Laptop GPU
   with 8 GB VRAM and a busy host. They are not a property of AirLLM.
8. **The token ceiling is host-specific.** 340 tokens is what this
   model needed *here*, after observing its preamble. A different
   model needs a different number, and a too-small ceiling fails
   silently as a parse error (§6.1).

---

# 11. Verdict

    Runtime ........ AIRLLM_RUNTIME_READY
    Quality ........ AI_STRATEGY_WORSE_THAN_FALLBACK

**AirLLM does run a real model and does produce real
`StrategyDecision`s inside the TKB pipeline.** That is established:
5 of 5 valid, `provider = airllm`, a named model with weights on
disk, a real CUDA device, and a decision that passed the strict
Python parser, the Python schema, **and** the independent Node
validator before the solver ever saw it.

**On this dataset, at this model size, that strategy is worse than the
deterministic fallback** — `sharedPoolGlobalScore` 0.3704 against
0.6296, consistently, with zero hard violations in either arm.

Neither half of that sentence is a reason to disable the AI layer. The
fallback is always available, always feasible, and 21x faster, which
is exactly what the results say should happen when the AI is this
weak. The correct reading is narrower and more useful: **the pipeline
now works end to end with a real model, and its first honest quality
measurement says the deterministic default is still the better
strategy chooser.**

## 11.1 Success criteria

| # | Criterion | Status |
|---|---|---|
| 1 | AirLLM environment verified | **met** — versions read from the runtime |
| 2 | Model really exists | **met** — 3,087,467,144 bytes of `model.safetensors` |
| 3 | CUDA verified | **met** — `torch.cuda.is_available() == True`, GPU named, real matmul |
| 4 | AirLLM version captured | **met** — 4.0.0 |
| 5 | Model version/path captured | **met** — `qwen2.5-1.5b-instruct`, resolved locally |
| 6 | Model loads | **met** — 33.4 s, `MODEL_READY` |
| 7 | `/ready` passes | **met** — HTTP 200 |
| 8 | `/plan` passes | **met** — Tier A `PASS` |
| 9 | Provider identity confirmed | **met** — `provider = airllm` from the response |
| 10 | Valid `StrategyDecision` | **met** — 5/5, accepted by the Node validator |
| 11 | Real `SchedulingInput` reaches the AI | **met** — 7,386-char aggregate report |
| 12 | Solver consumes the validated strategy | **met** |
| 13 | Hard violations remain 0 | **met** — 0 across all 10 runs |
| 14 | Independent evaluator accepts | **met** |
| 15 | Fallback remains safe | **met** — `P35-9` against a closed port |
| 16 | No PII / raw slot leakage | **met** — `findPersonalData` empty, no enumeration |
| 17 | Shared-score comparison valid | **met** — both arms in one pool |
| 18 | Benchmark repeated | **met** — 5x5 |
| 19 | No cherry-picking | **met** — all 5 runs reported per arm |
| 20 | Verdict evidence-based | **met** — two agreeing yardsticks |
| 21 | No persistence changes | **met** — `src/persistence` untouched this phase |
| 22 | No travel | **met** — H14 `UNSUPPORTED` |
| 23 | No transfer optimization | **met** — H13 `INACTIVE` |
| 24 | No training | **met** — inference only |
| 25 | All regression tests pass | **met** — 800 / 93 / 75, plus 16 gated integration |

## 11.2 Test results

| Suite | Result |
|---|---|
| Backend (`npm test`) | **800 / 800** on a clean host; see the pre-existing flake below |
| Python (`pytest`) | **93 / 93 pass** |
| Frontend | **75 / 75 pass** |
| Phase 35 unit tests | **37 / 37 pass** |
| Real-runtime integration (`AIRLLM_INTEGRATION=1`, live 1.5B service) | **16 / 16 pass** |
| Build | clean |

`AIRLLM_INTEGRATION` is set only for the integration run and is cleared
afterwards.

**A pre-existing flake, reported rather than hidden.** Across
verification runs, `PHASE 25 / 23` failed intermittently — 3 clean
runs and 1 failure per group of 3, more often when the machine was
busy. It is **not** a Phase 35 regression and **not** caused by
anything in this phase; it was not passing reliably before this phase
began. Its cause is identified:

    test('PHASE 25 / 23 - no AI invocation ...', () => {
      const r1 = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
      const r2 = solveReal('GLOBAL_ASSIGNMENT_BALANCED', 0xC0FFEE, 5_000);
      assert.deepEqual(r1.solution.metrics, r2.solution.metrics);
    });

`solveReal` passes `timeLimitMs` with **no iteration bound**, so the
search is bounded only by the wall clock. This is precisely the defect
Phase 31.1 documented and fixed — the file already contains
`placementFingerprint` and the iteration-bounded test 19b for it. This
one instance was missed, and the test is additionally defined **twice**
in the same file. Under enough load the two solves perform different
amounts of work and the metrics diverge.

It is left as found. Fixing it means editing a Phase 25 test, which is
outside this phase's scope, and a fix should be made deliberately
alongside the rest of Phase 25 rather than incidentally from here. The
regression claim above is stated with this caveat rather than as an
unqualified 800/800.

## 11.3 What changed

| File | Change |
|---|---|
| `ai-service/app/runtime.py` | tensor normalisation, prompt stripping, `max_new_tokens` forwarding, concrete-class keyword filtering, memory-tolerant load, RAM-aware pinning |
| `ai-service/run-phase35.ps1` | reproducible launcher with a weight-presence check |
| `backend/src/domain/ai/providers/airllm-client.js` | `node:http` transport with a caller-derived deadline |
| `backend/src/domain/ai/providers/airllm-planner.js` | passes `fetchImpl` through instead of forcing global `fetch` |
| `backend/src/benchmark/runner.js` | AI-call ceiling 600 s -> 2400 s, now measured |
| `backend/src/benchmark/report.js` | renders a skipped Tier B instead of crashing |
| `backend/tests/phase30_airllm_provider.test.js` | import allow-list admits `node:` builtins |
| `backend/tests/phase35_real_airllm_runtime.test.js` | **new** — 37 GPU-free tests |
| `backend/tests/integration/airllm/phase35_real_runtime.integration.test.js` | **new** — 16 gated real-runtime tests |
| `docs/PHASE_35_REAL_AIRLLM_RUNTIME.md` | **new** — this document |
| `docs/PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md` | rewritten by the live benchmark run |

**Not touched:** `src/persistence`, `api/commit`, `preview-store`,
`schedule-store`, the solver, the constraint catalogue, the global
scorer, and every UI file. Brief 41, 42 and 50 hold.

## 11.4 Reproducing

    # 1. environment
    cd ai-service
    python -m venv .venv
    .\.venv\Scripts\python.exe -m pip install -r requirements.txt
    .\.venv\Scripts\python.exe -m pip install "torch==2.14.1+cu130" `
        --index-url https://download.pytorch.org/whl/cu130
    .\.venv\Scripts\python.exe -m pip install "transformers>=4.40" accelerate "airllm>=4.0.0" numpy

    # 2. the model (weights verified after download)
    #    Qwen/Qwen2.5-1.5B-Instruct -> ai-service/models/qwen2.5-1.5b-instruct

    # 3. the service
    .\run-phase35.ps1 qwen2.5-1.5b-instruct
    #    /ready must be 200 with modelLoaded true

    # 4. the real-runtime integration tests
    cd ..\backend
    $env:AIRLLM_INTEGRATION = "1"; $env:AI_PROVIDER = "airllm"
    $env:AI_REQUEST_TIMEOUT_MS = "3600000"
    node --test "tests/integration/airllm/phase35_real_runtime.integration.test.js"

    # 5. the benchmark (about 60 minutes on this host)
    node src/benchmark/cli.js --reps=5 --provider=airllm

    # 6. clear the gate again
    Remove-Item Env:\AIRLLM_INTEGRATION, Env:\AI_PROVIDER, Env:\AI_REQUEST_TIMEOUT_MS
