# Phase 33 — Schedule Commit + Persistence

Phase 32 ended with a timetable the user could see, compare and
inspect, and nothing they could keep. `POST /api/schedules/commit`
re-validated the selected solution and answered `written: false` with
`persistence.reason: 'PREVIEW_ONLY'`, which was the honest answer at
the time: the project had no persistence workflow.

Phase 33 defines one. The pipeline is now

```text
Generate      → a preview, nothing written
Select        → local, no request
Preview       → local, no request
Confirm       → an explicit dialog, no request yet
POST /commit  → revalidate → re-score → persist → read back
```

and a committed schedule is a NEW record with a stable id, not an
overwrite of anything that existed.

---

## 1. Generate vs Preview

They are the same operation, and that is the point.

`generateSchedules()` cannot write. It has no `ScheduleStore` in
scope, no import path to one, and no branch that reaches
`node:fs`. The only module in the tree that holds a store is
`src/api/commit.js`, and it holds it as an injected dependency. A
structural test asserts this rather than trusting a comment: check
`G3` in `tests/phase33_schedule_commit.test.js` reads every file in
`src/api/` and asserts that exactly two of them import
`src/persistence/` — `commit.js` and the route wiring.

Generating after a commit does not disturb the commit. A new
generation issues a new `requestId` and new solution ids; the
committed records are untouched, and the UI reads them from the
backend rather than from the render.

## 2. The commit flow

`POST /api/schedules/commit`, body `{ requestId, solutionId }` and
nothing else. The seven steps, in the order they run:

| # | Step | Failure |
|---|------|---------|
| 1 | validate the request vocabulary | 400, nothing touched |
| 2 | look the candidate up **by id** | 404, nothing touched |
| 3 | re-validate with the independent evaluator | 409, nothing written |
| 4 | re-score (no search) | recorded, never a gate |
| 5 | build rows from the candidate | 409, nothing written |
| 6 | persist atomically | the only write |
| 7 | read back and compare | 500, reported as NOT persisted |

Steps 1-5 all run before step 6 and none of them writes. A rejection
leaves the store byte-identical, which is what "The schedule was not
saved" means.

### Request vocabulary

```json
{ "requestId": "req-000001", "solutionId": "ms-dab6b0d3" }
```

A body carrying anything else is **refused, not ignored**, with the
offending key named:

```text
{ requestId, solutionId, teacherId, period: 9, branchId: "Y" }
  -> 400  errors[0].code = "FORBIDDEN_FIELD", field = "teacherId"
```

Refusing rather than dropping is the same rule `generate` already
used: a body that carries a field the contract does not define has
two readings, and silently dropping it would answer the first one
with a schedule that ignores it.

## 3. Validation

The commit re-runs the **independent evaluator** (`evaluateCandidate`
from `src/domain/constraints/`) against a freshly loaded
`SchedulingInput`. It is the catalog, walked as the catalog decides
which constraints are active — there is no hard-coded list of
constraint ids in the commit path, and check `G7` proves it by
breaking exactly one constraint (`H06`) and asserting the response
names it.

The object re-validated is the **solver candidate the backend
produced**, not a reconstruction from the flattened display rows.
The first version of this code rebuilt a solver-shaped candidate
from the display projection and reported 479 phantom `H05`
violations: the reconstruction was a second, subtly different
implementation of the same thing, and the evaluator correctly
rejected it. The thing re-validated is the thing that was validated.

**Active entities.** `H08` is a catalog constraint, so an inactive
teacher, subject, class or branch is rejected by the evaluator. On
top of that the row builder has its own gate on the write path: the
legacy placeholder teacher `CN-TH` is refused there. That second gate
is not redundant — every catalog constraint walks
`input.assignmentIndex`, so a candidate whose *placement* points at a
teacher the assignment never named is invisible to the catalog. Check
`14b` builds exactly that candidate, asserts the catalog says
`ACCEPTED`, and asserts the commit still refuses it.

**Travel and transfer are unchanged.** `H14` is `UNSUPPORTED` and
`H13` is `INACTIVE` on this dataset, before and after Phase 33. The
commit response carries both, and the per-constraint statuses are
reported as `UNSUPPORTED` / `INACTIVE` — never as `PASS`. A commit
that implied transfers had been verified would be a claim the data
cannot support.

## 4. Re-score

The global scorer is re-run on the same candidate, with no search.
What it is used for is a **second, independent feasibility check** —
`scoreCandidate` calls the evaluator internally, so its agreement
with step 3 is a real confirmation rather than a restatement.

What it is **not** used for is re-ranking. Per-dimension min/max
normalization over a one-element pool collapses every dimension to
the neutral `0.5`, so a recomputed `total` is `0.5` by construction
and carries no ranking information. Reporting it as `globalScore`
contradicted the score the user had just been shown (and did, before
this was fixed). The response therefore reports:

```json
"score": {
  "globalScore": 0.96875,          // from the generation
  "qualityScore": 0.0714,          // from the generation
  "feasibility": "FEASIBLE",       // from the re-check
  "recheck": { "ran": true, "searched": false, "hardViolations": 0, "note": "..." }
}
```

## 5. Persistence

### Why a file store

The architecture was read before choosing, as the brief requires.
This repository has **no database**: `package.json` depends on
`express` and `bson` (a serializer, not a driver), `config.mongoUri`
is parsed and never used, and no module under `src/` opens a client.
Adding MongoDB would have meant a second persistence layer, a driver
dependency, a running server and a connection story — none of which
exist today.

So the store is a directory of JSON documents, one file per
committed schedule, and the design keeps the driver replaceable: the
API layer calls `create` / `read` / `list` and never touches
`node:fs`. Swapping in MongoDB is a change to
`src/persistence/schedule-store.js` and nothing else. No
`ScheduleV2` / `ScheduleFinal` / `ScheduleNew` type was introduced.

Location: `PERSISTENCE_DIR`, default `backend/data/schedules`,
gitignored. A test injects a temporary directory, so `npm test` never
touches the operator's data.

### Atomicity

```text
1. serialize the WHOLE record (all 802 slots) to a temp file in the
   SAME directory — same filesystem, which is what makes step 3
   atomic rather than a copy
2. write, fsync, close     the bytes are on the device
3. link(tmp, final)        POSIX create-if-absent: fails EEXIST if
                           `final` exists, otherwise appears atomically
4. unlink(tmp)             cleanup only; the record is already durable
```

Step 3 is the all-or-nothing point. A reader sees either no file or a
complete file. A crash at any step leaves at worst a stray temp file
(swept on the next store construction) and never a partial record
under a real id. There is no code path in which some slots are
stored and the request returns success.

One file per schedule rather than one growing index document is what
makes an append a *create* instead of a read-modify-write, and a
read-modify-write is exactly where partial writes live.

### Idempotency

`scheduleId` is **derived** from the pair:

```text
scheduleId = "sch-" + sha256(requestId + "\0" + solutionId)[0..16]
```

Two identical commit requests address the same file by construction.
The second `link` gets `EEXIST`, the store returns the existing
record, and the response is:

```json
{ "status": "COMMITTED_DUPLICATE", "duplicate": true,
  "scheduleId": "sch-8afa59b87c3282bb", "version": 1 }
```

A double-click cannot create a second schedule because there is no
second name for it. The client does not supply the key, so a client
cannot cause a duplicate by choosing a different one.

A replay also does not mint a new `version`: the counter is advanced
inside the lock, and the response reports the version of the record
that is actually stored. The counter consequently has gaps (a replay
consumes a number it does not use), which is harmless — versions are
an ordering, not a count.

### Concurrency

| Case | Policy |
|------|--------|
| Same solution, two clients | In-process async mutex keyed on `scheduleId`; the second waits and observes the completed record. `link()` is the cross-process backstop. |
| Different solutions, two clients | Two files. **Append-only versioning** — neither overwrites the other. |
| "Which one is current" | Derived (`max(version)`), not a stored mutable pointer. There is no lost update to have. |

A committed schedule is never modified or removed by a later commit.
The brief asks for the policy to be explicit rather than implicit, and
it is: **last commit does not win, both coexist, versions order
them.**

## 6. Readback verification

HTTP 200 is not proof. After the write, the record is read back off
the store and compared to the candidate row for row:

```json
"readback": { "slots": 802, "matchesCandidate": true }
```

A mismatch is a `500` with `persisted: false`, even though the write
technically succeeded, because the claim the response would be making
is false. On the real dataset the readback returns 802 rows, the same
`contentHash`, 113 distinct classes and days 1-6.

Comparison is **semantic, not byte-level**: same length, same
multiset of eight-field row keys. JSON round-tripping is free to
reorder keys and reformat whitespace, so byte comparison would test
the serializer instead of the persistence. Length is compared as
well as content, because 802 rows with one duplicated and one missing
has the same *set* and is a corrupt schedule.

## 7. Audit metadata

Kept, because they answer "what produced this and can I prove it":

```json
"audit": {
  "sourceRequestId": "req-000001", "sourceSolutionId": "ms-dab6b0d3", "sourceRank": 2,
  "inputHash": "94d8cec8", "datasetShapeHash": "8d739f89",
  "dimensionCatalogVersion": "ff0f3a1f", "scoringDefaultsVersion": "90193515",
  "strategy": { "optimizationMode": "BASE_FEASIBLE",
                "appliedOptimizationMode": "GLOBAL_ASSIGNMENT_BALANCED",
                "modeSource": "AI" },
  "ai": { "provider": "DeterministicMockAIPlanner", "used": true, "fallbackUsed": false },
  "score": { "globalScore": 0.96875, "qualityScore": 0.0714, "feasibility": "FEASIBLE" }
}
```

Deliberately **not** kept: any prompt text, any model response, any
teacher personal field, and the SchedulingInput. The rows already
name teacher ids; a person is identified by an id, not by a copy of
their record. Check `G6` asserts the commit response and the schedule
header contain no `hoTen`, `soDienThoai`, `email`, `ngaySinh` or
`diaChi`, and that the commit response is a header rather than a
payload.

There is no `createdBy`: the project has no authentication, and
inventing an identity field for it would be a claim about who did
something that nothing can support.

## 8. AI behaviour

The AI participates in **strategy selection at generation time**
only. The commit path holds no planner reference and never calls
`deps.makePlanner`; check `17` wraps the real deterministic planner
in a counter, generates (count > 0), commits (count unchanged), and
asserts the response says `ai.used: false` with
`reason: 'COMMIT_DOES_NOT_CALL_AI'`.

The committed record does keep `audit.ai` — which provider, whether
its decision was used, whether a fallback ran — because that is a
fact about the candidate's provenance, and a record of provenance is
worth more than a record of a request that was never made.

## 9. The record

```json
{
  "schemaVersion": 1,
  "scheduleId": "sch-8afa59b87c3282bb",
  "status": "COMMITTED",
  "requestId": "req-000001",
  "solutionId": "ms-dab6b0d3",
  "version": 1,
  "validated": true,
  "committedAt": "2026-10-04T21:05:16.541Z",
  "slotCount": 802,
  "contentHash": "130f8b5e…",
  "audit": { … },
  "slots": [ { "assignmentId": "…", "classId": "…", "subjectId": "…",
               "teacherId": "…", "branchId": "…",
               "day": 1, "session": "sang", "period": 3 }, … ]
}
```

This is a documented file record, not a database schema. The brief
asks for a limitation to be recorded before a schema is added rather
than after; the record above is the whole of it, and it is
deliberately minimal so a migration moves data rather than
reinterprets it.

**The legacy baseline is not overwritten and is not written to at
all.** Commit has no code path to the baseline, the raw dump, the
normalized source or the constraint catalog. Check `20` re-reads the
dataset after a commit and asserts all four provenance stamps and the
entity counts are unchanged, and that the hard-constraint list is
still 14 entries.

## 10. API surface

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/schedules/generate` | unchanged; still preview-only |
| `POST` | `/api/schedules/commit` | now writes |
| `GET` | `/api/schedules/committed` | headers of every committed schedule |
| `GET` | `/api/schedules/committed/:id` | one header |
| `GET` | `/api/schedules/committed/:id/full` | the slot table |
| `GET` | `/api/schedules/health` | `commit.mode: COMMIT_ENABLED` |

The header endpoints carry no slot table. Ten 802-slot records would
be ~5 MB of JSON nobody asked for; the rows are behind an explicit
`/full`, so a client verifying a `contentHash` never pays for them.

## 11. What changed in Phase 32

Three Phase 32 assertions described a behaviour Phase 33 exists to
remove, and were updated to protect the property underneath rather
than the letter:

| Test | Was | Now |
|------|-----|------|
| `16` | generate is pure; **commit writes nothing** | generate is pure and persists nothing; the commit half moved to Phase 33 |
| `16b` | no DB driver reachable from `src/api/` | unchanged, and still true — the driver is a file |
| `G7` | `commit()` returns 409 synchronously | same assertion, awaited; `commit` is now async and needs a store to refuse writing to |
| `G8` | `health.commit.mode === 'PREVIEW_ONLY'` | `COMMIT_ENABLED`, plus `allowedCommitFields` |

`G6` (404 codes), `G1`–`G5` and checks 1–18 were **not** modified.

Frontend: the three commit tests in `phase32_ui.test.jsx` now drive
the dialog. The properties they protect are unchanged — a commit the
backend did not confirm is never shown as a write, a refusal shows the
backend's own words, a result belongs to one solution — only the
expected copy changed, because "Preview only" is no longer the
truthful answer.

## 12. Known limitations

1. **Single-process version counter.** `version` is derived from the
   files on disk at store construction and advanced under an
   in-process mutex. It is correct for one Node process and **not
   coordinated across several processes** writing the same directory:
   two hosts could assign the same version to different schedules.
   With MongoDB this becomes a `findOneAndUpdate` on a counters
   collection. Stated rather than papered over with a lock file that
   would give a false guarantee.

2. **No authentication.** The commit endpoint is open, as every
   other endpoint in this project is. Adding an auth system is out of
   scope for this phase and was not started.

3. **`PreviewStore` is per-process and bounded to 6 generations.** A
   commit only accepts a solution from a generation the *same* process
   produced. After a restart, committed schedules are readable and
   new ones can be committed, but an already-open browser tab cannot
   commit a solution it generated before the restart. Making
   generation durable is the next thing this design needs.

4. **No pagination.** `placements=all` for 10 solutions is ~5 MB, and
   `GET /committed` is a full list. Both are bounded by the dataset,
   not by the commit workflow.

5. **No delete or amend.** Once committed, a schedule is permanent.
   Correcting a committed timetable means committing a new version,
   which is the versioning policy working as intended, not a gap.

6. **Travel and transfer remain unresolved.** `H14` is
   `UNSUPPORTED` and `H13` is `INACTIVE`. A commit does not make
   either feasible and does not claim to.

## 13. Real-data run

`40 teachers · 113 classes · 479 assignments · 802 periods · 6 days`,
three generated solutions, zero hard violations.

```text
generate  3 solutions          ms-b25dfb04 / ms-dab6b0d3 / ms-3c7e2ea2
select    Solution 2           ms-dab6b0d3
commit    COMMITTED            sch-8afa59b87c3282bb  v1  802 slots
readback  802 slots            hash 130f8b5e…  113 classes  days 1-6
replay    COMMITTED_DUPLICATE  same scheduleId, same version, 1 record
second    Solution 3           sch-166670e8007d9dc4  v3  802 slots, different hash
reload    2 schedules listed   read back from the backend
```

Browser: Generate → Solution 2 → Save → dialog shows rank 2,
globalScore 0.9688, qualityScore 0.0714, workloadSpread 12.0,
maxTeacherLoad 24, periods 802, hard violations 0 → Confirm and save
→ "Saving…" with the dialog disabled → Solution 2 carries a
`committed` badge and the panel lists the schedule. Reload shows both
schedules. Generating again keeps them.
