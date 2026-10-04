"""PHASE 30 -- HTTP SURFACE.

Three endpoints and nothing else:

    GET  /health   is the process alive, and what is it          (brief 10)
    GET  /ready    can it serve a decision right now              (brief 11)
    POST /plan     produce a StrategyDecision for a report       (brief 4)

The app is created by a factory, :func:`create_app`, which takes its
runtime and config as arguments rather than reading the environment
at import time. That is what lets ``test_api_contract.py`` mount the
real ASGI app with a stub generator and exercise every route, status
code, and failure path on a machine with no AirLLM, no torch, and no
model (brief 45).

NETWORK EXPOSURE (brief 43)
---------------------------
Binding is a uvicorn concern and lives in ``__main__`` below, which
passes the config's host explicitly and defaults to loopback. This
module adds no CORS, no ``0.0.0.0``, and no public route.

``/health`` and ``/ready`` are exempt from the bearer check on
purpose: they report no model content and no decision, they are what
an operator uses to diagnose an unauthenticated failure, and gating
them would mean an auth problem is indistinguishable from a service
that is simply down. ``/plan`` is the endpoint that costs GPU time
and it is the one that requires the token.

WHAT THE SERVICE REFUSES TO DO
------------------------------
There is no endpoint that accepts a SchedulingInput, a list of
schedule slots, a teacher record, or a database query (brief 21, 22,
54, 55). The request model has one field. That is the whole
guarantee, and it is enforced by a type rather than by a comment.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import JSONResponse

from .config import ServiceConfig, load_config, safe_config
from .runtime import ModelRuntime
from .schema import PlanRequest
from .service import FAILURE_UNSUPPORTED_REQUEST, PlanService

API_TITLE = "thuanhung_tkb ai-service"
API_VERSION = "1.0.0"


# ============================================================================
# Auth (brief 43)
# ============================================================================


def _require_token(expected: Optional[str], authorization: Optional[str]) -> None:
    """Enforce the optional internal shared secret on ``/plan``.

    Constant-time comparison via :func:`secrets.compare_digest`, so
    the check does not leak the secret through response timing. When
    no token is configured the endpoint is open -- acceptable only
    because the service binds loopback, which is why the bind address
    is validated at config load time and cannot be overridden to a
    public interface without an error.
    """
    if not expected:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="a bearer token is required")
    presented = authorization[len("Bearer ") :].strip()
    import secrets

    if not secrets.compare_digest(presented, expected):
        raise HTTPException(status_code=403, detail="the bearer token is not valid")


# ============================================================================
# App factory
# ============================================================================


def create_app(
    config: Optional[ServiceConfig] = None,
    runtime: Optional[ModelRuntime] = None,
) -> FastAPI:
    """Build the ASGI application.

    :param config: configuration; read from the environment when omitted.
    :param runtime: model runtime; a default one is built when omitted.
        Tests pass a runtime whose generator factory is a stub, which
        is how the routes are covered without a model.
    """
    resolved_config = config if config is not None else load_config()
    resolved_runtime = runtime if runtime is not None else ModelRuntime(resolved_config)
    service = PlanService(resolved_runtime, resolved_config)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Optional preload (brief 9).

        Off by default so a service started without a model still
        opens its port and can explain itself on ``/ready``. With
        ``AIRLLM_PRELOAD=1`` the load happens here, during startup,
        rather than on the first user request.
        """
        if resolved_config.preload:
            service.preload()
        yield

    app = FastAPI(
        title=API_TITLE,
        version=API_VERSION,
        # No interactive docs by default: /docs and /openapi.json would
        # publish the full request schema on a service that is meant to
        # be reachable only from the Node backend.
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.config = resolved_config
    app.state.runtime = resolved_runtime
    app.state.service = service

    def _auth(authorization: Optional[str] = Header(default=None)) -> None:
        _require_token(resolved_config.service_token, authorization)

    # -- health --------------------------------------------------------

    @app.get("/health")
    def health() -> JSONResponse:
        """Process liveness and identity (brief 10).

        Always ``200`` when it can answer at all, including when the
        model is missing or broken: "the process is up but the model
        is not" is exactly the information an operator needs, and
        turning it into a non-200 would collapse that distinction.
        The body carries only safe metadata -- versions and a model
        leaf name, never a full local path, a cache directory, or a
        token (brief 36).
        """
        body = resolved_runtime.health()
        body["config"] = safe_config(resolved_config)
        return JSONResponse(status_code=200, content=body)

    # -- readiness -----------------------------------------------------

    @app.get("/ready")
    def ready() -> JSONResponse:
        """Can this service serve a decision right now (brief 11)?

        ``200`` only for ``MODEL_READY``. ``MODEL_LOADING``,
        ``MODEL_ERROR``, and the initial ``SERVICE_RUNNING`` all return
        ``503``, so a caller can never mistake an open port for a
        usable model.
        """
        body, status = resolved_runtime.ready()
        return JSONResponse(status_code=status, content=body)

    # -- plan ----------------------------------------------------------

    @app.post("/plan")
    def plan(
        payload: PlanRequest,
        _authorized: None = Depends(_auth),
    ) -> JSONResponse:
        """Produce a StrategyDecision for a SituationReport (brief 4).

        The body must be exactly ``{"situationReport": {...}}``. Any
        other shape is a ``422`` from pydantic, which Node classifies
        as ``AI_UNSUPPORTED_REQUEST``.

        A model failure is a ``200`` with ``fallbackUsed: true`` and
        ``decision: null``, not a 5xx. See :mod:`app.service` for why.
        """
        if not payload.situation_report:
            raise HTTPException(
                status_code=400,
                detail={
                    "failure": FAILURE_UNSUPPORTED_REQUEST,
                    "error": "situationReport is empty. The service cannot build a prompt from "
                    "no facts, and it will not invent a request body.",
                },
            )
        outcome = service.plan(payload.situation_report)
        return JSONResponse(status_code=outcome.status, content=outcome.body)

    # -- startup -------------------------------------------------------
    # (The preload lives in the lifespan handler above, which runs on
    # the ASGI startup event without the deprecated on_event API.)

    return app


# ============================================================================
# ASGI entry point
# ============================================================================

app = create_app()


def main() -> None:  # pragma: no cover - process entry point
    """Run the service with uvicorn.

    The host comes from config, which has already refused anything
    that is not loopback. Passing it explicitly -- rather than letting
    uvicorn default to 127.0.0.1 by luck -- means the validated value
    is the one actually bound (brief 43).
    """
    import uvicorn

    config = load_config()
    if config.errors:
        for problem in config.errors:
            print(f"[ai-service] configuration problem: {problem}")
    uvicorn.run(
        "app.main:app",
        host=config.host,
        port=config.port,
        # Single worker on purpose: the model is loaded once per
        # process, and several workers would mean several copies of
        # the weights in RAM (brief 9).
        workers=1,
        log_level=os.environ.get("AI_SERVICE_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":  # pragma: no cover
    main()
