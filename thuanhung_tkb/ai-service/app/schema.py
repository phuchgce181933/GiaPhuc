"""PHASE 30 -- PYTHON-SIDE STRATEGY DECISION SCHEMA.

This is the FIRST of two validation layers (brief 16):

    AirLLM text
      -> parse/normalize  (parser.py)
      -> THIS layer       (Python, untrusted-by-policy)
      -> Node StrategyValidator   (authority)

Neither layer is optional and neither replaces the other. This one
exists so a clearly-bad model response never crosses the process
boundary; Node's exists because this service is not trusted and Node
is the authority. Both run, always (brief 16).

WHERE THE VOCABULARY COMES FROM
------------------------------
Not from constants in this file. The allowed modes, candidate counts,
and active dimensions are read out of the SituationReport that Node
sent, which Node built from its own dimension catalog and strategy
table. That is the whole point:

  * The report is Node's output, so this layer cannot invent a mode
    or a dimension -- there is nothing here to widen the allow-list
    with (brief 17, brief 20).
  * If the report is missing the vocabulary sections, the policy
    falls back to an EMPTY allow-list rather than to a hardcoded copy.
    Empty means "nothing is allowed", which fails closed. A service
    that carried its own copy of the modes would drift the moment
    Node added a mode, and the drift would be silent.

WHAT THIS LAYER DOES NOT DO
---------------------------
It does not decide weight BOUNDS. Bounds are Node's, authoritatively
(brief 20), so a weight that is a finite non-negative number is
passed through at whatever magnitude the model chose and Node clamps
it. Inventing a bound here would be a second, competing source of
truth for the same policy.

It also does not schedule anything. The only keys it will ever emit
are the seven decision fields; there is no code path that can produce
``day``, ``session``, ``period``, or ``teacherId`` (brief 54, 22).
"""

from __future__ import annotations

import math
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

# ============================================================================
# Vocabulary
# ============================================================================

#: The complete set of decision fields, mirroring the Node
#: ``ALLOWED_DECISION_FIELDS``. Extra fields are FORBIDDEN (brief 15):
#: an unrecognized key is how a model would try to smuggle in
#: ``disableConstraints`` or a schedule slot, so it is rejected rather
#: than dropped -- a silent drop would still be a lie in the audit
#: log.
DECISION_FIELDS = (
    "optimizationMode",
    "candidateCount",
    "scoringWeights",
    "priorities",
    "rationale",
    "confidence",
    "source",
)

#: Optional fields. Everything else is required to be present.
REQUIRED_DECISION_FIELDS = ("optimizationMode", "candidateCount", "scoringWeights")

PRIORITY_LEVELS = ("LOW", "MEDIUM", "HIGH")
DEFAULT_PRIORITY = "MEDIUM"

#: What this service calls itself in the decision's ``source`` field.
SERVICE_SOURCE = "airllm"


# ============================================================================
# Request
# ============================================================================


class PlanRequest(BaseModel):
    """Body of ``POST /plan``.

    The only accepted body is ``{"situationReport": {...}}`` (brief 4).
    There is no field for a SchedulingInput, a list of slots, a
    teacher record, or credentials -- the model cannot ask for the
    data this service is not allowed to have (brief 21, 22, 55).
    """

    model_config = ConfigDict(extra="forbid")

    #: Required, with no default. A missing field is a schema error
    #: and FastAPI answers 422; a present-but-empty object is a
    #: semantic error and the route answers 400. Splitting them keeps
    #: "you sent the wrong shape" distinguishable from "you sent a
    #: report with nothing in it", and both map to
    #: AI_UNSUPPORTED_REQUEST on the Node side.
    situation_report: dict[str, Any] = Field(
        alias="situationReport",
        description="Phase 29 SituationReport: aggregate facts, PII-free, slot-free.",
    )

    @field_validator("situation_report")
    @classmethod
    def _require_object(cls, value: Any) -> dict[str, Any]:
        if not isinstance(value, dict):
            raise ValueError("situationReport must be a JSON object")
        return value


# ============================================================================
# Policy derived from the report
# ============================================================================


class ActionPolicy:
    """The allow-list, read out of the SituationReport.

    Constructed with whatever the report contained. Missing sections
    become empty sets, so an unexpected or truncated report yields a
    policy that permits nothing and therefore rejects everything.
    """

    def __init__(self, report: dict[str, Any]) -> None:
        action_space = report.get("actionSpace")
        action_space = action_space if isinstance(action_space, dict) else {}

        modes = action_space.get("optimizationModes")
        self.modes: tuple[str, ...] = tuple(m for m in modes if isinstance(m, str)) if isinstance(modes, list) else ()

        counts = action_space.get("candidateCounts")
        self.counts: tuple[int, ...] = (
            tuple(c for c in counts if isinstance(c, int) and not isinstance(c, bool))
            if isinstance(counts, list)
            else ()
        )

        availability = report.get("dimensionAvailability")
        availability = availability if isinstance(availability, dict) else {}

        # Active dimensions carry the catalog default weight, which is
        # exactly what Node would substitute for a dimension the model
        # stayed silent about. Reusing it keeps the two layers from
        # disagreeing about defaults.
        active_rows = availability.get("active")
        self.default_weights: dict[str, float] = {}
        if isinstance(active_rows, list):
            for row in active_rows:
                if not isinstance(row, dict):
                    continue
                dim_id = row.get("id")
                if not isinstance(dim_id, str):
                    continue
                raw_default = row.get("defaultWeight")
                if isinstance(raw_default, (int, float)) and not isinstance(raw_default, bool):
                    self.default_weights[dim_id] = float(raw_default)

        # `active` is authoritative for membership; the default-weight
        # map is only a source of values. A dimension with a default
        # weight but no presence in `active` is NOT weightable.
        self.active_dimensions: tuple[str, ...] = tuple(
            sorted(self.default_weights.keys())
        )

        inactive_rows = availability.get("inactive")
        self.inactive_dimensions: tuple[str, ...] = tuple(
            sorted(
                str(row["id"])
                for row in (inactive_rows or [])
                if isinstance(row, dict) and isinstance(row.get("id"), str)
            )
        ) if isinstance(inactive_rows, list) else ()

    # ------------------------------------------------------------------
    @property
    def is_usable(self) -> bool:
        """True when the report supplied a usable action space.

        A policy with no modes, no counts, or no active dimensions
        cannot validate anything, and the service reports that as an
        unusable request rather than guessing a default.
        """
        return bool(self.modes) and bool(self.counts) and bool(self.active_dimensions)

    def summary(self) -> dict[str, Any]:
        """Redacted description for the audit log."""
        return {
            "modes": list(self.modes),
            "counts": list(self.counts),
            "activeDimensions": list(self.active_dimensions),
            "inactiveDimensions": list(self.inactive_dimensions),
        }


# ============================================================================
# Decision
# ============================================================================


class StrategyDecision(BaseModel):
    """The normalized decision this service is willing to send to Node.

    ``extra="forbid"`` makes the field list above the real contract:
    a model that invents a field cannot have it survive this class.
    """

    model_config = ConfigDict(extra="forbid")

    optimization_mode: str = Field(alias="optimizationMode")
    candidate_count: int = Field(alias="candidateCount")
    scoring_weights: dict[str, float] = Field(alias="scoringWeights")
    priorities: Optional[dict[str, str]] = Field(default=None, alias="priorities")
    rationale: Optional[str] = Field(default=None, alias="rationale")
    confidence: Optional[float] = Field(default=None, alias="confidence")
    source: str = Field(default=SERVICE_SOURCE, alias="source")

    def to_wire(self) -> dict[str, Any]:
        """Serialize with the camelCase keys Node's allow-list expects."""
        payload: dict[str, Any] = {
            "optimizationMode": self.optimization_mode,
            "candidateCount": self.candidate_count,
            "scoringWeights": dict(self.scoring_weights),
            "source": self.source,
        }
        if self.priorities is not None:
            payload["priorities"] = dict(self.priorities)
        if self.rationale is not None:
            payload["rationale"] = self.rationale
        if self.confidence is not None:
            payload["confidence"] = self.confidence
        return payload


class SchemaResult:
    """Outcome of normalizing a model response.

    Mirrors Node's ``ValidationResult`` shape (ok / corrections /
    failure) so the audit log reads the same on both sides.
    """

    __slots__ = ("ok", "decision", "corrections", "error")

    def __init__(
        self,
        ok: bool,
        decision: Optional[StrategyDecision] = None,
        corrections: Optional[list[str]] = None,
        error: Optional[str] = None,
    ) -> None:
        self.ok = ok
        self.decision = decision
        self.corrections = corrections or []
        self.error = error

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"SchemaResult(ok={self.ok}, corrections={len(self.corrections)}, error={self.error!r})"


class SchemaError(ValueError):
    """Raised by :func:`normalize_decision`; caught by the service."""


# ============================================================================
# Normalization
# ============================================================================


def _is_number(value: Any) -> bool:
    """True for a real JSON number.

    ``bool`` is excluded explicitly: ``isinstance(True, int)`` is True
    in Python, and a model that emitted ``true`` for a weight meant
    something other than 1.0 (brief 15, wrong types rejected).
    """
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def normalize_decision(raw: Any, policy: ActionPolicy) -> SchemaResult:
    """Validate and normalize a parsed model response.

    Policy, in order:

    1. Unknown top-level field              -> reject (brief 15)
    2. Missing required field               -> reject
    3. ``optimizationMode`` not in policy   -> reject (brief 17)
    4. ``candidateCount`` not in policy     -> reject (brief 19)
    5. Weight on an UNKNOWN dimension       -> reject (brief 18)
    6. Weight on an INACTIVE dimension      -> drop + record (brief 18, 53)
    7. Non-finite or negative weight        -> reject (brief 20)
    8. Out-of-range weight magnitude        -> PASS THROUGH (brief 20)
    9. Weight on an omitted active dimension-> default + record
    10. Unknown priority level              -> clamp to MEDIUM + record
    11. Non-string rationale / bad confidence -> drop + record

    Step 8 is the one that looks like a gap and is not. Bounds belong
    to Node (brief 20). This layer does not clamp, does not round, and
    does not substitute a bound of its own; it forwards the number and
    lets ``validateStrategyDecision`` -- the authority -- decide.
    """
    if not policy.is_usable:
        raise SchemaError(
            "the situation report carries no usable action space, so no decision can be validated"
        )
    if not isinstance(raw, dict):
        raise SchemaError("the model response is not a JSON object")

    corrections: list[str] = []

    # -- 1. unknown fields ---------------------------------------------
    unknown = sorted(k for k in raw if k not in DECISION_FIELDS)
    if unknown:
        raise SchemaError(
            f"the model returned unrecognized field(s): {', '.join(unknown)}. "
            "The decision schema has no such field and unknown fields are rejected, not ignored."
        )

    # -- 2. required fields --------------------------------------------
    missing = [f for f in REQUIRED_DECISION_FIELDS if f not in raw]
    if missing:
        raise SchemaError(f"the model response is missing required field(s): {', '.join(missing)}")

    # -- 3. optimizationMode -------------------------------------------
    mode = raw["optimizationMode"]
    if not isinstance(mode, str) or mode not in policy.modes:
        raise SchemaError(
            f"optimizationMode must be one of {list(policy.modes)}; got {mode!r}"
        )

    # -- 4. candidateCount ---------------------------------------------
    raw_count = raw["candidateCount"]
    # A quoted number is a model formatting slip, not a request for
    # something outside the action space, so it is normalized here.
    # It is still checked against the allowed set afterwards.
    count = raw_count
    if isinstance(count, str) and count.strip():
        try:
            count = int(count.strip())
        except ValueError:
            raise SchemaError(f"candidateCount is not a number: {raw_count!r}") from None
    if not isinstance(count, int) or isinstance(count, bool) or count not in policy.counts:
        raise SchemaError(
            f"candidateCount must be one of {list(policy.counts)}; got {raw_count!r}"
        )

    # -- 5-9. weights ----------------------------------------------------
    raw_weights = raw["scoringWeights"]
    if not isinstance(raw_weights, dict):
        raise SchemaError("scoringWeights must be a JSON object")

    weights: dict[str, float] = {}
    for dim_id, value in raw_weights.items():
        if dim_id not in policy.default_weights:
            if dim_id in policy.inactive_dimensions:
                # Step 6: known but INACTIVE. TRAVEL / TRANSFER /
                # CHANGED_ASSIGNMENTS. Dropped entirely so it cannot
                # be "activated" by naming it (brief 18, 53).
                corrections.append(
                    f"dropped weight {value!r} for INACTIVE dimension {dim_id}; "
                    "an inactive dimension cannot be activated by the model"
                )
                continue
            # Step 5: not a dimension at all.
            raise SchemaError(
                f"scoringWeights references unknown dimension {dim_id!r}; "
                "the model may not create scoring dimensions"
            )
        if not _is_number(value):
            raise SchemaError(f"weight for {dim_id} must be a JSON number; got {value!r}")
        number = float(value)
        if not math.isfinite(number):
            raise SchemaError(f"weight for {dim_id} is not finite: {value!r}")
        if number < 0:
            raise SchemaError(f"weight for {dim_id} is negative: {number}")
        # Step 8: no bound applied here. Node owns the bound.
        weights[dim_id] = number

    # Step 9: fill omissions from the catalog defaults Node supplied.
    for dim_id in policy.active_dimensions:
        if dim_id not in weights:
            weights[dim_id] = policy.default_weights[dim_id]
            corrections.append(
                f"omitted {dim_id}; used the catalog default weight {policy.default_weights[dim_id]}"
            )

    # -- 10. priorities ---------------------------------------------------
    priorities: Optional[dict[str, str]] = None
    raw_priorities = raw.get("priorities")
    if raw_priorities is not None:
        if not isinstance(raw_priorities, dict):
            raise SchemaError("priorities must be a JSON object when present")
        priorities = {}
        for dim_id, level in raw_priorities.items():
            if dim_id not in policy.active_dimensions:
                if dim_id in policy.inactive_dimensions:
                    raise SchemaError(
                        f"priorities assigns a level to INACTIVE dimension {dim_id!r}"
                    )
                raise SchemaError(f"priorities references unknown dimension {dim_id!r}")
            if not isinstance(level, str) or level not in PRIORITY_LEVELS:
                priorities[dim_id] = DEFAULT_PRIORITY
                corrections.append(
                    f"priority for {dim_id} was {level!r}; clamped to {DEFAULT_PRIORITY}"
                )
            else:
                priorities[dim_id] = level

    # -- 11. rationale / confidence --------------------------------------
    rationale = raw.get("rationale")
    if rationale is not None and not isinstance(rationale, str):
        corrections.append("rationale was not a string and was dropped; it is never parsed as logic")
        rationale = None

    confidence = raw.get("confidence")
    if confidence is not None:
        if _is_number(confidence) and math.isfinite(float(confidence)) and 0.0 <= float(confidence) <= 1.0:
            confidence = float(confidence)
        else:
            corrections.append(f"confidence {confidence!r} was not a number in [0, 1] and was dropped")
            confidence = None

    decision = StrategyDecision(
        optimizationMode=mode,
        candidateCount=count,
        scoringWeights=weights,
        priorities=priorities,
        rationale=rationale,
        confidence=confidence,
        source=SERVICE_SOURCE,
    )
    return SchemaResult(ok=True, decision=decision, corrections=corrections)


def decision_hash(decision: StrategyDecision) -> str:
    """Stable short hash of the decision's MEANING (brief 58).

    Deliberately excludes ``rationale``: prose is not part of what the
    decision does, so re-wording it must not produce a new hash, or
    the audit log fills with hashes that mean "the same thing".

    Weight keys are sorted so dict ordering cannot leak into the hash.
    """
    import hashlib

    material = "|".join(
        [
            decision.optimization_mode,
            str(decision.candidate_count),
            ";".join(f"{k}={decision.scoring_weights[k]!r}" for k in sorted(decision.scoring_weights)),
        ]
    )
    return hashlib.sha256(material.encode("utf-8")).hexdigest()[:16]
