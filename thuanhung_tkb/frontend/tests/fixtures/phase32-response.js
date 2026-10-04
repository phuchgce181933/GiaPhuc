/**
 * Response fixtures for the Phase 32 UI tests.
 *
 * These are shaped from the real serializer in
 * `backend/src/api/mappers.js`, not invented. Every field here exists
 * in a real response, and the shapes that matter for the UI's honesty
 * properties are reproduced exactly:
 *
 *   - `numberOrNull` behaviour, so a metric the scorer did not
 *     measure arrives as `null` and not as `0`.
 *   - `scoring.dimensions` with an INACTIVE travel/transfer pair whose
 *     `reason` is the backend's own sentence.
 *   - `ai.fallbackUsed` with `decision: null`, which is what a
 *     fallback run really returns and what the UI must not paper
 *     over.
 *   - `validation` from the independent evaluator, alongside
 *     `scoring.hardViolations` from the scorer — two different
 *     owners of two different counts.
 *
 * The counts (40 teachers / 7 branches / 113 classes / 479
 * assignments / 802 placements) are the real dataset's, because the
 * sixth school day is what makes the "no hard-coded Mon-Fri grid"
 * property observable at all.
 */

export const REAL_PROVENANCE = {
  source: 'LEGACY_MONGO_SAPLICH',
  legacyServerVersion: '1.0.0',
  legacyToolVersion: '2.3.1',
  counts: {
    teachers: 40,
    branches: 7,
    classes: 113,
    subjects: 31,
    activeSubjects: 27,
    assignments: 479,
    curriculum: 479,
    timeSlots: 802,
  },
  status: {
    travel: 'MISSING_CONFIGURATION',
    branches: 'OK',
    curriculum: 'OK',
  },
  benchmarkInputHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  datasetShapeHash: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
  dimensionCatalogVersion: 'catalog-v1.2.0',
  scoringDefaultsVersion: 'defaults-v1.1.0',
};

export const CALENDAR = {
  // SIX days. The real branches declare [1,2,3,4,5,6]; a hard-coded
  // Monday-Friday grid would drop the sixth while the solver had
  // scheduled it.
  days: [
    { day: 1, label: null, periods: [1, 2, 3, 4, 5], sessions: ['sang', 'chieu'] },
    { day: 2, label: null, periods: [1, 2, 3, 4, 5], sessions: ['sang', 'chieu'] },
    { day: 3, label: null, periods: [1, 2, 3, 4, 5, 6, 7], sessions: ['sang', 'chieu'] },
    { day: 4, label: null, periods: [1, 2, 3, 4, 5], sessions: ['sang', 'chieu'] },
    { day: 5, label: null, periods: [1, 2, 3, 4, 5], sessions: ['sang', 'chieu'] },
    { day: 6, label: null, periods: [1, 2, 3, 4, 5], sessions: ['sang'] },
  ],
  sessions: ['sang', 'chieu'],
  branches: [
    { branchId: 'b1', name: 'Cơ sở 1', schoolDays: [1, 2, 3, 4, 5, 6], periods: [1, 2, 3, 4, 5] },
    { branchId: 'b2', name: 'Cơ sở 2', schoolDays: [1, 2, 3, 4, 5, 6], periods: [1, 2, 3, 4, 5, 6, 7] },
  ],
};

export const DIRECTORY = {
  classes: [
    { id: 'c1', name: 'Lớp 6A', branchId: 'b1' },
    { id: 'c2', name: 'Lớp 9B', branchId: 'b2' },
  ],
  teachers: [
    { id: 't1', name: 'Nguyễn Văn An', specializationCount: 2 },
    { id: 't2', name: 'Trần Thị Bình', specializationCount: 1 },
  ],
  branches: [
    { id: 'b1', name: 'Cơ sở 1', schoolDays: [1, 2, 3, 4, 5, 6] },
    { id: 'b2', name: 'Cơ sở 2', schoolDays: [1, 2, 3, 4, 5, 6] },
  ],
  subjects: [
    { id: 's1', name: 'Toán', code: 'TOAN' },
    { id: 's2', name: 'Ngữ văn', code: 'NGUVAN' },
  ],
};

/** Four placements: one per day, one on the sixth day. */
export const PLACEMENTS = [
  { assignmentId: 'a1', classId: 'c1', subjectId: 's1', teacherId: 't1', branchId: 'b1', day: 1, session: 'sang', period: 1 },
  { assignmentId: 'a2', classId: 'c1', subjectId: 's2', teacherId: 't2', branchId: 'b1', day: 2, session: 'sang', period: 2 },
  { assignmentId: 'a3', classId: 'c2', subjectId: 's1', teacherId: 't1', branchId: 'b2', day: 3, session: 'chieu', period: 6 },
  // Day 6. If the grid hard-codes Mon-Fri this row has nowhere to go.
  { assignmentId: 'a4', classId: 'c1', subjectId: 's1', teacherId: 't2', branchId: 'b1', day: 6, session: 'sang', period: 3 },
];

const ACTIVE_DIMENSIONS = {
  WORKLOAD_SPREAD: {
    raw: 2.31, normalized: 0.71, weight: 0.3, contribution: 0.213,
    direction: 'HIGHER_IS_BETTER', active: true, reason: null,
  },
  MAX_TEACHER_LOAD: {
    raw: 22, normalized: 0.64, weight: 0.2, contribution: 0.128,
    direction: 'LOWER_IS_BETTER', active: true, reason: null,
  },
  // Inactive, and the reason is the backend's own sentence. A UI that
  // dropped the reason would let a reader assume it was forgotten.
  TRAVEL: {
    raw: null, normalized: null, weight: 0, contribution: 0,
    direction: 'LOWER_IS_BETTER', active: false, reason: 'H14_UNSUPPORTED_NO_TRAVEL_MATRIX',
  },
  TRANSFER: {
    raw: null, normalized: null, weight: 0, contribution: 0,
    direction: 'HIGHER_IS_BETTER', active: false, reason: 'H13_INACTIVE_NO_TRANSFER_POLICY',
  },
};

function solution(overrides = {}) {
  return {
    id: 'ms-00000001',
    rank: 1,
    qualityScore: 0.7712,
    globalScore: 0.7431,
    metrics: {
      accepted: true,
      hardViolations: 0,
      softPenalty: 0.31,
      teacherCount: 40,
      totalPeriods: 802,
      maxTeacherLoad: 22,
      minTeacherLoad: 19,
      averageTeacherLoad: 20.05,
      workloadSpread: 2.31,
      workloadStdev: 0.812,
      preferencePenalty: 0.12,
      changedAssignments: 41,
      changedFraction: 0.0856,
    },
    diversity: {
      slotToBest: 0,
      slotToPrevious: 0,
      teacherDay: 0,
      sessionMix: 0,
      overall: 0,
    },
    scoring: {
      feasibility: 'FEASIBLE',
      hardViolations: 0,
      rankReason: 'quality-first: best by primary quality objective (workloadSpread=2.31, maxLoad=22)',
      dimensions: ACTIVE_DIMENSIONS,
    },
    validation: { accepted: true, hardViolations: 0, reasons: [] },
    placements: PLACEMENTS,
    ...overrides,
  };
}

export const SOLUTIONS = [
  solution(),
  solution({
    id: 'ms-00000002',
    rank: 2,
    qualityScore: 0.7402,
    globalScore: 0.7112,
    diversity: {
      slotToBest: 0.1841, slotToPrevious: 0.1841, teacherDay: 0.2205, sessionMix: 0.0912, overall: 0.1653,
    },
    scoring: {
      feasibility: 'FEASIBLE',
      hardViolations: 0,
      rankReason: 'quality+diversity blend: qScore=0.7402, slotDivToBest=0.1841, slotDivToPrev=0.1841',
      dimensions: ACTIVE_DIMENSIONS,
    },
  }),
  solution({
    id: 'ms-00000003',
    rank: 3,
    qualityScore: 0.7011,
    globalScore: 0.6888,
    diversity: {
      slotToBest: 0.0912, slotToPrevious: 0.0912, teacherDay: 0.1033, sessionMix: 0.0611, overall: 0.0852,
    },
    scoring: {
      feasibility: 'FEASIBLE',
      hardViolations: 0,
      rankReason: 'quality+diversity blend: qScore=0.7011, slotDivToBest=0.0912, slotDivToPrev=0.0912',
      dimensions: ACTIVE_DIMENSIONS,
    },
  }),
];

/** What a real fallback run returns. `decision` is null, by design. */
export const FALLBACK_AI = {
  provider: 'AIRLLM',
  requested: true,
  available: false,
  used: false,
  fallbackUsed: true,
  reason: 'AI_UNAVAILABLE',
  detail: 'The AI provider was not reachable; the deterministic fallback produced this schedule.',
  decision: null,
  fallbackDecision: { optimizationMode: 'BASE_FEASIBLE', candidateCount: 3, scoringWeights: null, source: 'fallback' },
  validation: { status: 'NOT_APPLICABLE', events: [], reason: 'no AI output to validate' },
  timing: { reportMs: 3, providerMs: null, validationMs: 0 },
};

export const USED_AI = {
  ...FALLBACK_AI,
  provider: 'AIRLLM',
  available: true,
  used: true,
  fallbackUsed: false,
  reason: 'AI_USED',
  detail: 'An AI strategy was approved and used.',
  decision: { optimizationMode: 'GLOBAL_ASSIGNMENT_BALANCED', candidateCount: 3, scoringWeights: null, source: 'ai' },
  fallbackDecision: null,
};

export const NOT_REQUESTED_AI = {
  provider: 'none',
  requested: false,
  available: false,
  used: false,
  fallbackUsed: true,
  reason: 'AI_NOT_REQUESTED',
  detail: 'The request set useAI=false, so the deterministic path produced this schedule by design.',
};

export const TRAVEL_UNSUPPORTED = {
  h14: 'UNSUPPORTED',
  available: false,
  usedInScoring: false,
  detail: 'No travel matrix is configured. Travel times between branches are unknown and are not scored (H14 = UNSUPPORTED).',
};

export const TRANSFER_INACTIVE = {
  h13: 'INACTIVE',
  active: false,
  allowedTeacherCount: 0,
  usedInScoring: false,
  detail: 'No teacher carries an allowedTransferBranches policy, so the transfer constraint is inactive (H13 = INACTIVE) and transfers are not optimized.',
};

export const HEALTH = {
  ok: true,
  apiVersion: 'phase32-v1',
  status: 'OK',
  ai: { provider: 'AIRLLM', configured: true, integrationEnabled: false },
  request: {
    allowedFields: ['candidateCount', 'optimizationMode', 'useAI'],
    allowedCandidateCounts: [1, 3, 5, 10],
    allowedOptimizationModes: ['BASE_FEASIBLE', 'ASSIGNMENT_BALANCED', 'GLOBAL_ASSIGNMENT_BALANCED', 'PREFERENCE_FIRST'],
    allowedCommitFields: ['requestId', 'solutionId'],
  },
  placementDetail: { allowed: ['all', 'selected', 'none'], default: 'all' },
  commit: {
    implemented: true,
    mode: 'COMMIT_ENABLED',
    driver: 'file',
    atomic: true,
    idempotency: 'requestId+solutionId',
    outcomeStatuses: ['COMMITTED', 'COMMITTED_DUPLICATE', 'COMMIT_REJECTED'],
    committedCount: 0,
  },
  travel: { h14: 'UNSUPPORTED' },
  transfer: { h13: 'INACTIVE' },
};

/**
 * PHASE 33 — a successful commit response, in the shape the backend
 * actually returns.
 *
 * The two fields that matter to the UI are `committed` and
 * `committedAt`: the state machine refuses to record anything whose
 * `committed` is not literally `true`, and the panel prints the
 * schedule id, the version, the slot count and the content hash.
 */
export const COMMITTED_RESPONSE = {
  apiVersion: 'phase32-v1',
  status: 'COMMITTED',
  ok: true,
  requestId: 'req-000001',
  solutionId: 'ms-1a2b3c4d',
  scheduleId: 'sch-0123456789abcdef',
  version: 1,
  validated: true,
  committed: true,
  duplicate: false,
  written: true,
  committedAt: '2026-10-05T02:00:00.000Z',
  slotCount: 802,
  contentHash: 'a3f1c0d95b2e87461a0d5c8f4e6b7d2c9e0f1a2b3c4d5e6f708192a3b4c5d6e7',
  persistence: { implemented: true, mode: 'COMMIT_ENABLED', driver: 'file', atomic: true },
  validation: { accepted: true, hardViolations: 0, reasons: [] },
  score: { globalScore: 0.7431, qualityScore: 0.7712, feasibility: 'FEASIBLE', hardViolations: 0 },
  ai: { used: false, reason: 'COMMIT_DOES_NOT_CALL_AI' },
  travel: { h14: 'UNSUPPORTED' },
  transfer: { h13: 'INACTIVE' },
  readback: { slots: 802, matchesCandidate: true },
};

/** A rejected commit, as the backend answers it. */
export const REJECTED_RESPONSE = {
  apiVersion: 'phase32-v1',
  status: 'COMMIT_REJECTED',
  ok: false,
  persisted: false,
  error: {
    code: 'HARD_VIOLATION',
    message: 'The solution failed re-validation. The schedule was not saved.',
    hardViolations: 2,
    reasons: ['[H01] class 6a95 has two slots at 1|sang|1'],
  },
  validation: { accepted: false, hardViolations: 2, reasons: ['[H01] class 6a95 has two slots at 1|sang|1'] },
};

/** `GET /api/schedules/committed` — headers only, no slot table. */
export function committedList(...records) {
  return {
    apiVersion: 'phase32-v1',
    status: 'OK',
    ok: true,
    count: records.length,
    schedules: records.map((r) => ({
      scheduleId: r.scheduleId,
      version: r.version,
      status: r.status ?? 'COMMITTED',
      requestId: r.requestId,
      solutionId: r.solutionId,
      committedAt: r.committedAt,
      slotCount: r.slotCount,
      contentHash: r.contentHash,
      validated: r.validated,
      audit: null,
    })),
  };
}

function basePayload(overrides = {}) {
  return {
    apiVersion: 'phase32-v1',
    requestId: 'req-000001',
    status: 'OK',
    generation: {
      status: 'COMPLETED',
      stages: [
        { status: 'REQUEST_RECEIVED', atMs: 0 },
        { status: 'GENERATING', atMs: 1 },
        { status: 'SCORING', atMs: 240 },
        { status: 'COMPLETED', atMs: 260 },
      ],
      totalTimeMs: 260,
    },
    ai: FALLBACK_AI,
    strategy: {
      optimizationMode: 'BASE_FEASIBLE',
      appliedOptimizationMode: 'BASE_FEASIBLE',
      modeSource: 'DETERMINISTIC_FALLBACK',
      candidateCount: 3,
      seed: 12648430,
      baseStrategyId: 'STRATEGY_C',
    },
    solutions: SOLUTIONS,
    errors: [],
    placementDetail: { level: 'all', includedSolutionRanks: [1, 2, 3], note: '' },
    calendar: CALENDAR,
    directory: DIRECTORY,
    travel: TRAVEL_UNSUPPORTED,
    transfer: TRANSFER_INACTIVE,
    diagnostics: {
      errors: [],
      solver: { produced: 3, rejectedReasons: [], searchLimited: false, generationMs: 240 },
      scoring: { inputSize: 3, feasibleSize: 3, selectedSize: 3, totalTimeMs: 18 },
      data: { provenance: REAL_PROVENANCE, missingData: [], warnings: [] },
      duplicateSolutionIds: [],
      timing: {
        totalTimeMs: 260,
        solverMs: 240,
        scoringMs: 18,
        aiMs: 0,
        breakdown: { solveMs: 240, scoreMs: 18, strategyMs: 2, apiOverheadMs: 0 },
      },
    },
    ...overrides,
  };
}

/** A complete 200 with three solutions. */
export const OK_RESPONSE = basePayload();

/** A 200 with MISSING_DATA: valid request, absent data. */
export const MISSING_DATA_RESPONSE = basePayload({
  status: 'MISSING_DATA',
  solutions: [],
  generation: {
    status: 'NO_SOLUTION',
    stages: [{ status: 'REQUEST_RECEIVED', atMs: 0 }, { status: 'NO_SOLUTION', atMs: 4 }],
    totalTimeMs: 4,
  },
  errors: [
    { field: 'Curriculum/periodsPerWeek', code: 'MISSING_DATA', message: 'Curriculum has no weekly period counts.' },
  ],
  // MISSING_DATA and EMPTY carry no calendar/directory in a real
  // response — the run stopped before them.
  calendar: undefined,
  directory: undefined,
  ai: null,
  strategy: null,
});

/** A 200 with EMPTY: the solver ran and found nothing feasible. */
export const EMPTY_RESPONSE = basePayload({
  status: 'EMPTY',
  solutions: [],
  generation: {
    status: 'NO_SOLUTION',
    stages: [{ status: 'REQUEST_RECEIVED', atMs: 0 }, { status: 'NO_SOLUTION', atMs: 41 }],
    totalTimeMs: 41,
  },
  diagnostics: {
    ...basePayload().diagnostics,
    solver: {
      produced: 0,
      rejectedReasons: ['NO_HARD_FEASIBLE_CANDIDATE: 802 required periods vs 7 placeable slots'],
      searchLimited: false,
      generationMs: 40,
    },
  },
});
