// PHASE 33  SCHEDULE RECORD: the persisted shape of one solution.
//
// WHAT THIS MODULE IS FOR
// -----------------------
// Commit has to turn a SOLVER CANDIDATE (a `Map<assignmentId, Slot[]>`
// plus a `Map<assignmentId, {teacherId, branchId}>`) into a flat,
// serializable list of rows, and it has to be able to do the reverse
// well enough to PROVE the round trip. This module owns both
// directions plus the content hash that makes "the stored schedule is
// the schedule the user picked" a checkable claim rather than an
// assumption (brief �24, �25).
//
// THE ROW IS THE UNIT OF PERSISTENCE
// ---------------------------------
// One row per (assignment, slot):
//
//   { assignmentId, classId, subjectId, teacherId, branchId,
//     day, session, period }
//
// which is exactly the tuple brief �9 names. Those eight fields are
// derived HERE, from the candidate plus the input, and never from a
// request body: there is no code path by which a client-supplied
// teacherId, day, session, period or branch reaches a persisted row
// (brief �22, �29).
//
// WHY `classId` AND `subjectId` ARE RESOLVED FROM THE INPUT
// ---------------------------------------------------------
// The candidate does not carry them. `input.assignmentIndex` does, and
// the input is the backend's own data, so a row can only ever name an
// assignment that exists in the loaded dataset. An assignment id the
// candidate invented is dropped and REPORTED (see
// `buildScheduleRows`), never written with nulls.
//
// SEMANTIC, NOT BYTE, EQUALITY
// ----------------------------
// `compareRows` answers "is the persisted schedule the same schedule",
// not "is the file byte-identical". JSON round-tripping preserves
// numbers and strings but is free to reorder keys and to reformat
// whitespace, so byte comparison would test the serializer instead of
// the persistence. Semantic equality is defined as: same length, and
// the same SET of row keys, where a row key is the eight fields joined
// by U+0000 in a fixed field order. Duplicates therefore matter 
// 802 rows with one duplicated and one missing is a DIFFERENT
// schedule and must not compare equal (brief �16).
//
// MUTATION
// --------
// Nothing in this module writes to `candidate`, to `input`, or to any
// array it is handed. It reads and it builds new objects. The commit
// path relies on that: the source data, the baseline, and the
// constraint catalog are immutable inputs, and a helper that sorted or
// spliced one of them in place would be a silent corruption of
// everything downstream (brief �7).

import { createHash } from 'node:crypto';
import { sessionForSlot } from '../domain/time.js';
import { effectiveAssignmentMeta } from '../domain/assignment.js';

/** The persisted field order. Also the hash field order. */
export const ROW_FIELDS = Object.freeze([
  'assignmentId',
  'classId',
  'subjectId',
  'teacherId',
  'branchId',
  'day',
  'session',
  'period',
]);

/** Schema version. Bump when ROW_FIELDS changes shape. */
export const RECORD_SCHEMA_VERSION = 1;

/**
 * One identity key for one row. U+0000 is used as the separator
 * because it cannot occur in any of the eight values (all are ids,
 * day numbers, session codes, or period numbers)  so two different
 * rows can never collide into the same key by concatenation.
 */
export function rowKey(row) {
  return ROW_FIELDS.map((f) => String(row?.[f] ?? '')).join('\u0000');
}

/**
 * Canonical sort: assignmentId, then day, then period, then the rest
 * of the fields. Sorting is what makes the content hash a property of
 * the SCHEDULE rather than of the iteration order of a `Map`, and the
 * two are genuinely different: the same 802 slots in a different
 * order is the same timetable, and a hash that changed on reordering
 * would report a difference where there is none.
 */
function compareRowOrder(a, b) {
  for (const f of ['assignmentId', 'day', 'period', 'branchId', 'subjectId', 'classId', 'session', 'teacherId']) {
    const av = a?.[f] ?? '';
    const bv = b?.[f] ?? '';
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

/**
 * buildScheduleRows(candidate, input) -> { rows, warnings }
 *
 * `warnings` is non-empty when a row could not be built, and the
 * commit path treats a non-empty list as a refusal rather than
 * writing a schedule that is missing slots. A 400-slot schedule
 * returned with a 200 is the exact failure brief �16 forbids, and
 * silently dropping rows is how it happens.
 */
export function buildScheduleRows(candidate, input) {
  const warnings = [];
  const index = input?.assignmentIndex ?? new Map();
  const branchesById = new Map((input?.branches ?? []).map((b) => [b.id, b]));
  const rows = [];

  const assignments = toEntries(candidate?.assignments);
  const placements = candidate?.placements instanceof Map
    ? candidate.placements
    : new Map(Array.isArray(candidate?.placements) ? candidate.placements : []);

  for (const [assignmentId, slots] of assignments) {
    const meta = index.get(assignmentId);
    if (!meta) {
      warnings.push({
        code: 'UNKNOWN_ASSIGNMENT',
        message: `Assignment ${assignmentId} is not in the loaded scheduling input.`,
      });
      continue;
    }
    const placement = placements.get(assignmentId) ?? null;
    const teacherId = effectiveAssignmentMeta(candidate, assignmentId, input)?.teacherId;
    if (!teacherId) {
      warnings.push({
        code: 'NO_TEACHER',
        message: `Assignment ${assignmentId} resolved to no teacher.`,
      });
      continue;
    }
    if (teacherId === 'CN-TH') {
      // Phase 22/23 established that the legacy dump contains a
      // placeholder teacher id. H08 (active entities) is what rejects
      // it, and this is a second, explicit gate on the WRITE path so
      // the refusal is attributable to commit even if the catalog is
      // ever relaxed (brief �18).
      warnings.push({
        code: 'INACTIVE_TEACHER',
        message: `Assignment ${assignmentId} resolves to the placeholder teacher ${teacherId}.`,
      });
      continue;
    }
    if (!Array.isArray(slots) || slots.length === 0) {
      warnings.push({
        code: 'NO_SLOTS',
        message: `Assignment ${assignmentId} has no slots.`,
      });
      continue;
    }

    for (const slot of slots) {
      const branchId = slot?.branchId ?? meta.branchId ?? null;
      const branch = branchesById.get(branchId) ?? null;
      const row = {
        assignmentId,
        classId: meta.classId ?? null,
        subjectId: meta.subjectId ?? null,
        teacherId,
        branchId,
        day: Number(slot?.day),
        session: sessionForSlot(slot, branch),
        period: Number(slot?.period),
      };
      if (!Number.isFinite(row.day) || !Number.isFinite(row.period) || !row.branchId) {
        warnings.push({
          code: 'INVALID_SLOT',
          message: `Assignment ${assignmentId} has a slot without a usable branch/day/period.`,
        });
        continue;
      }
      rows.push(row);
    }
  }

  rows.sort(compareRowOrder);
  return { rows, warnings };
}

/** `Map` or `Array<[k, v]>` -> `Array<[k, v]>`, without mutating either. */
function toEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value;
  return [];
}

/**
 * The content hash of a set of rows.
 *
 * SHA-256 over the canonical serialization: every row key, sorted,
 * newline-joined, UTF-8. The rows are sorted by `compareRowOrder` here as
 * well so a caller that hands over an unsorted list still gets a
 * stable hash.
 */
export function contentHash(rows) {
  const ordered = [...(rows ?? [])].sort(compareRowOrder);
  const h = createHash('sha256');
  for (const row of ordered) h.update(rowKey(row)).update('\n');
  return h.digest('hex');
}

/**
 * Semantic equality of two row sets.
 *
 * `equal` is the pass/fail verdict; `onlyInLeft` / `onlyInRight` are
 * the evidence, and the commit response carries the COUNT of each so
 * a mismatch is reportable without shipping 802 rows to a log.
 */
export function compareRows(left, right) {
  const a = new Set((left ?? []).map(rowKey));
  const b = new Set((right ?? []).map(rowKey));
  let shared = 0;
  const onlyInLeft = [];
  const onlyInRight = [];
  for (const k of a) {
    if (b.has(k)) shared += 1;
    else onlyInLeft.push(k);
  }
  for (const k of b) {
    if (!a.has(k)) onlyInRight.push(k);
  }
  // Length is compared as well as content: 802 rows where one is
  // duplicated and another missing has the same SET and a different
  // multiset, and that is a corruption, not a match.
  const sameLength = (left ?? []).length === (right ?? []).length;
  return {
    equal: sameLength && onlyInLeft.length === 0 && onlyInRight.length === 0,
    shared,
    leftCount: (left ?? []).length,
    rightCount: (right ?? []).length,
    onlyInLeft,
    onlyInRight,
  };
}

/**
 * normalizeReadback(record) -> rows
 *
 * The read side of the round trip. It re-derives numeric fields
 * because a JSON reader has no way to know whether `day` came back as
 * `1` or `"1"`, and comparing a string day against a number day would
 * report a difference that is purely representational (brief �25).
 */
export function normalizeReadback(record) {
  const rows = Array.isArray(record?.slots) ? record.slots : [];
  return rows
    .map((r) => ({
      assignmentId: r?.assignmentId ?? null,
      classId: r?.classId ?? null,
      subjectId: r?.subjectId ?? null,
      teacherId: r?.teacherId ?? null,
      branchId: r?.branchId ?? null,
      day: Number(r?.day),
      session: r?.session ?? null,
      period: Number(r?.period),
    }))
    .filter((r) => Number.isFinite(r.day) && Number.isFinite(r.period))
    .sort(compareRowOrder);
}

/**
 * The audit metadata attached to a record.
 *
 * Brief �30/�31 ask for provenance without excess. What is kept:
 *
 *   sourceRequestId / sourceSolutionId  the identity of the source
 *   inputHash / scoringDefaultsVersion  which data and which scorer
 *   strategy                           the mode the candidate was
 *                                      produced under
 *   aiProvider / aiFallbackUsed         whether a strategy came from
 *                                      the AI layer or from the
 *                                      deterministic fallback
 *
 * What is deliberately NOT kept: any prompt text, any model
 * response, any teacher personal field, and the whole SchedulingInput.
 * The rows already name the teacher ids; a person is identified by an
 * id, not by a copy of their record.
 */
export function buildAuditBlock({ requestId, solutionId, provenance, strategy, rank, score, actorId }) {
  return {
    sourceRequestId: requestId ?? null,
    actorId: actorId ?? null,
    catalogRevision: provenance?.catalogRevision ?? null,
    sourceSolutionId: solutionId ?? null,
    sourceRank: rank ?? null,
    inputHash: provenance?.benchmarkInputHash ?? null,
    datasetShapeHash: provenance?.datasetShapeHash ?? null,
    dimensionCatalogVersion: provenance?.dimensionCatalogVersion ?? null,
    scoringDefaultsVersion: provenance?.scoringDefaultsVersion ?? null,
    strategy: {
      optimizationMode: strategy?.optimizationMode ?? null,
      appliedOptimizationMode: strategy?.appliedOptimizationMode ?? null,
      modeSource: strategy?.modeSource ?? null,
    },
    score: {
      globalScore: typeof score?.globalScore === 'number' ? score.globalScore : null,
      qualityScore: typeof score?.qualityScore === 'number' ? score.qualityScore : null,
      feasibility: score?.feasibility ?? null,
    },
  };
}
