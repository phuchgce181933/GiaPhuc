"""PHASE 30 -- pytest bootstrap.

Two jobs, and nothing else:

1. Put the service root on ``sys.path`` so ``import app`` works from a
   fresh clone with no editable install. ``pytest.ini`` sets the same
   thing via ``pythonpath``; this duplicate is deliberate, because
   ``python -m pytest`` from a different working directory bypasses the
   ini file's relative resolution in some invocations, and a test
   suite that only runs from one directory is a test suite nobody
   runs.

2. Re-export the ``report`` fixture. Fixtures are only auto-discovered
   from ``conftest.py``, so the data lives in ``fixtures.py`` (an
   ordinary importable module the tests can also use directly) and the
   fixture itself is defined here.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

from tests.fixtures import situation_report  # noqa: E402


@pytest.fixture
def report() -> dict:
    """A fresh SituationReport per test, so no test can affect another."""
    return situation_report()
