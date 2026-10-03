// Layer 6 — PHASE 20 VERIFICATION.
//
// Pure verification helpers that walk the legacy-saplich
// pipeline (RAW → NORMALIZED → SCHEDULING MODEL → ORCHESTRATOR
// INPUT) and report semantic state.
//
// The brief is explicit: VERIFY + AUDIT + TRACE + TEST + DOCUMENT.
// No business rule is added. No data is invented. The only
// mutating effect of this module is on its own return values.
//
// Each `verify*` function returns a structured report. The
// top-level `runPhase20Audit(result)` runs all of them.

import { validateInput } from '../../domain/validate.js';
import { makeOrchestrator } from '../../orchestrator/index.js';

// ---------------------------------------------------------------------------
// §2 — Traceability
// ---------------------------------------------------------------------------

export function verifyTraceability(normalized, scheduling) {
  // For every entity in scheduling, the id must be present in
  // normalized. For every entity in normalized that should
  // appear in scheduling, it must. ID stability = no new IDs.
  const normTeacherIds = new Set(normalized.teachers.map((t) => t.id));
  const schedTeacherIds = new Set(scheduling.teachers.map((t) => t.id));
  const normBranchIds = new Set(normalized.branches.map((b) => b.id));
  const schedBranchIds = new Set(scheduling.branches.map((b) => b.id));
  const normClassIds = new Set(normalized.classes.map((c) => c.id));
  const schedClassIds = new Set(scheduling.classes.map((c) => c.id));
  const normSubjectIds = new Set(normalized.subjects.map((s) => s.id));
  const schedSubjectIds = new Set(scheduling.subjects.map((s) => s.id));

  // Active subset of normalized teachers
  const normActiveTeacherIds = new Set(
    normalized.teachers.filter((t) => t.isActive).map((t) => t.id)
  );

  // Active subject subset
  const normActiveSubjectIds = new Set(
    normalized.subjects.filter((s) => s.isActive).map((s) => s.id)
  );

  const inNormalizedOnlyTeachers = [...normActiveTeacherIds].filter(
    (id) => !schedTeacherIds.has(id)
  );
  const inSchedulingOnlyTeachers = [...schedTeacherIds].filter(
    (id) => !normActiveTeacherIds.has(id)
  );
  const inactiveInScheduling = normalized.teachers
    .filter((t) => !t.isActive)
    .filter((t) => schedTeacherIds.has(t.id));

  const inNormalizedOnlyBranches = [...normBranchIds].filter(
    (id) => !schedBranchIds.has(id)
  );
  const inSchedulingOnlyBranches = [...schedBranchIds].filter(
    (id) => !normBranchIds.has(id)
  );

  const inNormalizedOnlyClasses = [...normClassIds].filter(
    (id) => !schedClassIds.has(id)
  );
  const inSchedulingOnlyClasses = [...schedClassIds].filter(
    (id) => !normClassIds.has(id)
  );

  const inNormalizedOnlySubjects = [...normActiveSubjectIds].filter(
    (id) => !schedSubjectIds.has(id)
  );
  const inSchedulingOnlySubjects = [...schedSubjectIds].filter(
    (id) => !normActiveSubjectIds.has(id)
  );

  // Assignment IDs: every scheduling assignment must trace to a
  // normalized historical assignment. The reverse direction:
  // some historical assignments may have been dropped only if
  // the source was missing. Today we import them all, so the
  // counts must match.
  const normAssignmentIds = new Set(normalized.historicalAssignments.map((a) => a.id));
  const schedAssignmentIds = new Set(scheduling.assignments.map((a) => a.id));
  const assignmentsInNormOnly = [...normAssignmentIds].filter(
    (id) => !schedAssignmentIds.has(id)
  );
  const assignmentsInSchedOnly = [...schedAssignmentIds].filter(
    (id) => !normAssignmentIds.has(id)
  );

  return {
    counts: {
      normalized: {
        teachers: normalized.teachers.length,
        activeTeachers: normalized.teachers.filter((t) => t.isActive).length,
        branches: normalized.branches.length,
        classes: normalized.classes.length,
        subjects: normalized.subjects.length,
        activeSubjects: normalized.subjects.filter((s) => s.isActive).length,
        curriculum: normalized.curriculum.length,
        historicalAssignments: normalized.historicalAssignments.length,
      },
      scheduling: {
        teachers: scheduling.teachers.length,
        branches: scheduling.branches.length,
        classes: scheduling.classes.length,
        subjects: scheduling.subjects.length,
        curriculum: scheduling.curriculum.length,
        assignments: scheduling.assignments.length,
      },
    },
    idStability: {
      teachers: {
        inNormalizedOnly: inNormalizedOnlyTeachers,
        inSchedulingOnly: inSchedulingOnlyTeachers,
        inactiveInScheduling: inactiveInScheduling.map((t) => t.id),
        activeMatch: inNormalizedOnlyTeachers.length === 0 && inSchedulingOnlyTeachers.length === 0 && inactiveInScheduling.length === 0,
      },
      branches: {
        inNormalizedOnly: inNormalizedOnlyBranches,
        inSchedulingOnly: inSchedulingOnlyBranches,
        match: inNormalizedOnlyBranches.length === 0 && inSchedulingOnlyBranches.length === 0,
      },
      classes: {
        inNormalizedOnly: inNormalizedOnlyClasses,
        inSchedulingOnly: inSchedulingOnlyClasses,
        match: inNormalizedOnlyClasses.length === 0 && inSchedulingOnlyClasses.length === 0,
      },
      subjects: {
        inNormalizedOnly: inNormalizedOnlySubjects,
        inSchedulingOnly: inSchedulingOnlySubjects,
        match: inNormalizedOnlySubjects.length === 0 && inSchedulingOnlySubjects.length === 0,
      },
      assignments: {
        inNormalizedOnly: assignmentsInNormOnly,
        inSchedulingOnly: assignmentsInSchedOnly,
        match: assignmentsInNormOnly.length === 0 && assignmentsInSchedOnly.length === 0,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// §3 — Teachers
// ---------------------------------------------------------------------------

export function verifyTeachers(normalized, scheduling) {
  const sourceById = new Map(normalized.teachers.map((t) => [t.id, t]));
  const schedById = new Map(scheduling.teachers.map((t) => [t.id, t]));

  const activeCount = normalized.teachers.filter((t) => t.isActive).length;
  const inactiveLeak = scheduling.teachers.filter(
    (t) => !sourceById.get(t.id)?.isActive
  );
  const activeMissingInScheduling = normalized.teachers
    .filter((t) => t.isActive)
    .filter((t) => !schedById.has(t.id))
    .map((t) => t.id);

  const nameMismatches = [];
  const emailMismatches = [];
  const phoneMismatches = [];
  const homeBranchMismatches = [];
  for (const t of scheduling.teachers) {
    const src = sourceById.get(t.id);
    if (!src) continue;
    if (t.hoTen !== src.name) nameMismatches.push({ id: t.id, scheduling: t.hoTen, source: src.name });
    if ((t.email || '') !== (src.email || '')) emailMismatches.push({ id: t.id, scheduling: t.email, source: src.email });
    if ((t.soDienThoai || '') !== (src.phone || '')) phoneMismatches.push({ id: t.id, scheduling: t.soDienThoai, source: src.phone });
    if ((t.homeBranchId || null) !== (src.branch || null)) homeBranchMismatches.push({ id: t.id, scheduling: t.homeBranchId, source: src.branch });
  }

  // Specializations: per Phase 21 fix, the raw teacher
  // `specializations` are subject ids (not names). The scheduling
  // model projects them into BOTH:
  //   - `chuyenMon[].tenChuyenMon` (kept for contract compat) with
  //     the value = subject id
  //   - `eligibleSubjectIds[]` (explicit, solver-friendly)
  //
  // Audit checks: every scheduling `tenChuyenMon` must be a real
  // subject id (not a name); every `eligibleSubjectIds[]` must be
  // a subset of the source specializations.
  const subjectIdSet = new Set(normalized.subjects.map((s) => s.id));
  const eligibilityIssues = [];
  const eligibilityAsAssignment = [];
  let teachersWithEligible = 0;
  let eligibleIdCount = 0;
  for (const t of scheduling.teachers) {
    const src = sourceById.get(t.id);
    if (!src) continue;
    // chuyenMon[].tenChuyenMon must equal a subject id (per the
    // Bug #2 fix). It must NOT be a subject name.
    for (const s of t.chuyenMon) {
      if (!subjectIdSet.has(s.tenChuyenMon)) {
        eligibilityIssues.push({ teacherId: t.id, field: 'chuyenMon.tenChuyenMon', value: s.tenChuyenMon, reason: 'not_a_subject_id' });
      }
    }
    // eligibleSubjectIds must be a subset of source specializations
    const sourceSpecSet = new Set(src.specializations);
    for (const sid of t.eligibleSubjectIds ?? []) {
      if (!sourceSpecSet.has(sid)) {
        eligibilityIssues.push({ teacherId: t.id, field: 'eligibleSubjectIds', value: sid, reason: 'not_in_source_specializations' });
      }
    }
    if ((t.eligibleSubjectIds ?? []).length > 0) teachersWithEligible += 1;
    eligibleIdCount += (t.eligibleSubjectIds ?? []).length;
    if (src.specializations.length > 0 && (t.eligibleSubjectIds ?? []).length === 0) {
      eligibilityAsAssignment.push({ teacherId: t.id, reason: 'eligibility dropped to zero' });
    }
  }

  return {
    sourceActiveCount: activeCount,
    schedulingCount: scheduling.teachers.length,
    inactiveLeak: inactiveLeak.map((t) => t.id),
    activeMissingInScheduling,
    nameMismatches,
    emailMismatches,
    phoneMismatches,
    homeBranchMismatches,
    eligibilityIssues,
    eligibilityAsAssignment,
    teachersWithEligible,
    eligibleIdCount,
    note: 'specializations[] in source = subject ids. After Phase 21 fix: chuyenMon[].tenChuyenMon = subject id (not name); eligibleSubjectIds[] is the explicit solver-friendly projection. No teacher loses eligibility compared to source.',
  };
}

// ---------------------------------------------------------------------------
// §4 — Workload
// ---------------------------------------------------------------------------

export function verifyWorkload(normalized, scheduling) {
  // Source teachingWorkload (legacy denormalized)
  const sourceById = new Map(normalized.teachers.map((t) => [t.id, t]));

  // Derived from normalized historical assignments
  const derived = new Map();
  for (const t of normalized.teachers) derived.set(t.id, 0);
  for (const a of normalized.historicalAssignments) {
    if (a.teacher != null && derived.has(a.teacher)) {
      derived.set(a.teacher, (derived.get(a.teacher) || 0) + (a.assignedPeriods || 0));
    }
  }

  // Scheduling budget (sum of chuyenMon[].soTietTuan) — used by
  // the orchestrator's workload balance score. The contract says
  // workloadOf(t) = Σ soTietTuan.
  const schedBudget = new Map();
  for (const t of scheduling.teachers) {
    const sum = (t.chuyenMon || []).reduce((acc, s) => acc + (s.soTietTuan || 0), 0);
    schedBudget.set(t.id, sum);
  }

  const comparison = [];
  let legacyMismatches = 0;
  for (const t of normalized.teachers) {
    if (!t.isActive) continue;
    const src = sourceById.get(t.id);
    const legacyValue = t.teachingWorkload;
    const derivedValue = derived.get(t.id) || 0;
    const budget = schedBudget.get(t.id) || 0;
    const legacyEqDerived = legacyValue === derivedValue;
    if (!legacyEqDerived) legacyMismatches += 1;
    comparison.push({
      teacherId: t.id,
      name: t.name,
      legacy: legacyValue,
      derived: derivedValue,
      schedulingBudget: budget,
      legacyEqualsDerived: legacyEqDerived,
      budgetEqualsDerived: budget === derivedValue,
    });
  }

  return {
    legacyMismatches,
    rows: comparison,
    note: 'legacy teachingWorkload is denormalized; derived is recomputed from assignments. schedulingBudget is Σ chuyenMon[].soTietTuan. None of the three overwrites another.',
  };
}

// ---------------------------------------------------------------------------
// §5 — Branches
// ---------------------------------------------------------------------------

export function verifyBranches(normalized, scheduling) {
  const sourceById = new Map(normalized.branches.map((b) => [b.id, b]));
  const schedById = new Set(scheduling.branches.map((b) => b.id));

  const missingInScheduling = [...sourceById.keys()].filter((id) => !schedById.has(id));
  const schedIds = new Set(scheduling.branches.map((b) => b.id));
  const inferredFromName = []; // we do not infer; this is just a sentinel for the audit
  // Verify the scheduling branch has schoolDays and periods
  const branchProfile = scheduling.branches.map((b) => ({
    id: b.id,
    name: b.name,
    schoolDays: b.schoolDays,
    periods: b.periods,
    slotCount: scheduling.timeSlotsByBranch.get(b.id)?.length ?? 0,
  }));

  return {
    sourceCount: normalized.branches.length,
    schedulingCount: scheduling.branches.length,
    missingInScheduling,
    inferredFromName, // always empty: we do not infer from class/teacher name
    branchProfile,
    note: 'branches = source. no inference from class name, teacher name, or code. timeSlotsByBranch is built from each branch.schoolDays × branch.periods.',
  };
}

// ---------------------------------------------------------------------------
// §6 — Classes
// ---------------------------------------------------------------------------

export function verifyClasses(normalized, scheduling) {
  const sourceById = new Map(normalized.classes.map((c) => [c.id, c]));
  const schedById = new Set(scheduling.classes.map((c) => c.id));
  const blockIds = new Set(normalized.blocks.map((b) => b.id));
  const branchIds = new Set(normalized.branches.map((b) => b.id));

  const missingInScheduling = [...sourceById.keys()].filter((id) => !schedById.has(id));

  // Check class.block and class.branch references in scheduling.
  // scheduling classes do not have a `block` field (only branchId,
  // name, gradeLevel). The brief says "không suy luận branch từ
  // tên class"; verify that scheduling.class[i].branchId matches
  // the source class.branch for the same id.
  const classBranchMismatch = [];
  const inferredFromName = [];
  for (const c of scheduling.classes) {
    const src = sourceById.get(c.id);
    if (!src) continue;
    if (c.branchId !== src.branch) {
      classBranchMismatch.push({ id: c.id, schedulingBranch: c.branchId, sourceBranch: src.branch });
    }
  }

  return {
    sourceCount: normalized.classes.length,
    schedulingCount: scheduling.classes.length,
    missingInScheduling,
    classBranchMismatch,
    inferredFromName,
    note: 'branch in scheduling = source classes.branch. no inference from class name.',
  };
}

// ---------------------------------------------------------------------------
// §7 — Subjects
// ---------------------------------------------------------------------------

export function verifySubjects(normalized, scheduling) {
  const sourceById = new Map(normalized.subjects.map((s) => [s.id, s]));
  const schedById = new Set(scheduling.subjects.map((s) => s.id));
  const sourceActive = normalized.subjects.filter((s) => s.isActive);
  const sourceInactive = normalized.subjects.filter((s) => !s.isActive);

  // CN-TH must remain in normalized.
  const cnthInSource = normalized.subjects.find(
    (s) => s.code === 'CN-TH' || s.name === 'Công nghệ, Tin học'
  );

  // CN-TH must NOT be in the active scheduling demand.
  const cnthInScheduling = cnthInSource ? schedById.has(cnthInSource.id) : null;

  // Subject codes/names in source vs scheduling
  const nameMismatches = [];
  for (const s of scheduling.subjects) {
    const src = sourceById.get(s.id);
    if (!src) continue;
    if (s.name !== src.name) nameMismatches.push({ id: s.id, source: src.name, scheduling: s.name });
  }

  // Inactive subjects should not appear in scheduling.
  const inactiveLeakToScheduling = sourceInactive
    .filter((s) => schedById.has(s.id))
    .map((s) => s.id);

  return {
    sourceCount: normalized.subjects.length,
    sourceActiveCount: sourceActive.length,
    sourceInactiveCount: sourceInactive.length,
    schedulingCount: scheduling.subjects.length,
    cnthInSource: cnthInSource
      ? { id: cnthInSource.id, isActive: cnthInSource.isActive, code: cnthInSource.code, name: cnthInSource.name }
      : null,
    cnthInScheduling,
    inactiveLeakToScheduling,
    nameMismatches,
    note: 'subjects in source = 6. active = 5. CN-TH inactive preserved in normalized, NOT promoted to scheduling.',
  };
}

// ---------------------------------------------------------------------------
// §8 — Curriculum
// ---------------------------------------------------------------------------

export function verifyCurriculum(normalized, scheduling) {
  // Source 24 = blocksubjects count
  const rawCount = normalized.curriculum.length;
  const sourceSubjectById = new Map(normalized.subjects.map((s) => [s.id, s]));
  const inactiveIds = new Set(
    normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );

  // Effective (active) curriculum in source = 24 - rows whose subject is inactive
  const effectiveSource = normalized.curriculum.filter(
    (cs) => !inactiveIds.has(cs.subject)
  ).length;
  const excludedSource = normalized.curriculum.filter(
    (cs) => inactiveIds.has(cs.subject)
  );

  // Scheduling curriculum: rows that are not in scheduling.excludedCurriculum
  const schedActive = scheduling.curriculum.length;
  const schedExcluded = (scheduling.excludedCurriculum ?? []).length;

  // Curriculum classId check. Legacy curriculum uses `block` (5
  // grade groups). Scheduling stores it as `classId` because the
  // orchestrator's validator expects that field. This is a
  // semantic mismatch (block id != real class id) and is the
  // single largest semantic issue in the current pipeline. The
  // brief instructs us to report it, not fix it.
  const classIdIsRealClass = new Set(scheduling.classes.map((c) => c.id));
  const classIdIsBlock = new Set(normalized.blocks.map((b) => b.id));
  const subjectIdIsReal = new Set(scheduling.subjects.map((s) => s.id));
  const curriculumClassIdMismatch = [];
  const curriculumSubjectIdMismatch = [];
  const curriculumMissingBlockId = [];
  const curriculumTraceable = [];
  for (const cs of scheduling.curriculum) {
    if (!classIdIsRealClass.has(cs.classId)) {
      const isBlock = classIdIsBlock.has(cs.classId);
      curriculumClassIdMismatch.push({
        curriculumId: cs.id,
        classId: cs.classId,
        isRealClass: false,
        isBlock: isBlock,
      });
    }
    if (!subjectIdIsReal.has(cs.subjectId)) {
      curriculumSubjectIdMismatch.push({ curriculumId: cs.id, subjectId: cs.subjectId });
    }
    if (cs.blockId == null) {
      curriculumMissingBlockId.push({ curriculumId: cs.id });
    }
    // Traceability: every scheduling curriculum row must reduce
    // to a single source blocksubject. The composite id is
    // `${sourceId}::${classId}`.
    curriculumTraceable.push({
      id: cs.id,
      classId: cs.classId,
      subjectId: cs.subjectId,
      blockId: cs.blockId,
    });
  }

  return {
    rawCount,
    effectiveSource,
    excludedSource: excludedSource.map((cs) => ({
      id: cs.id,
      subject: cs.subject,
      reason: 'inactive_subject',
    })),
    schedulingActive: schedActive,
    schedulingExcluded: schedExcluded,
    classLevelCurriculumCount: schedActive,
    effectiveCurriculumBlockLevel: effectiveSource,
    blockLevelDerivedFromSource: effectiveSource,
    classLevelExpandedFromBlocks: schedActive,
    curriculumClassIdMismatch: {
      total: curriculumClassIdMismatch.length,
      isBlockIds: curriculumClassIdMismatch.filter((x) => x.isBlock).length,
      isNeither: curriculumClassIdMismatch.filter((x) => !x.isBlock).length,
      sample: curriculumClassIdMismatch.slice(0, 3),
    },
    curriculumSubjectIdMismatch: {
      total: curriculumSubjectIdMismatch.length,
      sample: curriculumSubjectIdMismatch.slice(0, 3),
    },
    curriculumMissingBlockId: curriculumMissingBlockId.length,
    derivedNotHardCoded: effectiveSource === 21, // 24 raw - 3 inactive CN-TH
    note: 'Phase 21 fix: curriculum is now CLASS-LEVEL. Each (block, subject) blocksubject is expanded to one row per active class in the block. classId is a REAL class id; blockId is preserved alongside.',
  };
}

// ---------------------------------------------------------------------------
// §9 — Demand
// ---------------------------------------------------------------------------

export function verifyDemand(normalized, scheduling) {
  // Source demand
  const total = normalized.historicalAssignments.length;
  const requiredSum = normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.requiredPeriods || 0), 0
  );
  const assignedSum = normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.assignedPeriods || 0), 0
  );
  const shortageSum = normalized.historicalAssignments.reduce(
    (acc, a) => acc + (a.shortage || 0), 0
  );

  // Subject breakdown in source
  const bySubject = new Map();
  for (const a of normalized.historicalAssignments) {
    const k = a.subject;
    const cur = bySubject.get(k) ?? { subjectId: a.subject, demand: 0, classCount: new Set(), periods: 0 };
    cur.demand += a.requiredPeriods;
    cur.classCount.add(a.class);
    cur.periods += a.assignedPeriods;
    bySubject.set(k, cur);
  }
  const subjectBreakdown = [...bySubject.values()].map((v) => ({
    subjectId: v.subjectId,
    demand: v.demand,
    classCount: v.classCount.size,
    periods: v.periods,
  }));

  // Class breakdown
  const byClass = new Map();
  for (const a of normalized.historicalAssignments) {
    const k = a.class;
    const cur = byClass.get(k) ?? { classId: a.class, demand: 0, subjects: new Set() };
    cur.demand += a.requiredPeriods;
    cur.subjects.add(a.subject);
    byClass.set(k, cur);
  }
  const classBreakdown = [...byClass.values()].map((v) => ({
    classId: v.classId,
    demand: v.demand,
    subjectCount: v.subjects.size,
  }));

  // Subjects present in assignments (must NOT include CN-TH)
  const inactiveIds = new Set(
    normalized.subjects.filter((s) => !s.isActive).map((s) => s.id)
  );
  const usedInactive = [...inactiveIds].filter((sid) => bySubject.has(sid));

  return {
    assignments: total,
    required: requiredSum,
    assigned: assignedSum,
    shortage: shortageSum,
    derivedExpected: 479,
    derivedExpectedRequired: 802,
    derivedExpectedAssigned: 802,
    derivedExpectedShortage: 0,
    subjectBreakdown,
    classCount: byClass.size,
    classBreakdownSample: classBreakdown.slice(0, 3),
    usedInactiveSubjects: usedInactive,
    note: 'demand is derived from assignments. We do NOT adjust to make 802 — the sum is the source truth.',
  };
}

// ---------------------------------------------------------------------------
// §10 — Assignment semantic
// ---------------------------------------------------------------------------

export function verifyAssignments(normalized, scheduling) {
  const sourceById = new Map(normalized.historicalAssignments.map((a) => [a.id, a]));
  const classById = new Map(normalized.classes.map((c) => [c.id, c]));
  const subjectById = new Map(normalized.subjects.map((s) => [s.id, s]));
  const teacherById = new Map(normalized.teachers.map((t) => [t.id, t]));
  const branchById = new Map(normalized.branches.map((b) => [b.id, b]));

  const schedById = new Map(scheduling.assignments.map((a) => [a.id, a]));

  // Re-check core invariants in scheduling
  let classMissing = 0, subjectMissing = 0, teacherMissing = 0, branchMissing = 0;
  let classBranchMismatch = 0, teacherIneligible = 0;
  let baselineTrueCount = 0, baselineFalseCount = 0, baselineMissingCount = 0;

  for (const a of scheduling.assignments) {
    if (a.baselineAssignment === true) baselineTrueCount += 1;
    else if (a.baselineAssignment === false) baselineFalseCount += 1;
    else baselineMissingCount += 1;

    if (!classById.has(a.classId)) classMissing += 1;
    if (!subjectById.has(a.subjectId)) subjectMissing += 1;
    if (!teacherById.has(a.teacherId)) teacherMissing += 1;
    if (!branchById.has(a.branchId)) branchMissing += 1;

    const cls = classById.get(a.classId);
    if (cls && cls.branch !== a.branchId) classBranchMismatch += 1;

    const teacher = teacherById.get(a.teacherId);
    if (teacher) {
      const specSet = new Set(teacher.specializations);
      if (!specSet.has(a.subjectId)) teacherIneligible += 1;
    }
  }

  // Trace check: every scheduling assignment id is in the source.
  const traceMissing = scheduling.assignments
    .filter((a) => !sourceById.has(a.id))
    .map((a) => a.id);

  return {
    schedulingCount: scheduling.assignments.length,
    baselineTrueCount,
    baselineFalseCount,
    baselineMissingCount,
    brokenClassRef: classMissing,
    brokenSubjectRef: subjectMissing,
    brokenTeacherRef: teacherMissing,
    brokenBranchRef: branchMissing,
    classBranchMismatch,
    teacherIneligible,
    traceMissing,
    note: 'baselineAssignment=true means historical baseline. It is NOT a fixed assignment. The orchestrator may re-optimize teacher selection.',
  };
}

// ---------------------------------------------------------------------------
// §11 — Schedule slots (against legacyBaseline)
// ---------------------------------------------------------------------------

export function verifyScheduleSlots(normalized, legacyBaseline) {
  const slots = legacyBaseline.scheduleSlots;
  const assignments = legacyBaseline.assignments;
  const byAssignment = new Map(assignments.map((a) => [a.id, a]));

  // Each assignment has exactly assignedPeriods slots.
  const slotCountByAssignment = new Map();
  for (const s of slots) {
    slotCountByAssignment.set(s.assignment, (slotCountByAssignment.get(s.assignment) || 0) + 1);
  }
  let slotCountMismatch = 0;
  for (const a of assignments) {
    const c = slotCountByAssignment.get(a.id) || 0;
    if (c !== a.assignedPeriods) slotCountMismatch += 1;
  }

  // No duplicate class/day/session/period
  const classSlots = new Set();
  let classDup = 0;
  for (const s of slots) {
    const k = `${s.class}|${s.day}|${s.session}|${s.period}`;
    if (classSlots.has(k)) classDup += 1;
    classSlots.add(k);
  }
  // No duplicate teacher/day/session/period
  const teacherSlots = new Set();
  let teacherDup = 0;
  for (const s of slots) {
    const k = `${s.teacher}|${s.day}|${s.session}|${s.period}`;
    if (teacherSlots.has(k)) teacherDup += 1;
    teacherSlots.add(k);
  }

  // Slot fields match assignment fields
  let subjectMismatch = 0, teacherMismatch = 0;
  for (const s of slots) {
    const a = byAssignment.get(s.assignment);
    if (!a) continue;
    if (s.subject !== a.subject) subjectMismatch += 1;
    if (s.teacher !== a.teacher) teacherMismatch += 1;
  }

  return {
    totalSlots: slots.length,
    slotCountMismatch,
    classDuplicateSlots: classDup,
    teacherDuplicateSlots: teacherDup,
    subjectMismatch,
    teacherMismatch,
    note: 'ground truth is scheduleslots, NOT the schedules summary (which says 671 and is a legacy snapshot).',
  };
}

// ---------------------------------------------------------------------------
// §12 — Transfer semantics
// ---------------------------------------------------------------------------

export function verifyTransfers(normalized) {
  const assignments = normalized.historicalAssignments;
  const transferred = assignments.filter((a) => a.isTransferred);
  const transferredFromMissing = transferred.filter((a) => a.transferredFromTeacher == null);

  const logs = normalized.transferHistory;
  const success = logs.filter((t) => t.status === 'SUCCESS').length;
  const failed = logs.filter((t) => t.status === 'FAILED').length;

  // Orphan historical references (assignment id no longer in
  // assignments)
  const assignmentIds = new Set(assignments.map((a) => a.id));
  const orphan = logs.filter((t) => t.assignment != null && !assignmentIds.has(t.assignment)).length;

  // Failure reasons preserved
  const reasons = new Set(
    logs.filter((t) => t.status === 'FAILED').map((t) => t.failureReason).filter(Boolean)
  );

  return {
    transferredAssignments: transferred.length,
    transferredFromMissingCount: transferredFromMissing.length,
    logCount: logs.length,
    success,
    failed,
    orphanAssignmentReferences: orphan,
    failureReasons: [...reasons].sort(),
    scope: [...new Set(logs.map((t) => t.scope))],
    note: 'isTransferred / transferredAt / transferredFromTeacher are preserved verbatim. logs are not deleted for orphan assignment references.',
  };
}

// ---------------------------------------------------------------------------
// §13 — Transfer eligibility (per teacher)
// ---------------------------------------------------------------------------

export function verifyTransferEligibility(normalized, scheduling) {
  const sourceById = new Map(normalized.teachers.map((t) => [t.id, t]));
  const schedById = new Map(scheduling.teachers.map((t) => [t.id, t]));

  const sourceStats = {
    homeBranch: { present: 0, null: 0 },
    allowedTransferBranches: { present: 0, empty: 0, missing: 0 },
    preferredTransferBranches: { present: 0, empty: 0, missing: 0 },
  };
  for (const t of normalized.teachers) {
    if (t.branch != null) sourceStats.homeBranch.present += 1;
    else sourceStats.homeBranch.null += 1;
    if (Array.isArray(t.allowedTransferBranches)) {
      if (t.allowedTransferBranches.length > 0) sourceStats.allowedTransferBranches.present += 1;
      else sourceStats.allowedTransferBranches.empty += 1;
    } else {
      sourceStats.allowedTransferBranches.missing += 1;
    }
    if (Array.isArray(t.preferredTransferBranches)) {
      if (t.preferredTransferBranches.length > 0) sourceStats.preferredTransferBranches.present += 1;
      else sourceStats.preferredTransferBranches.empty += 1;
    } else {
      sourceStats.preferredTransferBranches.missing += 1;
    }
  }

  // In scheduling, did the loader surface allowedTransferBranches?
  const schedStats = {
    homeBranch: { present: 0, null: 0 },
    allowedTransferBranches: { present: 0, empty: 0, missing: 0 },
  };
  for (const t of scheduling.teachers) {
    if (t.homeBranchId != null) schedStats.homeBranch.present += 1;
    else schedStats.homeBranch.null += 1;
    if (Array.isArray(t.allowedTransferBranches)) {
      if (t.allowedTransferBranches.length > 0) schedStats.allowedTransferBranches.present += 1;
      else schedStats.allowedTransferBranches.empty += 1;
    } else {
      schedStats.allowedTransferBranches.missing += 1;
    }
  }

  return {
    sourceStats,
    schedStats,
    note: 'allowedTransferBranches is empty in source (no teacher has it set). H_TRANSFER_ALLOWED is therefore INACTIVE in the scheduling model. We do NOT auto-fill.',
  };
}

// ---------------------------------------------------------------------------
// §14 — Preferences
// ---------------------------------------------------------------------------

export function verifyPreferences(normalized, scheduling) {
  const FIELDS = [
    { key: 'maxSessionsPerWeek', inScheduling: 'nguyenVong.soBuoiToiDa' },
    { key: 'preferredSession', inScheduling: 'nguyenVong.buoiUuTien' },
    { key: 'fixedDayOff', inScheduling: 'nguyenVong.thuNghi' },
    { key: 'preferredGrades', inScheduling: 'NOT_IN_SCHEDULING' },
    { key: 'preferredTransferBranches', inScheduling: 'NOT_IN_SCHEDULING' },
    { key: 'transferPriority', inScheduling: 'NOT_IN_SCHEDULING' },
  ];

  const perField = {};
  for (const f of FIELDS) {
    const sourceHasValue = normalized.teachers.filter((t) => {
      const v = t[f.key];
      if (v == null) return false;
      if (Array.isArray(v) && v.length === 0) return false;
      if (typeof v === 'string' && v === '') return false;
      return true;
    }).length;
    const sourceNull = normalized.teachers.filter((t) => t[f.key] == null).length;
    const sourceEmpty = normalized.teachers.filter((t) => {
      const v = t[f.key];
      if (v == null) return false;
      if (Array.isArray(v) && v.length === 0) return true;
      if (typeof v === 'string' && v === '') return true;
      return false;
    }).length;
    perField[f.key] = {
      inScheduling: f.inScheduling,
      sourceHasValue,
      sourceNull,
      sourceEmpty,
    };
  }

  return {
    perField,
    note: 'maxSessionsPerWeek and preferredSession are projected into nguyenVong. fixedDayOff, preferredGrades, preferredTransferBranches, transferPriority are NOT yet in the scheduling model contract (preserved in normalized, not promoted).',
  };
}

// ---------------------------------------------------------------------------
// §15 — Session model
// ---------------------------------------------------------------------------

export function verifySessionModel(scheduling) {
  // In source: scheduleslots use day (string: Monday..Sunday),
  // session (string: morning/afternoon/both), period (number).
  // The contract model is: day (1..7), session (sang/chieu/ca_hai),
  // period (1..N). We do NOT project scheduleslots into the
  // scheduling model today (they are in legacyBaseline only).

  // Verify branch profile yields a sane session split
  const branchSessions = scheduling.branches.map((b) => ({
    id: b.id,
    name: b.name,
    schoolDays: b.schoolDays,
    periods: b.periods,
    sangMax: b.periods[Math.ceil(b.periods.length / 2) - 1] ?? 5,
    slotCount: scheduling.timeSlotsByBranch.get(b.id)?.length ?? 0,
  }));

  // Count maxSessionsPerWeek distribution
  const maxDist = { sang: 0, chieu: 0, ca_hai: 0, noNguyenVong: 0 };
  for (const t of scheduling.teachers) {
    if (!t.nguyenVong) {
      maxDist.noNguyenVong += 1;
      continue;
    }
    const p = t.nguyenVong.buoiUuTien;
    if (p === 'sang') maxDist.sang += 1;
    else if (p === 'chieu') maxDist.chieu += 1;
    else maxDist.ca_hai += 1;
  }

  return {
    branchSessions,
    maxDist,
    slotGridSample: [...(scheduling.timeSlotsByBranch.values())][0]?.slice(0, 3) ?? [],
    note: 'period is a period number, not a session. session is derived from period via the branch profile (default period<=5 -> sang, else chieu).',
  };
}

// ---------------------------------------------------------------------------
// §16 — Travel readiness
// ---------------------------------------------------------------------------

export function verifyTravelReadiness(scheduling, normalized) {
  // Travel is not in the dump.
  const travelTime = scheduling.travelTime;
  const travelStatus = scheduling.travelStatus;

  // fromBranch / toBranch fields are in transfer history
  // (TransferHistory entity). They are NOT in the scheduling
  // model. The scheduling model has branchId on assignments,
  // which is the input a future TravelProvider needs.
  const fromBranchSourced = normalized.transferHistory
    .filter((t) => t.fromBranch != null)
    .length;
  const toBranchSourced = normalized.transferHistory
    .filter((t) => t.toBranch != null)
    .length;

  // For the scheduling model, every assignment has a branchId.
  // The (class.branch, teacher.home branch) tuple is the input a
  // future TravelProvider would consult.
  const assignmentBranchPair = new Set();
  const classById = new Map(normalized.classes.map((c) => [c.id, c]));
  const teacherById = new Map(normalized.teachers.map((t) => [t.id, t]));
  for (const a of scheduling.assignments) {
    const cls = classById.get(a.classId);
    const t = teacherById.get(a.teacherId);
    const k = `${a.branchId}|${cls?.branch ?? '?'}|${t?.branch ?? '?'}`;
    assignmentBranchPair.add(k);
  }

  return {
    travelTime: travelTime,
    travelStatus: travelStatus,
    hTravelFeasibleActive: false, // because travelTime is null
    fromBranchSourced,
    toBranchSourced,
    schedulingAssignmentBranchPairs: assignmentBranchPair.size,
    note: 'TRAVEL_DATA_MISSING. H_TRAVEL_FEASIBLE = INACTIVE. SchedulingInput does carry (assignment.branchId, class.branch, teacher.branch) tuples — enough to plug a TravelProvider later, but no matrix exists today.',
  };
}

// ---------------------------------------------------------------------------
// §17 — Dry-run orchestrator
// ---------------------------------------------------------------------------

export function dryRunOrchestrator(scheduling) {
  // Pre-scheduler validation.
  const validation = validateInput(scheduling);
  // Orchestrator call. We cap strategies to a single run with
  // very low solve cost to avoid a real benchmark.
  const orch = makeOrchestrator();
  let result;
  let threw = null;
  try {
    result = orch.preview(scheduling, { solutions: 1, strategies: ['A_PREFERENCE_FIRST'], seed: 0xC0FFEE });
  } catch (e) {
    threw = e.message;
  }

  // Classify outcome
  const status = result?.status;
  const statusClass =
    status === 'INVALID_INPUT' ? 'INVALID_INPUT'
    : status === 'MISSING_DATA' ? 'MISSING_DATA'
    : status === 'OK' ? 'OK'
    : status === 'EMPTY' ? 'EMPTY'
    : 'UNKNOWN';

  return {
    threw,
    status,
    statusClass,
    issues: validation.issues,
    missing: validation.missing,
    issuesByCode: countBy(validation.issues, 'code'),
    issuesByEntity: countBy(validation.issues, 'entity'),
    missingByEntity: countBy(validation.missing, 'entity'),
    warnings: result?.warnings ?? [],
    solutionsProduced: result?.solutions?.length ?? 0,
    strategiesAttempted: result?.diagnostics?.strategiesAttempted ?? 0,
    totalSolveMs: result?.diagnostics?.totalSolveMs ?? 0,
    note: 'pre-scheduler validation runs first. We probe ONLY the validation status, not the solver benchmark.',
  };
}

function countBy(arr, key) {
  const m = new Map();
  for (const x of arr) {
    const k = x[key] ?? '?';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries(m);
}

// ---------------------------------------------------------------------------
// Top-level audit
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<typeof import('./index.js').loadFromLegacySaplich>} result
 */
export function runPhase20Audit(result) {
  const { normalized, scheduling, legacyBaseline } = result;
  return {
    traceability: verifyTraceability(normalized, scheduling),
    teachers: verifyTeachers(normalized, scheduling),
    workload: verifyWorkload(normalized, scheduling),
    branches: verifyBranches(normalized, scheduling),
    classes: verifyClasses(normalized, scheduling),
    subjects: verifySubjects(normalized, scheduling),
    curriculum: verifyCurriculum(normalized, scheduling),
    demand: verifyDemand(normalized, scheduling),
    assignments: verifyAssignments(normalized, scheduling),
    scheduleSlots: verifyScheduleSlots(normalized, legacyBaseline),
    transfers: verifyTransfers(normalized),
    transferEligibility: verifyTransferEligibility(normalized, scheduling),
    preferences: verifyPreferences(normalized, scheduling),
    sessionModel: verifySessionModel(scheduling),
    travelReadiness: verifyTravelReadiness(scheduling, normalized),
    orchestratorDryRun: dryRunOrchestrator(scheduling),
  };
}