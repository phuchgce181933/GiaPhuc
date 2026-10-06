import { randomUUID } from 'node:crypto';
import { loadFromLegacySaplich, buildSchedulingModel } from '../../loader/legacy-saplich/index.js';
import { isEligibleFor } from '../../domain/eligibility.js';
import { defaultCatalogStore } from './catalog.store.js';

const TYPES = new Set(['teachers','subjects','classes']);
const FIELDS = {
  teachers: new Set(['code','name','email','phone','homeBranchId','specializationIds','isActive','capacityPeriodsPerWeek']),
  subjects: new Set(['code','name','description','isActive']),
  classes: new Set(['code','name','branchId','blockId','homeroomTeacherId','isActive']),
};

export class CatalogError extends Error {
  constructor(status, field, code, message) { super(message); this.status = status; this.errors = [{ field, code, message }]; }
}
const fail = (status, field, code, message) => { throw new CatalogError(status, field, code, message); };

function mergeRows(source, changes) {
  const rows = new Map(source.map((row) => [row.id, row]));
  for (const [id, row] of Object.entries(changes)) {
    if (row === null) rows.delete(id);
    else if (row && row.id === id) rows.set(id, { ...rows.get(id), ...row });
    else throw new Error('Invalid catalog record.');
  }
  return [...rows.values()];
}

function currentData(source, state) {
  return { ...source, ...Object.fromEntries([...TYPES].map((type) => [type, mergeRows(source[type], state[type])])) };
}

// Catalog reads and schedule generation consume the same effective roster.
export function loadCatalogData({ store = defaultCatalogStore(), source = loadFromLegacySaplich() } = {}) {
  const state = store.read();
  const normalized = currentData(source.normalized, state);
  const changed = [...TYPES].some((type) => Object.keys(state[type]).length > 0);
  if (!changed) return { ...source, normalized, catalogRevision: state.revision };
  const scheduling = buildSchedulingModel({ ...normalized, classes: normalized.classes.filter((row) => row.isActive) });
  const oldByPair = new Map();
  for (const assignment of source.scheduling.assignments) {
    const key = JSON.stringify([assignment.classId, assignment.subjectId]);
    oldByPair.set(key, [...(oldByPair.get(key) ?? []), assignment]);
  }
  const assignments = [];
  for (const demand of scheduling.curriculum) {
    const originals = oldByPair.get(JSON.stringify([demand.classId, demand.subjectId])) ?? [];
    const rows = originals.reduce((sum, row) => sum + row.requiredPeriods, 0) === demand.requiredPeriods ? originals
      : [{ id: `catalog-demand-${demand.classId}-${demand.subjectId}`, requiredPeriods: demand.requiredPeriods, teacherId: originals[0]?.teacherId }];
    const branchId = scheduling.classes.find((row) => row.id === demand.classId).branchId;
    for (const row of rows) {
      const teacher = scheduling.teacherIndex.get(row.teacherId);
      const teacherId = teacher && isEligibleFor(teacher, demand.subjectId) ? teacher.id : null;
      assignments.push({ ...row, classId: demand.classId, subjectId: demand.subjectId, branchId,
        teacherId, baselineAssignment: true, requiresTeacherAssignment: teacherId === null });
    }
  }
  scheduling.assignments = assignments;
  scheduling.assignmentIndex = new Map(assignments.map((row) => [row.id, row]));
  return { ...source, normalized, scheduling, catalogRevision: state.revision };
}

function validate(type, body, data, existing) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length) fail(400, 'body', 'INVALID_BODY', 'Cần cung cấp dữ liệu để lưu.');
  for (const key of Object.keys(body)) if (!FIELDS[type].has(key)) fail(400, key, 'UNKNOWN_FIELD', `Trường không được hỗ trợ: ${key}.`);
  if (type === 'teachers' && existing && Object.hasOwn(body, 'homeBranchId') && body.homeBranchId !== existing.branch) {
    fail(400, 'homeBranchId', 'HOME_BRANCH_IMMUTABLE', 'Phân hiệu chính cố định, không được thay đổi sau khi tạo giáo viên.');
  }
  const row = { ...existing };
  for (const key of ['code','name','email','phone','description']) if (Object.hasOwn(body, key)) {
    if (typeof body[key] !== 'string' || body[key].length > (key === 'description' ? 2000 : 200)) fail(400, key, 'INVALID_VALUE', 'Giá trị phải là văn bản hợp lệ.');
    row[key] = body[key].trim();
  }
  if (!row.name) fail(400, 'name', 'REQUIRED', 'Tên không được để trống.');
  if (Object.hasOwn(body, 'isActive')) {
    if (typeof body.isActive !== 'boolean') fail(400, 'isActive', 'INVALID_VALUE', 'Trạng thái phải là true hoặc false.');
    row.isActive = body.isActive;
  }
  row.isActive ??= true;
  const reference = (field, records, target, required = true) => {
    const value = Object.hasOwn(body, field) ? body[field] : row[target];
    if (!value && !required) { row[target] = null; return; }
    if (typeof value !== 'string' || !records.some((record) => record.id === value)) fail(400, field, 'INVALID_REFERENCE', 'Giá trị được chọn không tồn tại.');
    row[target] = value;
  };
  if (type === 'teachers') {
    reference('homeBranchId', data.branches, 'branch', !existing || existing.branch != null);
    if (row.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) fail(400, 'email', 'INVALID_VALUE', 'Email không hợp lệ.');
    const ids = Object.hasOwn(body,'specializationIds') ? body.specializationIds : row.specializations;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => !data.subjects.some((subject) => subject.id === id))) fail(400, 'specializationIds', 'INVALID_REFERENCE', 'Chọn ít nhất một môn chuyên môn hợp lệ.');
    row.specializations = [...new Set(ids)];
    if (Object.hasOwn(body,'capacityPeriodsPerWeek')) {
      const capacity = body.capacityPeriodsPerWeek;
      if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) fail(400,'capacityPeriodsPerWeek','INVALID_VALUE','Giới hạn tiết/tuần phải là số nguyên không âm hoặc để trống.');
      row.capacityPeriodsPerWeek = capacity;
    }
  }
  if (type === 'classes') {
    reference('branchId', data.branches, 'branch');
    reference('blockId', data.blocks, 'block');
    reference('homeroomTeacherId', data.teachers, 'homeroomTeacher', false);
  }
  if (row.code && data[type].some((item) => item.id !== existing?.id && item.code?.toLowerCase() === row.code.toLowerCase())) fail(409, 'code', 'DUPLICATE_CODE', 'Mã đã được sử dụng.');
  if (type !== 'teachers' && data[type].some((item) => item.id !== existing?.id && item.name.trim().toLowerCase() === row.name.toLowerCase()
    && (type !== 'classes' || item.branch === row.branch))) fail(409, 'name', 'DUPLICATE_NAME', 'Tên đã được sử dụng.');
  return row;
}

export function catalogUsage(type, id, data) {
  if (type === 'teachers') return data.historicalAssignments.filter((row) => row.teacher === id).length + data.classes.filter((row) => row.homeroomTeacher === id).length;
  if (type === 'subjects') return data.curriculum.filter((row) => row.subject === id).length + data.teachers.filter((row) => row.specializations.includes(id)).length;
  return data.historicalAssignments.filter((row) => row.class === id).length;
}

export function saveCatalogRecord(type, id, body, { store = defaultCatalogStore() } = {}) {
  if (!TYPES.has(type)) fail(404, 'type', 'NOT_FOUND', 'Danh mục không tồn tại.');
  return store.update((state) => {
    const data = currentData(loadFromLegacySaplich().normalized, state);
    const existing = id ? data[type].find((row) => row.id === id) : null;
    if (id && !existing) fail(404, 'id', 'NOT_FOUND', 'Bản ghi không tồn tại.');
    const row = validate(type, body, data, existing);
    const now = new Date().toISOString();
    Object.assign(row, { id: id ?? randomUUID(), createdAt: existing?.createdAt ?? now, updatedAt: now, source: 'operator' });
    if (type === 'teachers' && !existing) Object.assign(row, { email: row.email ?? '', phone: row.phone ?? '', allowedTransferBranches: [], preferredTransferBranches: [], standardWorkload: null, partTimeWorkload: null, teachingWorkload: null, capacityPeriodsPerWeek: row.capacityPeriodsPerWeek ?? null });
    state[type][row.id] = row;
    return row;
  });
}

export function deleteCatalogRecord(type, id, { store = defaultCatalogStore() } = {}) {
  if (!TYPES.has(type)) fail(404, 'type', 'NOT_FOUND', 'Danh mục không tồn tại.');
  return store.update((state) => {
    const source = loadFromLegacySaplich().normalized;
    const data = currentData(source, state);
    if (!data[type].some((row) => row.id === id)) fail(404, 'id', 'NOT_FOUND', 'Bản ghi không tồn tại.');
    if (catalogUsage(type, id, data) > 0) fail(409, 'id', 'RECORD_IN_USE', 'Bản ghi đang được sử dụng. Hãy chuyển trạng thái sang ngừng sử dụng thay vì xóa.');
    if (source[type].some((row) => row.id === id)) state[type][id] = null;
    else delete state[type][id];
    return { id };
  });
}
