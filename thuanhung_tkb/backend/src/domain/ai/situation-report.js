// PHASE 29 — SITUATION REPORT.
//
// Goal
// ----
// Produce the ONLY thing an AI provider is allowed to see about the
// scheduling problem: a deterministic, privacy-minimized summary of
// FACTS, not schedule slots.
//
//   SchedulingInput  ->  SituationReport  ->  AIPlanner  ->  StrategyDecision
//
// This module does NOT:
//   - import the solver (brief §36 — the AI layer must not reach
//     search internals; see `dimension-catalog.js` for why the
//     catalog was extracted into a leaf module),
//   - read a clock, use randomness, or depend on DB ordering
//     (brief §15),
//   - contain any teacher name, email, or phone number
//     (brief §27),
//   - make a decision. It reports; `strategy-schema.js` validates
//     and `planner.js` decides.
//
// Determinism
// -----------
// Same SchedulingInput => byte-identical report. Concretely:
//   - every emitted array is sorted by a total, content-derived key
//     (never by Map insertion order, which is load-order dependent);
//   - every number is derived by a pure fold over the input;
//   - no `Date.now()`, no `Math.random()`, no I/O.
//
// The report carries a `hash` (FNV-1a over a key-sorted
// serialization) so the audit log can prove two runs saw the same
// situation without storing the situation itself (brief §26).
//
// Privacy / minimization
// ----------------------
// The report is AGGREGATE-ONLY. It deliberately omits:
//   - `teacher.hoTen`, `teacher.email`, `teacher.soDienThoai`
//   - per-teacher identifiers entirely (not even hashed ids)
//   - branch names (institution names do not affect strategy choice)
//   - any schedule slot, placement, or assignment-teacher pair
//
// It retains subject names, because "which subjects are in demand"
// is the substance of the specialization/demand reasoning the AI is
// being asked to do. Everything else is a count or a statistic.

import { workloadOf } from '../workload.js';
import { CATALOG } from '../constraints/index.js';
import { DIMENSION_CATALOG, inactiveReason } from '../dimension-catalog.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../strategies.js';

export const SITUATION_REPORT_VERSION = 'PHASE_29';

/**
 * Thresholds behind the `signals` array. These are FACTS about the
 * dataset, computed with documented, fixed cut-offs — not a
 * quality judgment. They exist so the AI (and the audit) can talk
 * about "workload imbalance is high" without the AI re-deriving
 * statistics from raw slots (brief §16).
 */
export const SIGNAL_THRESHOLDS = Object.freeze({
  // Relative demand spread ((max-min)/average) at or above this,
  // AND an absolute spread at or above the floor, means the
  // pre-set load is lopsided enough to be worth balancing. The
  // relative part keeps the signal comparable across school
  // sizes; the floor stops a 2-period wobble on a 500-period
  // school from being called an imbalance.
  workloadRelativeSpreadHigh: 0.25,
  workloadAbsoluteSpreadFloor: 3,
  // preferenceCoverage.ratio < this => PREFERENCE_SIGNAL_WEAK
  preferenceCoverageLow: 0.2,
  // preferenceCoverage.ratio >= this => PREFERENCE_COVERAGE_STRONG
  preferenceCoverageHigh: 0.5,
  // distinctSubjects / subjects <= this => SPECIALIZATION_NARROW
  specializationNarrowRatio: 0.5,
});

// ============================================================================
// Canonical serialization + hash (brief §26)
// ============================================================================

/**
 * Deterministic JSON with recursively sorted object keys. Arrays
 * keep their (already deterministic) order. `undefined` members are
 * dropped so two structurally-equal reports hash identically.
 */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
}

/**
 * FNV-1a, 32-bit, returned as 8 lowercase hex chars. Not a
 * cryptographic hash — its only job is "did these two runs see the
 * same situation?".
 */
export function hashSituationReport(report) {
  const text = canonicalStringify(report);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ============================================================================
// Small deterministic helpers
// ============================================================================

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/** Population standard deviation; 0 for fewer than 2 values. */
function stdev(values) {
  if (values.length < 2) return 0;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  let s = 0;
  for (const v of values) s += (v - avg) ** 2;
  return Math.sqrt(s / values.length);
}

/** Round to a fixed number of decimals so the hash is stable. */
function round(n, decimals = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function countTimeGridSlots(input) {
  const m = input?.timeSlotsByBranch;
  if (!(m instanceof Map) && !(Array.isArray(m))) return null;
  let n = 0;
  for (const arr of m.values()) n += Array.isArray(arr) ? arr.length : 0;
  return n;
}

// ============================================================================
// Section builders
// ============================================================================

/** Aggregate of a per-teacher load distribution. */
function statsOf(values) {
  if (values.length === 0) {
    return { count: 0, total: 0, max: 0, min: 0, average: 0, spread: 0, stdev: 0, relativeSpread: 0, zeroCount: 0 };
  }
  const total = values.reduce((a, b) => a + b, 0);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const average = total / values.length;
  return {
    count: values.length,
    total: round(total, 4),
    max: round(max, 4),
    min: round(min, 4),
    average: round(average, 4),
    spread: round(max - min, 4),
    stdev: round(stdev(values), 4),
    // Size-independent imbalance measure: 0 means every teacher
    // carries the same load, 1 means the busiest carries double
    // the average.
    relativeSpread: round(average > 0 ? (max - min) / average : 0),
    zeroCount: values.filter((v) => v === 0).length,
  };
}

/**
 * Two distinct workload views, because they answer different
 * questions and conflating them hides the interesting one:
 *
 *   declared — the curriculum record per teacher
     (`chuyenMon.soTietTuan`). This is what the school says each
     teacher is contracted to teach. On the current dataset it is
     1 for every teacher, i.e. not a load measure at all, so it
     is reported but never drives a signal.
 *
 *   demand   — the periods the CURRENT pre-set assignment routes
     to each teacher (`assignment.teacherId`). This is the
     distribution the solver is trying to even out, so it is the
     one a strategy decision should be based on. On the real
     dataset: max 24, min 10, average 20.05, spread 14,
     stdev 3.146 — and the best candidate the solver reaches has
     spread 12, max 24, stdev 3.008, so the pre-set distribution
     genuinely predicts the achievable one.
 *
 * No teacher id or name is emitted — only the distributions.
 */
function buildTeacherWorkload(input) {
  const teachers = asArray(input?.teachers);

  const declared = [];
  for (const t of teachers) {
    const w = Number(workloadOf(t));
    if (Number.isFinite(w)) declared.push(w);
  }

  const demandByTeacher = new Map();
  let unassignedPeriods = 0;
  let unassignedCount = 0;
  for (const a of asArray(input?.assignments)) {
    const p = Number(a?.requiredPeriods);
    const periods = Number.isFinite(p) ? p : 0;
    if (a?.teacherId == null) {
      unassignedPeriods += periods;
      unassignedCount += 1;
      continue;
    }
    const id = String(a.teacherId);
    demandByTeacher.set(id, (demandByTeacher.get(id) ?? 0) + periods);
  }

  return {
    teacherCount: teachers.length,
    declared: statsOf(declared),
    demand: {
      ...statsOf([...demandByTeacher.values()]),
      unassignedAssignments: unassignedCount,
      unassignedPeriods: round(unassignedPeriods, 4),
    },
  };
}

/**
 * Specialization distribution: how many teachers cover each
 * subject, and how many declared periods that subject carries.
 *
 * Subject NAME is retained (it is the reasoning vocabulary, and a
 * subject name is not personal data). Teacher identities are not.
 */
function buildSpecialization(input) {
  const bySubject = new Map();
  for (const t of asArray(input?.teachers)) {
    for (const s of asArray(t?.chuyenMon)) {
      const name = s?.tenChuyenMon;
      if (name == null) continue;
      const cur = bySubject.get(name) ?? { subjectName: String(name), teacherCount: 0, declaredPeriods: 0 };
      cur.teacherCount += 1;
      const p = Number(s?.soTietTuan);
      cur.declaredPeriods += Number.isFinite(p) ? p : 0;
      bySubject.set(name, cur);
    }
  }
  const entries = [...bySubject.values()]
    .map((e) => ({
      subjectName: e.subjectName,
      teacherCount: e.teacherCount,
      declaredPeriods: round(e.declaredPeriods, 4),
    }))
    // Total order: most-covered first, then name ASC. Name is a
    // content key, so the order never depends on load order.
    .sort((a, b) => b.teacherCount - a.teacherCount || a.subjectName.localeCompare(b.subjectName));
  return { distinctSubjects: entries.length, entries };
}

/** Per-branch demand and staffing, keyed by branchId (not name). */
function buildBranchWorkload(input) {
  const byBranch = new Map();
  const bump = (id) => {
    const k = String(id ?? 'UNKNOWN');
    const cur = byBranch.get(k) ?? {
      branchId: k, classCount: 0, assignmentCount: 0,
      requiredPeriods: 0, teacherCount: 0,
    };
    byBranch.set(k, cur);
    return cur;
  };
  const classesByBranch = new Set();
  for (const c of asArray(input?.classes)) {
    if (c?.branchId != null) classesByBranch.add(String(c.branchId));
  }
  for (const id of classesByBranch) bump(id).classCount = 1;
  for (const t of asArray(input?.teachers)) {
    if (t?.homeBranchId != null) bump(t.homeBranchId).teacherCount += 1;
  }
  for (const a of asArray(input?.assignments)) {
    const row = bump(a?.branchId);
    row.assignmentCount += 1;
    const p = Number(a?.requiredPeriods);
    row.requiredPeriods += Number.isFinite(p) ? p : 0;
  }
  const entries = [...byBranch.values()]
    .map((e) => ({
      branchId: e.branchId,
      classCount: e.classCount,
      assignmentCount: e.assignmentCount,
      requiredPeriods: round(e.requiredPeriods, 4),
      teacherCount: e.teacherCount,
    }))
    .sort((a, b) => a.branchId.localeCompare(b.branchId));
  return { branchCount: entries.length, entries };
}

/** Per-subject demand, keyed by subjectId + name. */
function buildSubjectDemand(input) {
  // Each subject tracks its OWN branch set — sharing one Set across
  // subjects would make branchCount leak from one row into the next.
  const bySubject = new Map();
  for (const a of asArray(input?.assignments)) {
    const id = String(a?.subjectId ?? 'UNKNOWN');
    let cur = bySubject.get(id);
    if (!cur) {
      cur = {
        subjectId: id,
        subjectName: subjectNameOf(input, a?.subjectId),
        assignmentCount: 0,
        requiredPeriods: 0,
        branches: new Set(),
      };
      bySubject.set(id, cur);
    }
    cur.assignmentCount += 1;
    const p = Number(a?.requiredPeriods);
    cur.requiredPeriods += Number.isFinite(p) ? p : 0;
    if (a?.branchId != null) cur.branches.add(String(a.branchId));
  }
  const entries = [...bySubject.values()]
    .map((e) => ({
      subjectId: e.subjectId,
      subjectName: e.subjectName,
      assignmentCount: e.assignmentCount,
      branchCount: e.branches.size,
      requiredPeriods: round(e.requiredPeriods, 4),
    }))
    .sort((a, b) => b.requiredPeriods - a.requiredPeriods || a.subjectId.localeCompare(b.subjectId));
  return { subjectCount: entries.length, entries };
}

function subjectNameOf(input, subjectId) {
  if (subjectId == null) return null;
  for (const s of asArray(input?.subjects)) {
    if (s?.id === subjectId) return s?.name ?? null;
  }
  return null;
}

/**
 * How many teachers expressed a session preference (S01), and how
 * the preferences split across sessions. Aggregate only — a
 * teacher's own preferred session is never emitted, because
 * combined with a workload row it would be re-identifying.
 */
function buildPreferenceCoverage(input) {
  const bySession = { sang: 0, chieu: 0, ca_hai: 0, unknown: 0 };
  let withPreference = 0;
  const teachers = asArray(input?.teachers);
  for (const t of teachers) {
    const p = t?.nguyenVong?.buoiUuTien;
    if (p == null) { bySession.unknown += 1; continue; }
    withPreference += 1;
    if (p in bySession) bySession[p] += 1;
    else bySession.unknown += 1;
  }
  return {
    teacherCount: teachers.length,
    teachersWithPreference: withPreference,
    ratio: teachers.length > 0 ? round(withPreference / teachers.length) : 0,
    bySession,
  };
}

/**
 * Travel readiness. Mirrors the H14 activation predicate in the
 * constraint catalog; it does NOT invent a matrix and it does NOT
 * promise that a matrix would be sufficient.
 */
function buildTravelReadiness(input) {
  const hasMatrix = Boolean(input?.travelTime && typeof input.travelTime === 'object');
  return {
    supported: hasMatrix,
    hasMatrix,
    status: hasMatrix ? 'READY' : 'UNSUPPORTED',
    sourceStatus: input?.travelStatus ?? null,
    note: hasMatrix
      ? 'A travel matrix is present; H14 is ACTIVE.'
      : 'H14 = UNSUPPORTED. No travel matrix in the input; the TRAVEL scoring dimension is INACTIVE and must stay at weight 0.',
  };
}

/** Transfer readiness. Mirrors the H13 activation predicate. */
function buildTransferReadiness(input) {
  let withPermission = 0;
  for (const t of asArray(input?.teachers)) {
    if (Array.isArray(t?.allowedTransferBranches) && t.allowedTransferBranches.length > 0) withPermission += 1;
  }
  const active = withPermission > 0;
  return {
    active,
    teachersWithPermission: withPermission,
    status: active ? 'ACTIVE' : 'INACTIVE',
    note: active
      ? 'H13 = ACTIVE; the TRANSFER dimension may be weighted.'
      : 'H13 = INACTIVE. No teacher carries allowedTransferBranches; the TRANSFER scoring dimension is INACTIVE and must stay at weight 0.',
  };
}

/**
 * Constraint activation status for every catalog entry.
 *
 * The report tells the AI WHICH constraints are active so it can
 * choose a strategy that is sensible under them. It cannot change
 * them: `aiMayDisable: false` is not a suggestion, it is the
 * absence of any field the schema would accept (see
 * `strategy-schema.js`, which REJECTS any unknown top-level field).
 */
function buildConstraintActivation(input) {
  const rows = [];
  for (const c of CATALOG) {
    let active = false;
    try {
      active = c.active(input) === true;
    } catch {
      active = false;
    }
    // H14 is the one entry the catalog documents as UNSUPPORTED
    // (a hard dependency is not wired), as distinct from INACTIVE
    // (required data is simply absent).
    const status = active ? 'ACTIVE' : (c.id === 'H14' ? 'UNSUPPORTED' : 'INACTIVE');
    rows.push({
      id: c.id,
      code: c.code,
      category: c.category,
      severity: c.severity,
      active,
      status,
      note: active ? null : inactiveReasonForConstraint(c, input),
    });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const count = (cat, status) => rows.filter((r) => r.category === cat && r.status === status).length;
  return {
    hard: rows.filter((r) => r.category === 'HARD'),
    soft: rows.filter((r) => r.category === 'SOFT'),
    summary: {
      hardActive: count('HARD', 'ACTIVE'),
      hardInactive: count('HARD', 'INACTIVE'),
      hardUnsupported: count('HARD', 'UNSUPPORTED'),
      softActive: count('SOFT', 'ACTIVE'),
      softInactive: count('SOFT', 'INACTIVE'),
    },
    aiMayDisable: false,
  };
}

function inactiveReasonForConstraint(c, input) {
  if (c.id === 'H14') return 'UNSUPPORTED: no travel provider is wired';
  if (c.id === 'H13') return 'INACTIVE: no allowedTransferBranches on any teacher';
  if (c.id === 'H09') return 'INACTIVE: no capacity data';
  if (c.id === 'H10') return 'INACTIVE: no maxSessionsPerWeek data';
  if (c.id === 'H11') return 'INACTIVE: no day-off data';
  if (c.id === 'H12') return 'INACTIVE: no branch-session configuration';
  try {
    return c.active(input) ? 'ACTIVE' : 'INACTIVE: activation predicate returned false';
  } catch {
    return 'INACTIVE: activation predicate threw';
  }
}

/**
 * Which scoring dimensions can carry weight right now. This is the
 * dimension-side twin of the constraint report: it is how the AI
 * learns that TRAVEL is not a legal target on this dataset.
 */
function buildDimensionAvailability(input) {
  const active = [];
  const inactive = [];
  for (const d of DIMENSION_CATALOG) {
    let isActive = false;
    try {
      isActive = d.active(input) === true;
    } catch {
      isActive = false;
    }
    if (isActive) active.push({ id: d.id, direction: d.direction, defaultWeight: d.defaultWeight });
    else inactive.push({ id: d.id, direction: d.direction, reason: inactiveReason(d.id, input) });
  }
  return {
    active: active.sort((a, b) => a.id.localeCompare(b.id)),
    inactive: inactive.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * Facts, not judgments. Each signal is a named, threshold-backed
 * observation so the AI can reason over it without re-deriving
 * statistics from raw slots.
 */
function buildSignals(report) {
  const t = SIGNAL_THRESHOLDS;
  const out = [];
  const w = report.teacherWorkload;
  const demand = w.demand;

  if (w.teacherCount === 0) {
    out.push('NO_TEACHER_DATA');
  } else if (
    demand.relativeSpread >= t.workloadRelativeSpreadHigh
    && demand.spread >= t.workloadAbsoluteSpreadFloor
  ) {
    out.push('WORKLOAD_IMBALANCE_HIGH');
  } else {
    out.push('WORKLOAD_BALANCE_ACCEPTABLE');
  }

  if (report.preferenceCoverage.ratio < t.preferenceCoverageLow) out.push('PREFERENCE_SIGNAL_WEAK');
  else if (report.preferenceCoverage.ratio >= t.preferenceCoverageHigh) out.push('PREFERENCE_COVERAGE_STRONG');

  const subjectTotal = report.counts.subjects;
  const covered = report.specialization.distinctSubjects;
  if (subjectTotal === 0 || covered / subjectTotal <= t.specializationNarrowRatio) out.push('SPECIALIZATION_NARROW');
  else out.push('SPECIALIZATION_BROAD');

  out.push(report.travelReadiness.supported ? 'TRAVEL_READY' : 'TRAVEL_UNAVAILABLE');
  out.push(report.transferReadiness.active ? 'TRANSFER_ACTIVE' : 'TRANSFER_INACTIVE');
  if (report.counts.assignments === 0) out.push('NO_ASSIGNMENTS');
  if (demand.unassignedAssignments > 0) out.push('UNMAPPED_DEMAND');
  return out.sort();
}

// ============================================================================
// Public API
// ============================================================================

/**
 * buildSituationReport(input, options) -> SituationReport
 *
 * The report is a NEW object tree. `input` is never mutated, and
 * no reference into `input` is retained in the output — the caller
 * may freeze or discard the input afterwards.
 *
 * options:
 *   - `candidateSummary` — the object returned by
 *     `summarizeCandidates(...)`. When supplied, the report gains
 *     `candidateQuality` and `candidateDiversity` sections (the
 *     POST-SOLVE shape). When omitted those sections are `null`
 *     and `signals` reports PRE-SOLVE facts only.
 *   - `requestedCandidateCount` — the caller's own request, which
 *     the AI may echo back. It is validated against the shared
 *     vocabulary here so a bad request is normalized BEFORE the AI
 *     ever sees it.
 */
export function buildSituationReport(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('buildSituationReport requires a SchedulingInput object');
  }
  const teachers = asArray(input.teachers);
  const branches = asArray(input.branches);
  const classes = asArray(input.classes);
  const subjects = asArray(input.subjects);
  const assignments = asArray(input.assignments);

  let requiredPeriods = 0;
  for (const a of assignments) {
    const p = Number(a?.requiredPeriods);
    if (Number.isFinite(p)) requiredPeriods += p;
  }

  const report = {
    version: SITUATION_REPORT_VERSION,
    counts: {
      teachers: teachers.length,
      branches: branches.length,
      classes: classes.length,
      subjects: subjects.length,
      assignments: assignments.length,
      requiredPeriods: round(requiredPeriods, 4),
      // The (branch x day x period) TIME GRID, i.e. how many cells a
      // schedule could ever fill. Distinct from requiredPeriods
      // (802), which is how many cells the curriculum demands.
      timeGridSlots: countTimeGridSlots(input),
    },
    teacherWorkload: buildTeacherWorkload(input),
    specialization: buildSpecialization(input),
    branchWorkload: buildBranchWorkload(input),
    subjectDemand: buildSubjectDemand(input),
    preferenceCoverage: buildPreferenceCoverage(input),
    travelReadiness: buildTravelReadiness(input),
    transferReadiness: buildTransferReadiness(input),
    constraintActivation: buildConstraintActivation(input),
    dimensionAvailability: buildDimensionAvailability(input),
    actionSpace: {
      optimizationModes: Object.freeze(Object.values(OPTIMIZATION_MODES)),
      candidateCounts: Object.freeze([...ALLOWED_CANDIDATE_COUNTS]),
    },
    candidateQuality: null,
    candidateDiversity: null,
  };

  const requested = options.requestedCandidateCount;
  if (requested != null) {
    report.requestedCandidateCount = ALLOWED_CANDIDATE_COUNTS.includes(Number(requested))
      ? Number(requested)
      : ALLOWED_CANDIDATE_COUNTS[2];
  }

  const cs = options.candidateSummary;
  if (cs && typeof cs === 'object') {
    report.candidateQuality = cs.quality ?? null;
    report.candidateDiversity = cs.diversity ?? null;
  }

  report.signals = buildSignals(report);
  report.hash = hashSituationReport(report);
  return report;
}

/**
 * Assert that a report carries no personal data. Exported so the
 * test suite and any future provider boundary can reuse it rather
 * than re-implement the denylist.
 *
 * The check is a structural key scan (a key whose name matches a
 * personal field is a failure regardless of value) plus a value
 * scan over the serialized report for the actual PII strings
 * present in the input, which catches a leak that arrives under an
 * innocuous key.
 */
const PERSONAL_KEY_PATTERN = /(^|_)(hoTen|ten|fullName|name_teacher|email|soDienThoai|phone|address|diaChi|cmnd|cccd|identity|birth|dob)($|_)/i;

export function findPersonalData(report, input) {
  const findings = [];
  const seen = new Set();
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      if (PERSONAL_KEY_PATTERN.test(k)) findings.push({ path: `${path}.${k}`, kind: 'PERSONAL_KEY', key: k });
      walk(v, `${path}.${k}`);
    }
  };
  walk(report, 'report');

  // Value-level scan: none of the teacher's own contact strings may
  // appear anywhere in the serialized report.
  const serialized = canonicalStringify(report);
  for (const t of asArray(input?.teachers)) {
    for (const field of ['hoTen', 'email', 'soDienThoai']) {
      const v = t?.[field];
      if (typeof v === 'string' && v.length >= 3 && serialized.includes(v)) {
        findings.push({ path: 'report', kind: 'PERSONAL_VALUE', field });
      }
    }
  }
  return findings;
}
