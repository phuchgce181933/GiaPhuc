# Phase 32 — End-to-end API and UI

Phase 32 is the first surface in this project a person actually
touches. Everything before it is a library, a test, or an audit
report. This document records what the user-facing path is, what it
refuses to claim, and what was measured rather than assumed.

## What shipped

| Layer | Location |
| ----- | -------- |
| Request vocabulary + validation | `backend/src/api/contract.js` |
| PII boundary (response mappers) | `backend/src/api/mappers.js` |
| Honest status blocks (AI / travel / transfer) | `backend/src/api/status.js` |
| Pipeline assembly | `backend/src/api/generate.js` |
| Routes (`/api/schedules/*`) | `backend/src/api/routes.js` |
| API contract + E2E tests | `backend/tests/phase32_api_e2e.test.js` |
| Feature: service, hook, components, page | `frontend/src/features/scheduling/` |
| Route component | `frontend/src/pages/Generate.jsx` |
| UI honesty tests | `frontend/tests/phase32_ui.test.jsx` |

## The three endpoints

```
GET  /api/schedules/health     what this deployment CAN do
POST /api/schedules/generate   run the pipeline
POST /api/schedules/commit     re-validate a selected solution
```

Status codes:

| Endpoint | 200 | 400 | 404 | 409 | 500 |
| -------- | --- | --- | --- | --- | --- |
| `generate` | `OK` \| `EMPTY` \| `MISSING_DATA` | `INVALID_INPUT` | — | — | infrastructure only |
| `commit` | re-validated, `written: false` | missing ids | unknown request/solution | re-validation failed | — |
| `health` | capability report | — | — | — | — |

`EMPTY` and `MISSING_DATA` are 200 on purpose. The pipeline ran; the
honest answer is "no timetable" or "the data is not there", and
neither is the same statement as "your request was malformed".

## The request vocabulary is closed

A request may carry exactly three fields:

```json
{ "candidateCount": 3, "optimizationMode": "BASE_FEASIBLE", "useAI": true }
```

`candidateCount` ∈ `{1, 3, 5, 10}`. `optimizationMode` ∈ the four
`OPTIMIZATION_MODES`. `useAI` is a boolean.

Everything else is refused with a named code, not silently dropped:

- `FORBIDDEN_FIELD` — the client tried to name a teacher, a class, a
  day, a period, a seed, a weight, a constraint, or a dataset.
- `UNKNOWN_FIELD` — a typo, reported rather than ignored.

A forbidden field is refused rather than ignored because a body
carrying `{"candidateCount": 3, "teacherId": "..."}` has two readings,
and answering the wrong one leaves the caller unable to tell what
happened. The list is derived from the real `SchedulingInput` keys, so
a new domain field cannot leak in by omission.

The UI reads this vocabulary from `/health` rather than keeping a
second copy, so the control cannot offer a value the contract refuses.

## Why there are two pipelines

`/api/scheduling/*` (Phase 14-17) and `/api/schedules/*` (Phase 32) are
both mounted, and both are tested. They are **different pipelines, not
an old and a new version of one**:

| | `/api/scheduling` | `/api/schedules` |
| - | - | - |
| Solves per request | once per A/B/C preset | `candidateCount` candidates, one pipeline |
| Multi-solution | no | yes (Phase 27) |
| Scoring | Phase 17 scorer | Phase 28 global scoring |
| AI boundary | no | yes (Phase 29) |
| Situation report | yes | no |
| PII whitelist | no | yes |

Reusing the old orchestrator would have meant either dropping
Phases 27-29 or rewriting the modules that Phase 14-21 tests pin. The
legacy surface is left exactly as it is (`phase32_api_e2e.test.js`
check G9 asserts it still answers and still has its own shape).

The frontend's legacy `services/scheduling.js` client and the old
inline `AI Generate` markup were **removed**. They read
`s.score.overallScore` and `s.validation.coverage`, neither of which
exists in the Phase 32 response; rendering Phase 32 data through them
would have meant teaching the grid about solver internals.

## The honesty rules, and where each one is enforced

| Claim a UI could make wrongly | Enforced in | Enforced in UI | Tested by |
| - | - | - | - |
| "Generated with AI" when the fallback ran | `status.js` → `ai.used` | `StatusBanner` | UI: `a fallback run is not presented as an AI run` |
| "AI not requested" shown as a provider failure | `status.js` → `ai.requested` | `StatusBanner` | UI: `"AI not requested" is distinct…` |
| "Travel optimized" when H14 is UNSUPPORTED | `status.js` → `travel.available` | `StatusBanner` | UI: `travel reads as not scored` |
| "Transfers applied" when H13 is INACTIVE | `status.js` → `transfer.active` | `StatusBanner` | UI: `an inactive transfer is not rendered as applied` |
| A UI-authored "why this rank" | `mappers.js` → `scoring.rankReason` | `SolutionList` renders verbatim | UI: `the rank reason is rendered exactly as the scorer wrote it` |
| `globalScore` and `qualityScore` collapsed into one | `mappers.js` keeps them separate | `SolutionList` shows both | UI: `the global and quality scores are the response values` |
| "more diverse = better" | n/a — an inference, not a field | `SolutionList` disavows it in copy | UI: `diversity is labelled as a comparison` |
| An unmeasured number rendered as `0.000` | `numberOrNull` → `null` | `fmt` → em dash | UI: `a null metric renders as a dash` |
| An inactive dimension shown as bare "inactive" | `dimensions[id].reason` | `SolutionList` renders the reason | UI: `an inactive dimension shows the backend reason` |
| A Monday-Friday grid | `calendar.days` from the time model | `ScheduleGrid` builds from it | UI + API G3: six days survive |
| "Saved" when nothing was written | `written: false` | `SolutionList` says "Preview only" | UI: `a preview-only commit says so` |
| A stack trace in the browser | `infrastructureFailure` | `messageOf` in the hook | API G2 + UI: `a 400 shows the backend message` |

### Measured, on the real dataset

40 teachers · 7 branches · 113 classes · 479 assignments ·
802 periods per solution · **0 hard violations** · 6 school days.

The real branches declare `schoolDays: [1,2,3,4,5,6]`. A hard-coded
Monday-Friday grid would have silently dropped the sixth day while the
solver had scheduled it — which is why the calendar is derived from
`timeSlotsByBranch` and the day `label` is left `null`. The UI presents
day numbers as Vietnamese weekday names and falls back to `Day N` for
a number it does not recognise, rather than inventing a name the
source never made.

## Payload size is a client decision

`?placements=all | selected | none`, measured on the real dataset for
3 solutions:

| Level | Response | Carries slots for |
| ----- | -------- | ----------------- |
| `all` (default) | ~1.55 MB | every solution |
| `selected` | ~0.52 MB | rank 1 only |
| `none` | ~0.01 MB | none (summaries only) |

Placement rows carry **ids, not names** — the names are already in
`directory` in the same response. That one change removed ~40% of the
payload (measured at 866 KB before it). The UI reports the level it
received, so empty cells are never mistaken for a schedule with holes
in it.

## Preview only, and no way to pretend otherwise

`POST /commit` re-validates the selected solution against the stored
input with the independent evaluator, and then reports
`written: false`, `persistence.implemented: false`,
`persistence.reason: 'PREVIEW_ONLY'`. There is no branch in the
function that can reach a database; `phase32_api_e2e.test.js` check
16b asserts structurally that no module under `src/api/` imports a
persistence library and that `package.json` depends on no driver at
all.

A solution that no longer passes re-validation is refused with **409
and not written**, not written and then reported.

## The UI does no arithmetic

The frontend imports nothing from the domain. It never computes a
score, never re-derives a metric, never composes a rank explanation,
and never counts a directory array — `provenance.counts` is the
loader's own block, re-projected field by field.

What the UI *does* own: the request lifecycle (one hook, so a double
click cannot start two solves), the layout, and the choice of what to
show. The `busy` guard is a **ref read synchronously before the first
await**, because two clicks in one tick both read the same stale
`false` from a state variable.

## Test coverage

```
backend  npm test -- tests/phase32_api_e2e.test.js     42 passed
frontend npm test                                       38 passed
```

The backend suite runs against **real HTTP** on an ephemeral port —
routing, status codes and JSON shape are the surface Phase 32
introduces, and calling the service directly would have left them
untested. The 18 brief checks are numbered and named in file order;
everything after 18 is a guard on a property the phase depends on.

The UI suite has **no snapshot tests**. Every assertion is about a
specific claim: a value that must be shown, a word that must not
appear, a capability that must not be asserted.

No test in either suite requires AirLLM, a GPU, or the Python
service. The fallback path is exercised with an explicitly
unavailable planner, which is deterministic and needs no network.

## Verified against the running stack

Not just unit-tested: the backend on `:4010` and the Vite dev server
on `:5173`, through the proxy, with the real dataset.

- health loaded; the mode list came from the API, not from the UI
- 3 solutions rendered; rank reasons and the dimension table verbatim,
  including `H14 = UNSUPPORTED (no travel matrix)`,
  `H13 = INACTIVE (no allowedTransferBranches…)` and `REPORTING_ONLY`
- status banner read "AI strategy, approved / AI_USED" with the
  provider's own rationale, "Not scored (UNSUPPORTED)" for travel,
  "Inactive (INACTIVE)" for transfers
- commit returned "Preview only — PREVIEW_ONLY" on the committed card
  only
- the timetable grid drew all six days with teacher, subject and
  branch in the filled cells

### Two defects this verification caught

Both were invisible to the unit tests and to a green build, and both
are now fixed and covered.

1. **Doubled path prefix.** `service.js` built
   `` `${API}${path}` `` where `API` is already `/api` and the paths
   also began with `/api`, so every call went to
   `/api/api/schedules/generate` and came back as the catch-all 404
   *"Unknown API endpoint."* The message reads as "the API is broken"
   rather than "this string is doubled", so nothing local to the
   failure pointed at the cause.

2. **Wrong grid row model.** The grid looped day-major, emitting one
   block of period rows per day. The period numbers repeated six times
   down the page, and because the header spanned one column while the
   body had two (session + period), every day heading sat over the
   wrong cell. Rows are now periods, unioned across days and grouped by
   session, and the header spans both label columns.

## Known limits

- **Preview only.** No persistence workflow exists. `commit` re-validates and says so.
- **Travel is UNSUPPORTED and transfer is INACTIVE** on this dataset. Both are reported per response; neither is ever rendered as optimized.
- **AirLLM is BLOCKED** on this host (see `PHASE_31_1_RUNTIME_VERIFICATION.md`). The UI shows the mock provider's decision and labels it as such.
- **The AI rationale is the backend's.** The UI does not reword it, so a provider that returns a terse reason produces a terse line.
- **No pagination.** 10 solutions at `placements=all` is ~5 MB. The level is the escape hatch; nothing paginates within a response.
