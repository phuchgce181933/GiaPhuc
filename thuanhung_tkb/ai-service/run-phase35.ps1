# PHASE 35 — start the real AirLLM service on this host.
#
# Every value below is an EXISTING key from app/config.py. Nothing here
# invents an environment variable, and nothing here is required to
# import the package: the service still starts, and /health still
# answers, with none of them set.
#
#   .\run-phase35.ps1
#
# The four that matter:
#
#   AIRLLM_MODEL_PATH    a local directory with REAL weights. A
#                        tokenizer-only snapshot is refused by
#                        app/config.py before any load is attempted.
#   AIRLLM_DEVICE=cuda   requested explicitly so the service FAILS
#                        LOUDLY if torch cannot see a GPU, instead of
#                        silently running on CPU (app/runtime.py,
#                        _resolve_device).
#   AIRLLM_PRELOAD=1     load at startup so /ready is meaningful and the
#                        first /plan does not pay the load.
#   AIRLLM_MAX_NEW_TOKENS  a CAP, not a target, and it has to cover the
#                        PREAMBLE as well as the answer. Measured on
#                        this host at ~0.24 tokens/second, because
#                        AirLLM reloads every layer from disk for every
#                        token, so this is the single most expensive
#                        number in the file.
#
#                        200 was tried first and it FAILED, with a cause
#                        worth recording: the model wrote ~140 tokens
#                        of prose first, then opened a ```json fence and
#                        was cut off part-way through the object. The
#                        strict parser refused the truncated text --
#                        correctly, and without repairing it -- and the
#                        5-run benchmark recorded 0/5 valid decisions.
#                        The model was producing the right SHAPE; the
#                        budget was too small to hold it. 340 covers
#                        the observed preamble plus the ~120-token
#                        object with margin.
#   AI_REQUEST_TIMEOUT_MS  the deadline for ONE inference, honoured on
#                        both sides because Node and this service read
#                        the same key. It must be LARGER than the
#                        measured generation time, or every request is
#                        abandoned mid-answer and reported as a
#                        timeout rather than as the answer it was
#                        producing. 40 min against a ~24 min
#                        generation makes the deadline a backstop, not
#                        the thing that normally fires.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

$env:AIRLLM_CACHE_DIR        = Join-Path $here '.cache'
$env:AIRLLM_DEVICE           = 'cuda'
$env:AIRLLM_PRELOAD          = '1'
$env:AIRLLM_MAX_NEW_TOKENS   = '340'
$env:AI_REQUEST_TIMEOUT_MS   = '2400000'
$env:AI_SERVICE_LOG_LEVEL    = 'info'

# Optional first argument: the model directory, relative to `models/`.
# Defaults to the 0.5B checkpoint, which is the fastest way to prove
# load -> generate. A larger model is slower per token because AirLLM
# streams every layer from disk, so the checkpoint is a deliberate
# trade of speed for how well the output contract is followed.
if ($args.Count -ge 1) {
    $env:AIRLLM_MODEL_PATH = Join-Path $here "models\$($args[0])"
} else {
    $env:AIRLLM_MODEL_PATH = Join-Path $here 'models\qwen2.5-0.5b-instruct'
}

if (-not (Test-Path $env:AIRLLM_MODEL_PATH)) {
    throw "model directory not found: $($env:AIRLLM_MODEL_PATH)"
}

# Refuse to start on a checkpoint that has no weights. Phase 31.1 was
# blocked by a snapshot holding a config and a tokenizer and nothing
# else, and this is the cheapest possible place to catch that again.
$weightBytes = 0
Get-ChildItem $env:AIRLLM_MODEL_PATH -File |
    Where-Object { $_.Name -match '\.(safetensors|bin)$' } |
    ForEach-Object { $weightBytes += $_.Length }
if ($weightBytes -le 0) {
    throw "no weights (*.safetensors / *.bin) under $($env:AIRLLM_MODEL_PATH) -- this is a tokenizer-only snapshot, not a model"
}

Write-Host "model   = $($env:AIRLLM_MODEL_PATH)"
Write-Host "weights = $([math]::Round($weightBytes/1GB,2)) GiB"
Write-Host "device  = $($env:AIRLLM_DEVICE)"
& (Join-Path $here '.venv\Scripts\python.exe') -m app.main
