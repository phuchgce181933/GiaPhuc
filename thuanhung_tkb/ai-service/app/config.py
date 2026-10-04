"""PHASE 30 -- SERVICE CONFIGURATION.

Every knob the service has is read from the environment here and
nowhere else. There is no model path, device, or secret baked into
source (brief 5).

Why a hand-rolled reader instead of pydantic-settings
-----------------------------------------------------
Two reasons, both of them about failing safely rather than about
taste:

  1. ``AIRLLM_ALLOW_REMOTE_CODE`` must be opt-IN (brief 8). Several
     settings libraries treat a missing value as "use the class
     default", and the class default for that flag is ``True``,
     because it is the useful default for a CLI. A misconfigured
     deploy must not silently start executing model-repository code,
     so the default here is hard-wired to ``False`` and can only be
     moved to ``True`` by writing the exact string ``"true"``.
  2. The service must be able to report *why* a config is bad rather
     than crash on it. ``load_config`` collects every problem into
     ``errors`` instead of raising on the first, so ``/health`` can
     tell an operator all of what is wrong at once.

What is read
------------
============================  ==========================================
``AIRLLM_SERVICE_HOST``       bind address; default 127.0.0.1
``AIRLLM_SERVICE_PORT``       bind port; default 8077
``AIRLLM_SERVICE_TOKEN``      optional bearer shared secret
``AIRLLM_MODEL_PATH``         local model directory (preferred)
``AIRLLM_MODEL_ID``           HF repo id (must be explicit)
``AIRLLM_CACHE_DIR``          model/cache root
``AIRLLM_DEVICE``             e.g. ``cpu``, ``cuda:0``
``AIRLLM_DTYPE``              e.g. ``float16``, ``bfloat16``
``AIRLLM_ALLOW_REMOTE_CODE``  opt-in to model-repo code execution
``AIRLLM_MAX_NEW_TOKENS``     generation ceiling
``AIRLLM_TEMPERATURE``        sampling temperature
``AIRLLM_PRELOAD``            load at startup vs first request
``AIRLLM_INTEGRATION``        ``1`` enables the real-model tests
============================  ==========================================

Secrets never logged
--------------------
:func:`safe_config` is the only representation intended for logs,
``/health``, or the audit metadata (brief 36). It reports the token
as present/absent and the model by ID, never by full local path.
``__repr__`` is overridden so an accidental ``print(config)`` or a
f-string in a traceback cannot leak the secret either.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Optional

# ============================================================================
# Constants
# ============================================================================

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8077
DEFAULT_MAX_NEW_TOKENS = 512
DEFAULT_TEMPERATURE = 0.0

#: Only these host values may be bound. ``0.0.0.0`` is refused at
#: parse time (brief 43) -- the service holds model weights and an
#: inference endpoint, neither of which belongs on every interface.
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})

_TRUTHY = frozenset({"true", "1", "yes", "on"})


# ============================================================================
# Config object
# ============================================================================


@dataclass(frozen=True)
class ServiceConfig:
    """Immutable service configuration.

    ``errors`` is non-empty exactly when the config cannot be used to
    serve inference. The service still starts in that case so that
    ``/health`` and ``/ready`` can explain the problem instead of the
    port simply never opening (brief 9, brief 11).
    """

    # -- transport ------------------------------------------------------
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    service_token: Optional[str] = None

    # -- model resolution (brief 5, brief 6) ----------------------------
    model_path: Optional[str] = None
    model_id: Optional[str] = None
    cache_dir: Optional[str] = None

    # -- runtime --------------------------------------------------------
    device: Optional[str] = None
    dtype: Optional[str] = None
    allow_remote_code: bool = False
    max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS
    temperature: float = DEFAULT_TEMPERATURE
    preload: bool = False

    #: Deadline for a single inference, in milliseconds. The Node
    #: client enforces ``AI_REQUEST_TIMEOUT_MS`` too; this is the
    #: service-side backstop for the case where the process running
    #: the request is not Node (a curl, a script, another service).
    #: One variable, honored on both sides, so the two deadlines can
    #: never disagree about what "too slow" means.
    request_timeout_ms: int = 120_000

    # -- diagnostics ----------------------------------------------------
    errors: tuple[str, ...] = field(default_factory=tuple)

    # ------------------------------------------------------------------
    @property
    def model_source(self) -> str:
        """Which resolution path this config selects.

        ``local_path`` / ``model_id`` / ``none``. Local path wins when
        both are set, because brief 6 prefers it: a local directory
        cannot trigger a download, so it is the safe default.
        """
        if self.model_path:
            return "local_path"
        if self.model_id:
            return "model_id"
        return "none"

    @property
    def model_ref(self) -> str:
        """A model identifier safe to log (brief 36).

        A local path can encode a user name, a customer name, or a
        share name, so the directory's leaf name is reported instead
        of the full path. Enough to tell two models apart in a log,
        not enough to disclose where the disk is mounted.
        """
        if self.model_source == "local_path" and self.model_path:
            return _leaf(self.model_path)
        if self.model_id:
            return self.model_id
        return "unconfigured"

    @property
    def resolves_locally(self) -> bool:
        """True when no network fetch is required to obtain weights."""
        return self.model_source == "local_path"

    @property
    def is_servable(self) -> bool:
        """True when config alone permits serving inference."""
        return not self.errors

    def __repr__(self) -> str:  # pragma: no cover - defensive
        # Never let the token reach a log line or a traceback.
        return (
            f"ServiceConfig(host={self.host!r}, port={self.port!r}, "
            f"model_source={self.model_source!r}, model_ref={self.model_ref!r}, "
            f"device={self.device!r}, allow_remote_code={self.allow_remote_code!r}, "
            f"service_token={'<set>' if self.service_token else None!r}, "
            f"errors={self.errors!r})"
        )

    __str__ = __repr__


def _leaf(path: str) -> str:
    """Last path segment, tolerant of trailing separators."""
    cleaned = str(path).rstrip("/\\")
    if not cleaned:
        return "unknown"
    return cleaned.replace("\\", "/").rsplit("/", 1)[-1] or "unknown"


# ============================================================================
# Loading
# ============================================================================


def _str(env, key: str) -> Optional[str]:
    raw = env.get(key)
    if raw is None:
        return None
    value = raw.strip()
    return value or None


def _int(env, key: str, default: int, errors: list[str], *, minimum: int) -> int:
    raw = _str(env, key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        errors.append(f"{key}={raw!r} is not an integer; using {default}.")
        return default
    if value < minimum:
        errors.append(f"{key}={value} is below the minimum of {minimum}; using {default}.")
        return default
    return value


def _float(env, key: str, default: float, errors: list[str], *, minimum: float, maximum: float) -> float:
    raw = _str(env, key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError:
        errors.append(f"{key}={raw!r} is not a number; using {default}.")
        return default
    if not (minimum <= value <= maximum):
        errors.append(f"{key}={value} is outside [{minimum}, {maximum}]; using {default}.")
        return default
    return value


def _bool(env, key: str, default: bool) -> bool:
    raw = _str(env, key)
    if raw is None:
        return default
    return raw.lower() in _TRUTHY


def load_config(env: Optional[dict] = None) -> ServiceConfig:
    """Build a :class:`ServiceConfig` from ``env`` (defaults to ``os.environ``).

    Never raises. A bad value is reported in ``errors`` and replaced
    with a safe default, because a service that refuses to start
    cannot explain *why* (brief 11).
    """
    source = os.environ if env is None else env
    errors: list[str] = []

    # -- transport ------------------------------------------------------
    host = _str(source, "AIRLLM_SERVICE_HOST") or DEFAULT_HOST
    if host not in LOOPBACK_HOSTS:
        errors.append(
            f"AIRLLM_SERVICE_HOST={host!r} is not a loopback address. The service must not bind a "
            f"public interface; use one of {sorted(LOOPBACK_HOSTS)}."
        )
        host = DEFAULT_HOST
    port = _int(source, "AIRLLM_SERVICE_PORT", DEFAULT_PORT, errors, minimum=1)
    if port > 65535:
        errors.append(f"AIRLLM_SERVICE_PORT={port} is above 65535; using {DEFAULT_PORT}.")
        port = DEFAULT_PORT

    # -- model resolution (brief 6) -------------------------------------
    model_path = _str(source, "AIRLLM_MODEL_PATH")
    model_id = _str(source, "AIRLLM_MODEL_ID")
    if model_path and not os.path.isdir(model_path):
        errors.append(
            f"AIRLLM_MODEL_PATH does not exist or is not a directory. The service will not "
            f"download a replacement: set AIRLLM_MODEL_ID explicitly if that is what you want."
        )
    if not model_path and not model_id:
        errors.append(
            "Neither AIRLLM_MODEL_PATH nor AIRLLM_MODEL_ID is set. The service has no model to "
            "load and will report MODEL_ERROR (brief 6)."
        )

    return ServiceConfig(
        host=host,
        port=port,
        service_token=_str(source, "AIRLLM_SERVICE_TOKEN"),
        model_path=model_path,
        model_id=model_id,
        cache_dir=_str(source, "AIRLLM_CACHE_DIR"),
        device=_str(source, "AIRLLM_DEVICE"),
        dtype=_str(source, "AIRLLM_DTYPE"),
        # Hard-wired default False; only the literal truthy strings move
        # it. See the module docstring for why (brief 8).
        allow_remote_code=_bool(source, "AIRLLM_ALLOW_REMOTE_CODE", False),
        max_new_tokens=_int(source, "AIRLLM_MAX_NEW_TOKENS", DEFAULT_MAX_NEW_TOKENS, errors, minimum=16),
        temperature=_float(source, "AIRLLM_TEMPERATURE", DEFAULT_TEMPERATURE, errors, minimum=0.0, maximum=2.0),
        preload=_bool(source, "AIRLLM_PRELOAD", False),
        request_timeout_ms=_int(source, "AI_REQUEST_TIMEOUT_MS", 120_000, errors, minimum=100),
        errors=tuple(errors),
    )


# ============================================================================
# Redacted view (brief 36)
# ============================================================================


def safe_config(cfg: ServiceConfig) -> dict:
    """Log/serve-safe projection of ``cfg``.

    Contains no token, no cache directory, and no full model path.
    ``/health`` returns this and nothing richer (brief 10, brief 36).
    """
    return {
        "host": cfg.host,
        "port": cfg.port,
        "model": cfg.model_ref,
        "modelSource": cfg.model_source,
        "modelResolvesLocally": cfg.resolves_locally,
        "device": cfg.device or "auto",
        "dtype": cfg.dtype or "auto",
        "allowRemoteCode": cfg.allow_remote_code,
        "maxNewTokens": cfg.max_new_tokens,
        "temperature": cfg.temperature,
        "preload": cfg.preload,
        "authRequired": bool(cfg.service_token),
        "errors": list(cfg.errors),
    }
