import { Router } from 'express';
import { loadFromLegacySaplich } from '../loader/legacy-saplich/index.js';
import { defaultTeacherPreferenceStore } from '../persistence/teacher-preference-store.js';
import { config } from '../config/index.js';

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
    preferredTransferBranchIds: saved?.preferredTransferBranchIds ?? teacher.preferredTransferBranches ?? [],
  };
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
    preference: pref,
  };
}

export function createCatalogRouter({ preferenceStore = defaultTeacherPreferenceStore(config.persistenceDir) } = {}) {
  const router = Router();
  const data = () => loadFromLegacySaplich().normalized;
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
      if (keys.length === 0 || errors.length > 0) {
        return res.status(400).json({ ok: false, errors: errors.length ? errors : [{ field: 'preference', code: 'EMPTY_PREFERENCE', message: 'Provide at least one preference field.' }] });
      }
      // Old saved preferences can outlive a branch rename/removal. Drop those
      // stale ids instead of rejecting the entire otherwise-valid form.
      const validBranchIds = new Set(d.branches.map((branch) => branch.id));
      const savedBody = normalizedBody.preferredTransferBranchIds
        ? { ...normalizedBody, preferredTransferBranchIds: normalizedBody.preferredTransferBranchIds.filter((id) => validBranchIds.has(id)) }
        : normalizedBody;
      const preference = await preferenceStore.put(t.id, { ...preferenceFor(t, preferenceStore), ...savedBody });
      return res.json({ ok: true, preference, supportedFields: [...ALLOWED_PREFERENCE_FIELDS] });
    } catch (error) { return next(error); }
  });
  router.get('/subjects', (_req, res) => { const d = data(); res.json({ ok: true, subjects: d.subjects }); });
  router.get('/classes', (_req, res) => {
    const d = data(); const blocks = new Map(d.blocks.map((b) => [b.id, b])); const subjects = new Map(d.subjects.map((s) => [s.id, s]));
    res.json({ ok: true, classes: d.classes.map((c) => ({ ...c, block: blocks.get(c.block) ?? null, curriculum: d.curriculum.filter((x) => x.block === c.block).map((x) => ({ ...x, subject: subjects.get(x.subject) ?? null })) })) });
  });
  router.get('/classes/:classId', (req, res) => { const d = data(); const c = byId(d.classes, req.params.classId); if (!c) return res.status(404).json({ ok:false, errors:[{field:'classId',code:'NOT_FOUND',message:'Class not found.'}] }); const subjects = new Map(d.subjects.map((s)=>[s.id,s])); return res.json({ok:true, class:{...c, curriculum:d.curriculum.filter((x)=>x.block===c.block).map((x)=>({...x,subject:subjects.get(x.subject)??null}))}}); });
  router.get('/branches', (_req, res) => { const d=data(); res.json({ok:true, branches:d.branches.map((b)=>({...b,classCount:d.classes.filter((c)=>c.branch===b.id).length,homeTeacherCount:d.teachers.filter((t)=>t.branch===b.id).length}))}); });
  router.get('/branches/:branchId', (_req, res) => { const d=data(); const b=byId(d.branches, _req.params.branchId); if(!b) return res.status(404).json({ok:false,errors:[{field:'branchId',code:'NOT_FOUND',message:'Branch not found.'}]}); return res.json({ok:true,branch:{...b,classes:d.classes.filter((c)=>c.branch===b.id),teachers:d.teachers.filter((t)=>t.branch===b.id).map((t)=>teacherDto(t,d,preferenceStore))}}); });
  router.get('/dashboard', (_req,res) => { const d=data(); res.json({ok:true,counts:{branches:d.branches.length,classes:d.classes.length,activeTeachers:d.teachers.filter((x)=>x.isActive).length,activeSubjects:d.subjects.filter((x)=>x.isActive).length,assignments:d.historicalAssignments.length,requiredPeriods:d.historicalAssignments.reduce((n,x)=>n+x.requiredPeriods,0)}}); });
  return router;
}
