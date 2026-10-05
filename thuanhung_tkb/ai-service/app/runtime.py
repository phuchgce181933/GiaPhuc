"""PHASE 30 -- MODEL LIFECYCLE.

Owns AirLLM, torch, the model weights, and the model cache. Nothing
else in this service imports a machine-learning library, which is what
lets the package import cleanly and the test suite run on a machine
with no GPU and no model installed (brief 45).

IMPORT DISCIPLINE
-----------------
Every ``import airllm`` / ``import torch`` / ``import transformers`` in
this project lives in this file, inside a function. Consequences:

  * ``import app.main`` succeeds on a machine with none of them, so
    ``/health`` can start and answer "MODEL_ERROR: airllm is not
    installed" instead of the process dying at startup and taking the
    port with it (brief 11, 13).
  * ``pip install -r requirements.txt`` is a deployment step, not a
    precondition for running the tests (brief 39, 45).

LIFECYCLE (brief 9)
-------------------
One load, reused for every request. The model is loaded on the first
``/plan`` that needs it (or at startup when ``AIRLLM_PRELOAD=1``) and
kept. There is no code path that loads, infers, and unloads per
request, because loading dominates the cost of AirLLM by orders of
magnitude and doing it per request would make the service useless.

A ``threading.Lock`` serializes the first load. Concurrent first
requests block rather than each constructing their own copy of the
weights, which would exhaust memory rather than merely be slow.

REMOTE CODE (brief 8)
---------------------
AirLLM cannot enforce this itself: its ``AutoModel.get_module_class``
resolves the config with ``trust_remote_code=True`` unconditionally,
with no keyword to turn that off. So the check is done HERE, before
AirLLM is ever asked to load anything:

  1. Read the model config with ``AutoConfig`` and
     ``trust_remote_code=False``.
  2. If that succeeds, the architecture is one Transformers recognises
     natively. No repository code can run, because none is needed.
  3. If it fails, the model wants remote code. Refuse, and say so.
     Only when ``AIRLLM_ALLOW_REMOTE_CODE=true`` was set by hand does
     the load proceed -- and then it is recorded in the audit metadata
     so the operator can see it happened (brief 35).

The default is ``False`` in :mod:`app.config` and can only be moved by
writing the literal string ``"true"``.

VERSION-ADAPTIVE LOADING (brief 7)
----------------------------------
AirLLM's ``from_pretrained`` signature has changed across releases, so
the adapter passes only the keyword arguments the installed callable
actually accepts, discovered by :func:`inspect.signature`. A keyword
that does not exist in the installed version is dropped rather than
raising ``TypeError`` -- and the dropped keywords are reported, so a
mismatch is visible in the log instead of silent. This is why the
project does not copy a snippet from a tutorial: a tutorial is pinned
to one release, and a snippet that breaks on upgrade would take the
service down at load time, which is the exact moment an operator is
least able to debug it.
"""

from __future__ import annotations

import importlib
import importlib.metadata
import inspect
import os
import platform
import sys
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Protocol

from .config import ServiceConfig

# ============================================================================
# States (brief 11)
# ============================================================================

STATE_SERVICE_RUNNING = "SERVICE_RUNNING"
STATE_MODEL_LOADING = "MODEL_LOADING"
STATE_MODEL_READY = "MODEL_READY"
STATE_MODEL_ERROR = "MODEL_ERROR"

ALL_STATES = (STATE_SERVICE_RUNNING, STATE_MODEL_LOADING, STATE_MODEL_READY, STATE_MODEL_ERROR)


class ModelError(RuntimeError):
    """The model cannot be loaded or used. Always terminal until reset."""


# ============================================================================
# Generator seam
# ============================================================================


class TextGenerator(Protocol):
    """What :class:`ModelRuntime` needs from whatever runs inference.

    Kept as a Protocol so tests can supply a stub that returns fixed
    text, which is how the prompt, parser, and schema are all
    exercised without a model, a GPU, or AirLLM (brief 45).
    """

    def generate(self, prompt: str) -> str:
        """Return the model's raw completion text for ``prompt``."""


# ============================================================================
# Version reporting (brief 40)
# ============================================================================


def _dist_version(name: str) -> Optional[str]:
    """Installed version of ``name``, or ``None`` if not installed.

    Uses distribution metadata rather than ``module.__version__`` so
    it works for packages that do not set one, and it never imports
    the package -- asking what version torch is must not be what pulls
    torch in.
    """
    try:
        return importlib.metadata.version(name)
    except importlib.metadata.PackageNotFoundError:
        return None
    except Exception:  # pragma: no cover - defensive
        return None


def runtime_info() -> dict[str, Any]:
    """Safe runtime metadata for ``/health``.

    Versions, the interpreter, and whether CUDA is available. No
    paths, no device count, no environment dump (brief 40, 36).
    """
    return {
        "pythonVersion": platform.python_version(),
        "pythonImplementation": platform.python_implementation(),
        "airllmVersion": _dist_version("airllm"),
        "torchVersion": _dist_version("torch"),
        "transformersVersion": _dist_version("transformers"),
        "fastapiVersion": _dist_version("fastapi"),
        "platform": platform.system(),
        "cudaAvailable": _cuda_available(),
    }


def _cuda_available() -> bool:
    """Whether torch reports a usable CUDA device.

    Imports torch, so it is called only from paths that already accept
    a heavy import. Returns ``False`` rather than raising when torch
    is absent, because "no CUDA" and "no torch" both mean the same
    thing to a readiness check.
    """
    try:
        torch = importlib.import_module("torch")
    except Exception:
        return False
    try:
        return bool(torch.cuda.is_available())
    except Exception:  # pragma: no cover - driver-level failure
        return False


# ============================================================================
# AirLLM adapter
# ============================================================================


@dataclass
class LoadReport:
    """What actually happened during a load, for the audit log."""

    remote_code_used: bool = False
    dropped_kwargs: list = field(default_factory=list)
    device: Optional[str] = None
    load_ms: int = 0
    #: The AirLLM class that was actually constructed, e.g.
    #: ``AirLLMBaseModel``. Read back from the package rather than
    #: assumed, so a report cannot name a class that was not built.
    target_class: Optional[str] = None
    #: PHASE 35. True when the first load attempt failed on memory and
    #: the retry ran with AirLLM's layer pinning disabled. Pinned
    #: memory cannot be paged out, so it is taken from physical RAM;
    #: a host with little free RAM fails there rather than on commit.
    #: Pageable layers copy more slowly, and this flag is how that cost
    #: stays visible instead of being silently absorbed.
    pinning_disabled: bool = False


class AirLLMGenerator:
    """Adapts ``airllm.AutoModel`` to the :class:`TextGenerator` seam.

    Constructed only after the architecture check has passed, so the
    model is guaranteed to be one Transformers recognises natively
    (unless remote code was explicitly opted into).
    """

    def __init__(self, model: Any, tokenizer: Any, config: ServiceConfig, report: LoadReport) -> None:
        self._model = model
        self._tokenizer = tokenizer
        self._config = config
        self._report = report

    def generate(self, prompt: str) -> str:
        """Run one completion and return raw text.

        AirLLM's tokenizer API has also moved between releases, so the
        encoding call is signature-checked the same way the loader is.
        If a release exposes none of the shapes handled here, the
        failure is reported as a :class:`ModelError` naming the class
        that was found -- a precise, actionable message instead of an
        ``AttributeError`` from inside a library.
        """
        if self._tokenizer is None:
            raise ModelError("no tokenizer is available, so a prompt cannot be encoded")

        try:
            encoded = _encode(self._tokenizer, prompt)
        except ModelError:
            raise
        except Exception as exc:
            raise ModelError(f"the tokenizer could not encode the prompt: {exc}") from exc

        try:
            return self._run(encoded)
        except ModelError:
            raise
        except Exception as exc:
            # PHASE 35. A real model failed in a real library, and
            # `str(exc)` alone said only WHERE the symptom showed up
            # ("Tensor on device cuda:0 is not on the expected device
            # meta!"), never which frame raised it. Diagnosis of a
            # layer-streaming kernel under a mismatched transformers
            # release is impossible from a one-line message, so the
            # traceback goes to stderr alongside uvicorn's own
            # diagnostics. The prompt is NOT logged: it is derived
            # from the dataset, and stderr is not a place for that.
            traceback.print_exc()
            raise ModelError(f"AirLLM inference failed: {exc}") from exc

    def _generation_kwargs(self) -> dict:
        """Keywords forwarded to the model's generation call.

        PHASE 35 -- WHY ``max_new_tokens`` IS NOW SENT
        ---------------------------------------------
        It was already a supported setting (``AIRLLM_MAX_NEW_TOKENS``,
        read in :mod:`app.config`) and it was never forwarded, so the
        knob was decorative. Without it, generation falls back to
        ``max_length`` from the checkpoint's own ``generation_config``;
        for an instruct model that is in the tens of thousands of
        tokens. On AirLLM -- which reloads every layer from disk for
        every token -- that is not a slow request, it is a request that
        never returns.

        SAMPLING
        --------
        ``temperature <= 0`` means greedy (``do_sample=False``), which
        is also the only setting that is valid without a sampler:
        passing ``temperature=0`` with ``do_sample=True`` is a hard
        error in Transformers. Greedy is the default for a reason --
        it makes a decision reproducible, which is what lets a
        benchmark tell "the model chose the same strategy" apart from
        "the sampler moved".
        """
        kwargs: dict = {}
        max_new = self._config.max_new_tokens
        if isinstance(max_new, int) and max_new > 0:
            kwargs["max_new_tokens"] = max_new
        temperature = self._config.temperature
        if temperature is None or temperature <= 0:
            kwargs["do_sample"] = False
        else:
            kwargs["do_sample"] = True
            kwargs["temperature"] = temperature
        return kwargs

    def _run(self, encoded: Any) -> str:
        model = self._model
        # The generations entry point has been called both `generate`
        # and `generate_text` across AirLLM releases.
        entry = getattr(model, "generate", None)
        if entry is None:
            entry = getattr(model, "generate_text", None)
        if entry is None:
            raise ModelError(
                f"the loaded model exposes neither 'generate' nor 'generate_text'; "
                f"it is a {type(model).__name__}"
            )
        # The prompt length is captured BEFORE the call, because the
        # result carries the prompt back and decoding it would put the
        # instructions in front of the answer. See _decode.
        prompt_len = int(encoded.shape[-1]) if hasattr(encoded, "shape") else None
        raw = entry(encoded, **self._generation_kwargs())
        return _decode(self._tokenizer, raw, prompt_len=prompt_len)


def _encode(tokenizer: Any, prompt: str) -> Any:
    """Encode ``prompt`` into a BATCHED TENSOR.

    PHASE 35 -- WHY A TENSOR AND NOT A LIST
    ---------------------------------------
    A token *list* is not an acceptable input to generation, and the
    reason is the model rather than AirLLM: AirLLM's ``generate`` is a
    one-line passthrough (``return self.model.generate(*args, **kwargs)``)
    to the wrapped Transformers model, and that model reads
    ``inputs_tensor.shape[0]`` to learn the batch size. A list has no
    ``shape``, so handing one over raises

        AttributeError: 'list' object has no attribute 'shape'

    from inside a library, on a path that a stub-based test can never
    reach. This is the class of defect the brief means by "classify the
    exact cause": the prompt, the weights, the GPU, and the parser are
    all innocent. The fix belongs HERE, in the adapter -- not in the
    parser, which must keep rejecting anything but a clean JSON object.

    ORDER MATTERS
    -------------
    The tensor form is attempted FIRST, on every release, even where a
    bare list would also have worked. A tensor is accepted by both the
    old and the new generation API; a list is accepted only by the old
    one. Trying the list first would work on old stacks and fail on new
    ones, which is precisely the pin-to-one-release trap the module
    docstring warns about.

    ``return_tensors="pt"`` does not always return a tensor -- on
    several releases it returns a mapping (a ``BatchEncoding``) -- so
    :func:`_as_input_ids` normalises whatever comes back.
    """
    attempts: list[tuple[str, Any]] = [
        ("__call__(return_tensors='pt')", lambda fn=tokenizer: fn(prompt, return_tensors="pt")),
        ("encode(return_tensors='pt')", lambda fn=tokenizer: fn.encode(prompt, return_tensors="pt")),
        ("encode()", lambda fn=tokenizer: fn.encode(prompt)),
        ("encode() as attribute", lambda fn=tokenizer: fn(prompt)),
    ]
    tried: list[str] = []
    for label, attempt in attempts:
        if label.startswith("__call__") and not callable(tokenizer):
            continue
        if label.startswith("encode() as attribute") and not callable(getattr(tokenizer, "encode", None)):
            continue
        tried.append(label)
        try:
            return _as_input_ids(attempt())
        except TypeError:
            # This release does not accept that call shape. Try the next.
            continue
        except ModelError:
            raise
        except Exception as exc:
            raise ModelError(f"the tokenizer failed to encode the prompt: {exc}") from exc

    raise ModelError(
        f"the tokenizer {type(tokenizer).__name__} exposes no usable encoding; tried {tried}. "
        "This AirLLM/transformers combination is not supported by the adapter."
    )


def _as_input_ids(value: Any) -> Any:
    """Normalise a tokenizer result into a 2-D ``input_ids`` tensor.

    Three shapes are seen in the wild and all three are handled:
    a tensor (returned as-is), a mapping such as ``BatchEncoding``
    (its ``input_ids`` is taken), and a plain list of ints (lifted into
    a tensor, because a list cannot be generated from).

    ``torch`` is reached through :func:`importlib.import_module` here,
    for the same reason every other heavy import in this file is
    deferred: importing this module must succeed on a machine with no
    torch installed, so that ``/health`` can answer rather than the
    process dying at import. That is also why the project's structural
    test forbids a line beginning ``import torch`` -- the deferred
    import has to be deferred in a way that reads the same everywhere.
    """
    if hasattr(value, "dim"):
        ids = value
    elif hasattr(value, "get") and callable(getattr(value, "get")):
        try:
            ids = value["input_ids"]
        except Exception as exc:
            raise ModelError(f"the tokenizer returned a mapping without usable input_ids: {exc}") from exc
    else:
        torch = _require("torch", "torch")
        ids = torch.tensor([list(value)], dtype=torch.long)

    if not hasattr(ids, "dim"):
        raise ModelError(f"the tokenizer produced a {type(ids).__name__}, not a tensor")

    # Generation needs a batch dimension. A 1-D tensor of token ids is
    # accepted by some releases and not others; adding the leading axis
    # is unambiguous and cheap.
    if ids.dim() == 1:
        ids = ids.unsqueeze(0)
    return ids


def _decode(tokenizer: Any, raw: Any, prompt_len: Optional[int] = None) -> str:
    """Decode a generation back to the COMPLETION text.

    PHASE 35 -- WHY THE PROMPT IS STRIPPED
    --------------------------------------
    ``generate`` returns the prompt concatenated with the completion,
    not the completion alone. Decoding that whole tensor would return
    the instructions followed by the answer, and the strict parser in
    :mod:`app.parser` would then reject the response for "prose before
    the JSON" -- a rejection of the model's own prompt, caused by the
    adapter, and invisible to a stub generator that returns finished
    text.

    The parser is NOT loosened to accommodate this. The adapter returns
    what the model actually generated, and the prompt is removed here,
    where it was added.

    ``prompt_len`` is how many prompt tokens to drop. It is passed in
    rather than recomputed so the caller reads the length off the exact
    tensor it handed to the model. When it is unknown the raw result is
    decoded unchanged, which is the previous behaviour and is correct
    for a release that returns only the new tokens.
    """
    if isinstance(raw, str):
        return raw

    # A tensor or nested sequence: drop the prompt prefix first.
    tokens = raw
    if prompt_len is not None and hasattr(tokens, "shape"):
        try:
            if int(tokens.dim()) >= 2 and int(tokens.shape[-1]) > prompt_len:
                tokens = tokens[..., prompt_len:]
        except Exception:  # pragma: no cover - defensive
            tokens = raw

    decoder = getattr(tokenizer, "decode", None)
    if not callable(decoder):
        return str(raw)
    try:
        result = decoder(tokens)
    except Exception:
        return str(raw)

    # A 1-D slice of token ids decodes to a str. Some releases return
    # a list of strings, and a bare tensor decodes to a nested list.
    # All three are handled, and the order matters: a str is the
    # common case and must be recognised before the indexing below,
    # which would otherwise take its first character.
    if isinstance(result, str):
        return result
    if isinstance(result, list) and result and isinstance(result[0], str):
        return "\n".join(result)
    try:
        return str(result[0])
    except Exception:  # pragma: no cover - defensive
        return str(result)


# ============================================================================
# Runtime
# ============================================================================


class ModelRuntime:
    """Owns model load, inference, and readiness state.

    Thread-safe for the load transition. Inference itself is delegated
    to the generator; the service layer bounds concurrent inference.
    """

    def __init__(
        self,
        config: ServiceConfig,
        generator_factory: Optional[Callable[[ServiceConfig, LoadReport], TextGenerator]] = None,
    ) -> None:
        self._config = config
        self._factory = generator_factory or _build_airllm_generator
        self._lock = threading.Lock()
        self._generator: Optional[TextGenerator] = None
        self._state = STATE_SERVICE_RUNNING
        self._error: Optional[str] = None
        self._report = LoadReport()
        self._loaded_at: Optional[float] = None
        self._load_count = 0
        self._inference_count = 0

    # -- state ---------------------------------------------------------

    @property
    def state(self) -> str:
        return self._state

    @property
    def loaded(self) -> bool:
        return self._state == STATE_MODEL_READY and self._generator is not None

    @property
    def error(self) -> Optional[str]:
        return self._error

    @property
    def report(self) -> LoadReport:
        return self._report

    def stats(self) -> dict:
        """Operational counters. No paths, no secrets (brief 36)."""
        return {
            "loadCount": self._load_count,
            "inferenceCount": self._inference_count,
            "loadedAt": self._loaded_at,
            "remoteCodeUsed": self._report.remote_code_used,
        }

    def _fail(self, message: str) -> None:
        self._state = STATE_MODEL_ERROR
        self._error = message

    # -- lifecycle -----------------------------------------------------

    def ensure_loaded(self) -> TextGenerator:
        """Return a ready generator, loading the model once if needed.

        Idempotent and thread-safe. Every failure path sets
        ``MODEL_ERROR`` with an actionable message and re-raises, so
        the service can answer ``fallbackUsed: true`` instead of
        pretending the model is available.

        A load that has already failed is NOT retried. The recorded
        error is re-raised immediately, and :meth:`reset` is the only
        way to try again. Retrying automatically would turn one clear
        diagnosis into a stream of identical ones, and would re-attempt
        a multi-gigabyte read on every incoming request for as long as
        the underlying problem -- a missing checkpoint, a missing CUDA
        driver -- went unfixed.
        """
        if self._generator is not None and self._state == STATE_MODEL_READY:
            return self._generator
        if self._state == STATE_MODEL_ERROR and self._error:
            raise ModelError(self._error)

        with self._lock:
            # Re-check under the lock: another thread may have finished
            # the load, or recorded its failure, while this one waited.
            if self._generator is not None and self._state == STATE_MODEL_READY:
                return self._generator
            if self._state == STATE_MODEL_ERROR and self._error:
                raise ModelError(self._error)

            self._state = STATE_MODEL_LOADING
            self._error = None
            started = time.monotonic()
            try:
                generator = self._factory(self._config, self._report)
            except ModelError as exc:
                self._fail(str(exc))
                raise
            except Exception as exc:  # pragma: no cover - defensive
                self._fail(f"{type(exc).__name__}: {exc}")
                raise ModelError(str(exc)) from exc

            self._generator = generator
            self._state = STATE_MODEL_READY
            self._load_count += 1
            self._loaded_at = time.time()
            self._report.load_ms = int((time.monotonic() - started) * 1000)
            return generator

    def generate(self, prompt: str) -> str:
        """Run one inference against the already-loaded model.

        Does NOT load on demand. The caller must have called
        :meth:`ensure_loaded`; separating the two keeps "is a model
        even available" answerable from ``/ready`` without running
        inference.
        """
        if self._generator is None or self._state != STATE_MODEL_READY:
            raise ModelError(f"the model is not ready (state={self._state})")
        self._inference_count += 1
        return self._generator.generate(prompt)

    def reset(self) -> None:
        """Return to ``SERVICE_RUNNING`` and drop the loaded model.

        Test-support and operator-support. After a load failure this
        is the only way to retry, which is deliberate: retrying a
        failed load on every request would turn one clear error into a
        stream of them.
        """
        with self._lock:
            self._generator = None
            self._state = STATE_SERVICE_RUNNING
            self._error = None
            self._report = LoadReport()
            self._loaded_at = None

    # -- health / readiness -------------------------------------------

    def health(self) -> dict:
        """``GET /health`` body (brief 10).

        Answers "is the process alive and what is it", which is a
        question about the service, not about whether a model is
        present. ``modelLoaded: false`` with ``status: SERVICE_RUNNING``
        is a healthy answer.
        """
        return {
            "status": self._state,
            "provider": "airllm",
            "modelLoaded": self.loaded,
            "model": self._config.model_ref,
            "runtime": runtime_info(),
        }

    def ready(self):
        """``GET /ready`` body and its HTTP status (brief 11).

        Returns ``200`` only for ``MODEL_READY``. Everything else
        returns ``503``, so a load balancer -- or Node's readiness
        probe -- can tell "the process is up" apart from "this can
        serve a decision", which is exactly the distinction brief 11
        asks for.
        """
        state = self._state
        body = {
            "state": state,
            "provider": "airllm",
            "model": self._config.model_ref,
            "ready": state == STATE_MODEL_READY,
            "remoteCodeUsed": self._report.remote_code_used,
            # PHASE 35: what the load actually negotiated with the
            # installed AirLLM. A dropped keyword is a version-drift
            # fact an operator needs, and a report that hid it would
            # make a silent behavioural change look like a clean load.
            "loadReport": {
                "device": self._report.device,
                "droppedKwargs": list(self._report.dropped_kwargs),
                "targetClass": self._report.target_class,
                "loadMs": self._report.load_ms or None,
                "pinningDisabled": self._report.pinning_disabled,
            },
            "errors": list(self._config.errors),
        }
        if self._error:
            body["error"] = self._error
        if state == STATE_MODEL_READY:
            body["stats"] = self.stats()
            return body, 200
        return body, 503


# ============================================================================
# The real loader
# ============================================================================


def _require(name: str, pip_name: str) -> Any:
    """Import ``name`` or raise a :class:`ModelError` naming the fix."""
    try:
        return importlib.import_module(name)
    except ImportError as exc:
        raise ModelError(
            f"{name} is not installed in this interpreter ({sys.executable}). "
            f"Install the runtime dependencies with: pip install -r requirements.txt "
            f"(the package providing it is '{pip_name}')."
        ) from exc


def _apply_cache_dir(config: ServiceConfig) -> Optional[str]:
    """Point Hugging Face at the configured cache directory.

    Only sets variables that are not already set, so an operator who
    exported ``HF_HOME`` in their shell keeps their value. Returns
    nothing on the wire: the cache path is local filesystem detail
    that ``/health`` does not publish (brief 36, 38).
    """
    if not config.cache_dir:
        return None
    try:
        os.makedirs(config.cache_dir, exist_ok=True)
    except OSError as exc:
        raise ModelError(f"AIRLLM_CACHE_DIR is not usable: {exc}") from exc
    for var in ("HF_HOME", "TRANSFORMERS_CACHE", "AIRLLM_CACHE_DIR"):
        os.environ.setdefault(var, config.cache_dir)
    return config.cache_dir


def _resolve_device(torch: Any, config: ServiceConfig) -> str:
    """Decide the device, refusing to claim a GPU that is not there.

    Nothing here hard-codes ``cuda:0`` (brief 41). With no explicit
    setting, AirLLM's own default applies and this reports ``auto``,
    which is honest: the service does not know and will not guess.

    With an explicit ``cuda`` request and no CUDA, this fails loudly
    rather than quietly running on CPU -- a silent CPU fallback would
    make a deployment look healthy while being orders of magnitude
    slower than configured (brief 41).
    """
    requested = config.device
    if not requested:
        return "auto"
    normalized = requested.strip().lower()
    wants_cuda = normalized.startswith("cuda")
    available = bool(torch.cuda.is_available())
    if wants_cuda and not available:
        raise ModelError(
            f"AIRLLM_DEVICE={requested!r} requests CUDA, but torch reports no available CUDA "
            "device. Install a CUDA-enabled torch build with a working driver, or set "
            "AIRLLM_DEVICE=cpu to run on CPU and accept the slower inference."
        )
    return requested


def _check_architecture(config: ServiceConfig):
    """Resolve the model config without executing repository code.

    Returns ``(auto_config, remote_code_used)``.

    On a failure that looks like "this architecture needs custom code",
    the load is refused unless remote code was explicitly enabled. The
    message names the escape hatch so the choice stays an operator's,
    made deliberately, rather than something a model repository
    triggers merely by existing (brief 8).
    """
    transformers = _require("transformers", "transformers")
    ref = config.model_path or config.model_id
    if not ref:
        raise ModelError(
            "no model is configured. Set AIRLLM_MODEL_PATH to a local model directory "
            "(preferred) or AIRLLM_MODEL_ID explicitly (brief 6)."
        )
    if config.model_path and not os.path.isdir(config.model_path):
        raise ModelError(
            "AIRLLM_MODEL_PATH does not point at a directory. The service will not "
            "download a replacement model; set AIRLLM_MODEL_ID if that is intended."
        )

    try:
        auto_config = transformers.AutoConfig.from_pretrained(ref, trust_remote_code=False)
    except Exception as first_error:
        if not config.allow_remote_code:
            raise ModelError(
                f"the configured model could not be resolved with trust_remote_code=False: "
                f"{type(first_error).__name__}: {first_error}. This usually means the model "
                "needs custom modeling code, which this service will not execute. Either "
                "choose a model whose architecture Transformers recognises natively, or set "
                "AIRLLM_ALLOW_REMOTE_CODE=true to accept running code from the model "
                "repository (brief 8)."
            ) from first_error
        # Opted in, by hand. Proceed, and record that it happened.
        try:
            auto_config = transformers.AutoConfig.from_pretrained(ref, trust_remote_code=True)
        except Exception as second_error:
            raise ModelError(
                f"the model config could not be read even with trust_remote_code=True: {second_error}"
            ) from second_error
        return auto_config, True

    return auto_config, False


def _supported_kwargs(fn: Any, candidates: dict, constructor: Any = None) -> tuple:
    """Keep only the ``candidates`` this callable actually accepts.

    The dropped names are returned so the caller can log them. A
    keyword that the installed release does not have is not an error;
    passing it anyway would raise ``TypeError`` at load time, and
    dropping it silently would hide a version mismatch (brief 7).

    PHASE 35 -- WHY ``constructor`` IS ALSO CONSULTED
    ------------------------------------------------
    Inspecting the public entry point is not sufficient, and on AirLLM
    4.0.0 it is actively misleading. ``AutoModel.from_pretrained`` is

        def from_pretrained(cls, path, *inputs, **kwargs)

    -- a ``**kwargs`` forwarder. It looks like it accepts anything, it
    accepts anything, and it then calls

        return class_(path, *inputs, **kwargs)

    on an architecture-specific subclass. ``AirLLMBaseModel.__init__``
    has no ``trust_remote_code``, so the load dies with

        TypeError: AirLLMBaseModel.__init__() got an unexpected
        keyword argument 'trust_remote_code'

    which is what this host reported. Filtering against the entry point
    therefore returns "accepts everything" and guarantees the failure.

    ``constructor`` is the class AirLLM will actually instantiate, so
    its ``__init__`` is the signature that matters. It is resolved
    through AirLLM's own ``get_module_class`` -- the same call the
    forwarder makes -- so the answer is read from the installed
    package rather than guessed from a name in this file.
    """
    try:
        signature = inspect.signature(fn)
    except (TypeError, ValueError):  # pragma: no cover - builtins
        signature = None

    parameters = signature.parameters if signature else None
    entry_is_open = parameters is not None and any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in parameters.values()
    )

    if constructor is None and entry_is_open:
        # Nothing concrete to check against, and the entry point will
        # take anything. Passing every candidate is the best available
        # guess, and the load's own error is the report.
        return dict(candidates), []

    accepted = dict(candidates)
    dropped: list[str] = []

    if not entry_is_open and parameters is not None:
        ok = {
            name
            for name, value in candidates.items()
            if name in parameters
            and parameters[name].kind
            in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        }
        dropped.extend(sorted(set(candidates) - ok))
        accepted = {k: v for k, v in candidates.items() if k in ok}

    if constructor is not None:
        try:
            ctor_signature = inspect.signature(constructor)
        except (TypeError, ValueError):  # pragma: no cover - builtins
            return accepted, sorted(dropped)

        ctor_params = ctor_signature.parameters
        if any(p.kind is inspect.Parameter.VAR_KEYWORD for p in ctor_params.values()):
            # The constructor really does take anything; nothing to drop.
            return accepted, sorted(set(dropped))

        ok = {
            name
            for name in accepted
            if name in ctor_params
            and ctor_params[name].kind
            in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
        }
        dropped.extend(sorted(set(accepted) - ok))
        accepted = {k: v for k, v in accepted.items() if k in ok}

    return accepted, sorted(set(dropped))


#: Free physical memory, in bytes, below which AirLLM's layer pinning
#: is turned off. PHASE 35. Chosen from the failure it prevents: on
#: this host 15.7 GB total with 1.7 GB free produced Windows error
#: 1455 ("the paging file is too small") the first time a streamed
#: layer was pinned. Pinning cannot be paged out, so it must come from
#: physical RAM; 4 GiB leaves room for the OS, the browser, and the
#: solver in the same machine.
PINNING_HEADROOM_BYTES = 4 * 1024**3


def _available_ram_bytes() -> Optional[int]:
    """Free physical memory, or ``None`` when it cannot be measured.

    ``psutil`` arrives as an AirLLM dependency, so this normally works.
    When it does not, returning ``None`` means the caller changes
    nothing: an absent measurement is not a licence to degrade the
    load, it is a licence to leave it alone.
    """
    try:
        psutil = importlib.import_module("psutil")
        return int(psutil.virtual_memory().available)
    except Exception:
        return None


def _is_memory_failure(exc: BaseException) -> bool:
    """True when a load failed because the host ran out of memory.

    Deliberately narrow. It matches the Windows allocation error, the
    POSIX one, and torch's own out-of-memory type, because those are
    the only failures that pinning can plausibly fix. A missing
    checkpoint, an unreadable config, or a bad architecture is NOT one
    of them, and retrying those would only replace a clear diagnosis
    with a confusing one.
    """
    # Windows: ERROR_COMMITMENT_LIMIT, surfaced by the allocator as 1455.
    if getattr(exc, "errno", None) == 1455:
        return True
    text = str(exc).lower()
    if "paging file is too small" in text:
        return True
    if "out of memory" in text or "cannot allocate" in text:
        return True
    # torch raises a dedicated type when CUDA itself is exhausted. Pinning
    # is host RAM rather than VRAM, so this is reported separately and is
    # NOT retried here; `_resolve_device` already refuses an impossible
    # device request.
    return type(exc).__name__ in ("OutOfMemoryError",)


def _airllm_target_class(airllm: Any, model_ref: str) -> Optional[type]:
    """The AirLLM class ``from_pretrained`` will construct, or ``None``.

    Resolved with AirLLM's own ``get_module_class``, which reads only
    the model config (no weights are loaded) and returns the class name
    it is about to instantiate. Any failure returns ``None``, which
    makes the caller fall back to filtering on the entry point alone --
    a documented, logged degradation rather than a load attempt that
    is certain to fail.

    It is called as a BOUND classmethod, on the class rather than on
    the underlying function: reaching for ``.__func__`` un-binds it,
    and the unbound form then demands the missing ``cls`` argument.
    """
    getter = getattr(airllm.AutoModel, "get_module_class", None)
    if not callable(getter):
        return None
    try:
        module_name, class_name = getter(model_ref)
        module = importlib.import_module(module_name)
        target = getattr(module, class_name)
        return target if isinstance(target, type) else None
    except Exception:
        return None


def _build_airllm_generator(config: ServiceConfig, report: LoadReport) -> TextGenerator:
    """Load AirLLM and its model. Raises :class:`ModelError` on any failure.

    Order is fixed and each step is a precondition for the next:

      1. config errors      -- refuse an unusable config before touching a library
      2. cache directory    -- must exist before a download could be attempted
      3. architecture check -- before AirLLM sees the model, so its unconditional
                               trust_remote_code=True can never run repository code
      4. torch + device     -- a bad device must fail before weights are loaded
      5. airllm import      -- last, because it is the heaviest dependency
    """
    if config.errors:
        raise ModelError("the service configuration is invalid: " + "; ".join(config.errors))

    _apply_cache_dir(config)

    # 3. Architecture safety, before AirLLM is involved.
    _auto_config, remote_code_used = _check_architecture(config)
    report.remote_code_used = remote_code_used

    # 4. Runtime and device.
    torch = _require("torch", "torch")
    report.device = _resolve_device(torch, config)

    # 5. AirLLM itself.
    airllm = _require("airllm", "airllm")
    model_ref = config.model_path or config.model_id

    load_candidates = {
        "device": report.device,
        "dtype": config.dtype,
        "trust_remote_code": True if remote_code_used else False,
    }
    # Drop the keys this release does not take rather than crashing.
    # Filter against the class AirLLM will actually build, not just the
    # **kwargs forwarder it is reached through. See _supported_kwargs.
    target_class = _airllm_target_class(airllm, model_ref)
    load_kwargs, dropped = _supported_kwargs(
        airllm.AutoModel.from_pretrained, load_candidates, constructor=target_class
    )
    if report.device == "auto":
        load_kwargs.pop("device", None)
    if config.dtype is None:
        load_kwargs.pop("dtype", None)

    # PHASE 35 -- PHASE 35 -- layer pinning vs. free RAM.
    # AirLLM pins each streamed layer inside its forward hook, so a
    # low-memory failure appears during GENERATION and cannot be
    # fixed by retrying the load. The decision is therefore made here,
    # from the machine, and recorded.
    available = _available_ram_bytes()
    if available is not None and available < PINNING_HEADROOM_BYTES:
        pinned_off, dropped_pin = _supported_kwargs(
            airllm.AutoModel.from_pretrained,
            {**load_kwargs, "prefetching": False},
            constructor=target_class,
        )
        if "prefetching" in pinned_off and pinned_off.get("prefetching") is False:
            load_kwargs = pinned_off
            report.pinning_disabled = True
            # Appended to `dropped`, which is what is written to the
            # report a few lines below. Assigning `report.dropped_kwargs`
            # here would be silently overwritten by that assignment, and
            # the reason a run was slower would be lost.
            dropped = [
                *dropped,
                *dropped_pin,
                f"prefetching=False (free RAM {available // (1024**2)} MiB is below "
                f"the {PINNING_HEADROOM_BYTES // (1024**2)} MiB headroom AirLLM's pinned "
                "layers need)",
            ]
    if target_class is None:
        # Kept rather than discarded: this host is then filtering on a
        # **kwargs forwarder, which is exactly the condition that let a
        # bad keyword through. The load may still succeed; the reader
        # deserves to know the check was weaker.
        dropped = [*dropped, "target-class-unresolved: filtered on the entry point only"]
    report.dropped_kwargs = dropped
    report.target_class = getattr(target_class, "__name__", None)

    try:
        model = airllm.AutoModel.from_pretrained(model_ref, **load_kwargs)
    except Exception as first_error:
        # PHASE 35 -- one documented retry, for memory only.
        #
        # AirLLM pins every streamed layer, and pinned memory cannot be
        # paged out, so it must come from physical RAM. Its own guard
        # catches RuntimeError, but on Windows the allocator raises
        # OSError 1455 ("the paging file is too small"), so the guard does
        # not fire and the load dies on a host that is short of RAM.
        # Retrying with prefetching=False makes the layers pageable: a
        # little slower to copy, and vastly more likely to load at all.
        #
        # Scoped deliberately. Any other failure is re-raised unchanged,
        # because silently degrading a genuine misconfiguration would
        # hide it -- and a retry that masks a missing checkpoint is
        # exactly the kind of repair this service refuses to perform.
        if not _is_memory_failure(first_error):
            raise ModelError(
                f"AirLLM could not load the model: {type(first_error).__name__}: "
                f"{first_error}. (AirLLM {_dist_version('airllm') or 'unknown'}, "
                f"torch {_dist_version('torch') or 'unknown'}, device={report.device})"
            ) from first_error

        retry_kwargs, retry_dropped = _supported_kwargs(
            airllm.AutoModel.from_pretrained,
            {**load_kwargs, "prefetching": False},
            constructor=target_class,
        )
        try:
            model = airllm.AutoModel.from_pretrained(model_ref, **retry_kwargs)
        except Exception as second_error:
            raise ModelError(
                f"AirLLM could not load the model, and the retry with layer pinning "
                f"disabled also failed. First: {type(first_error).__name__}: "
                f"{first_error}. Retry: {type(second_error).__name__}: "
                f"{second_error}. This host does not have enough free memory to "
                f"stream this checkpoint."
            ) from second_error
        report.pinning_disabled = True
        report.dropped_kwargs = [
            *report.dropped_kwargs,
            *retry_dropped,
            "prefetching=False (retried: the host is short of RAM for pinned layers)",
        ]

    # AirLLM's own tokenizer is preferred over loading a second one.
    # AirLLMBaseModel already built a tokenizer for exactly this
    # checkpoint during __init__ (`self.tokenizer = self.get_tokenizer(...)`),
    # so reaching for it is both cheaper and more correct than building a
    # second instance that could disagree with the first about special
    # tokens. A separate AutoTokenizer is still loaded when the model
    # object does not carry one.
    tokenizer = getattr(model, "tokenizer", None)
    if tokenizer is None:
        transformers = _require("transformers", "transformers")
        try:
            tokenizer = transformers.AutoTokenizer.from_pretrained(
                model_ref, trust_remote_code=remote_code_used
            )
        except Exception as exc:
            # A missing tokenizer is not fatal at load time: some AirLLM
            # setups carry the tokenizer on the model object. The failure
            # surfaces on the first generate() with a precise message
            # instead of here, where it would be a guess.
            report.dropped_kwargs.append(f"tokenizer: {type(exc).__name__}")

    return AirLLMGenerator(model, tokenizer, config, report)
