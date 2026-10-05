# Index

This directory contains the design and audit artifacts for the
`thuanhung_tkb` AI-assisted multi-school timetable optimization
system.

## Documents

| File                              | Phase | Purpose                                                                  |
| --------------------------------- | ----- | ------------------------------------------------------------------------ |
| `DOMAIN.md`                       | 1     | Core entities (Teacher, Branch, Class, Subject, Curriculum, Assignment)  |
| `SCHEDULING_MODEL.md`             | 1     | Time/place abstraction: Day, Period, Session, TimeSlot                   |
| `DATA_CONTRACT.md`                | 1     | Source of truth, fixture policy, missing-data policy                     |
| `SCHEDULING_DATA_CONTRACT.md`     | 1     | Wire shape of every entity (teacher, branch, class, …)                  |
| `CONSTRAINTS.md`                  | 1     | Hard / Soft / Objective separation                                       |
| `AI_STRATEGY.md`                  | 1     | AI participation in optimization (weights, priorities, multi-strategy)   |
| `OPTIMIZATION_INTERFACE.md`       | 1     | Solver contract: input, output, multi-solution, diversification         |
| `VALIDATOR.md`                    | 1     | Independent validator: required checks, no bypass                        |
| `EXPLANATION.md`                  | 1     | Structured reasons (`WHY_*`) and the explanation pipeline                |
| `PIPELINE.md`                     | 1     | End-to-end flow: Data → AI → Solver → Validator → Preview → Commit       |
| `REAL_DATA_READINESS.md`          | 14    | Phase 14 audit: data-source readiness, no-invention rule, status table   |
| `REAL_DATASET_STATUS.md`          | 15    | Phase 15 per-entity READY/MISSING report (current run)                   |
| `FIRST_REAL_RUN_REPORT.md`        | 15    | Phase 15 first-run report: what happened and why no solver ran           |
| `FIRST_REAL_RUN_METRICS.json`     | 15    | Phase 15 structured preview output for the current run                   |
| `REAL_DATA_SOURCE_MAP.md`         | 18    | Phase 18 source-of-truth map (loader paths, fields, missing-data behavior) |
| `REAL_TKB_RUN.md`                 | 18    | Phase 18 first-real-run report (orchestrator probe, 14-question answers) |
| `REAL_TKB_PATTERN_ANALYSIS.md`    | 18    | Phase 18 "one-color" pattern audit (template + honest empty report)      |
| `PHASE_19_LEGACY_DATA_INGESTION.md` | 19  | Phase 19 legacy MongoDB dump ingestion (5-layer model + 7 anomalies)     |
| `LEGACY_DATA_SOURCE_MAP.md`       | 19    | Phase 19 collection → entity mapping (field-level)                       |
| `PHASE_20_ORCHESTRATOR_DRYRUN_AUDIT.md` | 20 | Phase 20 dry-run audit (verify.js + 16 sections + 2 known projection issues) |
| `PHASE_21_PROJECTION_FIX.md`           | 21 | Phase 21 projection-fix audit (Bug #1 curriculum classId, Bug #2 chuyenMon subjectId) |
| `CONSTRAINT_SPECIFICATION.md`          | 22 | Phase 22 authoritative constraint catalog (H01–H14, S01–S08) |
| `PHASE_22_CONSTRAINT_AUDIT.md`         | 22 | Phase 22 real-data audit + legacy baseline evaluation (read-only) |
| `PHASE_22_1_BASELINE_RECONCILIATION.md`| 22.1 | Phase 22.1 identity-bug reconciliation (H01/H02 vs raw 802) |
| `PHASE_23_SOLVER_CORRECTNESS.md`        | 23    | Phase 23 solver correctness on real data (27 invariants)  |
| `PHASE_24_TEACHER_ASSIGNMENT_OPTIMIZATION.md` | 24 | Phase 24 teacher-assignment optimization (BASE_FEASIBLE vs ASSIGNMENT_BALANCED, metrics, controlled fixture) |
| `PHASE_25_GLOBAL_ASSIGNMENT_OPTIMIZATION.md` | 25 | Phase 25 global assignment optimization (GLOBAL_ASSIGNMENT_BALANCED, comparator, BEST_FOUND verdict) |
| `PHASE_26_TRANSFER_TRAVEL_READINESS.md`   | 26 | Phase 26 transfer semantics + travel readiness (transfer/travel formalization; H14 stays UNSUPPORTED; no fake matrix) |
| `PHASE_27_MULTI_SOLUTION_DIVERSITY.md`     | 27 | Phase 27 multi-solution + structural diversity (generateSolutions; id uniqueness; quality-first; H14 still UNSUPPORTED) |
| `PHASE_28_GLOBAL_SCORING_SELECTION.md`     | 28 | Phase 28 global scoring + final selection (dimension catalog; score vector; quality-first greedy farthest-point; travel/transfer inactive) |
| `PHASE_29_AI_STRATEGY_LAYER.md`            | 29 | Phase 29 AI strategy layer (situation report; untrusted planner seam; validator boundary; deterministic fallback) |
| `PHASE_30_AIRLLM_LOCAL_PROVIDER.md`        | 30 | Phase 30 AirLLM local provider (Python ai-service over loopback; prompt contract; timeout/fallback; no GPU needed to test) |
| `PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md`    | 31 | Phase 31 real AirLLM smoke test + AI strategy quality benchmark (Tier A runtime vs Tier B usefulness, kept apart; fallback vs AirLLM on one fixed input; verdict from data or `AIRLLM_BENCHMARK_BLOCKED`) |
| `PHASE_31_1_RUNTIME_VERIFICATION.md`       | 31.1 | Phase 31.1 test stabilization + AirLLM runtime verification (determinism split into `DETERMINISTIC_SEARCH` / `TIME_BUDGETED_SEARCH` via a seed-stable `maxSearchIterations`; four clean full-suite runs under load; AirLLM **BLOCKED** with the captured evidence and the exact steps to unblock) |
| `PHASE_32_E2E_API_UI.md`                   | 32   | Phase 32 end-to-end API + UI (`/api/schedules/*`; closed request vocabulary; PII whitelist; AI/travel/transfer honesty blocks; preview-only commit; the six-day grid; why `/api/scheduling` and `/api/schedules` coexist; the two defects caught only by running the stack) |
| `PHASE_33_SCHEDULE_COMMIT_PERSISTENCE.md`  | 33   | Phase 33 schedule commit + persistence (generate stays preview; explicit confirm; backend re-validates before writing; the exact selected candidate persisted; atomic all-or-nothing write; `requestId+solutionId` idempotency; append-only versioning as the concurrency policy; readback verification; no client-side trust; audit metadata; the six documented limitations) |
| `PHASE_34_PERSISTENCE_HARDENING.md`        | 34   | Phase 34 persistence hardening (durable preview store; candidate integrity hash; restart-safe and cross-process-safe commit; unique version claims via `link(2)`; atomic writes; a real cross-process sweep bug found and fixed) |
| `PHASE_35_REAL_AIRLLM_RUNTIME.md`           | 35   | Phase 35 real AirLLM runtime (environment verified from the runtime, not from config: torch 2.14.1+cu130, AirLLM 4.0.0, RTX 4060 with CUDA proven by a real matmul; a real INSTRUCT checkpoint with weights proven on disk; `/ready` MODEL_READY and `/plan` returning a real `StrategyDecision`; five defects only a live model exposed, fixed in the adapter and the transport; 5x5 benchmark on one shared-pool yardstick; verdict `AI_STRATEGY_WORSE_THAN_FALLBACK` on Qwen2.5-1.5B-Instruct) |

## Authoritative fixture

`data/fixtures/teachers.authoritative.json` is the immutable source of
truth for the five teachers used in regression tests. It must not be
sorted, renamed, normalized, cleaned or deduplicated.

## Phase-1 exit criteria

- [x] Authoritative fixture exists and matches the source byte-for-byte.
- [x] Every entity has a defined shape and source of truth.
- [x] Hard vs. soft constraints are explicitly classified.
- [x] AI strategy and solver contracts are described as interfaces, not
      implementations.
- [x] Validator requirements are independent of the solver.
- [x] Missing-data policy is explicit for every optional field.

Implementation starts in **Phase 2**.
