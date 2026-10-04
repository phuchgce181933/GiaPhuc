"""PHASE 30 -- PROMPT CONSTRUCTION.

The prompt is a VERSIONED, TEMPLATED artifact (brief 23). There is
exactly one template -- ``providers/strategy_prompt.txt`` -- and its
version is reported in every response and recorded in the Node audit
log, so a stored decision can be traced to the exact wording that
produced it. No prompt string is assembled inline anywhere else in
this service.

STRUCTURE (brief 24, brief 25)
------------------------------
The template is three labelled sections in a fixed order:

    SYSTEM POLICY
        What the model is and is not. It is an advisor. It does not
        create slots, does not assign teachers to periods, cannot
        disable constraints, and may only pick from the enumerated
        vocabulary.

    ALLOWED OUTPUT SCHEMA
        The exact JSON object, its required and optional fields, and
        the typing rules. The model is told that an extra field
        causes rejection, so it learns the same strictness the
        parser enforces.

    FACT DATA
        The SituationReport, serialized as JSON inside explicit
        BEGIN/END delimiters, preceded by a statement that the block
        is data and that instruction-like text inside it must be
        treated as data.

That last part is the injection defense. It is a layered argument
rather than a sanitizer, deliberately: the service never rewrites
subject names or strips anything, because mangling the facts to
defeat an injection would corrupt the very signal the model is being
asked to read. The structural defenses that actually hold are
downstream -- the parser only accepts seven known fields, the schema
rejects anything else, and Node re-validates against an allow-list
this process cannot widen.
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from .schema import ActionPolicy

#: Prompt contract version. Bump this whenever the template text
#: changes in a way that could alter a model's output; it travels to
#: Node in every response and lands in the audit log (brief 23, 35).
PROMPT_VERSION = 1

#: Environment override for the version label, so a deployment can
#: label a fork without editing code. Parsed to an int; a non-integer
#: falls back to :data:`PROMPT_VERSION`.
PROMPT_VERSION_ENV = "AI_STRATEGY_PROMPT_VERSION"

#: Template location, resolved relative to this file so the service
#: works from any working directory.
TEMPLATE_PATH = Path(__file__).resolve().parent.parent / "providers" / "strategy_prompt.txt"

#: Placeholder syntax. One pass, never rescan -- see :func:`render`.
_TOKEN = re.compile(r"\{\{([A-Z][A-Z0-9_]*)\}\}")


class PromptError(RuntimeError):
    """The template is missing or a placeholder was not supplied."""


# ============================================================================
# Template loading
# ============================================================================


@lru_cache(maxsize=1)
def load_template() -> str:
    """Read and cache the prompt template.

    Raises :class:`PromptError` rather than letting a bare
    ``FileNotFoundError`` escape, so a missing template is reported as
    the service-level failure it is (MODEL_ERROR / CONFIG_ERROR) and
    not as a stack trace from an arbitrary depth.
    """
    try:
        return TEMPLATE_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        raise PromptError(f"the prompt template at {TEMPLATE_PATH.name} could not be read: {exc}") from exc


def prompt_version() -> int:
    """Effective prompt version, honouring the environment override."""
    import os

    raw = (os.environ.get(PROMPT_VERSION_ENV) or "").strip()
    if raw.isdigit():
        return int(raw)
    return PROMPT_VERSION


# ============================================================================
# Section builders
# ============================================================================


def _mode_table(modes: tuple[str, ...]) -> str:
    """One indented line per mode, in the order the report listed them."""
    if not modes:
        return "  (none supplied)"
    return "\n".join(f"  - {mode}" for mode in modes)


def _dimension_table(
    active: tuple[str, ...], defaults: dict[str, float]
) -> str:
    if not active:
        return "  (none supplied)"
    return "\n".join(
        f"  - {dim_id} (default weight {defaults[dim_id]:g})" for dim_id in active
    )


def _inactive_list(inactive: tuple[str, ...]) -> str:
    if not inactive:
        return "  (none)"
    return "\n".join(f"  - {dim_id}" for dim_id in inactive)


def _defaults_block(defaults: dict[str, float]) -> str:
    if not defaults:
        return "  (none)"
    return "  " + ", ".join(
        f"{dim_id}={defaults[dim_id]:g}" for dim_id in sorted(defaults)
    )


def _report_json(report: dict[str, Any]) -> str:
    """Serialize the report for the fact-data block.

    ``sort_keys`` and compact separators make the rendered prompt a
    pure function of the report, which is what lets the prompt be
    compared across runs.
    """
    return json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


# ============================================================================
# Rendering
# ============================================================================


def render(template: str, values: dict[str, str]) -> str:
    """Substitute ``{{TOKEN}}`` placeholders in a SINGLE pass.

    Single-pass substitution is a security property, not a stylistic
    one. A sequential ``str.replace`` loop would rescan text it had
    already inserted, so a report containing the literal string
    ``{{MODE_LIST}}`` in a subject name would have its own data
    replaced by the mode list -- a data-driven prompt injection with
    no attacker-written code. :func:`re.sub` with a function never
    rescans replacement text, so the fact block is opaque.
    """
    if "{" in template and _TOKEN.search(template) is None:
        # Guard against a template that lost its placeholder syntax:
        # better to fail than to send a prompt with unfilled tokens.
        raise PromptError("the prompt template contains no {{TOKEN}} placeholders")

    missing = sorted(set(_TOKEN.findall(template)) - set(values))
    if missing:
        raise PromptError(f"prompt template placeholder(s) not supplied: {', '.join(missing)}")

    def substitute(match: re.Match[str]) -> str:
        return values.get(match.group(1), match.group(0))

    return _TOKEN.sub(substitute, template)


def build_prompt(report: dict[str, Any], policy: ActionPolicy | None = None) -> str:
    """Render the full prompt for ``report``.

    :param report: the Phase 29 SituationReport as received on the wire.
    :param policy: pre-built policy, or ``None`` to derive it here.
    """
    active_policy = policy if policy is not None else ActionPolicy(report)

    values = {
        "MODE_LIST": ", ".join(active_policy.modes) or "(none supplied)",
        "MODE_TABLE": _mode_table(active_policy.modes),
        "COUNT_LIST": ", ".join(str(c) for c in active_policy.counts) or "(none supplied)",
        "ACTIVE_DIMENSIONS": _dimension_table(
            active_policy.active_dimensions, active_policy.default_weights
        ),
        "INACTIVE_DIMENSIONS": _inactive_list(active_policy.inactive_dimensions),
        "DEFAULT_WEIGHTS": _defaults_block(active_policy.default_weights),
        "SITUATION_REPORT_JSON": _report_json(report),
    }
    return render(load_template(), values)


def prompt_facts(report: dict[str, Any]) -> str:
    """Just the serialized fact block.

    Exposed separately so tests can assert on the data half of the
    prompt without re-parsing the rendered text.
    """
    return _report_json(report)
