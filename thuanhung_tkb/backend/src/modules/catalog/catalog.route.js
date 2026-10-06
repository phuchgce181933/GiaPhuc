import { Router } from 'express';
import { defaultTeacherPreferenceStore } from '../../persistence/teacher-preference-store.js';
import { config } from '../../config/index.js';
import { loadCatalogData, saveCatalogRecord, deleteCatalogRecord, catalogUsage } from './catalog.service.js';
import { defaultCatalogStore } from './catalog.store.js';

const ALLOWED_PREFERENCE_FIELDS = new Set(['preferredSession', 'desiredTeachingSessionsPerWeek', 'preferredOffDay', 'preferredOffPart', 'preferredTransferBranchIds']);
const SESSION_ALIASES = new Map([
  ['morning', 'morning'], ['afternoon', 'afternoon'], ['both', 'both'],
  ['sang', 'morning'], ['chieu', 'afternoon'], ['ca_hai', 'both'],
]);
const DAYS = new Set(['NONE', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY']);
const OFF_PARTS = new Set(['NONE', 'MORNING', 'AFTERNOON', 'FULL_DAY']);
const byId = (items, id) => items.find((item) => item.id === id);
const normalizeSession = (value) => SESSION_ALIASES.get(value) ?? 'both';

function preferenceFor(teacher, store) {
  const saved = store.get(teacher.id);
  return {
    preferredSession: normalizeSession(saved?.preferredSession ?? teacher.preferredSession),
    desiredTeachingSessionsPerWeek: saved?.desiredTeachingSessionsPerWeek ?? null,
    preferredOffDay: saved?.preferredOffDay ?? 'NONE',
    preferredOffPart: saved?.preferredOffPart ?? 'NONE',
    preferredTransferBranchIds: [...new Set(saved?.preferredTransferBranchIds ?? teacher.preferredTransferBranches ?? [])]
      .filter((branchId) => branchId !== teacher.branch),
  };
}

function preferenceConfiguration(teacher, store) {
  const saved = store.get(teacher.id);
  const fields = saved?._configuredFields ?? Object.keys(saved ?? {}).filter((field) => ALLOWED_PREFERENCE_FIELDS.has(field));
  const configuredFields = fields.filter((field) => {
    const value = saved[field];
    if (field === 'preferredSession') return value != null && normalizeSession(value) !== 'both';
    if (field === 'desiredTeachingSessionsPerWeek') return value != null;
    if (field === 'preferredTransferBranchIds') return value?.some((branchId) => branchId !== teacher.branch) ?? false;
    return value != null && value !== 'NONE';
  });
  return { source: saved ? 'OPERATOR_OVERLAY' : 'LEGACY', configuredFields, configuredCount: configuredFields.length };
}

function teacherDto(t, data, store) {
  const subjects = new Map(data.subjects.map((s) => [s.id, s]));
  const branch = byId(data.branches, t.branch);
  const pref = preferenceFor(t, store);
  return {
    id: t.id, code: t.code, name: t.name, email: t.email, phone: t.phone,
    homeBranchId: t.branch, homeBranchName: branch?.name ?? null, isActive: t.isActive,
    specializations: t.specializations.map((id) => ({ id, name: subjects.get(id)?.name ?? id })),
    workload: { standard: t.standardWorkload, partTime: t.partTimeWorkload, teaching: t.teachingWorkload },
    capacityPeriodsPerWeek:t.capacityPeriodsPerWeek ?? null,
    preference: pref,
    preferenceConfiguration: preferenceConfiguration(t, store),
    canDelete: catalogUsage('teachers', t.id, data) === 0,
  };
}

function classDto(row, data) {
  return { ...row, blockId:row.block, branchId:row.branch, block:byId(data.blocks,row.block) ?? null,
    canDelete:catalogUsage('classes',row.id,data) === 0,
    curriculum:data.curriculum.filter((item) => item.block === row.block).map((item) => ({ ...item,subject:byId(data.subjects,item.subject) ?? null })) };
}

export function createCatalogRouter({ preferenceStore = defaultTeacherPreferenceStore(config.persistenceDir), catalogStore = defaultCatalogStore() } = {}) {
  const router = Router();
  const data = () => loadCatalogData({ store: catalogStore }).normalized;
  for (const type of ['teachers','subjects','classes']) {
    const resource = type === 'teachers' ? 'teacher' : type === 'subjects' ? 'subject' : 'class';
    router.post(`/${type}`, async (req, res, next) => {
      try { const row = await saveCatalogRecord(type, null, req.body, { store: catalogStore });
        const d = data(); return res.status(201).json({ ok: true, [resource]: type === 'teachers' ? teacherDto(row, d, preferenceStore) : row });
      } catch (error) { return next(error); }
    });
    router.patch(`/${type}/:id`, async (req, res, next) => {
      try { const row = await saveCatalogRecord(type, req.params.id, req.body, { store: catalogStore });
        const d = data(); return res.json({ ok: true, [resource]: type === 'teachers' ? teacherDto(row, d, preferenceStore) : row });
      } catch (error) { return next(error); }
    });
    router.delete(`/${type}/:id`, async (req, res, next) => {
      try { await deleteCatalogRecord(type, req.params.id, { store: catalogStore }); return res.json({ ok: true, deleted: true, id: req.params.id }); }
      catch (error) { return next(error); }
    });
  }
  router.get('/blocks', (_req, res) => res.json({ ok: true, blocks: data().blocks }));
  router.get('/subjects/:id', (req, res) => {
    const d = data(); const row = byId(d.subjects, req.params.id);
    if (!row) return res.status(404).json({ ok:false, errors:[{field:'id',code:'NOT_FOUND',message:'Môn học không tồn tại.'}] });
    return res.json({ ok: true, subject: { ...row, canDelete: catalogUsage('subjects', row.id, d) === 0 } });
  });
  router.get('/teachers', (_req, res) => {
    const d = data(); res.json({ ok: true, teachers: d.teachers.map((t) => teacherDto(t, d, preferenceStore)) });
  });
  router.get('/teachers/:teacherId', (req, res) => {
    const d = data(); const t = byId(d.teachers, req.params.teacherId);
    if (!t) return res.status(404).json({ ok: false, errors: [{ field: 'teacherId', code: 'NOT_FOUND', message: 'Teacher not found.' }] });
    return res.json({ ok: true, teacher: teacherDto(t, d, preferenceStore) });
  });
  router.get('/teachers/:teacherId/preferences', (req, res) => {
    const d = data(); const t = byId(d.teachers, req.params.teacherId);
    if (!t) return res.status(404).json({ ok: false, errors: [{ field: 'teacherId', code: 'NOT_FOUND', message: 'Teacher not found.' }] });
      return res.json({ ok: true, preference: preferenceFor(t, preferenceStore), supportedFields: [...ALLOWED_PREFERENCE_FIELDS] });
  });
  router.put('/teachers/:teacherId/preferences', async (req, res, next) => {
    try {
      const d = data(); const t = byId(d.teachers, req.params.teacherId);
      if (!t) return res.status(404).json({ ok: false, errors: [{ field: 'teacherId', code: 'NOT_FOUND', message: 'Teacher not found.' }] });
      const body = req.body ?? {}; const keys = Object.keys(body);
      const normalizedBody = { ...body };
      if (Object.hasOwn(body, 'preferredSession')) normalizedBody.preferredSession = normalizeSession(body.preferredSession);
      const errors = [];
      for (const key of keys) if (!ALLOWED_PREFERENCE_FIELDS.has(key)) errors.push({ field: key, code: 'UNKNOWN_FIELD', message: `Unsupported preference field: ${key}.` });
      if (body.preferredSession != null && !SESSION_ALIASES.has(body.preferredSession)) errors.push({ field: 'preferredSession', code: 'INVALID_VALUE', message: 'Preferred session must be morning, afternoon, both, sang, chieu, or ca_hai.' });
      if (body.desiredTeachingSessionsPerWeek != null && (!Number.isInteger(body.desiredTeachingSessionsPerWeek) || body.desiredTeachingSessionsPerWeek < 0 || body.desiredTeachingSessionsPerWeek > 15)) errors.push({ field: 'desiredTeachingSessionsPerWeek', code: 'INVALID_VALUE', message: 'Desired sessions must be a whole number from 0 to 15.' });
      if (body.preferredOffDay != null && !DAYS.has(body.preferredOffDay)) errors.push({ field: 'preferredOffDay', code: 'INVALID_VALUE', message: 'Preferred off day is not supported.' });
      if (body.preferredOffPart != null && !OFF_PARTS.has(body.preferredOffPart)) errors.push({ field: 'preferredOffPart', code: 'INVALID_VALUE', message: 'Preferred off part is not supported.' });
      if (body.preferredTransferBranchIds != null && !Array.isArray(body.preferredTransferBranchIds)) errors.push({ field: 'preferredTransferBranchIds', code: 'INVALID_VALUE', message: 'Preferred transfer branches must be an array.' });
      if (Array.isArray(body.preferredTransferBranchIds) && body.preferredTransferBranchIds.includes(t.branch)) errors.push({ field: 'preferredTransferBranchIds', code: 'HOME_BRANCH_NOT_TRANSFER', message: 'Phân hiệu chính cố định theo hồ sơ. Chỉ chọn nguyện vọng điều chuyển đến phân hiệu khác.' });
      if (keys.length === 0 || errors.length > 0) {
        return res.status(400).json({ ok: false, errors: errors.length ? errors : [{ field: 'preference', code: 'EMPTY_PREFERENCE', message: 'Provide at least one preference field.' }] });
      }
      // Old saved preferences can outlive a branch rename/removal. Drop those
      // stale ids instead of rejecting the entire otherwise-valid form.
      const validBranchIds = new Set(d.branches.map((branch) => branch.id));
      const savedBody = normalizedBody.preferredTransferBranchIds
        ? { ...normalizedBody, preferredTransferBranchIds: [...new Set(normalizedBody.preferredTransferBranchIds.filter((id) => validBranchIds.has(id) && id !== t.branch))] }
        : normalizedBody;
      const previous = preferenceStore.get(t.id);
      const configuredFields = [...new Set([...(previous?._configuredFields ?? Object.keys(previous ?? {}).filter((field) => ALLOWED_PREFERENCE_FIELDS.has(field))), ...keys])];
      await preferenceStore.put(t.id, { ...preferenceFor(t, preferenceStore), ...savedBody, _configuredFields: configuredFields });
      return res.json({ ok: true, preference: preferenceFor(t, preferenceStore), preferenceConfiguration: preferenceConfiguration(t, preferenceStore), supportedFields: [...ALLOWED_PREFERENCE_FIELDS] });
    } catch (error) { return next(error); }
  });
  router.get('/subjects', (_req, res) => { const d = data(); res.json({ ok: true, subjects: d.subjects.map((row) => ({ ...row, canDelete: catalogUsage('subjects', row.id, d) === 0 })) }); });
  router.get('/classes', (_req, res) => {
    const d = data(); res.json({ ok:true,classes:d.classes.map((row) => classDto(row,d)) });
  });
  router.get('/classes/:classId', (req, res) => { const d=data(); const c=byId(d.classes,req.params.classId); if(!c) return res.status(404).json({ok:false,errors:[{field:'classId',code:'NOT_FOUND',message:'Class not found.'}]}); return res.json({ok:true,class:classDto(c,d)}); });
  router.get('/branches', (_req, res) => { const d=data(); res.json({ok:true, branches:d.branches.map((b)=>({...b,classCount:d.classes.filter((c)=>c.branch===b.id).length,homeTeacherCount:d.teachers.filter((t)=>t.branch===b.id).length}))}); });
  router.get('/branches/:branchId', (_req, res) => { const d=data(); const b=byId(d.branches, _req.params.branchId); if(!b) return res.status(404).json({ok:false,errors:[{field:'branchId',code:'NOT_FOUND',message:'Branch not found.'}]}); return res.json({ok:true,branch:{...b,classes:d.classes.filter((c)=>c.branch===b.id),teachers:d.teachers.filter((t)=>t.branch===b.id).map((t)=>teacherDto(t,d,preferenceStore))}}); });
  router.get('/dashboard', (_req,res) => { const loaded=loadCatalogData({store:catalogStore}); const d=loaded.normalized; res.json({ok:true,counts:{branches:d.branches.length,classes:d.classes.length,activeTeachers:d.teachers.filter((x)=>x.isActive).length,activeSubjects:d.subjects.filter((x)=>x.isActive).length,assignments:loaded.scheduling.assignments.length,requiredPeriods:loaded.scheduling.assignments.reduce((n,x)=>n+x.requiredPeriods,0)}}); });
  router.use((error, _req, res, _next) => res.status(error.status ?? 500).json({ ok: false,
    errors: error.errors ?? [{ field:'catalog', code:'CATALOG_UNAVAILABLE', message:'Không thể đọc hoặc lưu danh mục. Dữ liệu chưa được ghi nhận.' }] }));
  return router;
}
