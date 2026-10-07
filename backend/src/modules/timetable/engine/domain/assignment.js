// Effective decisions are authoritative; source assignments describe demand.
// Keep this leaf independent of constraints, scoring and solver state.
function asMap(value) {
  return value instanceof Map ? value : new Map(Array.isArray(value) ? value : []);
}

function normalizeSubjectLabel(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function classSubjectTeacherKey(classId, subjectId, input = {}) {
  const subject = input.subjects?.find?.((row) => row.id === subjectId);
  const labels = [subjectId, subject?.name, subject?.tenMon, subject?.code].map(normalizeSubjectLabel);
  const technology = labels.some((label) => ['congnghe', 'technology', 'cn'].includes(label));
  const informatics = labels.some((label) => ['tinhoc', 'informatics', 'computerscience', 'th'].includes(label));
  const subjectGroup = technology || informatics ? 'technology-informatics' : subjectId;
  return JSON.stringify([classId, subjectGroup]);
}

export function candidateAssignments(candidate) {
  return asMap(candidate?.assignments ?? candidate?.slots);
}

export function effectiveAssignmentMeta(candidate, assignmentId, input = {}) {
  const source = input.assignmentIndex?.get?.(assignmentId)
    ?? input.assignments?.find?.((assignment) => assignment.id === assignmentId);
  const slots = candidateAssignments(candidate).get(assignmentId) ?? [];
  const placement = asMap(candidate?.placements).get(assignmentId);
  if (!source && !placement && slots.length === 0) return null;
  return {
    ...source,
    id: assignmentId,
    classId: source?.classId ?? null,
    subjectId: source?.subjectId ?? null,
    teacherId: placement?.teacherId ?? slots[0]?.teacherId ?? source?.teacherId ?? null,
    branchId: placement?.branchId ?? slots[0]?.branchId ?? source?.branchId ?? null,
    slots,
  };
}

export function withEffectiveMeta(candidate, input) {
  const index = input.assignmentIndex ?? new Map((input.assignments ?? []).map((assignment) => [assignment.id, assignment]));
  return {
    ...input,
    assignmentIndex: new Map([...index].map(([id, source]) => [id, {
      ...source,
      ...effectiveAssignmentMeta(candidate, id, input),
    }])),
  };
}

export function effectiveTeacherSlots(candidate, input = {}) {
  const byTeacher = new Map();
  for (const [assignmentId, slots] of candidateAssignments(candidate)) {
    const meta = effectiveAssignmentMeta(candidate, assignmentId, input);
    if (!meta?.teacherId) continue;
    const teacherSlots = byTeacher.get(meta.teacherId) ?? [];
    for (const slot of slots) teacherSlots.push({ ...slot, teacherId: meta.teacherId, classId: meta.classId, subjectId: meta.subjectId });
    byTeacher.set(meta.teacherId, teacherSlots);
  }
  return byTeacher;
}

// Compare demand by logical (class, subject), independently of assignment ids.
export function curriculumCoverage(input, candidate = null) {
  if (!input.curriculum?.length) return [];
  const pairs = new Map();
  const pairOf = (classId, subjectId) => {
    const key = JSON.stringify([classId, subjectId]);
    if (!pairs.has(key)) pairs.set(key, { classId, subjectId, requiredPeriods: 0, assignedPeriods: 0 });
    return pairs.get(key);
  };
  for (const row of input.curriculum) {
    if (row.classId && row.subjectId && Number.isFinite(row.requiredPeriods)) pairOf(row.classId, row.subjectId).requiredPeriods += row.requiredPeriods;
  }
  if (candidate) {
    for (const [id, slots] of candidateAssignments(candidate)) {
      const meta = effectiveAssignmentMeta(candidate, id, input);
      if (meta?.classId && meta.subjectId) pairOf(meta.classId, meta.subjectId).assignedPeriods += slots.length;
    }
  } else {
    for (const row of input.assignments ?? []) {
      if (row.classId && row.subjectId && Number.isFinite(row.requiredPeriods)) pairOf(row.classId, row.subjectId).assignedPeriods += row.requiredPeriods;
    }
  }
  return [...pairs.values()].filter((pair) => pair.requiredPeriods !== pair.assignedPeriods);
}
