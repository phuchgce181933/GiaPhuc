# Phase 34 — Persistence Hardening

Phase 33 made a timetable you could keep. It left two holes, both
stated there rather than hidden:

1. **`PreviewStore` was per-process.** A commit could only name a
   solution the *same* process had generated. Restart the server, or
   send the tab to a second worker, and the timetable on screen became
   uncommittable.
2. **The version counter was process-local.** Two Node processes
   writing the same directory could hand out the same `version`.

Both are now closed, and this document is about how, and about what is
still not true. The short version: durability now extends from the
committed record backwards to the generation it was committed from,
and version uniqueness is delegated to `link(2)` rather than to a lock
this codebase would have to get right.

Nothing about the user-facing workflow changed. Generate, select,
confirm, commit, reload — the same five steps, the same words on
screen. The commit request is still two strings.

---

## 1. What was actually wrong

Both limitations had the same root cause, which is worth naming
because the fix is the same shape in both places.

**A fact that has to survive a process restart was being derived from
process-local state.**

| Fact | Phase 33 | Consequence |
|------|----------|-------------|
| Which candidate a `solutionId` names | a `Map` in one heap | a commit 404s after a restart |
| Which version number is next | a counter in one heap | two processes pick the same number |

Both are now on disk, and both are read fresh rather than cached
across a trust boundary. The interesting question is *how* a file
store gets exclusivity without a lock — that answer is used twice, so
it is worth stating once.

---

## 2. The one primitive everything is built on

Every write in this phase is the same four steps, in
`src/persistence/atomic-file.js`:

```text
1. serialize the WHOLE record to a temp file in the SAME directory
2. write it, fsync it, close it
3. link(tmp, target)     POSIX create-if-absent: EEXIST, or atomically
                         present and complete
4. unlink(tmp)           cleanup only
```

Step 3 is the all-or-nothing point, and it is also the *exclusivity*
point. `link(2)` is atomic against a shared directory, so it does two
jobs at once:

- a reader never sees a name with partial contents (atomicity), and
- exactly one writer can ever create a given name (exclusivity).

Phase 33 already used it for atomicity. Phase 34 discovered that it
also answers the concurrency questions, which is why **no lock file,
no lock table, and no `flock` was added anywhere.** A lock this
codebase implements is a lock this codebase can get wrong under load;
a primitive the OS provides is a primitive the OS gets right.

### The temp-sweep bug, and why only a second process could find it

Phase 33 swept leftover `.tmp-` files on every store construction, on
the reasoning that a temp file is by definition abandoned. That is true
within one process and **false between two**:

```text
process A  writes .tmp-sch-x-111-aaaa        (in flight)
process B  boots, constructs a store, sweeps
            → deletes A's temp file
process A  link(.tmp-sch-x-111-aaaa, .version-4)
            → ENOENT
```

Check 7 in `tests/phase34_persistence_hardening.test.js` failed with
exactly that error on its first run, because it is the first test in
the project that runs four real OS processes against one directory.
No single-process test could have found it.

The fix narrows sweeping twice over:

```text
sweep a temp file only if
  (a) it was not written by THIS process   — ours may be in flight
  (b) it is older than staleTempMs        — theirs may be too
      (default 300 s, configurable, read from an injected clock)
```

A file that matches neither is left alone. (b) is a time heuristic, not
a proof: a writer that stalled for more than the threshold could still
lose its temp file. The window is orders of magnitude larger than the
operation it guards — writing and linking a record takes milliseconds,
not minutes — and the residual risk is recorded in §11 rather than
papered over with a claim of safety it does not have.

---

## 3. Durable preview identity

`src/persistence/preview-record.js` owns the record's shape;
`src/persistence/preview-store.js` owns its storage.

```text
<persistenceDir>/previews/req-000001-9c2f4811.json
```

Written with the same four steps, addressed by `requestId`, read fresh
on every lookup. There is deliberately **no in-memory cache layered on
top**: a cache would be a second source of truth with its own
invalidation problem, and the point is that the file *is* the truth. A
preview is read once, at commit time, so there is nothing to cache and
nothing that can go stale.

### What is stored, and what is deliberately not

```json
{
  "schemaVersion": 1,
  "kind": "PREVIEW",
  "requestId": "req-000001-9c2f4811",
  "createdAt": "2026-10-05T04:35:12.004Z",
  "expiresAt": null,
  "solutionCount": 3,
  "solutions": [
    {
      "id": "ms-dab6b0d3",
      "integrityHash": "…64 hex…",
      "candidate": { "assignments": [[…]], "placements": [[…]] },
      "solution": { "rank": 2, "globalScore": 0.9688,
                    "qualityScore": 0.0714, "scoring": { … } },
      "strategy": { … },
      "ai": { … }
    }
  ]
}
```

The candidate is stored **in full** — it is the whole point, and a
dropped slot would come back as a violation the user never caused.

The display solution is **not**. It carries 802 placement rows, which
is the candidate's job, and the commit path reads exactly five fields
from it (`rank`, `globalScore`, `qualityScore`, `scoring.rankReason`,
`id`). So the record keeps a **whitelisted score projection** instead.
The whitelist is the same discipline `mappers.js` applies on the other
side of the wire: a field not named here cannot reach the committed
audit block by being added to a mapper.

Measured on the real dataset: **441 KB** for a three-solution preview,
against 247 KB for one committed schedule.

### Why `Map`s go in and come back as `Map`s

JSON has no `Map`, so the record holds arrays of pairs. They are
rebuilt into real `Map`s on read, because the independent evaluator and
the global scorer both walk `Map`s. Handing them the array form would
be committing through a *different code path* than the one that was
validated — which is exactly the mistake Phase 33 made when it
reconstructed a candidate from flattened display rows and got 479
phantom `H05` violations.

---

## 4. Candidate integrity

The backend's authority over a schedule is established by two
independent things, and Phase 34 was careful not to let one stand in
for the other:

```text
integrity hash  →  "these are the bytes the backend wrote"
evaluator       →  "and those bytes are a feasible timetable"
```

A passing hash is not a feasibility result. Check 16 writes a
deliberately infeasible candidate *through the record builder*, so its
hash is honest, and asserts the commit still returns 409 with `H01`
named. A design where the hash gated the commit and the evaluator did
not would pass every other test in this file.

### Canonical serialization

`candidateIntegrityHash` hashes the **serialized** form, not the live
solver object. This is the one detail that decides whether the check
can work at all: `Map`s encode as `map[...]` and plain objects as
`{…}`, so a hash taken over the live object would never match the same
candidate read back from disk, and every write would report as
tampering. One encoding, used by the writer and the verifier.

Two normalizations exist so that hashing the in-memory object and
re-hashing the parsed one agree:

- **`undefined` fields are omitted** and **non-finite numbers become
  `null`** — exactly what `JSON.stringify` does, so a round trip
  through disk is a fixed point.
- **object keys are sorted** and a `Map` becomes a **sorted** array of
  pairs — iteration order is not a property of a schedule, and a hash
  that moved when a field was reordered would report tampering where
  there is none.

### What tampering does

```text
stored file edited  →  describe() = INVALID / FAILED
                    →  get()      = null
                    →  POST /commit = 409 PREVIEW_INTEGRITY
                    →  nothing written
```

Verified on the real dataset by moving one slot's `day` from 1 to 5 in
the stored JSON: lifecycle `INVALID`, http 409, `PREVIEW_INTEGRITY`,
`mismatched: ["ms-…"]`, and the record count unchanged at 3.

---

## 5. Preview expiration — opt-in, and off

`expiresAt` is written **only when `PREVIEW_TTL_SECONDS` is set**. The
default is "no TTL", and that is a decision rather than an omission:

> A policy nobody chose is worse than no policy. Previews that vanish
> silently turn an open browser tab into a 410 the user cannot explain,
> and "the timetable I was looking at is gone" is a worse answer than
> a few megabytes of JSON on disk.

An operator who wants one sets it, and the record then carries the
`expiresAt` that was actually applied — so the behaviour is readable
from the data afterwards rather than inferred from the code.

`/health` reports which of the two you have:

```json
"preview": { "ttlSeconds": null, "expiration": "NONE" }
```

Every expiry decision reads the store's **injected clock**. No code
path in the preview store calls `Date.now()` to decide business
behaviour, which is what lets check X1 prove an expiry fires without
sleeping for a minute.

`PREVIEW_LIMIT` (default 6, Phase 33's bound) caps the directory. The
limit is a target for the **sheddable** set, not a hard cap: a preview
that has already produced a committed schedule is never shed, so the
count can sit one above the limit. Evicting it to hit an exact number
would trade bookkeeping tidiness for the loss of a commit the user
already made. Check X6 pins both halves of that policy.

---

## 6. Multi-process version allocation

The same `link(2)` primitive, used a second time. A version is claimed
by hard-linking the finished temp file to a name **derived from the
version**:

```text
link(tmp, ".version-000000000004")   ← claimed by exactly one writer
link(tmp, "sch-8afa59b87c3282bb")    ← the published record
```

Both are hard links to the same inode, so the claim costs one
directory entry and **zero extra bytes** — visible in the E2E
directory listing, where `.version-000000000001` and
`sch-a426eae2cee8e751.json` are both 247,248 bytes. `EEXIST` is the
OS, not a protocol this module invented. A writer that loses takes the
next number.

### What this guarantees, stated precisely

| | |
|---|---|
| **guaranteed** | no two stored records ever share a version |
| **guaranteed** | correct across processes — the exclusivity is `link(2)` on a shared directory, not an in-process mutex |
| **guaranteed** | a store upgraded in place still honours Phase 33 records, which have no claim file |
| **NOT claimed** | that version order equals commit-completion order. A writer can claim 4, lose the disk for a while, and publish after one that claimed 5. |

That last row is the honest statement the brief asks for (brief §25),
so the number is not called "globally monotonic" anywhere in the code
or in this document. Versions are an **ordering**, not a clock.

**Gaps are possible and harmless.** A replay that finds the record
present exits on the fast path *before* claiming anything, so it
consumes no number. A replay that loses the create-if-absent race
consumes one and releases the claim, because the number was not used.
Releasing cannot collide two records — the claim is exclusive at the
moment it is taken.

### The factory, not the record

```js
// Phase 33: the CALLER chose the version
const built = ScheduleStore.buildRecord({ …, version: schedules.takeVersion() });
await schedules.create(built);

// Phase 34: the STORE chooses it
await schedules.create(scheduleId, (version) => ScheduleStore.buildRecord({ …, version }));
```

The version has to be *inside* the bytes and is not known until the
claim succeeds, so a caller that passed a finished record would have
had to pick the number itself — which is the bug being removed. Check
X8 asserts the old signature is now a typed `MALFORMED_RECORD` error
rather than something that silently works.

---

## 7. Idempotency — unchanged, and still structural

```text
scheduleId = "sch-" + sha256(requestId + "\0" + solutionId)[0..16]
```

Phase 34 kept the separator **byte for byte**. It is a literal NUL, and
it looks like a space in a diff — a real hazard, because changing it
to `' '` would re-derive every id and a record committed before the
change would stop being found by the pair that made it. Check X5 pins
both the value (`sch-8afa59b87c3282bb` for the pair Phase 33
documents) and the byte (`0x00`).

The client does not supply the key, so a client cannot cause a
duplicate by choosing a different one.

---

## 8. Corruption, missing records, and directory safety

**One bad record never makes the store unusable.**

| Situation | Behaviour |
|-----------|-----------|
| Truncated / hand-edited `sch-*.json` | `read` → null, `list` skips it, `health.corruptRecordCount` +1, the good records still list, endpoints still 200 |
| A commit targets a name that exists but cannot be read | **not** treated as a duplicate and **not** overwritten — 500 `RECORD_CORRUPT`, `persisted: false`, the damaged bytes untouched |
| Unknown `scheduleId` | 404 `UNKNOWN_SCHEDULE` |
| Unknown `requestId` | 404 `UNKNOWN_REQUEST` |
| Unknown `solutionId` | 404 `UNKNOWN_SOLUTION` with `error.available` |
| `.tmp-*` from an interrupted write | never a schedule; swept only when provably abandoned |
| `.version-*` | never a schedule; **never swept** — it is the proof a number was handed out |

**Directory safety is a whitelist, applied before any string reaches
`join`.** `sch-` plus exactly 16 lowercase hex; `req-` plus a
constrained suffix. `../../.env`, `..\..\package.json`,
`C:\Windows\...`, `sch-ABCDEF0123456789` (right length, wrong case) and
`{toString: () => '../x'}` are all refused — `pathFor` returns `null`
and no path is ever built. Over HTTP, percent-encoded and raw
traversals are refused too, and the assertion is that the response is
the API's own 404 and **never another file's contents**, because that
is the shape a successful traversal would take.

---

## 9. The lifecycle

```text
GENERATED   the solver finished; nothing stored yet
AVAILABLE   stored, integrity verified, not yet committed
COMMITTED   a committed schedule exists for it   (derived)
EXPIRED     a TTL was configured and has passed
INVALID     the hash did not match, the id was malformed, or the
            file is not readable JSON
MISSING     no record for this request id
```

`COMMITTED` is **derived, not stored.** Writing it into the record
would mean a second writer mutating a file whose integrity is
protected by a hash — the one thing a hash cannot survive. It is
computed by asking the schedule store, so it cannot disagree with it.

The lifecycle is asked at **step 2 of the commit, before the solution
lookup**, because "not available", "expired" and "tampered with" are
three facts with three recoveries — generate again, wait, investigate
the store — and a `get` that returns null cannot tell them apart:

```text
EXPIRED  → 410 PREVIEW_EXPIRED
INVALID  → 409 PREVIEW_INTEGRITY / PREVIEW_INVALID
MISSING  → 404 UNKNOWN_REQUEST
```

`NOT_TRACKED` is a real answer. The in-memory `PreviewStore` is still
a supported dependency (several Phase 32/33 checks inject a schedule
the solver would never emit), and it has no file and therefore no hash
— so it says `NOT_TRACKED` rather than implying a check that never
ran. The two stores are interchangeable because both answer
`describe(requestId)` with the same shape.

---

## 10. What did not change

- **The commit request.** Two strings. A third field is still refused
  with `FORBIDDEN_FIELD`, not dropped.
- **The seven-step order.** Vocabulary → lifecycle → lookup →
  re-validate → re-score → build rows → persist → read back.
- **Re-validation is still mandatory and still independent** (§4).
- **Re-scoring semantics are unchanged.** `globalScore` is still the
  generation's own score, and the re-check is still reported
  separately and labelled for what it is. Check 17 asserts the
  committed `globalScore` equals the number the user was shown, and
  is not `0.5`.
- **Idempotency** (§7).
- **The audit block**, and the deliberate absence of prompt text, model
  responses, teacher personal fields, and any `createdBy`.
- **Travel and transfer.** `H14 = UNSUPPORTED`, `H13 = INACTIVE`,
  before and after.

`/generate` gained one additive field, `previewPersistence`, and
`/health` gained `commit.versionAllocation` and a `preview` block. Both
are reported, never required by the UI. Check 20 extracts the field
list from the React hook's own source and asserts the commit response
carries every one, so the contract cannot drift from the UI in either
direction.

---

## 11. Known limitations

1. **The temp-sweep age threshold is a heuristic.** A writer stalled
   for longer than `staleTempMs` (default 300 s) can still lose its
   temp file to another process's construction. The margin is
   orders of magnitude larger than the operation it guards, but it is
   a time-based rule and not a proof of liveness. A truly airtight
   version needs an advisory lock the OS exposes (`flock` on POSIX,
   `LockFileEx` on Windows), which this design did not add.

2. **Version order is an allocation order, not a clock.** Uniqueness is
   guaranteed; monotonicity of *publication* time is not. Callers that
   need "the most recently published" should use `committedAt`, which
   is a real timestamp, rather than `version`.

3. **A version claim released on a lost race can be reused.** This
   cannot collide two records — the claim is exclusive when taken —
   but it means the sequence can close a gap. Stated because the
   alternative (burning a number forever on a duplicate request) has
   its own cost, and choosing is better than accident.

4. **One preview per `requestId`, never replaced.** The first record
   for an id wins and a second writer is told `duplicate: true`. A
   preview is a record of what a generation produced; letting a second
   writer replace it would let the committed schedule and the preview
   describe different candidates with nothing reporting the
   disagreement.

5. **The UI still requires its own session to commit.** The *backend*
   accepts a commit from any process for any stored preview — that is
   what the restart test above proves. But `SchedulePage` learns a
   `requestId` only by generating in that tab, so a reloaded tab cannot
   commit a generation it did not produce. The information is on the
   server and reachable; no UI was added to reach it, because the brief
   excludes UI changes beyond compatibility.

6. **Corruption is detected, not repaired.** A damaged record is
   skipped and counted. Nothing rewrites or quarantines it, because a
   store that silently "fixes" a record it cannot parse is a store
   inventing data.

7. **`previewPersistence` is reported, not rendered.** The generate
   response says whether the preview was stored; the screen does not
   show it. A generation whose preview failed to persist is presented
   exactly like any other — the solutions are real and worth seeing —
   and the user discovers the consequence on the next click. Surfacing
   it in the UI is a design decision the brief deferred.

8. **No authentication.** Unchanged from Phase 33: the commit
   endpoint is open, as every other endpoint here is.

9. **The preview directory grows to the limit, and pruning reads the
   parent.** `prune` checks the schedule directory to avoid deleting a
   preview that produced a committed record, which means one JSON
   parse per committed record per prune. Fine at this scale; it is a
   place to revisit if the record count grows by orders of magnitude.

10. **Travel and transfer remain unresolved.** `H14` is `UNSUPPORTED`
    and `H13` is `INACTIVE`. Durability does not make either feasible
    and does not claim to.

---

## 12. Real-data verification

`40 teachers · 113 classes · 479 assignments · 802 periods · 3
solutions`, zero hard violations. Step 1 ran in a **child process**
which then exited; every later step ran in a process that never held
the generation in memory.

```text
generate   child pid 30744, exited after writing the preview
           preview persisted {"stored":true,"driver":"file"}
           preview file 441,571 bytes

read       lifecycle AVAILABLE   integrity VERIFIED
           ms-85ce6ea2, ms-6306f0d3, ms-c17d7b04

commit     Solution 2 (ms-6306f0d3) -> COMMITTED
           sch-0689cf5b782e433a  version 1  802 slots
           accepted true, hard violations 0
           readback 802 slots, matchesCandidate true
           globalScore 0.6073 (the generation's own)
           preview integrity VERIFIED
           versionAllocation LINK_CLAIM_CROSS_PROCESS

readback   802 slots on disk · 802 slots over HTTP
           113 distinct classes · days 1-6
           hash recomputed from the rows matches the stored hash
           audit.sourceRequestId / sourceSolutionId carry through
```

### Concurrency

```text
10 concurrent commits, SAME solution (record did not exist yet)
  success                10
  was the writer          1
  replayed the record     9
  rejected                0
  errors (5xx)            0
  distinct scheduleIds    1
  distinct versions       1
  records on disk         1

1 further commit, same pair
  COMMITTED_DUPLICATE, same scheduleId, same version 1

3 concurrent commits, DIFFERENT solutions
  success                 3
  was the writer          2      (the third was already committed above)
  replayed the record     1
  rejected                0
  errors (5xx)            0
  distinct scheduleIds    3
  distinct versions       3
  all three coexist

4 OS processes × 5 records, claiming versions concurrently
  20 records · 20 distinct versions · 20 distinct scheduleIds
  4 distinct pids · high-water mark 20 · 20 claim files

final store state
  corrupt records 0 · stale temp files 0 · malformed JSON 0
  version collisions 0

integrity: one slot's day edited in the stored preview
  lifecycle INVALID · http 409 PREVIEW_INTEGRITY
  persisted false · records before/after 3/3
```

### Restart, in the browser

```text
1  generate 3 solutions, select Solution 2 (ms-dab6b0d3, 0.9688)
2  dialog: rank 2, globalScore 0.9688, workloadSpread 12.0,
           maxTeacherLoad 24, periods 802, hard violations 0
3  Confirm -> "Saving…" with the dialog disabled
4  committed badge on Solution 2 only; "1 schedule committed"
5  KILL the backend process
6  START a new one  (a different pid, no memory of anything above)
7  /health: committedCount 1, versionHighWaterMark 1,
            preview.durable true, preview.stored 1, available 1
8  POST /commit for Solution 1 with the requestId the DEAD process
   issued -> 200 COMMITTED, sch-069bde75..., version 2, 802 slots,
   0 hard violations, lifecycle AVAILABLE, integrity VERIFIED
9  RELOAD the page -> "2 schedules committed"
   v2 sch-069bde75 ms-b25dfb04 802 slots 124cc7c44dd60…
   v1 sch-a426eae2 ms-dab6b0d3 802 slots 130f8b5ebf05…
```

Step 8 is the limitation from Phase 33 §12.3, closed: a process that
never held a generation committed a solution from it, and the version
counter continued from the claim file rather than restarting at 1.

### On-disk shape

```text
e2e-phase34/
├── previews/
│   └── req-000001-9c2f4811.json     441,571
├── .version-000000000001            247,248   ← hard link, no extra bytes
├── .version-000000000002            247,248
├── sch-a426eae2cee8e751.json         247,248
└── sch-069bde757d79bcb4.json         247,248
```

---

## 13. What changed in earlier phases

One Phase 33 assertion, updated rather than deleted.

**`G3`** asserted "exactly two files under `src/api/` import
`../persistence/` at all". Phase 34 gave `generate.js` the lifecycle
vocabulary, so a third file imports a persistence module — and the
letter of the old assertion would have forced a choice between a
weaker test and duplicating two string constants.

The property underneath is narrower and stronger — *generate must not
be able to reach a store* — so the test now asks that directly:

- `schedule-store.js` is importable only by `commit.js` and
  `routes.js`;
- `generate.js` may import `preview-record.js` (pure functions and
  constants, no filesystem access anywhere in the module) and must
  never import a store;
- no module under `src/api/` imports `node:fs`, so there is no side
  door around the stores at all.

Unmodified: `G1`–`G7`, `16`, `16b`, and checks 1–20. `16b` (no
database driver) still passes because the driver is still a file;
check X4 re-asserts it against the four modules in
`src/persistence/`, on **imports** rather than on prose — these files
discuss MongoDB at length precisely to explain why there is none.

Frontend: no component changed. `phase34_persistence_ui.test.jsx`
adds 12 regression tests over the new wire fields and the two new
refusals, including the assertion that a 410 and a 409 both land in
the FAILED state with no badge and no success line.
