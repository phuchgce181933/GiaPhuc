import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { TeachersPage, TeacherPage, SubjectsPage, ClassesPage, BranchesPage, PreferencesPage } from '../src/features/catalog/pages/CatalogPages.jsx';
import { SolutionList } from '../src/features/scheduling/components/SolutionList.jsx';
import { ScheduleGrid } from '../src/features/scheduling/components/ScheduleGrid.jsx';
import { SOLUTIONS } from './fixtures/phase32-response.js';
import * as catalog from '../src/features/catalog/service.js';
import userEvent from '@testing-library/user-event';

vi.mock('../src/features/catalog/service.js', () => ({ getTeachers: vi.fn(), getSubjects: vi.fn(), getBranches: vi.fn(), getPreference: vi.fn(), getTeacher: vi.fn(), getClass: vi.fn(), getClasses: vi.fn(), getBranch: vi.fn(), savePreference: vi.fn(), getDashboard: vi.fn(), getBlocks:vi.fn(),createTeacher:vi.fn(),updateTeacher:vi.fn(),deleteTeacher:vi.fn(),createSubject:vi.fn(),updateSubject:vi.fn(),deleteSubject:vi.fn(),createClass:vi.fn(),updateClass:vi.fn(),deleteClass:vi.fn() }));

beforeEach(() => {
  history.replaceState({}, '', '/');
  catalog.getTeachers.mockResolvedValue({ teachers: [
    { id: 'legacy', name: 'Legacy teacher', isActive: true, homeBranchId: 'b', specializations: [], workload: {}, preference: { preferredSession: 'afternoon', preferredTransferBranchIds: ['b'] }, preferenceConfiguration: { source: 'LEGACY', configuredCount: 0 } },
    { id: 'operator', name: 'Operator teacher', isActive: true, homeBranchId: 'b', specializations: [], workload: {}, preference: { preferredSession: 'morning', desiredTeachingSessionsPerWeek: 4 }, preferenceConfiguration: { source: 'OPERATOR_OVERLAY', configuredCount: 2 } },
  ] });
  catalog.getBranches.mockResolvedValue({ branches: [{ id: 'b', name: 'Branch' }] });
  catalog.getSubjects.mockResolvedValue({ subjects: [] });
  catalog.getPreference.mockResolvedValue({ preference: { preferredSession: 'both', preferredOffDay: 'TUESDAY', preferredOffPart: 'MORNING', desiredTeachingSessionsPerWeek: null, preferredTransferBranchIds: [] } });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test.each(['teacher detail', 'subjects', 'classes', 'branches'])('catalog: %s renders the API data', async (page) => {
  catalog.getTeacher.mockResolvedValue({ teacher: { id: 't', name: 'Teacher detail', email: '', phone: '', homeBranchName: 'Branch', isActive: true, workload: { teaching: 20 }, preference: { preferredSession: 'afternoon' }, specializations: [{ id: 's', name: 'English' }] } });
  catalog.getSubjects.mockResolvedValue({ subjects: [{ id: 's', name: 'English', code: 'EN', isActive: true }] });
  catalog.getClasses.mockResolvedValue({ classes: [{ id: 'c', name: 'Class 6A', branch: 'b', block: { id: 'grade6', name: 'Grade 6' }, isActive: true, curriculum: [{ subject: { name: 'English' }, periodsPerWeek: 4 }] }] });
  catalog.getBranches.mockResolvedValue({ branches: [{ id: 'b', code: 'B1', name: 'Branch', isActive: true, classCount: 113, homeTeacherCount: 40 }] });
  const cases = {
    'teacher detail': [<TeacherPage id="t" />, 'Teacher detail', 'Chiều'],
    subjects: [<SubjectsPage />, 'English', 'EN'],
    classes: [<ClassesPage />, 'Class 6A', 'English (4)'],
    branches: [<BranchesPage />, 'Branch', '113'],
  };
  const [element, name, value] = cases[page];
  render(element);
  expect(await screen.findByText(name)).toBeTruthy();
  expect(screen.getByText(value)).toBeTruthy();
});

test.each([true, false])('calendar UI: period 5 has exactly one afternoon row (explicit pairs: %s)', (explicit) => {
  const day = { day: 2, periods: [1,2,3,4,5,6,7], sessions: ['sang', 'chieu'],
    ...(explicit ? { periodsBySession: { sang: [1,2,3,4], chieu: [5,6,7] } } : {}) };
  render(<ScheduleGrid days={[day]} entityId="c" placements={[{ assignmentId: 'a', classId: 'c', subjectId: 's', teacherId: 't', branchId: 'b', day: 2, period: 5, session: 'chieu' }]}
    directory={{ classes: [{ id: 'c', name: 'Class' }], teachers: [{ id: 't', name: 'Teacher P5' }], subjects: [{ id: 's', name: 'English' }], branches: [{ id: 'b', name: 'Branch' }] }} />);
  const periodRows = screen.getAllByRole('rowheader', { name: '5' });
  expect(periodRows).toHaveLength(1);
  const row = periodRows[0].closest('tr');
  expect(within(row).getByText('Chiều')).toBeTruthy();
  expect(within(row).getByText('Teacher P5')).toBeTruthy();
});

test('catalog: configuration count uses operator provenance and explains that it is not satisfaction', async () => {
  render(<TeachersPage />);
  expect(await screen.findByText('Đã cấu hình: 0/5')).toBeTruthy();
  const saved = screen.getByText('Đã cấu hình: 2/5');
  expect(saved.title).toContain('không phải tỷ lệ TKB đáp ứng');
  expect(screen.queryByText('Preference đã cấu hình')).toBeNull();
});

test('preference form: branch filter limits the teacher selector by home branch', async () => {
  catalog.getTeachers.mockResolvedValue({ teachers: [
    { id: 'operator', name: 'Operator teacher', homeBranchId: 'b', specializations: [] },
    { id: 'other', name: 'Other branch teacher', homeBranchId: 'other', specializations: [] },
  ] });
  catalog.getBranches.mockResolvedValue({ branches: [{ id: 'b', name: 'Branch' }, { id: 'other', name: 'Other branch' }] });
  render(<PreferencesPage />);

  await screen.findByRole('option', { name: 'Other branch' });
  await userEvent.selectOptions(screen.getByLabelText('Lọc phân hiệu'), 'other');

  const teacherSelect = screen.getByLabelText('Giáo viên');
  expect(within(teacherSelect).getByRole('option', { name: 'Other branch teacher' })).toBeTruthy();
  expect(within(teacherSelect).queryByRole('option', { name: 'Operator teacher' })).toBeNull();
});

test('preference form: off morning is described as a soft priority and null desired sessions remains empty', async () => {
  history.replaceState({}, '', '/teacher-preferences?teacher=operator');
  render(<PreferencesPage />);
  const desired = await screen.findByLabelText('Số buổi dạy mong muốn / tuần');
  expect(desired.value).toBe('');
  expect(screen.getByLabelText('Ngày mong muốn nghỉ').value).toBe('TUESDAY');
  expect(screen.getByLabelText('Ca mong muốn nghỉ').value).toBe('MORNING');
  expect(screen.getByText(/Nghỉ sáng không cấm dạy chiều/)).toBeTruthy();
});

test('preference form: home branch is fixed and only other branches can be transfer wishes', async () => {
  history.replaceState({}, '', '/teacher-preferences?teacher=operator');
  catalog.getBranches.mockResolvedValue({ branches: [{ id: 'b', name: 'Home branch' }, { id: 'other', name: 'Other branch' }] });
  catalog.getPreference.mockResolvedValue({ preference: { preferredSession: 'both', preferredTransferBranchIds: ['b'] } });
  catalog.savePreference.mockImplementation(async (_id, preference) => ({ preference }));
  render(<PreferencesPage />);
  expect(await screen.findByText(/Phân hiệu chính: Home branch/)).toBeTruthy();
  expect(screen.queryByRole('checkbox', { name: 'Home branch' })).toBeNull();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Other branch' }));
  await userEvent.click(screen.getByRole('button', { name: 'Lưu nguyện vọng' }));
  expect(catalog.savePreference.mock.calls[0][1].preferredTransferBranchIds).toEqual(['other']);
  expect(catalog.savePreference.mock.calls[0][1]).not.toHaveProperty('homeBranchId');
});

test('results: overall load and zero-load subject teachers are backend metrics, never recomputed in UI', () => {
  const solution = { ...SOLUTIONS[0], metrics: { ...SOLUTIONS[0].metrics, overallWorkloadSpread: 9, overallWorkloadStdev: 2,
    teacherWorkloads: [{ teacherId: 'A', teacherName: 'Teacher A', periods: 3, capacityPeriodsPerWeek: null }, { teacherId: 'B', teacherName: 'Teacher B', periods: 0, capacityPeriodsPerWeek: 23 }],
    subjectWorkloadSpread: 3, subjectWorkload: { English: { subjectId: 'english', subjectName: 'English', spread: 3, stdev: 1.5, teachers: [{ teacherId: 'A', teacherName: 'Teacher A', periods: 3 }, { teacherId: 'B', teacherName: 'Teacher B', periods: 0 }] } },
  } };
  render(<SolutionList solutions={[solution]} selectedId={solution.id} onSelect={() => {}} />);
  const overall = screen.getByTestId('overall-workload');
  expect(within(overall).getByText('Độ lệch tổng').nextSibling.textContent).toBe('9.0');
  expect(within(overall).getByText('Teacher B')).toBeTruthy();
  expect(within(overall).getByText('Chưa xác nhận')).toBeTruthy();
  expect(within(screen.getByTestId('subject-workload')).getByText('Teacher A: 3 tiết · Teacher B: 0 tiết')).toBeTruthy();
});
