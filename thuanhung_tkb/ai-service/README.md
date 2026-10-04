# ai-service — local AirLLM inference

The Python side of the Phase 30 AI strategy provider. It owns AirLLM,
torch, and the model weights. The Node backend reaches it over HTTP on
loopback and never imports it.

```
Node backend ──POST /plan──▶ ai-service (Python, AirLLM)
            ◀─{decision}───
```

The only thing that crosses the wire is a Phase 29 `SituationReport`:
aggregate facts, no personal data, no schedule slots. The only thing
that comes back is a `StrategyDecision`. This service has no database
client, no solver, and no code path that can produce a timetable slot.

**It is optional.** With it stopped, the backend falls back to the
deterministic strategy and the scheduler works exactly as it did in
Phase 29. Nothing in the default test suite requires it.

---

## 1. Requirements

| | |
|---|---|
| Python | 3.11 or newer (developed and tested on 3.12) |
| RAM | ~16 GB for a small model on CPU; more for larger ones |
| GPU | Optional. Without one, set `AIRLLM_DEVICE=cpu` and expect slow inference |
| Disk | Whatever the model weights need — 5 GB for a ~3B model at 4-bit |

No GPU is required. CPU inference works; it is simply slower, which is
why `AI_REQUEST_TIMEOUT_MS` matters on a CPU host.

## 2. Install

Run everything inside a virtualenv. Installing torch outside one is a
common way to end up with two incompatible copies.

```powershell
cd ai-service

python -m venv .venv
.\.venv\Scripts\Activate.ps1        # macOS/Linux: source .venv/bin/activate

pip install -r requirements.txt
```

`requirements.txt` is small on purpose — FastAPI, uvicorn, pydantic,
and the two test tools. It does **not** include torch, transformers, or
airllm, because installing torch is a multi-gigabyte operation whose
correct wheel depends on your CUDA version, and pinning it here would
override that choice. The service imports none of them eagerly, so the
test suite runs without them.

If you intend to actually run inference, install the model stack:

```powershell
# torch first, matched to your CUDA version: https://pytorch.org
pip install torch --index-url https://download.pytorch.org/whl/cu124   # or /cpu

pip install -r requirements-model.txt
```

## 3. Choose a model

Start small. The purpose of Phase 30 is to prove that AirLLM can
produce a *valid* strategy decision, not that a large model produces a
*good* one. A small instruct model is enough, and it loads in seconds.

Requirements for the model:

- An **instruct/chat** tuned variant. A base model does not follow the
  output-format instruction reliably, and you will spend the phase
  debugging formatting instead of the contract.
- An architecture **Transformers recognises natively** — the vast
  majority of modern models qualify. See §6.
- Small to medium. A 70B or 125B model on CPU is not a smoke test, it
  is an overnight job.

Download it once, ahead of time, and point `AIRLLM_MODEL_PATH` at the
directory. Nothing in this service downloads weights at runtime.

```powershell
# Example. Adjust the repo and size to what you actually want to test.
huggingface-cli download Qwen/Qwen2.5-1.5B-Instruct --local-dir D:\models\qwen2.5-1.5b-instruct
```

## 4. Configure

Every setting is an environment variable. There is nothing to edit in
the code, and no model path is hard-coded anywhere.

| Variable | Default | Meaning |
|---|---|---|
| `AIRLLM_MODEL_PATH` | — | Local model directory. **Preferred**: it cannot trigger a download |
| `AIRLLM_MODEL_ID` | — | Hugging Face repo id. Explicit opt-in only; may fetch |
| `AIRLLM_CACHE_DIR` | — | Cache root. Point it outside the repo |
| `AIRLLM_DEVICE` | auto | `cpu`, `cuda`, `cuda:1`. Never hard-coded |
| `AIRLLM_DTYPE` | auto | e.g. `float16`, `bfloat16` |
| `AIRLLM_SERVICE_HOST` | `127.0.0.1` | Bind address. A non-loopback value is refused |
| `AIRLLM_SERVICE_PORT` | `8077` | Bind port |
| `AIRLLM_SERVICE_TOKEN` | — | Optional bearer secret required on `/plan` |
| `AIRLLM_ALLOW_REMOTE_CODE` | `false` | Opt in to executing model-repository code. See §6 |
| `AIRLLM_MAX_NEW_TOKENS` | `512` | Generation ceiling |
| `AIRLLM_TEMPERATURE` | `0.0` | Sampling temperature. 0 is the reproducible choice |
| `AIRLLM_PRELOAD` | `false` | Load at startup instead of on first request |
| `AI_REQUEST_TIMEOUT_MS` | `120000` | Inference deadline, shared with the Node client |
| `AI_STRATEGY_PROMPT_VERSION` | `1` | Prompt contract version label |

A minimal working setup:

```powershell
$env:AIRLLM_MODEL_PATH = "D:\models\qwen2.5-1.5b-instruct"
$env:AIRLLM_DEVICE     = "cpu"
$env:AIRLLM_CACHE_DIR  = "D:\hf-cache"
$env:AI_REQUEST_TIMEOUT_MS = "300000"
```

### No secrets

`.env` here holds local runtime configuration only. `AIRLLM_SERVICE_TOKEN`
is the one secret, it is never committed (see `.gitignore`), and it is
never logged or returned: `/health` reports `authRequired: true` and
nothing more. The model is identified by its directory's leaf name, so a
path containing a user or machine name does not leak.

## 5. Run

```powershell
python -m app.main
```

Then check it, in this order. The distinction matters: an open port is
not readiness, and readiness is not "the model is loaded".

```powershell
curl http://127.0.0.1:8077/health
# {"status":"SERVICE_RUNNING","provider":"airllm","modelLoaded":false, ...}

curl -i http://127.0.0.1:8077/ready
# HTTP/1.1 503 ... {"state":"SERVICE_RUNNING","ready":false}

# after the first /plan, or with AIRLLM_PRELOAD=1:
curl http://127.0.0.1:8077/ready
# HTTP/1.1 200 ... {"state":"MODEL_READY","ready":true}
```

Then point the Node backend at it and ask for a plan:

```powershell
$env:AI_PROVIDER = "airllm"
$env:AIRLLM_SERVICE_URL = "http://127.0.0.1:8077"
npm start
```

The four states you will see on `/ready`:

| State | Meaning | `/plan` behaviour |
|---|---|---|
| `SERVICE_RUNNING` | Process up, no model loaded yet | Loads the model, then infers |
| `MODEL_LOADING` | Load in progress | Falls back while loading |
| `MODEL_READY` | Loaded and usable | Returns a decision |
| `MODEL_ERROR` | Load failed; see `error` | Falls back with that reason |

A load failure is terminal until the process is restarted. That is
deliberate: retrying a failed load on every request would turn one clear
diagnosis into a stream of identical ones.

## 6. Remote model code

By default this service **will not execute code from a model
repository.**

This check has to exist because AirLLM cannot make the promise itself:
`AutoModel.get_module_class` resolves the model config with
`trust_remote_code=True` unconditionally, with no keyword to turn it
off. So the check happens in `app/runtime.py` *before* AirLLM sees the
model:

1. Read the config with `AutoConfig` and `trust_remote_code=False`.
2. Success means Transformers recognises the architecture natively, so
   no repository code is needed and none runs.
3. Failure means the model wants custom modeling code. The load is
   refused with an explanation.

To override, set `AIRLLM_ALLOW_REMOTE_CODE=true` by hand. The decision
is recorded in `/ready` as `remoteCodeUsed` and in every response, so
it is visible in the audit log rather than silent.

## 7. Tests

The default suite needs **no model, no GPU, and no `airllm` package**.
It drives the real FastAPI app with a stub generator, so the routes,
the prompt, the parser, and the schema are all covered for real.

```powershell
python -m pytest tests
# 93 passed
```

That works because every `import airllm` / `import torch` /
`import transformers` in this project lives inside a function in
`app/runtime.py`. `app/main.py` imports cleanly on a machine that has
none of them installed.

The real-model tests are in the Node suite and are opt-in:

```powershell
# from the backend directory. The glob form is the portable one: a bare
# directory path makes Node try to LOAD it as a module on Windows.
node --test "tests/integration/airllm/*.test.js"                # skips
$env:AIRLLM_INTEGRATION = "1"
node --test "tests/integration/airllm/*.test.js"                # runs
```

They are outside `npm test`'s `tests/*.test.js` glob, so they cannot
fail a default run even with no service listening.

The last test in that file — service deliberately down, pipeline still
produces a feasible schedule — needs **no model and no GPU**. It is
still behind the flag because it runs the real solver on the real
479-assignment input, which takes minutes. Run it first whenever you
invoke the suite; it is the test that proves AirLLM is optional.

## 8. Layout

```
ai-service/
├── app/
│   ├── config.py      env -> ServiceConfig; collects errors, never raises
│   ├── schema.py      the decision contract; vocabulary read from the report
│   ├── prompt.py      versioned template rendering
│   ├── parser.py      strict text -> JSON object
│   ├── runtime.py     model load, device, remote-code check, state
│   ├── service.py     prompt -> infer -> parse -> validate -> response
│   └── main.py        FastAPI: /health, /ready, /plan
├── providers/
│   └── strategy_prompt.txt    the one and only prompt template
├── tests/
└── requirements.txt
```

The dependency direction is one-way: `main → service → {prompt,
parser, schema, runtime} → config`. `runtime.py` is the only module
that knows a model exists.

## 9. Troubleshooting

**`/ready` says `MODEL_ERROR` with "airllm is not installed"**
`pip install -r requirements-model.txt` inside the virtualenv you
actually started the service from. Check `sys.executable` in the
message — a global-interpreter mismatch is the usual cause.

**`MODEL_ERROR` mentions `trust_remote_code`**
The model's architecture is not one Transformers recognises natively.
Pick a different model, or set `AIRLLM_ALLOW_REMOTE_CODE=true` if you
accept running code from that repository.

**`MODEL_ERROR` mentions CUDA**
`AIRLLM_DEVICE` requests a GPU that torch cannot see. Install a
CUDA-enabled torch build, or set `AIRLLM_DEVICE=cpu`.

**`/plan` always falls back with a timeout**
AirLLM streams layers from disk, so the first inference is far slower
than later ones. Raise `AI_REQUEST_TIMEOUT_MS` and warm the model with
one call before relying on it. On CPU, expect minutes rather than
seconds.

**`/plan` falls back with "not valid JSON"**
The model did not follow the output format. Confirm you are using an
instruct-tuned model; a base model usually produces prose instead. The
parser deliberately does not attempt to rescue malformed output — that
is the fallback's job, and a parser that guesses would eventually guess
something that was never a decision.

**Node reports `AI_UNAVAILABLE` immediately**
Check `curl http://127.0.0.1:8077/health` from the same machine. A
non-loopback `AIRLLM_SERVICE_URL` is refused by the client by design.

## 10. What this service deliberately does not do

- No database access. Data flows Node → report → Python → decision → Node.
- No schedule generation. It cannot emit a day, period, session, slot,
  or teacher id; the decision schema has no such field and unknown
  fields are rejected.
- No training or fine-tuning. Inference only.
- No public exposure. The bind address is validated as loopback at
  startup and cannot be overridden without an error.
- No weight clamping. Weight bounds belong to the Node
  `StrategyValidator`, which is the authority. This service validates
  types and membership and forwards magnitudes untouched.
- No outbound HTTP. If you see a download, it came from a model
  repository at load time, not from this code.
