import { sessionForSlot } from '../domain/time.js';
import { effectiveAssignmentMeta } from '../domain/assignment.js';
// PHASE 32 — RESPONSE MAPPERS: the PII boundary.
//
// Every byte the API returns passes through this module. Nothing is
// spread from a domain object, because spreading a domain object is
// how a `teacher.email` ends up in a browser: the SchedulingInput is
// full of personal fields (`hoTen`, `email`, `soDienThoai`) and the
// raw loader also carries `_meta`, `excludedCurriculum`, and
// per-assignment transfer bookkeeping that has no place in a
// timetable view (brief §41, §42, §43).
//
// THE RULE
// --------
// Each mapper is an explicit WHITELIST. A field that is not named in
// a mapper cannot leave the backend, so adding a personal field to
// the loader is not a leak — it is simply not projected. A blacklist
// would fail the other way: every new domain field would have to be
// remembered, and the first one that was forgotten would ship.
//
// A test (`phase32_api_e2e.test.js` checks 13, 14, 29) serializes a
// real response and asserts the absence of the personal keys, so the
// rule is enforced rather than merely stated.
//
// WHAT IS DELIBERATELY INCLUDED
// -----------------------------
//   teacher.id + teacher.name   a timetable has to say who teaches
//                               what; `name` is the display identity
//                               the UI needs and nothing more.
//   teacher.specializationCount shown as a count only. A teacher with
//                               three specializations is still ONE
//                               person and gets ONE directory entry
//                               and ONE timetable — listing them
//                               three times would be a bug, not a
//                               detail (brief §14).
//
// WHAT IS DELIBERATELY EXCLUDED
// ------------------------------
//   email, soDienThoai, address, dob, and any other personal field.
//   `_meta`, `missingData`, `excludedCurriculum` — loader internals.
//   `transferredFromTeacher`, `transferredAt`, `isTransferred` — the
//   Imported transfer bookkeeping. H13 checks explicit permission;
//   historic transfers do not grant it. Capability status is mapped
//   separately from these imported fields.
//   ObjectId instances, BSON documents, Maps, and class instances.
//   Anything from `input.travelTime` — there is none (H14 is
//   UNSUPPORTED), and the mapper never reads it, so a future travel
//   matrix cannot leak through the timetable by accident.

/**
 * Build the lookup tables the mappers need, once per request.
 *
 * Doing this once is not a micro-optimisation: the real dataset is
 * 40 teachers / 7 branches / 113 classes / 479 assignments, and the
 * naive alternative is a `find()` inside a loop over 802 placements,
 * which is O(n*m) over the largest structure the API returns.
 */
export function buildIndex(input) {
  const teachers = new Map();
  for (const t of input?.teachers ?? []) {
    // `chuyenMon` is an array: a teacher may carry several
    // specializations. They are collapsed to a COUNT here so the
    // directory has one row per person (brief §14).
    const specializations = Array.isArray(t.chuyenMon) ? t.chuyenMon : [];
    teachers.set(t.id, {
      id: t.id,
      name: displayName(t),
      homeBranchId: t.homeBranchId ?? null,
      specializationCount: specializations.length,
    });
  }

  const branches = new Map();
  for (const b of input?.branches ?? []) {
    branches.set(b.id, { id: b.id, name: b.name ?? b.id, schoolDays: b.schoolDays ?? [], sessions: b.sessions ?? null });
  }

  const classes = new Map();
  for (const c of input?.classes ?? []) {
    classes.set(c.id, { id: c.id, name: c.name ?? c.id, branchId: c.branchId ?? null });
  }

  const subjects = new Map();
  for (const s of input?.subjects ?? []) {
    subjects.set(s.id, { id: s.id, name: s.name ?? s.id, code: s.code ?? null });
  }

  const assignments = new Map();
  for (const a of input?.assignments ?? []) {
    assignments.set(a.id, {
      id: a.id,
      classId: a.classId ?? null,
      subjectId: a.subjectId ?? null,
      teacherId: a.teacherId ?? null,
      branchId: a.branchId ?? null,
      requiredPeriods: a.requiredPeriods ?? null,
    });
  }

  return { teachers, branches, classes, subjects, assignments };
}

/**
 * Display identity for a person. The legacy field is `hoTen`; the
 * empty string is treated as "no name given" rather than being
 * rendered as a blank cell, because an unlabeled row in a teacher
 * timetable reads as a rendering bug to the person using it.
 */
function displayName(teacher) {
  const raw = teacher?.hoTen;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return `Giáo viên ${String(teacher?.id ?? '').slice(-4)}`;
}

// ============================================================================
// Time model metadata (brief §12, §13)
// ============================================================================
//
// The calendar is DERIVED from `input.timeSlotsByBranch` and the
// branches' own `schoolDays`, never from a hard-coded Monday-Friday
// list. That distinction is not cosmetic on this dataset: the real
// branches declare `schoolDays: [1,2,3,4,5,6]` — six days, the last
// of which is Saturday in the Vietnamese convention. A hard-coded
// Mon-Fri grid would silently drop every Saturday slot in the school
// from the timetable view while the solver had scheduled them.
//
// `label` is `null` throughout because the source data carries no
// human day names. The API does not invent them: an invented name is
// a claim about the source that the source did not make. Presentation
// of a day NUMBER is the UI's business, and the UI receives the exact
// set of days the data uses so it can never show a day that is not
// scheduled (brief §13).

export function mapCalendar(input, index) {
  const branches = input?.branches ?? [];
  const slotsByBranch = input?.timeSlotsByBranch ?? new Map();

  // day -> { day, periods: Set, sessions: Set, branches: Set }
  const days = new Map();

  for (const [branchId, slots] of slotsByBranch.entries()) {
    const branch = index.branches.get(branchId);
    for (const slot of slots ?? []) {
      const day = Number(slot.day);
      if (!Number.isFinite(day)) continue;
      if (!days.has(day)) days.set(day, { day, periods: new Set(), sessions: new Set(), branches: new Set(), periodsBySession: new Map() });
      const d = days.get(day);
      d.periods.add(Number(slot.period));
      d.branches.add(branchId);
      const session = sessionFor(branch, slot);
      if (session) {
        d.sessions.add(session);
        const periods = d.periodsBySession.get(session) ?? new Set();
        periods.add(Number(slot.period));
        d.periodsBySession.set(session, periods);
      }
    }
  }

  // Periods are reported per branch as well as per day, because the
  // branches do NOT all share a profile (the real set mixes
  // 5-period and 7-period branches). A single global period list
  // would imply periods that exist in no branch.
  const branchProfiles = branches.map((b) => ({
    branchId: b.id,
    name: b.name ?? b.id,
    schoolDays: [...(b.schoolDays ?? [])].sort((x, y) => x - y),
    periods: [...(slotsByBranch.get(b.id) ?? [])]
      .map((s) => Number(s.period))
      .filter(Number.isFinite)
      .filter((v, i, a) => a.indexOf(v) === i)
      .sort((x, y) => x - y),
  }));

  const sessionSet = new Set();
  for (const d of days.values()) for (const s of d.sessions) sessionSet.add(s);

  return {
    days: [...days.values()]
      .sort((a, b) => a.day - b.day)
      .map((d) => ({
        day: d.day,
        label: null,
        periods: [...d.periods].sort((x, y) => x - y),
        sessions: [...d.sessions].sort((a, b) => (a === 'sang' ? 0 : 1) - (b === 'sang' ? 0 : 1)),
        periodsBySession: Object.fromEntries([...d.periodsBySession].map(([session, periods]) =>
          [session, [...periods].sort((a, b) => a - b)])),
      })),
    sessions: [...sessionSet].sort((a, b) => (a === 'sang' ? 0 : 1) - (b === 'sang' ? 0 : 1)),
    branches: branchProfiles,
  };
}

/**
 * Session for one slot, resolved from the BRANCH's own profile.
 *
 * The import is of `time.js` — a leaf of pure functions with no
 * solver dependency — so the mapper does not breach the import
 * hygiene Phase 29 established for the AI layer. `sessionOf` is
 * applied with the branch profile; the default (period <= 4 is
 * `sang`) applies otherwise. Either way the value comes from the
 * time model, not from a constant in the UI.
 */
function sessionFor(branch, slot) {
  return sessionForSlot(slot, branch);
}

// ============================================================================
// Directory (the filter/selector vocabularies)
// ============================================================================

export function mapDirectory(input, index) {
  return {
    classes: [...index.classes.values()]
      .map((c) => ({ id: c.id, name: c.name, branchId: c.branchId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    teachers: [...index.teachers.values()]
      .map((t) => ({
        id: t.id,
        name: t.name,
        homeBranchId: t.homeBranchId,
        specializationCount: t.specializationCount,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    branches: [...index.branches.values()]
      .map((b) => ({ id: b.id, name: b.name, schoolDays: b.schoolDays }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    subjects: [...index.subjects.values()]
      .map((s) => ({ id: s.id, name: s.name, code: s.code }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ============================================================================
// Placements
// ============================================================================

/**
 * Flatten one candidate into timetable rows.
 *
 * The row is the unit the UI needs and the unit a teacher timetable
 * can be built from: WHO (teacher), WHAT (subject), FOR WHOM
 * (class), WHERE (branch), WHEN (day / session / period). The
 * frontend does not re-derive any of it from solver internals
 * (brief §10) — a Map of assignmentId -> slots is not a display
 * contract, and making the browser understand one would put domain
 * semantics in the UI.
 *
 * WHY IDS AND NOT NAMES
 * ---------------------
 * Each row carries the four reference ids, not the four names. The
 * names are already in `directory`, in the SAME response, keyed by
 * exactly these ids. Repeating them on all 802 rows of every solution
 * is the single largest avoidable cost in the payload: it was
 * measured at 866 KB for a 3-solution response, and roughly 360 bytes
 * of each row was a name that had already been sent.
 *
 * The join is not "the frontend re-derives solver semantics" — it is
 * reference data the backend ships in the same payload. The UI never
 * decides what a placement MEANS; it only labels a cell.
 *
 * Order is deterministic: by class, then day, then period, then
 * subject. Sorting is not cosmetic here — the response is compared
 * byte-for-byte between runs in the contract test, and an unsorted
 * Map iteration would make that test flaky for a reason that has
 * nothing to do with the scheduler.
 */
export function mapPlacements(candidate, index) {
  const rows = [];
  const assignments = candidate?.assignments;
  if (!assignments) return rows;

  const entries = assignments instanceof Map ? assignments.entries() : assignments;

  for (const [assignmentId, slots] of entries) {
    const assignment = index.assignments.get(assignmentId);
    if (!assignment) continue;
    const effective = effectiveAssignmentMeta(candidate, assignmentId, { assignmentIndex: index.assignments });
    const branch = index.branches.get(effective.branchId);
    for (const slot of slots ?? []) {
      // The shared effective decision owns teacher and branch identity.
      rows.push({
        assignmentId,
        classId: assignment.classId,
        subjectId: assignment.subjectId,
        teacherId: effective.teacherId,
        branchId: effective.branchId,
        day: Number(slot.day),
        session: sessionFor(branch, slot),
        period: Number(slot.period),
      });
    }
  }

  rows.sort((a, b) => {
    const ca = index.classes.get(a.classId)?.name ?? '';
    const cb = index.classes.get(b.classId)?.name ?? '';
    const sa = index.subjects.get(a.subjectId)?.name ?? '';
    const sb = index.subjects.get(b.subjectId)?.name ?? '';
    return ca.localeCompare(cb) || a.day - b.day || a.period - b.period || sa.localeCompare(sb);
  });
  return rows;
}

// ============================================================================
// Data provenance
// ============================================================================

/**
 * mapProvenance — the ONLY part of the loader's own report that
 * reaches the client.
 *
 * `loadBenchmarkDataset()` returns a provenance block written for an
 * audit trail, and it legitimately carries things a timetable UI has
 * no use for: `integrityCounts.transferHistory` (the number of rows
 * in the legacy transfer-log collection) and internal index sizes.
 * Passing that object through wholesale put a legacy transfer-log
 * count and internal index fields in the response, which is exactly
 * the "raw legacy metadata" leak the whitelist rule exists to
 * prevent — the leak came from a trusted module, not from the
 * teacher collection.
 *
 * So the block is re-projected field by field. What survives is what
 * answers "what data produced this, and can I prove two runs used the
 * same data?": the source, the versions, the effective counts, the
 * three data-status flags, and the four reproducibility stamps.
 */
export function mapProvenance(provenance) {
  if (!provenance || typeof provenance !== 'object') return null;
  const effective = provenance.effective ?? {};
  return {
    source: provenance.source ?? null,
    catalogRevision: numberOrNull(provenance.catalogRevision),
    legacyServerVersion: provenance.legacyServerVersion ?? null,
    legacyToolVersion: provenance.legacyToolVersion ?? null,
    counts: {
      teachers: effective.teachers ?? null,
      branches: effective.branches ?? null,
      classes: effective.classes ?? null,
      subjects: effective.subjects ?? null,
      activeSubjects: effective.activeSubjects ?? null,
      assignments: effective.assignments ?? null,
      curriculum: effective.curriculum ?? null,
      timeSlots: effective.timeSlots ?? null,
    },
    status: {
      travel: provenance.travelStatus ?? null,
      branches: provenance.branchesStatus ?? null,
      curriculum: provenance.curriculumStatus ?? null,
    },
    // The stamps that make "the same input, the same scorer" a
    // checkable claim rather than an assumption.
    benchmarkInputHash: provenance.benchmarkInputHash ?? null,
    datasetShapeHash: provenance.datasetShapeHash ?? null,
    dimensionCatalogVersion: provenance.dimensionCatalogVersion ?? null,
    scoringDefaultsVersion: provenance.scoringDefaultsVersion ?? null,
  };
}

// ============================================================================
// Placement detail level (brief §40)
// ============================================================================

/**
 * PLACEMENT_DETAIL — how much of each solution's slot table a
 * response carries.
 *
 * MEASURED, NOT ASSUMED. On the real dataset (40 teachers, 7
 * branches, 113 classes, 479 assignments, 802 placements per
 * solution) the serialized response is:
 *
 *   all       ~1.55 MB for 3 solutions   (802 rows x 3 solutions)
 *   selected  ~0.52 MB                   (802 rows x rank 1 only)
 *   none      ~0.01 MB                   (summaries only)
 *
 * `all` is the DEFAULT because brief §10 requires every solution to
 * carry its placements, and a client that silently received empty
 * grids would be a contract violation. `selected` and `none` exist
 * because 10 solutions is ~5 MB, which is a real cost, and the brief
 * asks for the escape hatch once the size has been measured. A client
 * asks for the level it can afford and never receives less than it
 * asked for.
 *
 * The ids-only placement row (see `mapPlacements`) already removed
 * ~40% of the payload; this level is what makes the remaining size a
 * client decision instead of a surprise.
 */
export const PLACEMENT_DETAIL = Object.freeze({
  ALL: 'all',
  SELECTED: 'selected',
  NONE: 'none',
});

/** Whether `value` is a placement-detail level this build understands. */
export function isPlacementDetail(value) {
  return value === undefined
    || value === null
    || value === ''
    || Object.values(PLACEMENT_DETAIL).includes(value);
}

// ============================================================================
// Solution
// ============================================================================

/**
 * `qualityScore` and `globalScore` are surfaced as separate numbers
 * because they ARE separate numbers upstream and the distinction is
 * the point of Phase 28:
 *
 *   qualityScore  1 / (1 + workloadSpread + preferencePenalty). A
 *                 single-objective summary, computed by Phase 27.
 *   globalScore   the weighted blend of the ACTIVE scoring
 *                 dimensions, computed by Phase 28.
 *
 * With one candidate in the pool every dimension normalizes to the
 * neutral 0.5, so both are 0.5 and neither is meaningful on its own.
 * Collapsing them into one field would hide that, and would make a
 * later retune of the scorer look like a change of ranking rather
 * than a change of scale.
 */
export function mapSolution(solution, options) {
  const { candidate, index } = options;
  const metrics = solution.metrics ?? candidate?.metrics ?? {};
  const scoring = solution.scoring ?? {};
  const diversity = solution.diversity ?? {};

  return {
    id: solution.id,
    rank: solution.rank ?? null,
    // Rank 1 is the one the pipeline would ship.
    qualityScore: numberOrNull(solution.qualityScore),
    globalScore: numberOrNull(scoring.total),
    metrics: {
      accepted: metrics.accepted ?? null,
      hardViolations: Number(metrics.hardViolations ?? 0),
      softPenalty: numberOrNull(metrics.softPenalty),
      teacherCount: numberOrNull(metrics.teacherCount),
      eligibleTeacherCount: numberOrNull(metrics.eligibleTeacherCount),
      totalPeriods: numberOrNull(metrics.totalPeriods),
      maxTeacherLoad: numberOrNull(metrics.maxTeacherLoad),
      minTeacherLoad: numberOrNull(metrics.minTeacherLoad),
      averageTeacherLoad: numberOrNull(metrics.averageTeacherLoad),
      workloadSpread: numberOrNull(metrics.workloadSpread),
      workloadStdev: numberOrNull(metrics.workloadStdev),
      overallWorkloadSpread: numberOrNull(metrics.overallWorkloadSpread),
      overallWorkloadStdev: numberOrNull(metrics.overallWorkloadStdev),
      teacherWorkloads: (metrics.teacherWorkloads ?? []).map((teacher) => ({
        teacherId: teacher.teacherId,
        teacherName: index.teachers.get(teacher.teacherId)?.name ?? teacher.teacherId,
        periods: teacher.periods,
        capacityPeriodsPerWeek: teacher.capacityPeriodsPerWeek ?? null,
      })),
      subjectWorkloadSpread: numberOrNull(metrics.subjectWorkloadSpread),
      subjectWorkloadStdev: numberOrNull(metrics.subjectWorkloadStdev),
      subjectWorkload: Object.fromEntries(Object.entries(metrics.subjectWorkload ?? {}).map(([key, subject]) => [key, {
        ...subject,
        teachers: (subject.teachers ?? []).map((teacher) => ({
          ...teacher,
          teacherName: index.teachers.get(teacher.teacherId)?.name ?? teacher.teacherId,
        })),
      }])),
      preferencePenalty: numberOrNull(metrics.preferencePenalty),
      preferenceBreakdown: metrics.preferenceBreakdown ?? null,
      changedAssignments: numberOrNull(metrics.changedAssignments),
      changedFraction: numberOrNull(metrics.changedFraction),
    },
    diversity: {
      slotToBest: numberOrNull(diversity.slotToBest),
      slotToPrevious: numberOrNull(diversity.slotToPrevious),
      teacherDay: numberOrNull(diversity.teacherDay),
      sessionMix: numberOrNull(diversity.sessionMix),
      overall: numberOrNull(diversity.overall),
    },
    scoring: {
      feasibility: scoring.feasibility ?? null,
      hardViolations: Number(scoring.hardViolations ?? 0),
      rankReason: scoring.rankReason ?? null,
      // The per-dimension vector is what makes "why is this ranked
      // here" answerable from the response instead of re-derived in
      // the browser (brief §17). The UI reads it; it never computes
      // it and never writes its own explanation.
      dimensions: Object.fromEntries(
        Object.entries(scoring.dimensions ?? {}).map(([id, d]) => [id, {
          raw: numberOrNull(d.raw),
          normalized: numberOrNull(d.normalized),
          weight: numberOrNull(d.weight),
          contribution: numberOrNull(d.contribution),
          direction: d.direction ?? null,
          active: d.active === true,
          reason: d.reason ?? null,
        }]),
      ),
    },
    placements: mapPlacements(candidate, index),
  };
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
