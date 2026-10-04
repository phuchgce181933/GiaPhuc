"""PHASE 30 -- PYTHON CONTRACT TESTS.

Covers checks 18-28 of the brief: /health, /ready, /plan, the prompt
contract, the parser, the schema, the failure paths, and the two
structural guarantees that this service cannot build a schedule and
cannot reach a database.

Running without a model
-----------------------
Every test here runs with NO airllm, NO torch, and NO model. The
runtime is constructed with a stub generator factory, so the routes,
the prompt, the parser, and the schema are all exercised for real
while the inference step returns fixed text. That is the mechanism
behind brief 45: the default Python suite must pass on a machine
where AirLLM cannot possibly work.

Checks 29-32 (a real model loading and a real pipeline) are NOT here.
They live behind ``AIRLLM_INTEGRATION=1`` in test_integration.py and
skip by default (brief 28).
"""
