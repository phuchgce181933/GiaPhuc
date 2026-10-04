"""PHASE 30 -- PLAN ORCHESTRATION.

The one code path from a SituationReport to a decision:

    SituationReport
      -> ActionPolicy        (vocabulary, read out of the report)
      -> build_prompt        (versioned template)
      -> model.generate      (AirLLM)
      -> parse_model_output  (strict)
      -> normalize_decision  (schema)
      -> response

EVERY FAILURE FALLS BACK, AND NONE OF THEM RAISE (brief 13)
----------------------------------------------------------
There is no input for which :meth:`PlanService.plan` raises. Not a
missing model, not a missing CUDA device, not an unparseable response,
not a mode outside the vocabulary, not a timeout, not a bug in this
file. Each produces a ``200`` with ``fallbackUsed: true``, an
``error`` string, and ``decision: null``, which the Node client maps
onto an ``AI_FAILURE`` kind and the orchestrator answers with the
deterministic fallback.

That is the point of the whole design. The service is the least
trusted component in the pipeline, so it is the one place where an
exception is least useful: an unhandled error becomes an opaque 500
at the HTTP boundary, which Node classifies as ``AI_UNAVAILABLE`` and
loses the reason. Answering ``200`` with a reason keeps the failure
legible while still producing a schedule.

The one exception is a request this service cannot even begin to
serve -- a body that is not ``{"situationReport": {...}}``. That is a
caller bug, it is answered ``400``, and Node maps it to
``AI_UNSUPPORTED_REQUEST``. It is not a model failure and must not be
confused with one.

WHAT IS NEVER HERE
------------------
No solver, no candidate generation, no teacher-to-period assignment,
no database client, no HTTP client. The service has no idea a solver
exists. It is handed facts and returns a strategy (brief 54, 55).

DETERMINISM (brief 56)
----------------------
Nothing here seeds or consumes a random number generator. Generation
sampling, if the model uses any, lives entirely inside the model and
cannot reach the Node solver's seeded RNG, which is why
``solverSeed = 0xC0FFEE`` still produces the same schedule whether the
AI agreed with the default or not (brief 57).
"""

from __future__ import annotations

import threading
import time
from typing import Any, Optional

from .config import ServiceConfig
from .parser import ParseError, parse_model_output
from .prompt import build_prompt, prompt_version
from .runtime import ModelError, ModelRuntime
from .schema import ActionPolicy, SchemaError, StrategyDecision, decision_hash, normalize_decision

# Failure kinds. Identical strings to the Node ``AI_FAILURE`` enum, so
# the audit log reads the same on both sides of the process boundary
# without a translation table (brief 13).
FAILURE_TIMEOUT = "AI_TIMEOUT"
FAILURE_INVALID_OUTPUT = "AI_INVALID_OUTPUT"
FAILURE_UNAVAILABLE = "AI_UNAVAILABLE"
FAILURE_PARSE_ERROR = "AI_PARSE_ERROR"
FAILURE_UNSUPPORTED_REQUEST = "AI_UNSUPPORTED_REQUEST"
FAILURE_INTERNAL = "AI_INTERNAL_ERROR"

PROVIDER_NAME = "airllm"


class PlanOutcome:
    """An HTTP status and the body that goes with it."""

    __slots__ = ("status", "body")

    def __init__(self, status: int, body: dict) -> None:
        self.status = status
        self.body = body

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"PlanOutcome(status={self.status}, fallbackUsed={self.body.get('fallbackUsed')})"


# ============================================================================
# Inference with a deadline
# ============================================================================


class _InferenceTimeout(Exception):
    """The generation did not finish inside the configured deadline."""


def _generate_with_deadline(runtime: ModelRuntime, prompt: str, timeout_ms: int) -> str:
    """Run inference on a worker thread and give up after ``timeout_ms``.

    AirLLM's generation is a synchronous call into Python and C++
    with no cancellation hook, so the only way to honour a deadline is
    to stop waiting for it. The worker is a daemon thread: if the
    underlying generation never returns, the process can still exit,
    and the request that abandoned it already has its answer.

    The abandoned thread is a known cost and is why ``MODEL_LOADING``
    and the request timeout are separate: a stuck generation holds no
    lock, so the next request reaches the already-loaded model and
    runs normally. The service degrades in latency, not in
    availability.
    """
    box: dict = {}

    def worker() -> None:
        try:
            box["text"] = runtime.generate(prompt)
        except BaseException as exc:  # noqa: BLE001 - forwarded below
            box["error"] = exc

    thread = threading.Thread(target=worker, name="airllm-inference", daemon=True)
    thread.start()
    thread.join(timeout=timeout_ms / 1000.0)

    if thread.is_alive():
        raise _InferenceTimeout(f"inference did not finish within {timeout_ms} ms")
    if "error" in box:
        raise box["error"]
    return box.get("text", "")


# ============================================================================
# Service
# ============================================================================


class PlanService:
    """Turns a SituationReport into a validated decision, or a fallback."""

    def __init__(self, runtime: ModelRuntime, config: ServiceConfig) -> None:
        self._runtime = runtime
        self._config = config

    # -- introspection -------------------------------------------------

    @property
    def runtime(self) -> ModelRuntime:
        return self._runtime

    def preload(self) -> None:
        """Load the model now rather than on the first request.

        Opt-in via ``AIRLLM_PRELOAD=1``. Useful when a deployment
        wants the slow load to happen during a rolling restart rather
        than on a user's first scheduling request. Failures are
        swallowed here deliberately: the state is already recorded on
        the runtime, and ``/ready`` is where an operator looks.
        """
        try:
            self._runtime.ensure_loaded()
        except ModelError:
            pass

    # -- planning ------------------------------------------------------

    def plan(self, report: dict) -> PlanOutcome:
        """Produce a decision for ``report``. Never raises."""
        started = time.monotonic()

        base_audit: dict = {
            "provider": PROVIDER_NAME,
            "model": self._config.model_ref,
            "promptVersion": prompt_version(),
        }

        try:
            policy = ActionPolicy(report)
        except Exception as exc:  # pragma: no cover - defensive
            return self._fallback(
                FAILURE_UNSUPPORTED_REQUEST,
                f"the situation report could not be read: {type(exc).__name__}: {exc}",
                started,
                base_audit,
            )

        if not policy.is_usable:
            # Fails closed: with no vocabulary in the report there is
            # nothing this service is permitted to return.
            return self._fallback(
                FAILURE_UNSUPPORTED_REQUEST,
                "the situation report carries no usable action space (no optimization modes, "
                "no candidate counts, or no active scoring dimensions), so no decision can be "
                "validated. The report must be built by the Node SituationReport builder.",
                started,
                base_audit,
            )

        # -- model ------------------------------------------------------
        # A load failure is UNAVAILABLE, not INVALID_OUTPUT: the model
        # could not answer for reasons that have nothing to do with
        # what it would have said (brief 13).
        try:
            self._runtime.ensure_loaded()
        except ModelError as exc:
            return self._fallback(FAILURE_UNAVAILABLE, str(exc), started, base_audit)
        except Exception as exc:  # pragma: no cover - defensive
            return self._fallback(
                FAILURE_UNAVAILABLE, f"the model could not be loaded: {type(exc).__name__}: {exc}",
                started, base_audit,
            )

        # -- prompt -----------------------------------------------------
        try:
            prompt = build_prompt(report, policy)
        except Exception as exc:
            return self._fallback(
                FAILURE_INTERNAL,
                f"the prompt template could not be rendered: {type(exc).__name__}: {exc}",
                started,
                base_audit,
            )

        # -- inference --------------------------------------------------
        inference_started = time.monotonic()
        try:
            raw_text = _generate_with_deadline(
                self._runtime, prompt, self._config.request_timeout_ms
            )
        except _InferenceTimeout as exc:
            return self._fallback(FAILURE_TIMEOUT, str(exc), started, base_audit)
        except ModelError as exc:
            return self._fallback(FAILURE_UNAVAILABLE, str(exc), started, base_audit)
        except Exception as exc:
            return self._fallback(
                FAILURE_UNAVAILABLE, f"inference failed: {type(exc).__name__}: {exc}",
                started, base_audit,
            )
        inference_ms = int((time.monotonic() - inference_started) * 1000)
        base_audit["inferenceMs"] = inference_ms

        # -- parse ------------------------------------------------------
        try:
            parsed = parse_model_output(raw_text)
        except ParseError as exc:
            return self._fallback(FAILURE_PARSE_ERROR, str(exc), started, base_audit)

        # -- schema -----------------------------------------------------
        try:
            schema_result = normalize_decision(parsed.value, policy)
        except SchemaError as exc:
            return self._fallback(FAILURE_INVALID_OUTPUT, str(exc), started, base_audit)
        except Exception as exc:  # pragma: no cover - defensive
            return self._fallback(
                FAILURE_INVALID_OUTPUT, f"the response failed validation: {type(exc).__name__}: {exc}",
                started, base_audit,
            )

        decision: StrategyDecision = schema_result.decision
        body = {
            "decision": decision.to_wire(),
            # Mirrored at the top level because the documented
            # /plan response shape carries it there (brief 4). It is
            # also inside `decision`, where Node's allow-list expects
            # it, so this is a convenience, not a second source.
            "rationale": decision.rationale,
            "provider": PROVIDER_NAME,
            "model": self._config.model_ref,
            "fallbackUsed": False,
            "validated": True,
            "corrections": list(schema_result.corrections),
            "promptVersion": prompt_version(),
            "state": self._runtime.state,
            "latencyMs": int((time.monotonic() - started) * 1000),
            "serviceLatencyMs": int((time.monotonic() - started) * 1000),
            "inferenceMs": inference_ms,
            "decisionHash": decision_hash(decision),
            "remoteCodeUsed": self._runtime.report.remote_code_used,
            "unwrappedFromFence": parsed.unwrapped_from_fence,
            "actionSpace": policy.summary(),
        }
        if base_audit.get("inferenceMs") is not None:
            body["inferenceMs"] = base_audit["inferenceMs"]
        return PlanOutcome(200, body)

    # -- failure -------------------------------------------------------

    def _fallback(
        self,
        failure_kind: str,
        message: str,
        started: float,
        audit: dict,
    ) -> PlanOutcome:
        """Build the no-decision response.

        Deliberately ``200``, not an error status. "I could not infer"
        is a legitimate answer to a scheduling question, and returning
        it as a success-with-a-fallback-flag is what keeps the reason
        intact all the way to the Node audit log instead of collapsing
        into a generic transport failure.
        """
        latency = int((time.monotonic() - started) * 1000)
        return PlanOutcome(
            200,
            {
                "decision": None,
                "rationale": None,
                "provider": PROVIDER_NAME,
                "model": self._config.model_ref,
                "fallbackUsed": True,
                "error": message,
                "failure": failure_kind,
                "validated": False,
                "corrections": [],
                "promptVersion": prompt_version(),
                "state": self._runtime.state,
                "latencyMs": latency,
                "serviceLatencyMs": latency,
                "decisionHash": None,
                "remoteCodeUsed": self._runtime.report.remote_code_used,
            },
        )
