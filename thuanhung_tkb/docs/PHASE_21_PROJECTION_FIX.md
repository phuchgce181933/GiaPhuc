# PHASE 21 — PROJECTION FIX

> Phase 21 fixes the two known projection bugs in
> `scheduling-model.js` that Phase 20 surfaced.
>
> Scope: **projection only.** The domain contract, the
> validator, the orchestrator, the solver, the AI strategy,
> the raw legacy data, the normalized source data, the
> baseline, the travel matrix, and every heuristic stay
> untouched.
>
> ```text
> RAW LEGACY DATA (data/source/legacy-saplich/)
>       ↓ (raw-reader.js, normalize.js)
> NORMALIZED DOMAIN
>       ↓ (scheduling-model.js) ← Bug #1 + Bug #2 fixed here
> SCHEDULING MODEL
>       ↓ (validateInput, orchestrator.preview)
> ORCHESTRATOR INPUT
> ```
>
> The audit numbers in this document come from
> `backend/src/loader/legacy-saplich/verify.js` (with a few
> additions) running against the legacy-saplich import
> result. The audit code is read-only.

---

## 1. Bug #1 — Curriculum `classId` masquerading as a class id

### Before

```text
// scheduling-model.js (Phase 20, buggy)
curriculum.push({
  id: cs.id,
  classId: cs.block,   // ← BUG: block id, not class id
  subjectId: cs.subject,
  requiredPeriods: cs.periodsPerWeek,
  academicYear: cs.academicYear,
});
```

`cs.block` is the source `blocksubjects.block` field — a
*block* (one of 5 grade groups), not a class (one of 113
classes). The orchestrator's `validateInput` checks
`curriculum.classId` against `classes[]`, finds the block id
is not a class id, and reports `invalid_reference` for all
21 effective rows. The orchestrator then short-circuits with
`status = INVALID_INPUT`.

### Why it was wrong

The SchedulingInput contract requires `curriculum[].classId`
to be a *class* id. A block is a grade group, not a class.
The semantic gap is:

```text
BlockSubject (24 raw rows)
       ↓
Block   ← what was being put into classId
       ↓
Classes in Block   ← the missing expansion
       ↓
Class + Subject = scheduling demand
```

The brief is explicit: Curriculum = demand definition;
Class + Subject = scheduling demand. The projection was
short-circuiting the second hop and writing the block id
directly.

### After

```text
// scheduling-model.js (Phase 21, fixed)
const blockToActiveClasses = new Map();
for (const c of normalized.classes) {
  if (!c.isActive) continue;
  if (!blockToActiveClasses.has(c.block)) blockToActiveClasses.set(c.block, []);
  blockToActiveClasses.get(c.block).push(c);
}
for (const list of blockToActiveClasses.values()) {
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

for (const cs of normalized.curriculum) {
  if (cs.subject != null && inactiveSubjectIds.has(cs.subject)) {
    excludedCurriculum.push({ ...cs, _reason: 'inactive_subject' });
    continue;
  }
  const classesInBlock = blockToActiveClasses.get(cs.block) || [];
  if (classesInBlock.length === 0) {
    excludedCurriculum.push({ ...cs, _reason: 'no_active_classes_in_block' });
    continue;
  }
  for (const c of classesInBlock) {
    curriculum.push({
      id: `${cs.id}::${c.id}`,   // composite id, traceable to source
      classId: c.id,             // REAL class id
      blockId: cs.block,         // preserve source block id
      subjectId: cs.subject,
      requiredPeriods: cs.periodsPerWeek,
      academicYear: cs.academicYear,
    });
  }
}
```

Each effective (block, subject) blocksubject row is expanded
to one scheduling row per *active* class in the block. The
source `blockId` is preserved on every expanded row so
block-level semantics are not lost. The composite id
(`${sourceId}::${classId}`) makes every scheduling row
reducible to a single source row (round-trip test P22).

### Validation

| Check                                    | Before | After |
| ---------------------------------------- | -----: | ----: |
| Curriculum rows with invalid `classId`   |     21 |     0 |
| Curriculum rows with valid `classId`     |      0 |   479 |
| Curriculum rows with `blockId` preserved |      0 |   479 |
| `curriculumSubjectIdMismatch`            |      0 |     0 |
| Validator `invalid_reference` count      |     21 |     0 |
| Class-level curriculum rows               |     21 |   479 |

The 21→0 invalid_reference drop is the validator no longer
seeing block ids in the `classId` field. The 21→479
class-level expansion matches the 479 historical assignments
exactly in the real dataset (every (class, subject) demand
pair in the curriculum projection has at least one
corresponding assignment).

---

## 2. Bug #2 — Subject name vs Subject ID in `chuyenMon`

### Before

```text
// scheduling-model.js (Phase 20, buggy)
chuyenMon: t.specializations
  .filter((sid) => subjectIdSet.has(sid))
  .map((sid) => ({
    tenChuyenMon: normalized.subjects.find((s) => s.id === sid).name,  // ← BUG: name
    soTietTuan: 1,
  })),
```

`tenChuyenMon` was set to the *subject name* (e.g.
`"Mỹ thuật"`). The orchestrator's eligibility check runs:

```text
// domain/validate.js (Phase 14, unchanged)
teacher.chuyenMon.some((s) => s.tenChuyenMon === a.subjectId)
```

`a.subjectId` is a 24-char hex id (e.g.
`"6a95e5f7804df2aa759c60ec"`). Comparing it to
`"Mỹ thuật"` never matches. Every assignment was reported
as `unresolvable_demand` (479 in total).

### Why it was wrong

The two fields were talking past each other in different
namespaces. Source `teacher.specializations[]` is *subject
ids*. The projection was converting them to *subject names*
in `tenChuyenMon`. The eligibility check then compared a
name with an id, which is a category error.

The brief is explicit: Subject.id is the canonical identity.
Teacher eligibility must work in the subject-id namespace.
The legacy Vietnamese field name (`tenChuyenMon`) stays for
contract compatibility; its *value* must be the subject id,
not the name.

### After

```text
// scheduling-model.js (Phase 21, fixed)
const eligibleSubjectIds = t.specializations.filter((sid) => subjectIdSet.has(sid));
teachers.push({
  id: t.id,
  hoTen: t.name,
  // ...
  chuyenMon: eligibleSubjectIds.map((sid) => ({
    tenChuyenMon: sid,   // subject id, NOT subject name
    soTietTuan: 1,
  })),
  eligibleSubjectIds,    // explicit list of subject ids; solver-friendly
  // ...
});
```

Two co-existing projections of the same eligibility:

* `chuyenMon[].tenChuyenMon` — kept for contract
  compatibility (the field name is the contract). The VALUE
  is the subject id. The orchestrator's
  `tenChuyenMon === subjectId` check now works because both
  sides are subject ids.
* `eligibleSubjectIds[]` — explicit, solver-friendly list
  of subject ids. The solver can consult this without
  depending on the legacy field name.

No teacher loses eligibility. The audit checks
(`eligibilityIssues`, `eligibilityAsAssignment`) confirm no
spurious drop and no spurious promotion to assignment.

### Validation

| Check                                | Before | After |
| ------------------------------------ | -----: | ----: |
| `tenChuyenMon` = subject id (always) |      0 |    42 |
| `tenChuyenMon` = subject name (any)  |     42 |     0 |
| `eligibleSubjectIds` present         |      0 |    40 |
| Validator `unresolvable_demand`      |    479 |     0 |
| Teachers with eligibility            |     40 |    40 |

Every active teacher now has `eligibleSubjectIds[]` populated
with the same ids the source `specializations[]` carried.
The orchestrator's eligibility check
(`tenChuyenMon === subjectId`) now passes for every
assignment.

---

## 3. Metric comparison table

| Metric                    | Phase 20 (Before) | Phase 21 (After) |
| ------------------------- | ----------------: | ---------------: |
| `invalid_reference`       |                21 |               0 |
| `unresolvable_demand`     |               479 |               0 |
| active teachers           |                40 |              40 |
| effective curriculum (block-level source) | 21 | 21 |
| assignments               |               479 |             479 |
| required periods          |               802 |             802 |
| assigned periods          |               802 |             802 |
| baseline slots            |               802 |             802 |
| travel                    |          MISSING |         MISSING |

The Phase 21 fix changes the *projection shape* (curriculum
is class-level now, not block-level), but the *block-level
audit metric* stays at 21. The 21 effective block-level
rows are the source-side count, captured in
`scheduling._meta.effectiveCurriculumBlockLevel`. The
class-level projection is `scheduling.curriculum.length`
(479) and is captured in
`scheduling._meta.classLevelCurriculumCount`.

| Curriculum shape           | Phase 20 | Phase 21 |
| -------------------------- | -------: | -------: |
| `curriculum.length`        |       21 |      479 |
| `_meta.effectiveCurriculumBlockLevel` | not present | 21 |
| `_meta.classLevelCurriculumCount`     | not present | 479 |
| Every row has a real `classId` |       no | yes |
| Every row has `blockId`           |       no | yes |

---

## 4. Validator + orchestrator behaviour

### Phase 20

```text
validateInput(scheduling):
  issues.invalid_reference   = 21
  issues.unresolvable_demand = 479
  missing.Travel              = 1   (legitimate)

orchestrator.preview(scheduling):
  status = INVALID_INPUT
  strategiesAttempted = 0
  totalSolveMs        = 0
```

The orchestrator short-circuited on the 21 + 479 issues
before reaching the solver. The `status` was a structural
INVALID_INPUT driven entirely by the two projection bugs.

### Phase 21

```text
validateInput(scheduling):
  issues = []
  missing.Travel = 1   (legitimate; no travel matrix in source)

orchestrator.preview(scheduling):
  status != INVALID_INPUT
  strategiesAttempted > 0
  totalSolveMs > 0
  (Travel remains MISSING_DATA — not a critical entity)
```

The 21 + 479 issues are gone. The orchestrator now reaches
the solver. Travel remains MISSING_DATA per the contract
(it's not a critical entity). The H_TRAVEL_FEASIBLE
constraint remains INACTIVE because no travel matrix exists.

---

## 5. What was NOT changed

Per the brief, Phase 21 does not touch:

* Raw legacy data (the BSON dump under
  `data/source/legacy-saplich/`). No document is altered.
* Normalized source data. The `normalize.js` mappers are
  unchanged. The `toId` / `toIso` helpers are unchanged.
* The SchedulingInput contract shape beyond the two bug
  fields (`curriculum.classId` and `chuyenMon[].tenChuyenMon`).
  New fields added: `curriculum.blockId`,
  `eligibleSubjectIds[]`, `_meta.effectiveCurriculumBlockLevel`,
  `_meta.classLevelCurriculumCount`. The orchestrator
  contract accepts them (it ignores unknown fields).
* The domain validator. The check
  `chuyenMon.some(s => s.tenChuyenMon === a.subjectId)` is
  preserved; the projection now puts a matching value in
  `tenChuyenMon`.
* The orchestrator, the solver, the AI strategy, the
  presets, the diversity helpers, the explainer, the
  scorer, the fixture loader, the dataset loader, the
  routes, the middleware. All untouched.
* The legacy baseline (`legacyBaseline.scheduleSlots`,
  `legacyBaseline.assignments`, `legacyBaseline.summary`).
  These still report the source truth (802 slots, 479
  assignments, 87 transfers, 4175 logs, etc.).
* Travel data. `travelTime` stays `null`; `travelStatus`
  stays `'MISSING_CONFIGURATION'`. No matrix is fabricated.
* The baseline ≠ fixed distinction. Every assignment still
  carries `baselineAssignment: true`. No `fixedAssignment`
  field is added. The solver retains the right to
  re-optimize teacher selection.

---

## 6. What was changed

| File | Change |
| ---- | ------ |
| `backend/src/loader/legacy-saplich/scheduling-model.js` | Bug #1: curriculum expanded block → active classes. Bug #2: `tenChuyenMon` is now the subject id; added `eligibleSubjectIds[]` and `_meta` audit fields. |
| `backend/src/loader/legacy-saplich/verify.js` | `verifyTeachers` now reports eligibility-issues and `eligibilityAsAssignment` (renamed from `specializationAsAssignment`); `verifyCurriculum` now reports `effectiveCurriculumBlockLevel`, `classLevelCurriculumCount`, `curriculumSubjectIdMismatch`, and `curriculumMissingBlockId`. |
| `backend/tests/phase20_orchestrator_audit.test.js` | Tests T6, Cu1, O1–O5, Tch4 were updated to assert the FIXED state instead of the BUG state. Comments mark each update explicitly. |
| `backend/tests/phase19_legacy_ingestion.test.js` | Test L19 was updated to assert the new class-level shape (479) and the preserved block-level metric (21) on `_meta`. |
| `backend/tests/phase21_projection_fix.test.js` | New regression test file. 30 tests covering the two bugs, the operational counts, the round-trip traceability, determinism, and the validator/orchestrator state. |

No other test in Phase 1–20 was modified.

---

## 7. Regression report

```text
Phase 20 baseline: 269 tests
Phase 21 final:    299 tests
   (269 existing + 30 new Phase 21 regression tests)
Passed: 299
Failed: 0
```

All 269 pre-existing tests continue to pass (with the 8
necessary updates in `phase20_orchestrator_audit.test.js`
and `phase19_legacy_ingestion.test.js` that were asserting
the BUG state — those updates are explicitly documented in
the test files as "PHASE 21 UPDATE" comments).

All 30 new Phase 21 tests pass.

---

## 8. Definition of Done

* [x] curriculum projection đúng classId
* [x] curriculum projection giữ blockId
* [x] teacher specialization resolve name → subjectId
       (i.e. `tenChuyenMon` is now the subject id)
* [x] invalid_reference = 0
* [x] unresolvable_demand = 0
* [x] all operational references valid
* [x] 40 active teachers
* [x] 7 branches
* [x] 113 classes
* [x] 5 active subjects (catalog has 6 incl. CN-TH)
* [x] 21 effective curriculum (block-level)
* [x] 479 assignments
* [x] 802 required periods
* [x] 802 assigned periods
* [x] 802 baseline slots
* [x] baseline không thành fixed assignment
* [x] travel vẫn MISSING, không fabricate
* [x] SchedulingInput deterministic
* [x] orchestrator không còn INVALID_INPUT do projection
* [x] regression tests pass
* [x] PHASE_21_PROJECTION_FIX.md được tạo

---

## 9. Phase 22 onward

Phase 21 stops at making the SchedulingInput *correct* and
*consistent* with the real data. It does NOT:

* Optimize the solver
* Tune strategy weights
* Integrate AI / AirLLM
* Compare quality vs. legacy baseline
* Fabricate a travel matrix
* Promote baseline assignments to fixed assignments
* Auto-create classes or invent subjects

The next phase can focus on solver-level concerns knowing
the input contract is trustworthy.
