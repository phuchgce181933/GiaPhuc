'use strict';
const { fold } = require('./intent-parser.service');
const { describeChange, audit } = require('./change-audit.service');
const failure = (message, status = 422, code = 'ADJUSTMENT_REJECTED') => Object.assign(new Error(message), { status, code });
const sameTime = (a, b) => a.day === b.day && a.session === b.session && a.period === b.period;
function candidateFromRows(rows) {
  const assignments = new Map(); const placements = new Map();
  for (const row of rows) {
    const previous = placements.get(row.assignmentId);
    if (previous && (previous.teacherId !== row.teacherId || previous.branchId !== row.branchId)) throw failure('Phân công có dữ liệu giáo viên/phân hiệu không nhất quán.');
    const slots = assignments.get(row.assignmentId) ?? [];
    slots.push({ day: row.day, period: row.period, session: row.session, branchId: row.branchId }); assignments.set(row.assignmentId, slots);
    placements.set(row.assignmentId, { teacherId: row.teacherId, branchId: row.branchId });
  }
  return { assignments, placements };
}
async function validateRows(rows, input) {
  const [{ evaluateCandidate }, { buildScheduleRows, compareRows }] = await Promise.all([import('../engine/domain/constraints/index.js'), import('../engine/persistence/schedule-record.js')]);
  const candidate = candidateFromRows(rows);
  const rebuilt = buildScheduleRows(candidate, input);
  if (rebuilt.warnings.length || !compareRows(rows, rebuilt.rows).equal) throw failure('Danh mục hiện tại không còn khớp với phiên bản lịch này. Hãy tạo lại TKB từ danh mục mới.', 409, 'CATALOG_CHANGED');
  return evaluateCandidate(candidate, input);
}
function teacherFor(intent, input) {
  const query = fold(intent.teacher).replace(/^(co|thay|gv)\s+/, '');
  const teachers = input.teachers ?? [];
  const label = (row) => row.name ?? row.hoTen ?? row.fullName ?? row.ten ?? '';
  const exact = teachers.filter((row) => fold(label(row)).replace(/^(co|thay)\s+/, '') === query);
  const matches = exact.length ? exact : teachers.filter((row) => fold(label(row)).includes(query));
  if (matches.length !== 1) {
    const names = matches.map(label).filter(Boolean);
    const error = failure(names.length ? `Có ${names.length} giáo viên khớp “${intent.teacher}”: ${names.join(', ')}. Vui lòng nhập họ tên đầy đủ để xác định đúng giáo viên.` : `Không tìm thấy giáo viên “${intent.teacher}”.`, 422, names.length ? 'TEACHER_AMBIGUOUS' : 'TEACHER_NOT_FOUND');
    const branches = input.branches ?? [];
    error.details = { matches: matches.map((row) => {
      const homeBranchId = row.homeBranchId ?? row.branch ?? null;
      return { name: label(row), homeBranchName: branches.find((branch) => branch.id === homeBranchId)?.name ?? null };
    }) };
    throw error;
  }
  return matches[0];
}
function engineTime(location, branch) {
  const periods = branch?.sessions?.[location.session] ?? (location.session === 'sang' ? [1, 2, 3, 4] : [5, 6, 7, 8]);
  const period = periods[location.period - 1];
  if (period == null) throw failure('Tiết yêu cầu không có trong buổi học của phân hiệu này.');
  return { day: location.day - 1, session: location.session, period: Number(period) };
}
function humanTime(row, input) {
  const branch = input.branches.find((item) => item.id === row.branchId);
  const periods = branch?.sessions?.[row.session] ?? (row.session === 'sang' ? [1, 2, 3, 4] : [5, 6, 7, 8]);
  return { day: row.day + 1, session: row.session, period: periods.map(Number).indexOf(row.period) + 1 };
}
async function createPlan({ original, intent, input }) {
  if (intent.kind === 'day' || intent.kind === 'many') {
    const { createBatchPlan } = require('./repair-batch.service');
    return createBatchPlan({ original, intent, input, teacherFor, engineTime, humanTime, validateRows });
  }
  const teacher = teacherFor(intent, input);
  const sources = original.slots.map((row, index) => ({ row, index })).filter(({ row }) => {
    if (row.teacherId !== teacher.id) return false;
    try { return sameTime(row, engineTime(intent.from, input.branches.find((item) => item.id === row.branchId))); } catch { return false; }
  });
  if (sources.length !== 1) {
    const sourceText = `thứ ${intent.from.day}, ${intent.from.session === 'chieu' ? 'chiều' : 'sáng'} tiết ${intent.from.period}`;
    throw failure(sources.length === 0
      ? `${teacher.name ?? teacher.hoTen ?? intent.teacher} không có lịch dạy tại ${sourceText} trong phiên bản đã chọn, nên không có tiết để chuyển.`
      : `Có nhiều tiết của ${teacher.name ?? teacher.hoTen ?? intent.teacher} tại ${sourceText}. Hãy chỉ rõ lớp hoặc môn học.`, 422, 'SOURCE_SLOT_NOT_FOUND');
  }
  const { row: source, index: sourceIndex } = sources[0];
  const branch = input.branches.find((item) => item.id === source.branchId);
  const target = engineTime(intent.to, branch);
  if (sameTime(source, target)) throw failure('Khung giờ đích trùng với khung giờ nguồn.');
  const baseline = await validateRows(original.slots, input);
  if (!baseline.summary.accepted) throw failure('TKB nguồn không còn hợp lệ theo quy tắc hiện tại. Cần xử lý lịch nguồn trước khi điều chỉnh.', 409, 'SOURCE_INVALID');
  const direct = original.slots.map((row, index) => index === sourceIndex ? { ...row, ...target } : { ...row });
  let rows = direct;
  let evaluation = await validateRows(rows, input);
  if (!evaluation.summary.accepted) {
    const blockers = original.slots.map((row, index) => ({ row, index })).filter(({ row, index }) => index !== sourceIndex && sameTime(row, target) && (row.classId === source.classId || row.teacherId === source.teacherId));
    if (blockers.length && blockers.length <= 2) {
      const swapped = direct.map((row, index) => blockers.some((item) => item.index === index) ? { ...row, day: source.day, session: source.session, period: source.period } : row);
      const checked = await validateRows(swapped, input);
      if (checked.summary.accepted) { rows = swapped; evaluation = checked; }
    }
    if (!evaluation.summary.accepted && blockers.length === 1) {
      const blocker = blockers[0];
      const slots = input.timeSlotsByBranch.get(blocker.row.branchId) ?? [];
      const { sessionForSlot } = await import('../engine/domain/time.js');
      for (const slot of slots.slice(0, 50)) {
        const proposed = direct.map((row, index) => index === blocker.index ? { ...row, day: slot.day, period: slot.period, session: sessionForSlot(slot, input.branches.find((b) => b.id === row.branchId)) } : row);
        const checked = await validateRows(proposed, input);
        if (checked.summary.accepted) { rows = proposed; evaluation = checked; break; }
      }
    }
  }
  const changed = rows.map((row, index) => ({ before: original.slots[index], after: row })).filter(({ before, after }) => !sameTime(before, after));
  const changes = changed.map(({ before, after }) => ({ ...describeChange(before, after, original.directory), from: humanTime(before, input), to: humanTime(after, input), assignmentId: after.assignmentId, branchId: after.branchId }));
  const issues = evaluation.hard.violations.map((v) => ({ code: v.constraintId ?? v.code ?? 'RULE_VIOLATION', message: v.message }));
  const { contentHash } = await import('../engine/persistence/schedule-record.js');
  return { scheduleId: original.scheduleId, sourceVersion: original.version, originalHash: contentHash(original.slots), candidateHash: contentHash(rows), intent, rows, changes, issues, repaired: changes.length > 1, evaluation,
    audit: audit({ original, changes: changed.map(({ after }) => after), evaluation, travelAvailable: evaluation.constraintStatuses.H14 === 'ACTIVE', originalContentHash: contentHash(original.slots) }) };
}
async function confirmPlan({ plan, dependencies, actorId }) {
  const [{ scheduleIdFor }, { contentHash, compareRows }] = await Promise.all([import('../engine/persistence/schedule-store.js'), import('../engine/persistence/schedule-record.js')]);
  const original = await dependencies.scheduleStore.read(plan.scheduleId);
  if (!original || contentHash(original.slots) !== plan.originalHash) throw failure('TKB nguồn đã thay đổi. Hãy tạo lại bản xem trước.', 409);
  if (contentHash(plan.rows) !== plan.candidateHash) throw failure('Bản xem trước không còn nguyên vẹn.', 409);
  const { input } = await dependencies.loadDataset();
  const evaluation = await validateRows(plan.rows, input);
  if (!evaluation.summary.accepted || plan.issues.length || !plan.evaluation.summary.accepted) throw failure('Bản xem trước vi phạm quy tắc hiện tại, không thể áp dụng.', 422);
  const solutionId = 'assistant-adjustment'; const scheduleId = scheduleIdFor(plan.planId, solutionId); const now = new Date().toISOString();
  const result = await dependencies.scheduleStore.create(scheduleId, (version) => ({ ...original, version, scheduleId, status: 'COMMITTED', requestId: plan.planId, solutionId, validated: true, committedAt: now,
    contentHash: contentHash(plan.rows), slots: plan.rows, slotCount: plan.rows.length,
    audit: { ...plan.audit, actorId, confirmedAt: now, assistantPlanId: plan.planId, intent: plan.intent, changes: plan.changes }, parentScheduleId: original.scheduleId }));
  const readBack = await dependencies.scheduleStore.read(scheduleId);
  if (!readBack || !compareRows(readBack.slots, plan.rows).equal) throw failure('Không thể xác minh phiên bản vừa lưu. Vui lòng kiểm tra danh sách lịch.', 500);
  return { created: result.created, scheduleId, version: readBack.version, previousScheduleId: original.scheduleId, planId: plan.planId };
}
module.exports = { createPlan, confirmPlan, candidateFromRows, validateRows };
