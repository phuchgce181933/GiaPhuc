# PHASE 22.1 — BASELINE RECONCILIATION

> Phase 22.1 reconciles the legacy-baseline evaluation against the
> Phase 19/20 raw-data integrity audit. Phase 22 (pre-fix) reported
> 335 hard violations (83 H01 class-double + 252 H02 teacher-double)
> on the 802 historical slots. Phase 19/20 reported 0 raw duplicates
> on the same 802 slots. The two results cannot both be right; the
> root cause was an identity definition bug in the new catalog.
>
> This document is the canonical record of:
>   1. What Phase 19/20 reported.
>   2. What Phase 22 reported.
>   3. The exact field/mapping/identity that caused the discrepancy.
>   4. The fix.
>   5. The independent verification.
>   6. The final baseline evaluation result.
>
> No source data was modified. No fixture was modified. No baseline was
> mutated. No solver, AI, scorer, orchestrator, or work-around was
> introduced.

---

## 1. Phase 19/20 raw-integrity result (the floor)

Phase 19 ingestion and Phase 20 verification report the following on
the raw 802 historical `scheduleslots`:

```text
total slots                                    : 802
assignment slot-count mismatches               : 0
duplicate class / day / session / period       : 0
duplicate teacher / day / session / period     : 0
slot subject mismatch vs assignment subject    : 0
slot teacher mismatch vs assignment teacher    : 0
```

Identity used: `(entity, day, session, period)` where `entity` is
`class` for the class-duplicate check and `teacher` for the
teacher-duplicate check. See `docs/PHASE_20_ORCHESTRATOR_DRYRUN_AUDIT.md`
§11 and `backend/src/loader/legacy-saplich/verify.js` →
`verifyScheduleSlots`.

---

## 2. Phase 22 evaluator result (the divergence)

Phase 22 ran `evaluateBaseline(legacyBaseline, scheduling)` on the
same 802 slots and reported:

```text
H01 (class double)     : 83 violations
H02 (teacher double)   : 252 violations
H04 (slot in branch)   : 0
H06 (slot validity)    : 0
total hard             : 335
```

This number was independently re-derived in
`backend/tests/debug22_1.js` (read-only, no fixture change):

```text
Identity (B): (entity, day, period) [drops session]
  rawClassDuplicates    : 83
  rawTeacherDuplicates  : 252
```

The **two reports agreed** on the same data. The disagreement was
between identities (Phase 19/20 used (A) with-session; Phase 22 used
(B) without-session), not between data sets.

---

## 3. Root cause — identity definition, NOT data corruption

The conflict-identity used by the new catalog's H01 and H02 was
`(entity, day, period)`. The brief-correct identity is
`(entity, day, session, period)`.

The legacy scheduleslots frequently place the same entity (class or
teacher) in two slots at the same `(day, period)` but in different
sessions (`morning` vs `afternoon`). The legacy data encodes these as
distinct physical times; the contract treats them as distinct; the
Phase 19/20 integrity check confirms zero duplicates under the
session-aware identity.

When Phase 22 dropped `session` from the conflict key, the legacy
"morning period 2" and "afternoon period 2" pair collapsed into a
single key, producing exactly 83 class-key and 252 teacher-key
collisions. The catalog had no view of session, so it could not tell
the pairs apart. **Both reports were correct under their respective
identities.** The bug was the missing session component in the new
catalog, not the legacy data.

Independent verification (`debug22_1.js`):

```text
All (B) class duplicates are cross-session   : true
All (B) teacher duplicates are cross-session : true
```

i.e. every single one of the 83 + 252 collisions is a same
`(day, period)` pair in **different** sessions. There is no real
duplicate under the brief-correct identity.

### The specific fix (no work-around)

Two functions in `backend/src/domain/time.js` were updated, and the
new catalog wired to them:

1. New session-aware conflict keys
   - `classConflictKey(slot)`  = `day : normalizeSession(session) : period`
   - `teacherConflictKey(slot)` = `day : normalizeSession(session) : period`
2. New `normalizeSession(value)` that maps `morning` → `sang`,
   `afternoon` → `chieu`, and returns `null` for unknown values
   (no fabrication).
3. `backend/src/domain/constraints/catalog.js` H01 and H02
   consult `classConflictKey` / `teacherConflictKey` instead of
   the legacy `classSlotKey` / `teacherSlotKey`.
4. `backend/src/domain/constraints/evaluator.js` →
   `evaluateBaseline(baseline, input)` converts the raw session
   string (`morning` / `afternoon`) to the canonical code
   (`sang` / `chieu`) before stamping each candidate slot. The
   raw slot's `_sourceSlotId`, `_sourceAssignmentId`,
   `_sourceClass`, `_sourceTeacher`, `_sourceSubject` are
   preserved for traceability.

The legacy `classSlotKey` / `teacherSlotKey` (no-session) are
preserved for the legacy validator and the solver's pruning, with
explicit `DEPRECATED for conflict detection` comments in the source.
No solver / AI / scorer / orchestrator was modified.

### What was NOT changed

- `data/source/legacy-saplich/` — untouched.
- `backend/src/loader/legacy-saplich/normalize.js` — untouched.
- `backend/src/loader/legacy-saplich/legacy-baseline.js` —
  untouched.
- `backend/src/loader/legacy-saplich/integrity.js` —
  untouched (Phase 19/20 floor is still correct).
- `backend/src/loader/legacy-saplich/verify.js` —
  untouched.
- `backend/src/loader/legacy-saplich/scheduling-model.js` —
  untouched.
- `backend/src/domain/constraints.js` (the legacy validator
  path) — untouched.
- `backend/src/domain/solver.js` — untouched.
- `backend/src/orchestrator/*` — untouched.

The Phase 22 catalog continues to use the same evaluator entry
points (`evaluateCandidate`, `evaluateBaseline`); only the
identity it consults changed.

---

## 4. Independent verification (Phase 22.1 §3 / §4 / §5)

`backend/tests/phase22_1_baseline_reconciliation.test.js` was
added. It is **read-only**. It does not modify any source data,
any normalized data, any fixture, or the baseline.

The test file performs an independent duplicate check on the raw
802 slots, computes both identities, and asserts:

| Identity | Class dupes | Teacher dupes |
| --------- | --------: | -----------: |
| (entity, day, session, period) — Phase 19/20 | 0 | 0 |
| (entity, day, period) — old Phase 22       | 83 | 252 |

These numbers are asserted from the test, not hard-coded into the
production code:

```text
PHASE 22.1 / R18 — explicit raw-vs-no-session comparison
  rawClassDuplicatesNoSession    = 83   ✓
  rawTeacherDuplicatesNoSession  = 252  ✓
  rawClassDuplicatesWithSession  = 0    ✓
  rawTeacherDuplicatesWithSession= 0    ✓
```

The brief-correct identity agrees with Phase 19/20: zero duplicates
on the raw 802 slots.

The test file also asserts that the baseline adapter preserves
**every** raw field on every slot:

| Test | Asserts |
| ---- | ------- |
| R3   | 802 raw slots → 802 candidate slots |
| R4   | `_sourceClass` round-trips |
| R5   | `_sourceTeacher` round-trips |
| R6   | `_sourceSubject` round-trips |
| R7   | candidate `session === normalizeSession(raw.session)` |
| R8   | candidate `period === raw.period` |
| R9   | no candidate slot has `null`/`undefined` `day`/`period`/`session` |

---

## 5. H12 — preferred session (semantics review)

Audit conclusion: **H12 stays INACTIVE**.

The current contract declares `preferredSession` is a **preference**
(not a hard requirement). The brief §14 is explicit: preferences
are SOFT. The constraint catalog therefore exposes:

- `H12 / H_PREFERRED_SESSION` — listed for catalog completeness.
  Active predicate is `() => false` (always INACTIVE). The
  description in the catalog explicitly states: "Today the
  contract declares this is SOFT, so this constraint is INACTIVE
  in the current domain."
- `S01 / S_PREFERRED_SESSION` — the SOFT variant. Active when
  any teacher has `nguyenVong.buoiUuTien` set to `sang` or
  `chieu` (40 teachers in the real dataset).

No business or data evidence in the legacy dump elevates
`preferredSession` from preference to requirement. Phase 22.1
**does not change policy**. The two entries are kept distinct so
a future contract amendment has an explicit slot to flip.

---

## 6. H09 / S04 — workload capacity (semantics review)

Audit conclusion: **H09 and S04 stay INACTIVE**.

The legacy dump carries `chuyenMon[].soTietTuan = 1` for every
entry (40 specializations, all placeholder). This field is
**per-subject specialization teaching demand**, not a teacher
weekly capacity. Treating it as capacity would be semantically
wrong (every teacher would be at budget 1, regardless of how
many subjects they teach).

The Phase 22 catalog therefore uses a **placeholder gate** on
both H09 and S04:

```text
ACTIVE  iff  ∃ teacher t such that
  t.chuyenMon.some(s => Number(s.soTietTuan) > 1)
```

In the real dataset:

| Field                               | Count |
| ----------------------------------- | ----: |
| teachers with `soTietTuan > 1`      | 0     |
| teachers with `soTietTuan == 1`     | 40    |

H09 and S04 are **INACTIVE** in the real dataset. They become
ACTIVE only when a future migration carries a real per-subject
workload signal. No capacity is invented.

No solver tuning, no policy rewrite, no work-around. The catalog
mirrors the data exactly.

---

## 7. Final baseline evaluation (post-fix)

```text
PHASE 22.1 BASELINE EVALUATION (post-fix)
  Total candidate slots        : 802
  Hard violations              : 0
  Soft penalty                 : 35.002
  Accepted                     : true

  Hard violations by constraint:
    (none)

  Soft violations by constraint:
    S01 (preferred session)    : 35.0  (penalty)
    S07 (session compact)       : 0.0   (no penalty)
    S08 (concentration)        : 0.0   (no penalty)
```

The legacy historical baseline is **accepted**: zero hard
violations. The soft penalty (35.0) reflects teachers whose
sessions do not match their declared `nguyenVong.buoiUuTien`.
These are real historical imperfections, surfaced by S01 and
treated as preference pressure, not as fatal.

---

## 8. Regression report

```text
Phase 22 baseline (post-fix): 347 tests
Phase 22.1 final            : 347 tests
  (329 existing + 18 new Phase 22.1 reconciliation tests)
Passed: 347
Failed: 0
```

The 18 new tests (`phase22_1_baseline_reconciliation.test.js`):

| Test | Asserts |
| ---- | ------- |
| R1   | raw class duplicate count (with-session) = 0 |
| R2   | raw teacher duplicate count (with-session) = 0 |
| R3   | baseline adapter preserves all 802 slots |
| R4   | baseline preserves classId |
| R5   | baseline preserves teacherId |
| R6   | baseline preserves subjectId |
| R7   | baseline preserves session (canonical form) |
| R8   | baseline preserves period |
| R9   | no baseline placement has missing day/session/period |
| R10  | baseline H01 result matches raw duplicate count (with-session) |
| R11  | baseline H02 result matches raw duplicate count (with-session) |
| R12  | `evaluateBaseline()` does not mutate baseline |
| R13  | `evaluateBaseline()` deterministic (1st vs 2nd call) |
| R14  | repeated evaluation gives identical result (10x) |
| R15  | cross-session slots are NOT counted as H01 violations |
| R16  | `classConflictKey` / `teacherConflictKey` discriminate by session |
| R17  | session aliases (morning/afternoon) normalize to sang/chieu |
| R18  | explicit raw-vs-no-session comparison |

All 329 pre-existing tests continue to pass without change.

---

## 9. What changed (Phase 22.1)

| File                                                            | Change |
| --------------------------------------------------------------- | ------ |
| `backend/src/domain/time.js`                                    | Added `normalizeSession`, `classConflictKey`, `teacherConflictKey`. Kept `classSlotKey` / `teacherSlotKey` for the legacy validator / solver pruning (marked DEPRECATED). |
| `backend/src/domain/constraints/catalog.js`                     | H01 / H02 wired to `classConflictKey` / `teacherConflictKey` instead of the legacy `classSlotKey` / `teacherSlotKey`. |
| `backend/src/domain/constraints/evaluator.js`                   | `evaluateBaseline()` converts `morning`/`afternoon` → `sang`/`chieu` and attaches `_sourceSlotId` / `_sourceAssignmentId` / `_sourceClass` / `_sourceTeacher` / `_sourceSubject` for traceability. |
| `backend/tests/phase22_1_baseline_reconciliation.test.js` (new) | 18 read-only regression tests. |
| `docs/PHASE_22_1_BASELINE_RECONCILIATION.md` (this document)    | The audit record. |
| `docs/00_INDEX.md`                                              | Index updated. |

No source data, no fixture, no baseline was modified. The legacy
`data/source/legacy-saplich/` directory is byte-identical to its
pre-Phase 22.1 state.

---

## 10. Definition of Done |

| Item                                                        | Status      |
| ---------------------------------------------------------- | ----------- |
| raw 802 slots independently verified                       | ✓           |
| raw class duplicate count known                          | ✓ (with-session=0, no-session=83) |
| raw teacher duplicate count known                        | ✓ (with-session=0, no-session=252) |
| all 802 slots traceable (source slot id preserved)         | ✓ (R3, R4–R8) |
| baseline adapter preserves slot semantics                  | ✓ (R3–R9)   |
| H01 / H02 match raw reality                                | ✓ (R10, R11)|
| no workaround / special case                               | ✓           |
| H12 semantics reviewed (still INACTIVE, contract unchanged)| ✓ (§5)      |
| H09 / S04 semantics reviewed (still INACTIVE, placeholder gate preserved) | ✓ (§6) |
| regression tests pass                                      | ✓ (18 / 18) |
| audit doc created                                          | ✓ (this file)|
| all previous tests still pass                              | ✓ (329 / 329)|

---

## 11. Stop here.

Phase 22.1 stops at the reconciliation. No solver optimization.
No tuning. No AI / AirLLM. No multi-solution comparison. No
scoring work. The catalog is the contract; the evaluator is the
gate; and now the gate sees the legacy baseline correctly.