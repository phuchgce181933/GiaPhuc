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
