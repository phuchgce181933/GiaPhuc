// PHASE 31 — FIXED BENCHMARK DATASET.
//
// Brief §3: one input, fixed, never mutated between runs, with a
// hash so that "we compared the same thing" is checkable rather than
// assumed.
//
//   40 active teachers
//   7 branches
//   113 classes
//   5 active subjects
//   479 assignments
//   802 historical schedule slots
//
// WHAT THE HASH COVERS, AND WHAT IT DELIBERATELY DOES NOT
// --------------------------------------------------------
//
// `benchmarkInputHash` is computed over a PROJECTION of the input,
// not the input itself. The projection contains:
//
//   - cardinalities of every collection
//   - a hash of the SORTED opaque ids of teachers, branches,
//     classes, subjects, and assignments
//   - a hash of each branch's day/period profile
//   - a hash of the multiset of `requiredPeriods`
//   - whether a travel matrix is present
//   - the full strategy that will be attached
//
// It contains NO teacher name, e-mail, or phone number. The raw
// SchedulingInput is full of them; a hash is one-way, but the rule
// here is stronger than "the hash is safe" — the bytes that go INTO
// the hash do not include personal data in the first place, so there
// is no path by which a name could reach an artifact even in
// principle (brief §33, Phase 29 §26).
//
// The ids are opaque 24-character hex strings from the source
// system. Hashing the sorted list rather than embedding it means two
// runs can be proven to have used identical data without the data
// being reproduced anywhere.
//
// THE CONTROLLED FIXTURE
// ----------------------
// Brief §28 asks for a second, small input with 2–4 valid strategies
// whose relative quality is known. The quality is NOT asserted by
// hand in this file — asserting it would be a human claim about a
// scorer, and brief §26/§27 forbid treating anything but the
// independent scorer as truth. Instead `establishFixtureGroundTruth`
// runs every optimization mode through the same solver and the same
// Phase 28 scorer and lets the measurement produce the ranking. See
// `runner.js` for that function; it lives with the code that runs it.

import { loadCatalogData } from '../modules/catalog/catalog.service.js';
import { defaultTeacherPreferenceStore } from '../persistence/teacher-preference-store.js';
import { config } from '../config/index.js';
import { STRATEGY_C } from '../domain/strategies.js';
import {
  DATASET_SOURCE,
  dimensionCatalogVersion,
  fnv1a32,
  hashValue,
  scoringDefaultsVersion,
} from './versions.js';

// ============================================================================
// The projection + the hash
// ============================================================================

/** Hash of a list of opaque ids, order-insensitive. */
function idSetHash(ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .filter((v) => typeof v === 'string' && v !== '')
    .slice()
    .sort();
  return { count: list.length, hash: fnv1a32(list.join('|')) };
}

/**
 * A deterministic, personal-data-free structural projection of a
 * SchedulingInput. Exported so a reader can see exactly what the
 * benchmark hash is a statement ABOUT.
 */
export function projectInput(input, strategy = null) {
  const branchProfiles = [];
  let timeSlotCount = 0;
  for (const [branchId, slots] of input?.timeSlotsByBranch ?? []) {
    const keys = (slots ?? []).map((s) => `${s.day}.${s.period}`).sort();
    timeSlotCount += keys.length;
    branchProfiles.push({ branchId, slots: keys.length, profile: fnv1a32(keys.join(',')) });
  }
  branchProfiles.sort((a, b) => a.branchId.localeCompare(b.branchId));

  const assignments = Array.isArray(input?.assignments) ? input.assignments : [];
  const requiredPeriods = assignments
    .map((a) => Number(a.requiredPeriods) || 0)
    .sort((a, b) => a - b);

  return {
    counts: {
      teachers: input?.teachers?.length ?? 0,
      branches: input?.branches?.length ?? 0,
      classes: input?.classes?.length ?? 0,
      subjects: input?.subjects?.length ?? 0,
      activeSubjects: (input?.subjects ?? []).filter((s) => s.isActive).length,
      assignments: assignments.length,
      curriculum: input?.curriculum?.length ?? 0,
      timeSlots: timeSlotCount,
      teacherIndex: input?.teacherIndex?.size ?? 0,
      assignmentIndex: input?.assignmentIndex?.size ?? 0,
    },
    teachers: idSetHash((input?.teachers ?? []).map((t) => t.id)),
    branches: idSetHash((input?.branches ?? []).map((b) => b.id)),
    classes: idSetHash((input?.classes ?? []).map((c) => c.id)),
    subjects: idSetHash((input?.subjects ?? []).map((s) => s.id)),
    assignments: idSetHash(assignments.map((a) => a.id)),
    branchProfiles,
    requiredPeriods: { count: requiredPeriods.length, hash: fnv1a32(requiredPeriods.join(',')) },
    // TRAVEL stays out: H14 is UNSUPPORTED and the matrix is absent.
    // Recorded so a future dataset that DOES ship one produces a
    // different hash and cannot be silently compared against this one.
    travelMatrixPresent: Boolean(input?.travelTime && typeof input.travelTime === 'object'),
    travelStatus: input?.travelStatus ?? null,
    transferPolicy: input?.transferPolicy ?? 'EXPLICIT',
    strategy: strategy
      ? {
        id: strategy.id ?? null,
        optimizationMode: strategy.optimizationMode ?? null,
        weights: strategy.weights ?? {},
        objectives: strategy.objectives ?? {},
        diversification: strategy.diversification ?? {},
        solver: strategy.solver ?? {},
      }
      : null,
  };
}

/**
 * benchmarkInputHash(input, strategy) -> 8 hex chars.
 *
 * Stable across processes and platforms: it depends only on the
 * projection, which depends only on sorted primitive values. No
 * clock, no path, no locale, no Map iteration order.
 */
export function benchmarkInputHash(input, strategy = null) {
  return hashValue(projectInput(input, strategy));
}

// ============================================================================
// The real dataset
// ============================================================================

/**
 * Load the real benchmark input.
 *
 * Returns `{ input, provenance }`.
 *
 *   input       — the SchedulingInput PLUS `.strategy`, ready for
 *                 `planStrategy`. The loader's own object is not
 *                 mutated: `.strategy` is attached to a shallow copy
 *                 so a caller that later calls `applyDecisionToInput`
 *                 cannot be surprised by a shared reference.
 *   provenance  — the brief §33 stamps. Serialisable, PII-free, and
 *                 sufficient to prove two runs used the same data,
 *                 the same constraints, and the same scorer.
 */
export function loadBenchmarkDataset(options = {}) {
  const loaded = loadCatalogData({ store: options.catalogStore });
  const overlays = (options.preferenceStore ?? defaultTeacherPreferenceStore(config.persistenceDir)).readAll();
  // The legacy import stays read-only. Persisted operator preferences are applied
  // only to the scheduling projection used by this generation.
  const teachers = loaded.scheduling.teachers.map((teacher) => {
    const saved = overlays[teacher.id];
    if (!saved) return teacher;
    const session = saved.preferredSession === 'morning' ? 'sang'
      : saved.preferredSession === 'afternoon' ? 'chieu' : saved.preferredSession === 'both' ? 'ca_hai' : teacher.nguyenVong?.buoiUuTien;
    const preferredBranches = saved.preferredTransferBranchIds ?? teacher.preferredTransferBranches;
    return {
      ...teacher,
      preferredTransferBranches: preferredBranches,
      nguyenVong: {
        ...(teacher.nguyenVong ?? {}),
        ...(session ? { buoiUuTien: session } : {}),
        desiredTeachingSessionsPerWeek: saved.desiredTeachingSessionsPerWeek ?? null,
        preferredOffDay: saved.preferredOffDay ?? 'NONE',
        preferredOffPart: saved.preferredOffPart ?? 'NONE',
      },
    };
  });
  const scheduling = { ...loaded.scheduling, teachers, teacherIndex: new Map(teachers.map((t) => [t.id, t])) };
  const strategy = options.strategy ?? STRATEGY_C;
  const input = { ...scheduling, strategy, transferPolicy:options.transferPolicy ?? config.transferPolicy };

  const projection = projectInput(input, strategy);
  const inventory = loaded.inventory ?? {};
  const integrity = loaded.integrity ?? {};

  const provenance = {
    source: DATASET_SOURCE,
    catalogRevision: loaded.catalogRevision,
    // Real, measured values — not a hand-written label.
    legacyServerVersion: loaded.serverVersion ?? null,
    legacyToolVersion: loaded.toolVersion ?? null,
    inventory: {
      assignments: inventory.assignments ?? null,
      branches: inventory.branches ?? null,
      classes: inventory.classes ?? null,
      subjects: inventory.subjects ?? null,
      teachers: inventory.teachers ?? null,
      schedules: inventory.schedules ?? null,
      // 802 — the historical schedule slots. This is the "802 periods"
      // of the brief; it is the SOURCE period count, not a number the
      // benchmark invented, and it is recorded for that reason.
      scheduleSlots: inventory.scheduleslots ?? null,
    },
    integrityCounts: integrity.counts ?? null,
    effective: projection.counts,
    travelStatus: scheduling.travelStatus ?? null,
    branchesStatus: scheduling.branchesStatus ?? null,
    curriculumStatus: scheduling.curriculumStatus ?? null,

    // ---- the stamps that make a comparison reproducible ----------
    benchmarkInputHash: hashValue(projection),
    datasetShapeHash: fnv1a32(hashValue(projection) + hashValue({
      server: loaded.serverVersion ?? null,
      tool: loaded.toolVersion ?? null,
    })),
    dimensionCatalogVersion: dimensionCatalogVersion(input),
    scoringDefaultsVersion: scoringDefaultsVersion(),
  };

  return { input, provenance, projection };
}

// ============================================================================
// The controlled fixture (brief §28)
// ============================================================================

const FIXTURE_BRANCH = 'fx-branch-1';
const FIXTURE_DAYS = Object.freeze([1, 2, 3, 4, 5]);
const FIXTURE_PERIODS = Object.freeze([1, 2, 3, 4]);

/**
 * A small, hand-written SchedulingInput.
 *
 *   1 branch, 5 days x 4 periods = 20 physical slots
 *   3 teachers, 3 classes, 2 subjects, 6 assignments
 *   total demand 14 periods
 *
 * Every teacher is eligible for BOTH subjects and declares
 * `soBuoiToiDa: 0`, `buoiUuTien: 'ca_hai'`, `thuNghi: []`, and
 * `soTietTuan: 1`. That is deliberate: it switches H09 (per-subject
 * workload), H10 (session cap), and H11 (day off) INACTIVE, leaving
 * H01-H08 as the whole hard-constraint set. A fixture whose
 * feasibility depends on three optional data fields is a fixture
 * that silently stops testing what it was written to test.
 *
 * TRAVEL is `null`, so H14 stays UNSUPPORTED, and no teacher carries
 * `allowedTransferBranches`, so H13 stays INACTIVE (brief §37, §38).
 *
 * The function returns a FRESH object on every call. The Maps and
 * arrays are rebuilt, so a test that mutates the fixture cannot
 * poison the next one.
 */
export function buildControlledFixture(options = {}) {
  const subjectA = 'fx-subject-a';
  const subjectB = 'fx-subject-b';
  const branch = FIXTURE_BRANCH;

  const branches = [{
    id: branch,
    name: 'Fixture branch',
    schoolDays: [...FIXTURE_DAYS],
    periods: [...FIXTURE_PERIODS],
  }];

  const subjects = [
    { id: subjectA, name: 'Fixture subject A', code: 'FSA', isActive: true },
    { id: subjectB, name: 'Fixture subject B', code: 'FSB', isActive: true },
  ];

  const teachers = ['fx-teacher-1', 'fx-teacher-2', 'fx-teacher-3'].map((id, i) => ({
    id,
    hoTen: `Fixture teacher ${i + 1}`,
    email: '',
    soDienThoai: '',
    trangThai: 'active',
    chuyenMon: [
      { tenChuyenMon: 'Fixture subject A', soTietTuan: 1 },
      { tenChuyenMon: 'Fixture subject B', soTietTuan: 1 },
    ],
    eligibleSubjectIds: [subjectA, subjectB],
    nguyenVong: { soBuoiToiDa: 0, buoiUuTien: 'ca_hai', thuNghi: [] },
    homeBranchId: branch,
  }));

  const classes = ['fx-class-1', 'fx-class-2', 'fx-class-3'].map((id, i) => ({
    id,
    name: `Fixture class ${i + 1}`,
    branchId: branch,
    level: i + 1,
  }));

  // One row per (class, subject): six unique logical demands. Two
  // rows for the SAME pair would be two assignment ids competing for
  // one demand, and H07 — which requires a single teacher per
  // (class, subject) — would make the fixture permanently infeasible
  // for reasons that have nothing to do with what it tests. Volume
  // comes from `requiredPeriods` instead.
  const demand = [
    ['fx-class-1', subjectA, 3],
    ['fx-class-1', subjectB, 2],
    ['fx-class-2', subjectA, 3],
    ['fx-class-2', subjectB, 2],
    ['fx-class-3', subjectA, 2],
    ['fx-class-3', subjectB, 2],
  ];

  const assignments = demand.map(([classId, subjectId, requiredPeriods], i) => ({
    id: `fx-assignment-${i + 1}`,
    classId,
    subjectId,
    teacherId: teachers[i % teachers.length].id,
    branchId: branch,
    requiredPeriods,
    baselineAssignment: true,
    isTransferred: false,
    transferredAt: null,
    transferredFromTeacher: null,
  }));

  const timeSlots = [];
  for (const day of FIXTURE_DAYS) {
    for (const period of FIXTURE_PERIODS) {
      timeSlots.push({ branchId: branch, day, period });
    }
  }

  const input = {
    teachers,
    branches,
    classes,
    subjects,
    assignments,
    curriculum: [],
    timeSlotsByBranch: new Map([[branch, timeSlots]]),
    // H14 stays UNSUPPORTED.
    travelTime: null,
    transitionMinutes: 10,
    teacherIndex: new Map(teachers.map((t) => [t.id, t])),
    assignmentIndex: new Map(assignments.map((a) => [a.id, a])),
    missingData: [],
    warnings: ['Phase 31 controlled fixture. Synthetic; not production data.'],
    branchesStatus: 'OK',
    curriculumStatus: 'OK',
    travelStatus: 'MISSING_CONFIGURATION',
    _meta: { fixture: true, totalPeriods: assignments.reduce((n, a) => n + a.requiredPeriods, 0) },
    strategy: options.strategy ?? STRATEGY_C,
  };

  return input;
}

/** The four modes the fixture's ground truth is measured over. */
export const FIXTURE_STRATEGY_MODES = Object.freeze([
  'BASE_FEASIBLE',
  'ASSIGNMENT_BALANCED',
  'PREFERENCE_FIRST',
  'GLOBAL_ASSIGNMENT_BALANCED',
]);

/** Provenance for the controlled fixture, in the same shape as the real one. */
export function controlledFixtureProvenance(input = buildControlledFixture()) {
  const projection = projectInput(input, input.strategy);
  return {
    source: 'phase31-controlled-fixture',
    legacyServerVersion: null,
    legacyToolVersion: null,
    inventory: null,
    integrityCounts: null,
    effective: projection.counts,
    travelStatus: input.travelStatus,
    branchesStatus: input.branchesStatus,
    curriculumStatus: input.curriculumStatus,
    benchmarkInputHash: hashValue(projection),
    datasetShapeHash: fnv1a32('phase31-controlled-fixture'),
    dimensionCatalogVersion: dimensionCatalogVersion(input),
    scoringDefaultsVersion: scoringDefaultsVersion(),
  };
}
