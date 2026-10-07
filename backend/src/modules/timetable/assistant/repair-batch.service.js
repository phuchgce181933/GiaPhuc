'use strict';
const { describeChange, audit } = require('./change-audit.service');
const failure = (message, code = 'BATCH_MOVE_REJECTED') => Object.assign(new Error(message), { status: 422, code });
const sameTime = (a, b) => a.day === b.day && a.period === b.period && a.session === b.session;

async function createBatchPlan({ original, intent, input, teacherFor, engineTime, humanTime, validateRows }) {
  const baseline = await validateRows(original.slots, input);
  if (!baseline.summary.accepted) throw failure('TKB nguồn không còn hợp lệ theo quy tắc hiện tại. Hãy kiểm tra lại lịch nguồn.', 'SOURCE_INVALID');
  const selected = [];
  if (intent.kind === 'day') {
    const teacher = teacherFor(intent, input);
    if (intent.fromDay === intent.toDay && (!intent.toSession || intent.fromSession === intent.toSession)) throw failure('Ngày/buổi đích trùng với nguồn.');
    original.slots.forEach((row, index) => {
      if (row.teacherId === teacher.id && row.day === intent.fromDay - 1 && (!intent.fromSession || row.session === intent.fromSession)) {
        const branch = input.branches.find(b => b.id === row.branchId);
        const local = humanTime(row, input);
        const targetSession = intent.toSession || row.session;
        let preferred;
        try { preferred = engineTime({ day: intent.toDay, session: targetSession, period: local.period }, branch); } catch { preferred = null; }
        selected.push({ index, source: row, preferred, targetSession });
      }
    });
    if (!selected.length) throw failure(`${intent.teacher} không có lịch dạy vào thứ ${intent.fromDay}${intent.fromSession ? intent.fromSession === 'sang' ? ' buổi sáng' : ' buổi chiều' : ''} trong phiên bản đã chọn.`, 'SOURCE_SLOT_NOT_FOUND');
  } else {
    for (const move of intent.moves) {
      const teacher = teacherFor(move, input);
      const matches = original.slots.map((source, index) => ({ source, index })).filter(({ source }) => {
        if (source.teacherId !== teacher.id) return false;
        try { return sameTime(source, engineTime(move.from, input.branches.find(b => b.id === source.branchId))); } catch { return false; }
      });
      if (matches.length !== 1) throw failure(`Không tìm thấy đúng một tiết của ${move.teacher} tại thứ ${move.from.day}, ${move.from.session === 'sang' ? 'sáng' : 'chiều'} tiết ${move.from.period}. Không áp dụng một phần yêu cầu.`, 'SOURCE_SLOT_NOT_FOUND');
      const { source, index } = matches[0];
      if (selected.some(item => item.index === index)) throw failure('Một tiết nguồn được yêu cầu chuyển nhiều lần. Hãy kiểm tra lại.');
      const preferred = engineTime(move.to, input.branches.find(b => b.id === source.branchId));
      if (sameTime(source, preferred)) throw failure('Có khung giờ đích trùng với nguồn.');
      selected.push({ source, index, preferred, targetSession: move.to.session });
    }
  }
  if (selected.length > 20) throw failure('Mỗi yêu cầu hỗ trợ tối đa 20 tiết. Hãy chia thành các nhóm nhỏ hơn.');
  const selectedIds = new Set(selected.map(item => item.index));
  const fixed = original.slots.filter((_, index) => !selectedIds.has(index));
  const { sessionForSlot, isBlockedTeachingSlot, isAdjacentTeachingPeriod } = await import('../engine/domain/time.js');
  const branchFor = row => input.branches.find(b => b.id === row.branchId);
  const direct = original.slots.map(row => ({ ...row }));
  for (const item of selected) if (item.preferred) Object.assign(direct[item.index], item.preferred);
  let rows = direct;
  let evaluation = await validateRows(rows, input);
  let searchLimited = false;
  const targetAvailable = item => item.preferred && (input.timeSlotsByBranch.get(item.source.branchId) ?? []).some(slot => slot.day === item.preferred.day && slot.period === item.preferred.period && sessionForSlot(slot, branchFor(item.source)) === item.targetSession);
  if (intent.kind === 'day' && (!evaluation.summary.accepted || selected.some(item => !targetAvailable(item)))) {
    const pools = selected.map(item => {
      const branch = branchFor(item.source);
      const slots = (input.timeSlotsByBranch.get(item.source.branchId) ?? []).filter(slot => slot.day === intent.toDay - 1 && sessionForSlot(slot, branch) === item.targetSession && !isBlockedTeachingSlot(slot, branch));
      return slots.map(slot => ({ ...item.source, day: slot.day, period: slot.period, session: item.targetSession })).sort((a, b) => Number(!item.preferred || !sameTime(a, item.preferred)) - Number(!item.preferred || !sameTime(b, item.preferred)) || a.period - b.period);
    });
    const proposed = original.slots.map(row => ({ ...row }));
    const placed = [];
    let nodes = 0;
    const started = Date.now();
    function conflicts(row, others) {
      return others.some(other => {
        if (sameTime(row, other) && (row.teacherId === other.teacherId || row.classId === other.classId)) return true;
        const adjacent = isAdjacentTeachingPeriod(row, other, branchFor(row), branchFor(other));
        return adjacent && ((row.teacherId === other.teacherId && row.branchId !== other.branchId) || (row.classId === other.classId && row.subjectId === other.subjectId));
      });
    }
    async function search(depth) {
      if (++nodes > 5000 || Date.now() - started > 3000) { searchLimited = true; return false; }
      if (depth === selected.length) {
        const checked = await validateRows(proposed, input);
        if (checked.summary.accepted) { rows = proposed.map(row => ({ ...row })); evaluation = checked; return true; }
        return false;
      }
      for (const row of pools[depth]) {
        if (conflicts(row, fixed) || conflicts(row, placed)) continue;
        proposed[selected[depth].index] = row;
        placed.push(row);
        if (await search(depth + 1)) return true;
        placed.pop();
        if (searchLimited) return false;
      }
      return false;
    }
    if (!await search(0)) throw failure(searchLimited
      ? 'Chưa tìm được phương án chuyển toàn bộ tiết trong giới hạn tìm kiếm. Không có tiết nào được áp dụng. Hãy chia nhỏ yêu cầu hoặc chọn ngày khác.'
      : `Không tìm được phương án hợp lệ để chuyển toàn bộ ${selected.length} tiết sang thứ ${intent.toDay} và giữ buổi dạy đã yêu cầu. Không có tiết nào được áp dụng.`, 'BATCH_NO_SOLUTION');
  }
  const changed = rows.map((after, index) => ({ before: original.slots[index], after })).filter(({ before, after }) => !sameTime(before, after));
  const changes = changed.map(({ before, after }) => ({ ...describeChange(before, after, original.directory), from: humanTime(before, input), to: humanTime(after, input), assignmentId: after.assignmentId, branchId: after.branchId }));
  const { contentHash } = await import('../engine/persistence/schedule-record.js');
  return { scheduleId: original.scheduleId, sourceVersion: original.version, originalHash: contentHash(original.slots), candidateHash: contentHash(rows), intent, rows, changes,
    issues: evaluation.hard.violations.map(v => ({ code: v.constraintId ?? v.code ?? 'RULE_VIOLATION', message: v.message })),
    repaired: selected.some(item => !item.preferred || !sameTime(rows[item.index], item.preferred)), evaluation, requestedSlots: selected.length,
    audit: audit({ original, changes: changed.map(({ after }) => after), evaluation, travelAvailable: evaluation.constraintStatuses.H14 === 'ACTIVE', originalContentHash: contentHash(original.slots) }) };
}
module.exports = { createBatchPlan };
