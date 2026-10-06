# Scheduler correctness

The current UI uses `/api/schedules`. `/api/scheduling` remains available for
compatibility and is deprecated; its commit is inspection-only and never writes
a schedule. No raw BSON, fixture data, branch, or commit was changed in this work.

## Business decisions

- `domain/assignment.js` is the effective-decision lookup shared by constraints,
  metrics, API rows and persisted rows. Candidate placement takes precedence over
  a stale slot teacher stamp and the imported baseline teacher.
- The legacy scheduling calendar is Monday–Friday, morning periods 1–4 and
  afternoon periods 5–7. Monday M1 and Friday M4 are blocked. There are 33 teaching
  slots per branch. Session calculation belongs to `domain/time.js`; H06 rejects
  a contradictory session or invalid slot. An explicit profile cannot make
  period 5 morning.
- `preferredOffDay` and `preferredOffPart` are soft preferences. MORNING does not
  prohibit afternoon; AFTERNOON does not prohibit morning. FULL_DAY charges a
  preference penalty for teaching on that day. `nguyenVong.thuNghi` is retained as
  a legacy soft day preference; only explicit `fixedDayOff` activates H11.
- A teaching session is a distinct `(day, session)` with at least one teaching
  period. A null desired-session value is unset, not zero. A desired value is
  evaluated even when an eligible teacher currently has zero sessions.
- Capacity is **not confirmed in the legacy dataset**, as confirmed by the
  operator during this work. `standardWorkload`, `partTimeWorkload` and historical
  `teachingWorkload` are preserved as `sourceWorkload`, not inferred limits.
  An explicit `capacityPeriodsPerWeek` is a non-negative integer weekly maximum;
  H09 only checks teachers with this value. Eligibility has no fabricated
  per-subject workload: legacy `chuyenMon[].soTietTuan` is null.
- Curriculum and assignment totals must match for each `(classId, subjectId)`.
  Input validation and H05 check coverage independently. The JSON loader no
  longer invents assignments by selecting the first eligible teacher.
- A known home branch is permitted. Other branches require
  `allowedTransferBranches`; an empty list does not grant permission.
  `preferredTransferBranches` never grants permission. A placement must agree
  with the class branch and its slots. The same policy helper is used by variant
  generation, transfer optimization and evaluation.
- The confirmed sequence is home-branch teaching first, transfer afterward.
  The home branch comes from the teacher record and is not a preference field.
  Transfer wishes list only other branches and do not change the home branch or
  grant permission. Imported baseline teacher choices may be replaced by an
  eligible home teacher even in BASE_FEASIBLE mode.
- H16 prohibits adjacent periods for the same class/subject within a session.
  H17 independently prohibits adjacent cross-branch teaching within a session.
  Crossing the morning/afternoon boundary is not H17 adjacency. Missing travel
  data leaves H14 UNSUPPORTED.

## Search and objectives

`solve` backtracks across assignments, tries another teacher/slot when a later
assignment fails, and rolls back occupancy, session/load counters and logical
class/subject ownership. H17 repair operates on a copy of the complete leaf;
failure returns to the search tree. Branch concentration within a session is a
heuristic, not an additional hard prohibition.

H17 is also pruned in the partial state. A deterministic node budget prevents a
single unlucky tree from consuming the whole request: a bounded restart advances
the seeded search, and `searchRestarts` records it. The default node budget is
`max(4000, assignmentCount * 12)` per tree, with at most 128 restarts. Complete
candidate and restart counts are distinct; the time budget still bounds the run.
The multi-solution layer consumes one candidate per solve. BASE, BALANCED and
PREFERENCE_FIRST therefore stop after that candidate instead of searching four
additional candidates that would be discarded. GLOBAL retains its incumbent search.

For imported demand, `solve` first schedules eligible teachers at their home
branches. This internal bounded step records independently checked local
coverage and remaining demand; it does not return a partial user timetable.
The final step keeps locally resolved demand at home and considers permitted
external teachers for remaining assignments. It reserves mandatory home demand
when testing physical slot availability and uses planned home loads to order
transfer choices. This avoids allocating a teacher's home teaching space to
transfers first. The UI shows both steps and exposes a timetable only when the
independent evaluator accepts coverage of the entire original curriculum.

GLOBAL starts with the home-stage decisions as a warm ordering, then
compares complete candidates and uses the existing bounded
`optimizeSubjectTeacherBalance`. Both global and local diagnostics say BEST_FOUND;
neither is a proof of global optimality. Time, iteration and move budgets remain
explicit. The local pass validates proposed moves, checks target eligibility,
permission, conflict and all active constraints, retains only comparator
improvements and rebuilds `candidate.transfers`.

Overall balance includes all active teachers eligible for the current subjects,
including zero loads. `overallWorkloadSpread` and `overallWorkloadStdev` are
explicit; `workloadSpread` and `workloadStdev` remain aliases for compatibility.
`teacherCount` retains its meaning of teachers actually used;
`eligibleTeacherCount` describes the balance population. `teacherWorkloads`
contains the complete population. Subject balance also includes eligible zero
loads and omits singleton subjects from its objective.

The core comparator prioritizes hard feasibility, overall spread, subject
spread, maximum load, overall and subject stdev, preference penalty, then a
deterministic tie-break. The default selector retains this order. Explicit
scoring weights select by weighted total and then blend weighted quality with
diversity for additional picks. Weights cannot admit a hard-invalid candidate;
evaluator errors reject the candidate.

## UI and persistence

API metrics supply both the overall teacher table and the subject tables; the
UI does not recalculate balance. The preference configuration count uses saved
operator provenance and explains that it is not timetable satisfaction. A
partial preference update records which fields were explicitly configured,
without counting inherited legacy values as new operator configuration.

The calendar mapper preserves `periodsBySession` for each day. The grid renders
those pairs instead of multiplying every period by every session; period 5 has
one afternoon row. Older response shapes use the same 1–4 / 5–7 convention.

Commit reloads input, checks input readiness, re-evaluates the stored candidate,
resolves effective rows, writes atomically and verifies readback. A failed check
writes no schedule. The existing persistence source had invalid UTF-8 comment
bytes and a literal NUL delimiter; it was encoded as the text Node already read,
and the delimiter was spelled as `\u0000`, retaining row-key/hash semantics.

## Data readiness and test scenarios

Unmodified legacy data has 40 active teachers, 7 branches, 113 classes,
479 assignments and 802 required periods. No teacher has an allowed transfer
branch list populated. There are 87 imported cross-branch assignments and 61
demands without an eligible home-branch teacher. Under the corrected permission
rule, generation returns EMPTY until authoritative permission data is supplied.
No permissions are inferred from historic transfers or preferences.
The API retains all unresolvable assignment IDs from the solver without
duplicating them across attempts. There are 61 permission-blocked demands / 76
periods and one additional local calendar shortage / 4 periods. The home stage
schedules 417 assignments / 722 periods; 62 assignments / 80 periods remain.
The 87
imported cross-branch assignments represent 142 periods; some can be reassigned
to an eligible home teacher, explaining the different counts.

`REAL_DATA_BLOCKED.md` lists every blocked class/subject/destination demand.
`SCHEDULER_VERIFICATION.json` records those demands, their eligible teachers and
permission decisions, all prohibited imported transfers, read-only historical
workload metrics and the explicitly permitted fixture HTTP round trip.

Positive solver/API/commit tests use `tests/helpers/scheduling-fixture.js`, which
keeps the real entities and demand and declares branch permissions **only in the
test input**. It marks the scenario `EXPLICIT_TEST_TRANSFER_PERMISSION`. Tests of
unconfigured legacy data use the original loader and expect the empty result.
These permissions are not production defaults and are never written to raw data.
Test scenarios also isolate operator preference overlays unless a test explicitly
supplies its own preference store.

AI providers, models, prompts and inference are unchanged. Strategy validation,
deterministic fallback and independent hard validation remain in place. Weight
selection tests establish a real effect on selection, not an AI quality gain.

## Verification

Focused tests cover effective teacher, session/blocked slots, soft/fixed off
rules, null/unique sessions, backtracking/rollback, capacity, curriculum coverage,
branch permission, zero-load balance, transfer validation/metadata, weighted
selection and commit refusal/readback. Existing tests are retained; fixtures and
expectations are updated where the corrected business semantics require it.

Core verification completed before the subsequent Generate-page diagnosis:

| Check | Result | Scope |
| --- | --- | --- |
| Full backend | 876 / 876 PASS; FAIL 0; SKIP 0 | `node --test --test-concurrency=1 --test-reporter=spec tests/*.test.js`; 626575.8596 ms. Includes existing HTTP E2E, persistence and cross-process preview tests. |
| Focused regression | 69 / 69 PASS; FAIL 0; SKIP 0 | Effective decisions, calendar/preferences, search witness, workload/coverage, selection weights, commit and subject balance. |
| Frontend | 84 / 84 PASS | `npm test`; 4 test files. Covers Teachers, Teacher detail, Subjects, Classes, Branches, Preferences, result metrics and the P5 grid. |
| Production build | PASS | `npm run build`; Vite completed in 5.33 s. |
| Additional HTTP E2E | PASS | Explicit test permissions; 3 independently accepted solutions of 802 periods, 0 hard violations each; exact commit/readback and idempotent duplicate commit. |
| Original legacy generation / HTTP | BLOCKED | `REAL DATA BLOCKED BY MISSING TRANSFER PERMISSION`; 61 demands / 76 periods, EMPTY, no candidate and no write. |
| Diff scope / whitespace | PASS | `git diff --check`; no raw legacy or separate root-app diff. |

The first requested sequential full run also passed 875 / 875 (633355.1259 ms).
Further inspection then added the calendar-pair regression and corrected the
diagnostic/grid defects; the final sequential run above includes those changes.
There are no unresolved genuine bugs identified by this verification.
Temporary HTTP servers, stores and the verification script were cleaned up.

Remaining limits are explicit: legacy capacity remains unconfirmed (H09 is
inactive for those teachers), transfer permissions must come from authoritative
data, H14 cannot validate travel without a matrix, bounded search returns
BEST_FOUND rather than an optimality proof, and real AirLLM inference was not
verified in this pass. AI mocks/fallback tests do not establish real-provider
quality or availability.

Failures were handled by their cause, without deleting existing tests:

| Finding | Classification | Resolution |
| --- | --- | --- |
| Legacy positive scheduling tests fail after enforcing branch permission | D: fixture/data-policy mismatch | Positive scenarios explicitly declare test-only permissions; original legacy data is separately verified as BLOCKED. |
| Legacy health and forged-teacher/unknown-assignment refusal assertions | B: stale expectation | Assertions reflect deprecation and earlier refusal by the effective-decision evaluator; writer guards and no-write assertions remain. |
| Deterministic API generation reaches its time budget | E: code bug, exposing C: time-budget failure | Non-global solves stop after the one candidate their caller consumes, removing searches whose results were discarded. |
| EMPTY API response loses the solver's blocked assignment IDs | E: code bug | Preserve and deduplicate the solver diagnostics; the regression compares all 61 IDs with independently computed permitted variants. |
| Timetable grid displays P5 in both session sections | E: code bug | Preserve day/session/period pairs in the mapper and render them in the grid; backend and frontend regressions cover P5. |

The witness tests explicitly exercise alternative-teacher backtracking and
slot rollback; every produced witness is accepted by the independent evaluator.
The small balance fixture includes eligible zero-load teachers and verifies
that `[2,1]` is preferred to `[3,0]`. Actual historical workload totals 802
periods over 40 teachers, with overall spread 14 and summed subject spread 22.
The explicitly permitted positive HTTP scenario has overall spread 13 and
summed subject spread 21. This comparison is descriptive and is not proof of
an optimal timetable or production feasibility.

## Generate-page diagnosis

The reported missing timetable was reproduced at `http://localhost:5173/generate`
against the actual runtime. Generate returned HTTP 200 / EMPTY because the
original legacy data lacks the required transfer permissions. This is a data
blocker; a successful test fixture does not imply production readiness.

The solver diagnostics now identify the affected class, subject, destination,
required periods and whether the failure is eligibility, permission or a branch
mismatch. The Generate page shows that diagnosis and an expandable table,
instead of only a generic no-solution message. The live backend was restarted
to load the corrected diagnostics. In GLOBAL mode the browser visibly shows
61 blocked assignments / 76 periods, with no timetable or committed record.

Verification after this follow-up: backend tests for commit/search/selection
18 / 18 PASS; existing HTTP API E2E 42 / 42 PASS; all frontend tests 86 / 86 PASS;
production build PASS (31.28 s). The complete backend result above was obtained
before this display/diagnostic follow-up and is preserved as that milestone.

## Confirmed home-branch sequence and transfer wishes

The operator subsequently clarified the business order and selected the policy
to display a timetable only after all demand is filled. The current workflow
therefore performs a home-only scheduling step before considering transfers.
It reports home-stage coverage and remaining assignments on the Generate page;
the partial internal schedule never enters the accepted solution/commit pool.
Independent evaluation of the local subset is explicit and does not certify
coverage of the full original curriculum.

The preference form displays the home branch from the teacher record and only
offers other branches under “Nguyện vọng được điều chuyển đến”. The API refuses
home-branch changes through preferences and refuses selecting the home branch
as a transfer wish. Existing legacy values containing the home branch are
excluded from the preference projection, without editing the legacy source.
The wishes remain soft preferences and do not fabricate transfer permission.

Under the corrected sequence the original dataset schedules 417 assignments /
722 periods at home, leaving 62 assignments / 80 periods. The missing eligible
home-teacher groups account for 61 assignments / 76 periods. The extra English
assignment at Phân hiệu 3 has 4 periods; its sole home English teacher has 36
periods of demand but only 33 teaching slots. This is a physical calendar bound,
not a guess about legacy workload capacity. Whole assignments are kept intact.

The transfer search accounts for mandatory future home demand when testing a
teacher's available calendar and confirmed capacity, and uses planned home load
to order external choices. Only remaining demand can acquire an external teacher;
the balance pass cannot move already locally resolved assignments off home.
Tests cover all modes, home preference over imported external choices, capacity
fallback, missing permission and reservation of home teaching before transfer.

Older tests pinned to historic load distributions were updated to verify actual
metrics, full independent coverage and the confirmed home-first decision rule.
A persistence corruption test also now ensures that its chosen new day differs
from the original and alters the candidate hash before expecting rejection.

Focused regression: 75 / 75 PASS. Frontend: 88 / 88 PASS. Build: PASS (5.46 s).
Additional HTTP E2E: 3 accepted solutions of 802 periods under explicit test
permission; exact readback and idempotent duplicate commit. The home-first rule
changes workload distributions: the tested complete fixture has overall spread
20 and summed subject spread 36. These metrics are observations, not a claim
that home-first scheduling improves unrestricted overall balance.

Final sequential backend verification for this workflow: **882 / 882 PASS,
FAIL 0, SKIP 0**, using
`node --test --test-concurrency=1 --test-reporter=spec tests/*.test.js`;
291566.8607 ms. The current UI's 88 frontend tests, 75 focused backend
regressions, production build and additional HTTP round trip all passed.
The live original dataset remains incomplete after the home stage because the
remaining transfers require authoritative permissions. No raw data was changed.

## Catalog CRUD follow-up

The latest request added persistent CRUD for teachers, classes and subjects,
with immutable teacher home branches. Full backend verification passed
889 / 889, all frontend tests passed 93 / 93, and the production build passed.
The browser checks used a separate temporary catalog and left live data intact.
See `CATALOG_CRUD.md` for the API, field rules, scheduling integration and evidence.

## Changed files

83 files are changed, added or moved across this work. The deleted
`backend/src/api/catalog.js` is now owned by `modules/catalog/catalog.route.js`.
The raw legacy source and the separate root applications are unchanged.

- `backend/.env.example`
- `backend/src/api/catalog.js`
- `backend/src/api/commit.js`
- `backend/src/api/mappers.js`
- `backend/src/api/routes.js`
- `backend/src/api/status.js`
- `backend/src/app.js`
- `backend/src/benchmark/dataset.js`
- `backend/src/config/index.js`
- `backend/src/domain/ai/situation-report.js`
- `backend/src/domain/assignment.js`
- `backend/src/domain/comparator.js`
- `backend/src/domain/constraints.js`
- `backend/src/domain/constraints/catalog.js`
- `backend/src/domain/dimension-catalog.js`
- `backend/src/domain/diversity.js`
- `backend/src/domain/global-scoring.js`
- `backend/src/domain/metrics.js`
- `backend/src/domain/multi-solution.js`
- `backend/src/domain/preferences.js`
- `backend/src/domain/scorer.js`
- `backend/src/domain/solver.js`
- `backend/src/domain/subject-teacher-balance.js`
- `backend/src/domain/teacher.js`
- `backend/src/domain/time.js`
- `backend/src/domain/transfer/transfer.js`
- `backend/src/domain/validate.js`
- `backend/src/domain/workload.js`
- `backend/src/loader/dataset.js`
- `backend/src/loader/legacy-saplich/normalize.js`
- `backend/src/loader/legacy-saplich/scheduling-model.js`
- `backend/src/loader/legacy-saplich/verify.js`
- `backend/src/modules/catalog/catalog.route.js`
- `backend/src/modules/catalog/catalog.service.js`
- `backend/src/modules/catalog/catalog.store.js`
- `backend/src/orchestrator/index.js`
- `backend/src/persistence/schedule-record.js`
- `backend/src/routes/scheduling.js`
- `backend/tests/calendar_preferences.test.js`
- `backend/tests/catalog_crud.test.js`
- `backend/tests/catalog_preferences.test.js`
- `backend/tests/commit_revalidation.test.js`
- `backend/tests/dataset.test.js`
- `backend/tests/effective_assignment.test.js`
- `backend/tests/helpers/scheduling-fixture.js`
- `backend/tests/phase16_hardening.test.js`
- `backend/tests/phase20_orchestrator_audit.test.js`
- `backend/tests/phase22_constraints.test.js`
- `backend/tests/phase23_solver_correctness.test.js`
- `backend/tests/phase24_1_optimization_effectiveness.test.js`
- `backend/tests/phase24_teacher_assignment_optimization.test.js`
- `backend/tests/phase25_global_assignment_optimization.test.js`
- `backend/tests/phase26_transfer_travel_readiness.test.js`
- `backend/tests/phase27_multi_solution_diversity.test.js`
- `backend/tests/phase28_global_scoring_selection.test.js`
- `backend/tests/phase29_ai_strategy.test.js`
- `backend/tests/phase30_airllm_provider.test.js`
- `backend/tests/phase31_ai_strategy_benchmark.test.js`
- `backend/tests/phase32_api_e2e.test.js`
- `backend/tests/phase33_schedule_commit.test.js`
- `backend/tests/phase34_generate_worker.mjs`
- `backend/tests/phase34_persistence_hardening.test.js`
- `backend/tests/phase35_real_airllm_runtime.test.js`
- `backend/tests/search_correctness.test.js`
- `backend/tests/selection_weights.test.js`
- `backend/tests/subject_teacher_balance.test.js`
- `backend/tests/validate.test.js`
- `backend/tests/workload_coverage.test.js`
- `docs/CATALOG_CRUD.md`
- `docs/REAL_DATA_BLOCKED.md`
- `docs/SCHEDULER_CORRECTNESS.md`
- `docs/SCHEDULER_VERIFICATION.json`
- `frontend/src/features/catalog/components/CatalogEditor.jsx`
- `frontend/src/features/catalog/components/catalog.css`
- `frontend/src/features/catalog/pages/CatalogCrudPages.jsx`
- `frontend/src/features/catalog/pages/CatalogPages.jsx`
- `frontend/src/features/catalog/service.js`
- `frontend/src/features/scheduling/components/ScheduleGrid.jsx`
- `frontend/src/features/scheduling/components/SolutionList.jsx`
- `frontend/src/features/scheduling/pages/SchedulePage.jsx`
- `frontend/tests/catalog_crud.test.jsx`
- `frontend/tests/core_semantics.test.jsx`
- `frontend/tests/phase32_ui.test.jsx`
