# thuanhung_tkb

AI-assisted multi-school timetable optimization system. New project,
no migration from prior code.

## Status

| Phase  | Description                         | State      |
| ------ | ----------------------------------- | ---------- |
| 1      | Domain & data design                | done       |
| 2      | Data model (teacher normalization)  | done       |
| 3      | Scheduling model (time/place)       | done       |
| 4      | Constraint model (H_/S_)            | done       |
| 5      | Optimization engine (backtracking)  | done       |
| 6      | Independent validator               | done       |
| 7      | Scoring (deterministic)             | done       |
| 8      | Diversity (slot-set distance)       | done       |
| 9      | AI strategy layer (A/B/C presets)   | done       |
| 10     | Multiple solutions                  | done       |
| 11     | Preview API (`POST /preview`)       | done       |
| 12     | Frontend (Vite + React stub)        | done       |
| 13     | Commit (re-validate + write)        | partial    |
| 14     | Real data readiness & validation    | done       |
| 15     | Real dataset integration & run      | done (no-solver run) |

`Commit` is partial: the orchestrator re-validates and returns the
solution from the preview cache, but it does NOT yet write to
MongoDB. The MongoDB writer is a Phase 13 follow-up that requires
real data.

Phase 14 added `src/domain/validate.js` as the single source of
truth for `INVALID_INPUT` vs `MISSING_DATA` classification. The
audit trail lives in `docs/REAL_DATA_READINESS.md`; it lists every
data source's readiness state and the no-invention rule.

Phase 15 added `src/loader/dataset.js` (a JSON dataset loader
that reads a single file containing the full `SchedulingInput`)
and the `DATASET_PATH` env switch. The current dataset
(teacher fixture only) is **not** sufficient to schedule; the
runtime correctly returns `status: MISSING_DATA` and skips the
solver. The first-run record lives in
`docs/FIRST_REAL_RUN_REPORT.md` and the structured output in
`docs/FIRST_REAL_RUN_METRICS.json`. No invented data, no
production DB write, no fake AI call.

## Layout

```text
.
├── backend/                       Node 20+, Express, no Mongo writer yet
│   ├── src/
│   │   ├── config/index.js        env loader, fixture path
│   │   ├── domain/                pure modules
│   │   │   ├── time.js            day/period/session utilities
│   │   │   ├── teacher.js         normalize + missing-data
│   │   │   ├── workload.js        Σ soTietTuan
│   │   │   ├── eligibility.js     teacher ↔ subject
│   │   │   ├── travel.js          TravelProvider + checkTransition
│   │   │   ├── constraints.js     H_*/S_* catalog, noGap, workload
│   │   │   ├── strategies.js      preset A/B/C
│   │   │   ├── solver.js          backtracking CSP w/ solution_penalty
│   │   │   ├── validator.js       independent audit
│   │   │   ├── scorer.js          weighted overall score
│   │   │   ├── diversity.js       slot-set Jaccard distance
│   │   │   ├── explain.js         WHY_* event builder + renderer
│   │   │   ├── situation.js       structured analysis
│   │   │   └── validate.js        pre-scheduler input validator (Phase 14)
│   │   ├── loader/
│   │   │   ├── fixture.js         byte-identical teacher fixture reader
│   │   │   ├── dataset.js         JSON dataset reader (full SchedulingInput, Phase 15)
│   │   │   └── index.js           entry point (mongo / dataset / fixture dispatch)
│   │   ├── orchestrator/index.js  preview + commit
│   │   ├── routes/scheduling.js   /api/scheduling
│   │   ├── app.js                 express factory
│   │   ├── server.js              entry point
│   │   └── utils/prng.js          mulberry32
│   ├── tests/                     98 tests, all green (44 phase 1-13 + 43 phase 14 + 11 phase 15)
│   ├── .env.example
│   └── package.json
├── frontend/                      Vite + React stub
│   ├── src/
│   │   ├── App.jsx                tab shell
│   │   ├── main.jsx
│   │   ├── pages/Generate.jsx     AI Generate UI
│   │   └── services/
│   │       ├── api.js             base URL
│   │       └── scheduling.js      preview / commit
│   ├── index.html
│   ├── vite.config.js             dev proxy → backend :4010
│   └── package.json
├── data/
│   ├── fixtures/
│   │   └── teachers.authoritative.json  byte-identical source
│   └── config/                    (empty; awaiting branch profile)
└── docs/                          Phase 1, 14, 15 design + audit artifacts
    ├── 00_INDEX.md
    ├── DOMAIN.md
    ├── SCHEDULING_MODEL.md
    ├── DATA_CONTRACT.md
    ├── SCHEDULING_DATA_CONTRACT.md
    ├── CONSTRAINTS.md
    ├── AI_STRATEGY.md
    ├── OPTIMIZATION_INTERFACE.md
    ├── VALIDATOR.md
    ├── EXPLANATION.md
    ├── PIPELINE.md
    ├── REAL_DATA_READINESS.md     Phase 14: data-source readiness audit
    ├── REAL_DATASET_STATUS.md     Phase 15: per-entity READY/MISSING report
    ├── FIRST_REAL_RUN_REPORT.md   Phase 15: first-run report (no-solver)
    └── FIRST_REAL_RUN_METRICS.json Phase 15: structured preview output
```

## Authoritative fixture

`data/fixtures/teachers.authoritative.json` contains the five
teachers from the brief, byte-identical to the source.

| hoTen  | Specializations                              | Workload | nguyenVong                                  |
| ------ | -------------------------------------------- | -------- | ------------------------------------------- |
| kim    | Công nghệ (1), Tin học (1)                   | 2        | soBuoiToiDa=4, buoiUuTien=ca_hai, thuNghi=[] |
| thư    | Tiếng Anh (4)                                | 4        | — (absent)                                  |
| trinh  | Mỹ thuật (1)                                 | 1        | soBuoiToiDa=4, buoiUuTien=chieu, thuNghi=[] |
| trâm   | Âm nhạc (1)                                  | 1        | — (absent)                                  |
| nản    | Giáo dục thể chất (2)                        | 2        | — (absent, per second brief)                |

`thư`, `trâm`, and `nản` deliberately have no `nguyenVong`. The
system must treat this as `undefined` and never invent a default.

## Run

### Backend

```bash
cd backend
npm install
npm test          # 98 tests
npm start         # listens on :4010
```

### Frontend

```bash
cd frontend
npm install
npm run dev       # Vite dev server on :5173, proxies /api → :4010
```

## API

`POST /api/scheduling/preview` returns one of four statuses:

| Status           | When                                            | HTTP |
| ---------------- | ----------------------------------------------- | ---- |
| `OK`             | At least one accepted solution was produced.    | 200  |
| `EMPTY`          | The solver ran but produced no candidate.       | 200  |
| `MISSING_DATA`   | Critical entities (Branch / Class / Curriculum / Assignment / Travel) are absent. The solver is skipped; the response lists the missing entities. | 200  |
| `INVALID_INPUT`  | The caller supplied a broken model (unknown FK, ineligible teacher, missing required field). The solver is never invoked; the response includes an `invalidInput` array. | 400  |

The status is reported as `out.status` in the JSON body.

`POST /api/scheduling/preview`

```json
{ "options": { "solutions": 3, "strategies": ["A_PREFERENCE_FIRST"] } }
```

Response (truncated):

```json
{
  "situation": { "teachers": [...], "branches": [], "shortage": [], "unresolvable": [] },
  "solutions": [],
  "diagnostics": {
    "strategiesAttempted": 3,
    "totalSolveMs": 1,
    "warnings": ["INFEASIBLE_DEMAND: no assignments to schedule"],
    "unresolvable": []
  },
  "warnings": [
    "INFEASIBLE_DEMAND: no assignments to schedule",
    "MISSING DATA: Branch profile is empty (no branches in fixture).",
    "MISSING DATA: Class list is empty (no classes in fixture).",
    "MISSING DATA: Curriculum is empty (no (class, subject, periods) in fixture).",
    "MISSING CONFIGURATION: TravelProvider is not registered."
  ],
  "missingData": [
    { "entity": "teacher", "entityId": "...", "field": "nguyenVong", "reason": "absent_in_source" },
    ...
  ]
}
```

The preview never writes to MongoDB.

`POST /api/scheduling/commit`

```json
{ "solutionId": "sol-..." }
```

Re-validates the cached solution and (in this phase) returns it
without writing. A future Phase 13 will write to `tkb` and
`transfer_log`.

`POST /api/scheduling/health`

```json
{ "ok": true }
```

A liveness check that does not load the dataset.

## Datasets

The orchestrator can read from three sources, in priority order:

1. `MONGODB_URI` — MongoDB loader. Interface only in this phase.
2. `DATASET_PATH` — a JSON file with the full `SchedulingInput`
   (Teacher + Branch + Class + Subject + Curriculum + Assignment
   + Travel). Wired through `src/loader/dataset.js`. The loader
   reads only what the operator supplies; missing sections are
   reported as `MISSING_DATA` rather than filled in.
3. fallback — the authoritative teacher fixture
   (`data/fixtures/teachers.authoritative.json`).

## Tests

`npm test` runs 87 tests covering:

- Fixture byte-identity and shape (casing, empty strings, missing
  fields, the `updatedAt` string-vs-object quirk for `nản`).
- Multi-specialization: `kim` is one teacher with two
  specializations and total workload 2.
- Workload regression: `kim=2`, `thư=4`, `trinh=1`, `trâm=1`,
  `nản=2`; total 10.
- Eligibility: `kim → Công nghệ = true`, `kim → Tin học = true`,
  `kim → Toán = false`; `eligibleTeachers` is case-sensitive and
  returns the empty set when no teacher specializes in a subject.
- Preference values for `kim` (ca_hai, 4, []) and that
  `thư`/`trâm`/`nản` are treated as `null`, not auto-filled.
- Pre-scheduler validator: `INVALID_INPUT` for broken references
  and ineligible teachers; `MISSING_DATA` for absent critical
  entities; the solver is never invoked on `INVALID_INPUT`.
- Validator: `H_TEACHER_ELIGIBLE`, `H_ASSIGNMENT_COMPLETE`,
  `H_SLOT_IN_BRANCH`, `H_NO_DUPLICATE_SLOT`, and the
  `H_TRAVEL_FEASIBLE INACTIVE` reporting.
- Solver: empty input → `INFEASIBLE_DEMAND`; no candidate slots →
  `UNRESOLVABLE_ASSIGNMENT`; feasible case returns ≥1 solution;
  multi-solution returns multiple distinct solutions.
- Diversity: identical = 0, disjoint = 1, 2/3 overlap = 2/3.
- End-to-end: synthetic branch + classes + assignments → preview
  returns validated, scored, diverse solutions.
- Benchmark: A vs B vs C produce measurably different scores on
  the same input; no fake "old engine" comparison.
