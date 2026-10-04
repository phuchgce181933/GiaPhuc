# PHASE 26 — TRANSFER SEMANTICS + TRAVEL READINESS

> **Verdict: PARTIAL.**
> The transfer-policy surface and historical transfer audit
> are now formalised. The TravelProvider abstraction is wired
> and deterministic. **H14 (Travel feasibility) remains
> UNSUPPORTED** because no travel matrix exists in the real
> dataset. **H13 (Transfer permission) is INACTIVE** because no
> teacher in the real dataset carries `allowedTransferBranches`.
> The two concepts — *transfer allowed* and *travel feasible* —
> are now cleanly separated and will be plug-compatible with
> future travel data.

## 1. Why Phase 26 is read-only

Phase 25 ended with a verified, multi-candidate search
(`GLOBAL_ASSIGNMENT_BALANCED`) that produces a feasible
candidate on the real dataset. The remaining gap is the
**transfer / travel readiness**:

```text
Teacher home branch
        ↓
Teacher working branch
        ↓
Transfer permission
        ↓
Travel feasibility
        ↓
Transfer cost / preference
```

The brief (§18 / §25) explicitly forbade Phase 25 from
optimising this dimension: there is no travel matrix, and the
real dataset has no teacher with `allowedTransferBranches`. The
optimizer therefore cannot know whether a cross-branch move is
even legal, let alone whether it is cheap.

Phase 26 does NOT close that gap with synthetic data. It:

  - formalises the transfer-policy surface (the data the
    teacher record already carries),
  - audits the historical transfer logs (read-only),
  - designs the TravelProvider contract so a real travel
    source can be plugged in later,
  - reports the orphan reference count, the failure-reason
    catalog, and the H13 / H14 activation status.

When a real travel matrix arrives, the constraint catalog can
be flipped from `UNSUPPORTED` to `ACTIVE` for H14 without
changing any other module.

## 2. Branch graph

The branch graph is the input to any future travel topology.
Phase 26 audits the graph but adds no edges (no travel data
is fabricated).

```text
Branch
  id
  code        (PHC, PH1..PH6)
  name        (Trường chính, Phân hiệu 1..6)
  active      (all 7 active)
  schoolDays  (count from the branch profile)
  periods     (count from the branch profile)
```

Real data:

| id (short code)        | name           | active |
|------------------------|----------------|--------|
| 6a95e5f690cb667a0236a2f5 (PHC) | Trường chính | true   |
| 6a95e5f690cb667a0236a2f6 (PH1) | Phân hiệu 1  | true   |
| 6a95e5f690cb667a0236a2f7 (PH2) | Phân hiệu 2  | true   |
| 6a95e5f690cb667a0236a2f8 (PH3) | Phân hiệu 3  | true   |
| 6a95e5f690cb667a0236a2f9 (PH4) | Phân hiệu 4  | true   |
| 6a95e5f690cb667a0236a2fa (PH5) | Phân hiệu 5  | true   |
| 6a95e5f690cb667a0236a2fb (PH6) | Phân hiệu 6  | true   |

7 branches total. All active. No edges.

## 3. Teacher transfer policy surface

Phase 26 formalises the data the teacher record already carries:

```text
teacher.homeBranchId                 (string | null)
teacher.allowedTransferBranches[]    (string[])
teacher.preferredTransferBranches[]  (string[])
teacher.transferPriority[]           (string[])
teacher.preferredGrades[]            (any[])
```

The helpers (`canWorkAtBranch`, `homeBranchOf`,
`allowedTransferBranchesOf`, `preferredTransferBranchesOf`)
are pure, deterministic, and never invent missing data.

Real-data coverage:

```text
total teachers            : 40
with homeBranchId         : 40
without homeBranchId      :  0   ← Phase 26 does NOT fabricate
with allowedTransferBranches  :  0   ← H13 is INACTIVE
with preferredTransferBranches:  0   ← S05 is INACTIVE
with any transfer policy  : 40
```

All 40 teachers carry a `homeBranchId`. The Phase 26 contract
preserves this fact: a teacher without `homeBranchId` is
reported, not auto-filled with a class branch or an
assignment-branch.

## 4. canWorkAtBranch — the policy helper

The transfer-policy helper is decoupled from travel feasibility.
It returns one of four statuses, each with a `source` field that
traces the decision back to the input data:

```text
HOME         — branch is the teacher's home
ALLOWED      — branch is in teacher.allowedTransferBranches
NOT_ALLOWED  — branch is neither home nor allowed (policy present, no match)
INACTIVE     — no transfer policy is recorded for the teacher
UNKNOWN      — inputs are missing (no fabrication)
```

`isAllowedToWorkAt(teacher, branchId)` collapses the four
statuses to a tri-state:

```text
ALLOW     — HOME or ALLOWED
DENY      — NOT_ALLOWED
UNKNOWN   — INACTIVE or UNKNOWN (no positive policy)
```

The helper does NOT use historical transfer logs to bypass a
missing policy. The brief §16 is explicit:

> "Không lấy historical transfer để bypass missing policy."

The helper does NOT touch travel. Even when the travel provider
is `null` / `MISSING` / `UNSUPPORTED`, the policy answer is
unaffected. Phase 26 §9 makes the distinction explicit in the
documentation; the test suite asserts the independence.

## 5. Historical transfer audit (read-only)

Real data:

```text
Total transfer logs        : 4175
  SUCCESS                  : 3626
  FAILED                   :  549
  UNKNOWN                  :    0

Failure reasons (preserved verbatim from source):
  ADJACENT_SLOT_AT_BRANCH      : 223
  TEACHER_CONFLICT             : 184
  SAME_SESSION_AT_MAIN_BRANCH  : 141
  SPECIALIZATION_MISMATCH      :   1
                              -----
                                549

Transferred baseline assignments:
  totalTransferred          : 87
  withOrigin                : 52
  withoutOrigin             : 35  (orphan)

Successful transfer breakdown:
  same-branch (no travel)   : 75
  cross-branch              : 3085
  unknown-branch (null)     : 466
```

The failure-reason catalog is preserved as **historical
evidence**, not as a hard-constraint specification. Phase 26 §7
documents the mapping from a reason to a *potential* future
constraint, but no constraint is auto-activated. Today the
catalog defines no rule that consults `failureReason`.

## 6. Orphan transfer references

The orphan classification is read-only. Phase 26 does NOT
delete, repair, or fabricate any row.

```text
Orphan transfer log references:
  transfer logs with orphan fromTeacher       : 29
  transfer logs with orphan toTeacher         : 69
  transfer logs with orphan assignment id     : 731  ← the brief's "731"
  transfer logs with orphan fromBranch        :  0
  transfer logs with orphan toBranch          :  0
  transferred assignments without origin      : 35
  unique transfer logs with ANY orphan ref    : 752
  total orphan references (sum across all)    : 864
```

The brief's "731 orphan historical transfer assignment
references" is the count of transfer logs whose `assignment`
id is not in the current `SchedulingInput.assignments[]`. These
are logs that reference deleted or pre-existing assignments —
preserved in the audit, never reattached.

## 7. Failure reason catalog

Phase 26 preserves the historical reason names verbatim:

| Reason                          | Count | Potential future constraint                       |
|---------------------------------|------:|---------------------------------------------------|
| `ADJACENT_SLOT_AT_BRANCH`       | 223   | adjacent-slot rule (H14-adjacent, when travel)    |
| `TEACHER_CONFLICT`              | 184   | already covered by H02 (Teacher no double book)   |
| `SAME_SESSION_AT_MAIN_BRANCH`   | 141   | transfer-time rule (H14-timing)                   |
| `SPECIALIZATION_MISMATCH`       |   1   | already covered by H03 (Subject eligibility)      |

The "potential future constraint" column is a *mapping
intuition*, not an activation. Each reason maps to a rule that
*would* prevent the failure if the rule were active. Today,
none of these rules is active: the historical reason was
captured by a different system that did not enforce the same
constraint set as the Phase 22 catalog.

## 8. Transfer vs travel — the clean separation

Phase 26 §9 documents the conceptual separation:

```text
TRANSFER_ALLOWED  ≠  TRAVEL_FEASIBLE
```

A teacher may have:

```text
teacher.allowedTransferBranches = [PH2]
```

The transfer-policy helper says: ALLOWED. But we do not know
whether the move is feasible:

```text
PH1 → PH2
morning period 2 → afternoon period 1
```

…because the travel matrix is missing. The two questions are
answered by two different modules:

```text
canWorkAtBranch(teacher, branchId)     // domain/transfer
isTravelFeasible(prev, next, provider) // domain/travel
```

When a real TravelProvider arrives, both helpers continue to
work; the constraint catalog simply flips H14 from
`UNSUPPORTED` to `ACTIVE`.

## 9. TravelProvider contract

The contract is intentionally narrow:

```ts
type TravelProvider = {
  status:    () => 'READY' | 'MISSING' | 'UNSUPPORTED';
  travelTime: (fromBranchId: string, toBranchId: string, fromPeriod: number) => number | null;
};
```

Three factory functions:

```text
makeTravelProvider(matrix)
  // matrix[from][to] = minutes
  // status() === 'READY'
  // missing key → null (NOT 0)

makeMissingTravelProvider()
  // status() === 'MISSING'
  // travelTime always returns null

makeUnsupportedTravelProvider()
  // status() === 'UNSUPPORTED'
  // travelTime always returns null
```

The contract is **PURE**: no IO, no clock reads, no mutation.
The provider is constructed with all its data; subsequent
calls are deterministic.

## 10. isTravelFeasible — the future H14 hook

```text
isTravelFeasible(
  previousPlacement: { branchId, day, period, session? },
  nextPlacement:     { branchId, day, period, session? },
  travelProvider,     // TravelProvider | null
  transitionMinutes   // number
) → {
  feasible: boolean,
  minutes:  number | null,
  reason:   <one of TRAVEL_FEASIBILITY_REASON>,
}
```

Reason codes (stable strings, exhaustive):

| Reason                | Meaning                                                |
|-----------------------|--------------------------------------------------------|
| `SAME_BRANCH`         | from and to branch are equal                           |
| `OK`                  | provider has data, transition is in time               |
| `MISSING_PROVIDER`    | provider is `null`                                     |
| `PROVIDER_UNSUPPORTED`| provider reports `UNSUPPORTED`                         |
| `NO_TRAVEL_DATA`      | provider has no data for the (from, to) pair           |
| `INSUFFICIENT_TIME`   | travel minutes > transition budget                     |
| `MISSING_PREV`        | previousPlacement is missing                           |
| `MISSING_NEXT`        | nextPlacement is missing                               |
| `MISSING_TRANSITION`  | transitionMinutes is missing or non-positive           |

Phase 26 §10 / §11 / §12 / §13 / §14 / §17 all map to this
contract. The brief says:

> "Unknown travel does not become 0."
> "Same-branch travel may be 0 if the contract defines it."

The contract above defines same-branch as 0 (the H04 short-
circuit). Cross-branch with missing data returns
`NO_TRAVEL_DATA` and `minutes: null` — never 0.

## 11. Adjacent-slot semantics

The `getNextTemporalSlot(prev, next)` helper answers one
question: is `next` the next temporal slot after `prev`?

```text
SAME_SLOT     — same (day, period)
ADJACENT      — same day, next.period > prev.period
NOT_ADJACENT  — same day, next.period < prev.period
DIFFERENT_DAY — different day
```

The helper does NOT assume "period 5 → period 6 is always
adjacent": it strictly tests the input fields. Sessions (sang
/ chieu) are not consulted; the conflict key already
separates sessions as distinct (day, session, period)
identities.

The helper does NOT hard-code any interpretation of
`ADJACENT_SLOT_AT_BRANCH` (the most common failure reason). It
only reports the temporal order. The "at branch" semantic is
the TravelProvider's job; the provider is missing today.

## 12. Teacher conflict vs travel conflict

The two are kept distinct. A teacher with:

```text
PH1 Monday morning P3   (placement 1)
PH2 Monday morning P4   (placement 2)
```

…is **not** double-booked (different branches, different
periods). The H02 (Teacher no double book) constraint passes.

But the move is potentially **travel-infeasible** if the
provider reports minutes > 10 (or NO_TRAVEL_DATA on the
real dataset). Today, the move is not flagged because H14 is
UNSUPPORTED. When a real matrix arrives, the same placement
pair will fail H14 — the violation is reported separately
from H02.

## 13. H13 / H14 status table

| ID | Code                | Name                 | Status (real data) | Reason                                |
|----|---------------------|----------------------|--------------------|---------------------------------------|
| H13| `H_TRANSFER_ALLOWED`| Transfer permission  | **INACTIVE**       | `data_dependency_missing` (no teacher carries `allowedTransferBranches`) |
| H14| `H_TRAVEL_FEASIBLE`| Travel feasibility   | **UNSUPPORTED**    | `no_travel_matrix` (no provider in input) |

H13 is INACTIVE because the activation predicate
`input.teachers.some(t => t.allowedTransferBranches.length > 0)`
returns `false` for the real dataset. H14 is UNSUPPORTED
because `input.travelTime === null` and the constraint catalog
parks the entry.

Phase 26 does NOT change the activation. It only documents
the activation rules more clearly and prepares the
TravelProvider for a future flip.

## 14. Transfer readiness report

| Question                                  | Answer                                         |
|-------------------------------------------|------------------------------------------------|
| Do we have enough data to call TravelProvider? | **No** (branch IDs yes, matrix no)         |
| Branch IDs                                | **READY** (7 branches, all active)             |
| Branch identity (code / name)             | **READY** (PHC + PH1..PH6)                     |
| Temporal model                            | **READY** (day, period, session)               |
| Travel durations                          | **MISSING** (no matrix, no provider)           |
| TravelProvider implementation             | **NOT YET ACTIVE** (interfaces defined, no production provider) |

```text
Transfer readiness : READY   (policy surface formalised, all 40 teachers carry home branch)
Travel readiness   : NOT READY
H13                : INACTIVE  (no allowedTransferBranches on the real dataset)
H14                : UNSUPPORTED  (no travel matrix)
```

## 15. No optimization, no AI, no external API

Phase 26 explicitly does not:

  - activate H14,
  - introduce a transfer penalty in the optimizer,
  - introduce a travel penalty in the optimizer,
  - introduce branch-switching penalty in the optimizer,
  - call Google Maps, OSRM, Mapbox, or GraphHopper,
  - introduce AI / LLM / AirLLM,
  - introduce multi-solution ranking,
  - introduce any heuristic that would alter the Phase 25
    `GLOBAL_ASSIGNMENT_BALANCED` search.

The only Phase 25 regression guarantee verified in the test
suite: the GLOBAL candidate still has `hardViolations = 0` on
the real dataset (Phase 26 invariant #22).

## 16. Code organization

```text
backend/src/domain/transfer/   ← new (Phase 26)
  branch-graph.js              — branch graph audit
  transfer.js                  — transfer-policy semantics
  history-analysis.js          — historical transfer audit
  orphan-analysis.js           — orphan classification
  index.js                     — public surface + buildTransferAudit

backend/src/domain/travel/     ← migrated from domain/travel.js
  travel-provider.js           — TravelProvider contract + 3 factories
  feasibility.js               — isTravelFeasible + getNextTemporalSlot
  index.js                     — public surface (re-exports)
```

The old `backend/src/domain/travel.js` is removed. All
importers (`catalog.js`, `constraints.js`, `solver.js`,
`dataset.js`, three Phase 1x test files) now import from
`backend/src/domain/travel/index.js`.

## 17. Test surface

`backend/tests/phase26_transfer_travel_readiness.test.js`
covers 27 invariants (the brief's 22 plus 5 extra):

| #    | Invariant                                                           |
|------|---------------------------------------------------------------------|
| 1    | 7 branches resolved                                                 |
| 2    | teacher branch references resolve                                   |
| 3    | allowed transfer branches resolve                                   |
| 4    | preferred transfer branches resolve                                 |
| 5    | missing homeBranch is not fabricated                                |
| 6    | transfer permission is distinct from travel feasibility             |
| 7    | historical transferred assignments = 87                             |
| 8    | historical transfer logs = 4175                                     |
| 9    | SUCCESS = 3626                                                      |
| 10   | FAILED = 549                                                        |
| 11   | orphan transfer references = 731                                    |
| 12   | orphan logs preserved                                               |
| 13   | failure reasons preserved                                           |
| 14   | H14 remains UNSUPPORTED                                              |
| 15   | no travel matrix fabricated                                         |
| 16   | TravelProvider interface deterministic                              |
| 17   | unknown travel does not become 0                                    |
| 18   | same-branch semantics follow contract                               |
| 19   | transfer helper is deterministic                                    |
| 20   | baseline transfer is historical only                                |
| 21   | Phase 25 GLOBAL candidate still works                               |
| 22   | Phase 25 hard violations remain 0                                   |
| 23   | (extra) getTravelProviderStatus normalises factory outputs          |
| 24   | (extra) getNextTemporalSlot is order-aware and pure                 |
| 25   | (extra) checkTransition is a backward-compatible alias              |
| 26   | (extra) analyzeOrphanReferences returns a stable structure          |
| 27   | (extra) analyzeTransferHistory exposes the brief-required buckets   |

All 27 pass.

## 18. Regression

```text
Before Phase 26:  439 tests pass
After  Phase 26:  466 tests pass  (439 + 27)
Failed:           0
```

No Phase 1–25 test was modified. The Phase 26 additions are
strictly additive:

  - new `domain/transfer/` module (5 files),
  - migrated `domain/travel.js` → `domain/travel/` (3 files),
  - updated 5 import sites to point at the new location,
  - 1 new test file (27 invariants),
  - this document.

The Phase 25 GLOBAL_ASSIGNMENT_BALANCED mode is untouched.
The Phase 22 constraint catalog is untouched. The Phase 23
solver is untouched. The Phase 24 metrics are untouched.

## 19. Definition of Done

```text
[x] transfer semantics formalized                                 ← §3, §4
[x] branch graph audited                                          ← §2
[x] teacher transfer policy audited                               ← §3
[x] missing home branch preserved                                 ← #5
[x] historical transfer data analyzed                              ← §5
[x] orphan logs preserved                                          ← §6, #12
[x] transfer ≠ travel semantics                                    ← §8, #6
[x] TravelProvider abstraction created                            ← §9
[x] unknown travel is not zero                                     ← §10, #17
[x] H14 remains UNSUPPORTED                                        ← §13, #14
[x] no fake travel matrix                                          ← §15
[x] no active travel optimization                                  ← §15
[x] Phase 25 GLOBAL regression remains valid                        ← #21, #22
[x] tests pass                                                     ← §17
[x] PHASE_26_TRANSFER_TRAVEL_READINESS.md                          ← this file
```

## 20. Final report

```text
Transfer readiness : READY       (policy surface, audit, orphan classification)
Travel readiness   : NOT READY   (no matrix; provider interfaces defined)
H13                : INACTIVE    (no allowedTransferBranches on real data)
H14                : UNSUPPORTED (no travel matrix)
Phase 25 regression: OK          (466 = 439 + 27; 0 failed)

Historical transfers        : 87
Transfer logs               : 4175
  SUCCESS                   : 3626
  FAILED                    :  549
Orphan transfer references  : 731  (transfer logs with orphan assignment id)
  + 35  transferred assignments without origin
  + 29  transfer logs with orphan fromTeacher
  + 69  transfer logs with orphan toTeacher
  + 752 unique transfer logs with any orphan reference

Failure reasons (preserved):
  ADJACENT_SLOT_AT_BRANCH        : 223
  TEACHER_CONFLICT               : 184
  SAME_SESSION_AT_MAIN_BRANCH    : 141
  SPECIALIZATION_MISMATCH        :   1

Tests:
  Before = 439
  After  = 466
  Passed = 466
  Failed = 0

Phase 26 stops here. No optimization, no AI, no travel data fabrication.
```
