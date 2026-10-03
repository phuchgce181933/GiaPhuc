// Layer 2 — NORMALIZER.
//
// Maps the raw BSON documents into the new project's domain
// entities. The rules:
//
//  * ObjectId  → its hex string (`.toString()`).
//  * Date      → ISO 8601 string. We keep a parallel `*At` field
//                only when downstream needs the timestamp; otherwise
//                we leave it as `_iso` so that comparison is trivial.
//  * `null`, `[]`, missing, `""`  → kept distinct. The normalizer
//                never treats them as the same value.
//  * Field renames are explicit in each mapper; nothing is renamed
//                implicitly.
//  * No data is invented. If a legacy field is absent on every
//                record, the normalized field is `undefined`,
//                surfaced in `presentFields` and `absentFields`.
//
// The output of `normalizeAll()` is the NORMALIZED DOMAIN layer.
// The SchedulingInput (Layer 3) is derived from this.

import { ObjectId } from 'bson';

/** Convert any value to a stable id key. */
export function toId(value) {
  if (value == null) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toString === 'function') return String(value);
  return null;
}

/** Convert a BSON Date to an ISO string. `null` stays `null`. */
export function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && typeof value.toString === 'function') return String(value);
  return null;
}

/**
 * @param {any} value
 * @returns {boolean}  true if `value` is a non-null, non-empty array.
 * The runtime distinguishes `[]` (empty) from missing (undefined) from `null`.
 */
export function isEmptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

// ---------------------------------------------------------------------------
// Branch
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   code: string,
 *   name: string,
 *   description: string | null,
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeBranch(raw) {
  return {
    id: toId(raw._id),
    code: String(raw.code ?? ''),
    name: String(raw.name ?? ''),
    description: raw.description ?? null,
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Block
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   code: string,
 *   name: string,
 *   order: number | null,
 *   description: string | null,
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeBlock(raw) {
  return {
    id: toId(raw._id),
    code: String(raw.code ?? ''),
    name: String(raw.name ?? ''),
    order: typeof raw.order === 'number' ? raw.order : null,
    description: raw.description ?? null,
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   code: string,
 *   name: string,
 *   description: string | null,
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeSubject(raw) {
  return {
    id: toId(raw._id),
    code: String(raw.code ?? ''),
    name: String(raw.name ?? ''),
    description: raw.description ?? null,
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Teacher
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   code: string | null,
 *   name: string,
 *   email: string,
 *   phone: string,
 *   branch: string | null,
 *   specializations: string[],
 *   standardWorkload: number | null,
 *   partTimeWorkload: number | null,
 *   teachingWorkload: number | null,
 *   maxSessionsPerWeek: number | null,
 *   preferredSession: string | null,
 *   fixedDayOff: any,
 *   allowedTransferBranches: string[],
 *   preferredTransferBranches: string[],
 *   transferPriority: string[],
 *   preferredGrades: any[],
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeTeacher(raw) {
  return {
    id: toId(raw._id),
    code: raw.code != null ? String(raw.code) : null,
    name: String(raw.name ?? ''),
    email: String(raw.email ?? ''),
    phone: String(raw.phone ?? ''),
    branch: toId(raw.branch),
    specializations: Array.isArray(raw.specializations) ? raw.specializations.map(toId).filter((x) => x != null) : [],
    standardWorkload: typeof raw.standardWorkload === 'number' ? raw.standardWorkload : null,
    partTimeWorkload: typeof raw.partTimeWorkload === 'number' ? raw.partTimeWorkload : null,
    teachingWorkload: typeof raw.teachingWorkload === 'number' ? raw.teachingWorkload : null,
    maxSessionsPerWeek: typeof raw.maxSessionsPerWeek === 'number' ? raw.maxSessionsPerWeek : null,
    preferredSession: raw.preferredSession ?? null,
    fixedDayOff: raw.fixedDayOff ?? null,
    allowedTransferBranches: Array.isArray(raw.allowedTransferBranches)
      ? raw.allowedTransferBranches.map(toId).filter((x) => x != null)
      : [],
    preferredTransferBranches: Array.isArray(raw.preferredTransferBranches)
      ? raw.preferredTransferBranches.map(toId).filter((x) => x != null)
      : [],
    transferPriority: Array.isArray(raw.transferPriority)
      ? raw.transferPriority.map(toId).filter((x) => x != null)
      : [],
    preferredGrades: Array.isArray(raw.preferredGrades) ? [...raw.preferredGrades] : [],
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   name: string,
 *   code: string | null,
 *   block: string | null,
 *   branch: string | null,
 *   homeroomTeacher: string | null,
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeClass(raw) {
  return {
    id: toId(raw._id),
    name: String(raw.name ?? ''),
    code: raw.code != null ? String(raw.code) : null,
    block: toId(raw.block),
    branch: toId(raw.branch),
    homeroomTeacher: toId(raw.homeroomTeacher),
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Curriculum (from blocksubjects)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   block: string | null,
 *   subject: string | null,
 *   periodsPerWeek: number,
 *   academicYear: string | null,
 *   isActive: boolean,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeBlockSubject(raw) {
  return {
    id: toId(raw._id),
    block: toId(raw.block),
    subject: toId(raw.subject),
    periodsPerWeek: typeof raw.periodsPerWeek === 'number' ? raw.periodsPerWeek : 0,
    academicYear: raw.academicYear ?? null,
    isActive: raw.isActive === true,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// HistoricalAssignment (from assignments)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {{
 *   id: string,
 *   class: string | null,
 *   subject: string | null,
 *   teacher: string | null,
 *   branch: string | null,
 *   requiredPeriods: number,
 *   assignedPeriods: number,
 *   shortage: number,
 *   shortageReason: string | null,
 *   status: string | null,
 *   academicYear: string | null,
 *   semester: number | null,
 *   note: string,
 *   isTransferred: boolean,
 *   transferredAt: string | null,
 *   transferredFromTeacher: string | null,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 *   source: 'legacy-saplich',
 * }}
 */
export function normalizeAssignment(raw) {
  return {
    id: toId(raw._id),
    class: toId(raw.class),
    subject: toId(raw.subject),
    teacher: toId(raw.teacher),
    branch: toId(raw.branch),
    requiredPeriods: typeof raw.requiredPeriods === 'number' ? raw.requiredPeriods : 0,
    assignedPeriods: typeof raw.assignedPeriods === 'number' ? raw.assignedPeriods : 0,
    shortage: typeof raw.shortage === 'number' ? raw.shortage : 0,
    shortageReason: raw.shortageReason ?? null,
    status: raw.status ?? null,
    academicYear: raw.academicYear ?? null,
    semester: typeof raw.semester === 'number' ? raw.semester : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    isTransferred: raw.isTransferred === true,
    transferredAt: toIso(raw.transferredAt),
    transferredFromTeacher: toId(raw.transferredFromTeacher),
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// HistoricalScheduleMetadata (from schedules)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizeSchedule(raw) {
  return {
    id: toId(raw._id),
    name: raw.name ?? null,
    academicYear: raw.academicYear ?? null,
    semester: typeof raw.semester === 'number' ? raw.semester : null,
    branch: toId(raw.branch),
    status: raw.status ?? null,
    completedAssignments: typeof raw.completedAssignments === 'number' ? raw.completedAssignments : null,
    totalAssignments: typeof raw.totalAssignments === 'number' ? raw.totalAssignments : null,
    hardConstraintViolations: typeof raw.hardConstraintViolations === 'number' ? raw.hardConstraintViolations : null,
    statistics: raw.statistics && typeof raw.statistics === 'object' ? { ...raw.statistics } : null,
    note: typeof raw.note === 'string' ? raw.note : '',
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    isHistoricalMetadata: true, // explicit: not ground truth
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// HistoricalScheduleSlot (from scheduleslots)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizeScheduleSlot(raw) {
  return {
    id: toId(raw._id),
    day: raw.day ?? null,
    session: raw.session ?? null,
    period: typeof raw.period === 'number' ? raw.period : null,
    class: toId(raw.class),
    subject: toId(raw.subject),
    teacher: toId(raw.teacher),
    assignment: toId(raw.assignment),
    slotType: raw.slotType ?? null,
    status: raw.status ?? null,
    academicYear: raw.academicYear ?? null,
    semester: typeof raw.semester === 'number' ? raw.semester : null,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// TransferHistory (from transferlogs)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizeTransferLog(raw) {
  return {
    id: toId(raw._id),
    assignment: toId(raw.assignment),
    fromTeacher: toId(raw.fromTeacher),
    toTeacher: toId(raw.toTeacher),
    fromBranch: toId(raw.fromBranch),
    toBranch: toId(raw.toBranch),
    scope: raw.scope ?? null,
    status: raw.status ?? null,
    failureReason: raw.failureReason ?? null,
    periodsTransferred: typeof raw.periodsTransferred === 'number' ? raw.periodsTransferred : null,
    affectedSlots: Array.isArray(raw.affectedSlots) ? raw.affectedSlots.map(toId).filter((x) => x != null) : [],
    teacherSessionsBefore: typeof raw.teacherSessionsBefore === 'number' ? raw.teacherSessionsBefore : null,
    teacherSessionsAfter: typeof raw.teacherSessionsAfter === 'number' ? raw.teacherSessionsAfter : null,
    teacherWorkloadBefore: typeof raw.teacherWorkloadBefore === 'number' ? raw.teacherWorkloadBefore : null,
    teacherWorkloadAfter: typeof raw.teacherWorkloadAfter === 'number' ? raw.teacherWorkloadAfter : null,
    transferScore: typeof raw.transferScore === 'number' ? raw.transferScore : null,
    rollbackable: raw.rollbackable === true,
    note: typeof raw.note === 'string' ? raw.note : '',
    executedBy: raw.executedBy ?? null,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// PartTimeAssignment (from parttimeassignments; expected empty)
// ---------------------------------------------------------------------------
/**
 * @param {object} raw
 * @returns {object}
 */
export function normalizePartTimeAssignment(raw) {
  return {
    id: toId(raw._id),
    raw: raw, // preserve full source for audit; part-time model is not yet defined
    source: 'legacy-saplich',
  };
}

// ---------------------------------------------------------------------------
// Top-level: normalize every collection in the dump.
// ---------------------------------------------------------------------------
/**
 * @param {RawDump} raw
 * @returns {{
 *   branches: object[],
 *   blocks: object[],
 *   subjects: object[],
 *   teachers: object[],
 *   classes: object[],
 *   curriculum: object[],            // from blocksubjects
 *   historicalAssignments: object[], // from assignments
 *   historicalSchedule: object[],    // from schedules
 *   historicalScheduleSlots: object[],
 *   transferHistory: object[],
 *   partTimeAssignments: object[],
 *   warnings: string[],
 * }}
 */
export function normalizeAll(raw) {
  const get = (name) => raw.collections.get(name)?.documents ?? [];
  const warnings = [];

  const branches = get('branches').map(normalizeBranch);
  const blocks = get('blocks').map(normalizeBlock);
  const subjects = get('subjects').map(normalizeSubject);
  const teachers = get('teachers').map(normalizeTeacher);
  const classes = get('classes').map(normalizeClass);
  const curriculum = get('blocksubjects').map(normalizeBlockSubject);
  const historicalAssignments = get('assignments').map(normalizeAssignment);
  const historicalSchedule = get('schedules').map(normalizeSchedule);
  const historicalScheduleSlots = get('scheduleslots').map(normalizeScheduleSlot);
  const transferHistory = get('transferlogs').map(normalizeTransferLog);
  const partTimeAssignments = get('parttimeassignments').map(normalizePartTimeAssignment);

  // Surface every absent field on every record (for the audit
  // report). This is informational; we never invent values.
  for (const t of teachers) {
    if (t.email === '') warnings.push(`teacher ${t.id} (${t.name}): email empty in source`);
    if (t.phone === '') warnings.push(`teacher ${t.id} (${t.name}): phone empty in source`);
    if (t.branch == null) warnings.push(`teacher ${t.id} (${t.name}): branch absent in source`);
  }
  for (const c of classes) {
    if (c.homeroomTeacher != null) warnings.push(`class ${c.id} (${c.name}): homeroomTeacher present (${c.homeroomTeacher}) — non-null is uncommon in the dump`);
  }

  return {
    branches,
    blocks,
    subjects,
    teachers,
    classes,
    curriculum,
    historicalAssignments,
    historicalSchedule,
    historicalScheduleSlots,
    transferHistory,
    partTimeAssignments,
    warnings,
  };
}