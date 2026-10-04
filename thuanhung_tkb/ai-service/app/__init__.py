"""AI service package.

Holds the AirLLM-backed implementation of the Phase 29 ``AIPlanner``
seam. Every module here is importable WITHOUT airllm, torch, or
transformers installed -- model imports are lazy and live in
``runtime.py`` alone. That is what lets the default test suite run
on a machine with no GPU and no model (brief 45).
"""

__all__ = ["__version__"]

__version__ = "1.0.0"
