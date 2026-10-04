"""PHASE 30 -- STRICT OUTPUT PARSER.

Turns raw model text into a Python object, or fails. There is no
middle path (brief 15).

WHAT IS REJECTED
----------------
  * prose before or after the JSON          -> reject
  * invalid JSON                            -> reject
  * a JSON array, string, or bare number    -> reject
  * two or more fenced code blocks          -> reject
  * an unterminated fence                   -> reject
  * empty output                            -> reject

THE ONE NORMALIZATION
---------------------
A single fenced code block is unwrapped, and nothing else is. That is
a bounded, deterministic transform with an unambiguous inverse: the
content between the fences must itself be a complete JSON object. It
is not "guessing", because nothing inside is inspected, repaired, or
reinterpreted -- if the fenced content is not valid JSON it is
rejected exactly as if it had not been fenced at all.

WHAT IS DELIBERATELY NOT IMPLEMENTED
-------------------------------------
No brace matching, no "find the first brace and the last brace", no
regex that hunts for keys, no trailing-comma repair, no unescaping of
smart quotes, no truncation of an over-long number.

The reason is that each of those is a guess, and a guess that
succeeds is indistinguishable from a guess that does not. A parser
that "recovers" a decision from half a response is a parser that will
eventually recover a decision from text that was never a decision.
Since the value of accepting a marginal response is one more AI run,
while the cost is a decision nobody can explain, the correct trade is
always to reject and let the deterministic fallback run.

Rejection is cheap and safe here precisely because the failure is
observable: the service answers with ``fallbackUsed: true`` and a
reason, Node maps that to ``AI_PARSE_ERROR``, and the schedule is
produced by the fallback path (brief 12, 13, 26).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Optional

#: A response larger than this is refused without being parsed. It is
#: a runaway generation or a mistake, and ``json.loads`` on a
#: multi-megabyte string is not worth the chance of a stall.
MAX_RESPONSE_CHARS = 64_000

_FENCE = "```"


class ParseError(ValueError):
    """The model text is not a usable JSON object."""


@dataclass(frozen=True)
class ParseResult:
    """A successfully parsed value, plus what had to be unwrapped."""

    value: Any
    #: True when the JSON arrived inside a single code block.
    unwrapped_from_fence: bool


# ============================================================================
# Fence scanning
# ============================================================================


def _fenced_blocks(text: str) -> list[tuple[str, str]]:
    """Return ``(info_string, content)`` for every closed fence, in order.

    A plain forward scan, not a pattern match over JSON. It locates
    whole fenced blocks and nothing else; it never looks for braces,
    quotes, or keys, and it has no notion of what the content means.

    An unterminated trailing fence yields no block, which the caller
    reports as a parse failure rather than silently repairing.
    """
    blocks: list[tuple[str, str]] = []
    cursor = 0
    while True:
        start = text.find(_FENCE, cursor)
        if start == -1:
            return blocks
        line_end = text.find("\n", start)
        if line_end == -1:
            # A fence with no newline after it is not a complete block.
            return blocks
        info = text[start + len(_FENCE) : line_end].strip().lower()
        close = text.find(_FENCE, line_end)
        if close == -1:
            return blocks
        blocks.append((info, text[line_end + 1 : close]))
        cursor = close + len(_FENCE)


# ============================================================================
# Parsing
# ============================================================================


def parse_model_output(text: Any) -> ParseResult:
    """Parse ``text`` into a JSON OBJECT, or raise :class:`ParseError`.

    Accepts exactly two shapes:

      1. a bare JSON object, with optional surrounding whitespace;
      2. that same object inside one fenced code block, with nothing
         outside the fence except whitespace.

    "Object" is required, not merely "valid JSON". A bare array, a
    number, a string, and ``null`` are all well-formed JSON and are all
    still wrong: the model's answer is a decision, and a decision is an
    object. Accepting them here would only move the rejection one layer
    down, where the error message would be less useful (brief 15).
    """
    if not isinstance(text, str):
        raise ParseError(f"the model returned {type(text).__name__}, not text")
    if not text.strip():
        raise ParseError("the model returned no output")
    if len(text) > MAX_RESPONSE_CHARS:
        raise ParseError(
            f"the model returned {len(text)} characters, above the "
            f"{MAX_RESPONSE_CHARS}-character limit"
        )

    # -- 1. strict parse of the whole response -------------------------
    try:
        return _require_object(json.loads(text))
    except json.JSONDecodeError as whole_error:
        last_error = whole_error

    # -- 2. the single bounded normalization ---------------------------
    blocks = _fenced_blocks(text)
    if len(blocks) > 1:
        raise ParseError(
            f"the response contains {len(blocks)} fenced code blocks; exactly one is required"
        )
    if len(blocks) == 1:
        inner = blocks[0][1].strip()
        if not inner:
            raise ParseError("the fenced code block is empty")
        try:
            return _require_object(json.loads(inner), unwrapped_from_fence=True)
        except json.JSONDecodeError as exc:
            raise ParseError(
                f"the fenced code block is not valid JSON: {exc.msg} "
                f"at line {exc.lineno} column {exc.colno}"
            ) from exc

    # No fence. Report the ORIGINAL strict-parse failure, which is the
    # most useful thing we know, rather than complaining about fences
    # the response never contained.
    raise ParseError(
        f"the response is not valid JSON: {last_error.msg} "
        f"at line {last_error.lineno} column {last_error.colno}"
    )


def _require_object(value: Any, unwrapped_from_fence: bool = False) -> ParseResult:
    """Wrap a decoded JSON value, refusing anything that is not an object."""
    if not isinstance(value, dict):
        raise ParseError(
            f"the response is valid JSON but is a {_json_type_name(value)}, "
            "and a decision must be a JSON object"
        )
    return ParseResult(value, unwrapped_from_fence=unwrapped_from_fence)


def _json_type_name(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return type(value).__name__


def parse_decision_payload(text: Any) -> tuple[Any, bool]:
    """Convenience wrapper returning ``(value, unwrapped_from_fence)``."""
    result = parse_model_output(text)
    return result.value, result.unwrapped_from_fence
