import { expect, test } from 'vitest';
import { buildTeacherSummary, filterTeacherScheduleRows } from '../../src/features/timetable/scheduling/components/ScheduleSummaryTable.jsx';

test('teacher totals include all subjects and branches; transfer is a subset of total', () => {
  const rows = Array.from({ length: 14 }, (_, index) => ({ teacherId: 'teacher', teacherName: 'HUỲNH HỮU TÂN', teacherHomeBranchId: 'home', teacherHomeBranchName: 'Phân hiệu 5', subjectId: 'it', subjectName: 'Tin học', branchId: index < 2 ? 'main' : index < 11 ? 'home' : 'other', branchName: index < 2 ? 'Trường chính' : index < 11 ? 'Phân hiệu 5' : 'Phân hiệu 2', day: 1 + index % 5, session: 'sang', period: 2, className: `Lớp ${index}` }));
  const summary = buildTeacherSummary(rows);
  expect(summary).toHaveLength(1);
  expect(summary[0].total).toBe(14);
  expect(summary[0].transfer).toBe(5);
  expect(summary[0].grandTotal).toBe(14);
  expect(summary[0].branchName).toBe('Phân hiệu 5');
  const filtered = buildTeacherSummary(filterTeacherScheduleRows([...rows, { ...rows[0], teacherId: 'unrelated', branchId: 'home' }], 'other'));
  expect(filtered).toHaveLength(1);
  expect(filtered[0].total).toBe(14);
  expect(filtered[0].transfer).toBe(5);
  const otherSubject = { ...rows[0], teacherId: 'musicTeacher', subjectId: 'music' };
  expect(filterTeacherScheduleRows([...rows, otherSubject], 'other', 'it')).toHaveLength(14);
  expect(filterTeacherScheduleRows([...rows, otherSubject], 'other', 'music')).toHaveLength(0);
});
