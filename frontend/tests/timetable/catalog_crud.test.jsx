import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import { render, screen, within, cleanup, waitFor } from './helpers/render.jsx';
import userEvent from '@testing-library/user-event';
import { TeachersPage, SubjectsPage, ClassesPage } from '../../src/features/timetable/catalog/pages/CatalogCrudPages.jsx';
import * as api from '../../src/features/timetable/catalog/service.js';
vi.mock('../../src/features/timetable/catalog/service.js', () => ({
  getTeachers: vi.fn(),
  getSubjects: vi.fn(),
  getClasses: vi.fn(),
  getBranches: vi.fn(),
  getBlocks: vi.fn(),
  getCatalogBootstrap: vi.fn(),
  createTeacher: vi.fn(),
  updateTeacher: vi.fn(),
  deleteTeacher: vi.fn(),
  createSubject: vi.fn(),
  updateSubject: vi.fn(),
  deleteSubject: vi.fn(),
  createClass: vi.fn(),
  updateClass: vi.fn(),
  deleteClass: vi.fn()
}));
const teacher = {
  id: 'teacher',
  name: 'Teacher',
  homeBranchId: 'home',
  homeBranchName: 'Home branch',
  email: 'old@example.test',
  phone: '',
  code: 'GV',
  isActive: true,
  specializations: [{
    id: 'subject',
    name: 'English'
  }],
  workload: {
    teaching: 20
  },
  preferenceConfiguration: {
    configuredCount: 0
  },
  canDelete: true
};
beforeEach(() => {
  api.getTeachers.mockResolvedValue({
    teachers: [{
      ...teacher
    }]
  });
  api.getSubjects.mockResolvedValue({
    subjects: [{
      id: 'subject',
      name: 'English',
      code: 'EN',
      isActive: true,
      canDelete: true
    }]
  });
  api.getClasses.mockResolvedValue({
    classes: [{
      id: 'class',
      name: 'Class 6A',
      code: '6A',
      branch: 'home',
      blockId: 'grade',
      block: {
        id: 'grade',
        name: 'Grade 6'
      },
      curriculum: [],
      isActive: true,
      canDelete: true
    }]
  });
  api.getBranches.mockResolvedValue({
    branches: [{
      id: 'home',
      name: 'Home branch'
    }, {
      id: 'other',
      name: 'Other branch'
    }]
  });
  api.getBlocks.mockResolvedValue({
    blocks: [{
      id: 'grade',
      name: 'Grade 6'
    }]
  });
  api.getCatalogBootstrap.mockResolvedValue({ branches: [{ id: 'home', name: 'Home branch' }, { id: 'other', name: 'Other branch' }], blocks: [{ id: 'grade', name: 'Grade 6' }], teachers: [], subjects: [] });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
test('teacher CRUD: edit keeps home branch read-only and sends no home-branch update', async () => {
  api.updateTeacher.mockResolvedValue({
    ok: true,
    teacher
  });
  render(<TeachersPage />);
  await userEvent.click(await screen.findByRole('button', {
    name: 'Sửa Teacher'
  }));
  const dialog = screen.getByRole('dialog', {
    name: 'Sửa giáo viên'
  });
  const home = within(dialog).getByLabelText('Phân hiệu chính');
  expect(home.readOnly).toBe(true);
  expect(home.value).toBe('Home branch');
  await userEvent.clear(within(dialog).getByLabelText('Họ tên'));
  await userEvent.type(within(dialog).getByLabelText('Họ tên'), 'Teacher edited');
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  await waitFor(() => expect(api.updateTeacher).toHaveBeenCalled());
  expect(api.updateTeacher.mock.calls[0][0]).toBe('teacher');
  expect(api.updateTeacher.mock.calls[0][1]).not.toHaveProperty('homeBranchId');
  expect(api.updateTeacher.mock.calls[0][1].specializationIds).toEqual(['subject']);
  expect(await screen.findByRole('status')).toHaveProperty('textContent', 'Đã lưu giáo viên.');
});
test('teacher CRUD: creation requires an explicitly chosen home branch and specialization', async () => {
  api.createTeacher.mockResolvedValue({
    ok: true,
    teacher
  });
  render(<TeachersPage />);
  await userEvent.click(screen.getByRole('button', {
    name: 'Thêm giáo viên'
  }));
  const dialog = screen.getByRole('dialog', {
    name: 'Thêm giáo viên'
  });
  await userEvent.type(within(dialog).getByLabelText('Họ tên'), 'New teacher');
  await userEvent.selectOptions(within(dialog).getByLabelText('Phân hiệu chính'), 'other');
  await userEvent.click(await within(dialog).findByRole('checkbox', {
    name: 'English'
  }));
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  await waitFor(() => expect(api.createTeacher).toHaveBeenCalled());
  expect(api.createTeacher.mock.calls[0][0].homeBranchId).toBe('other');
});
test('subject CRUD: create, edit and confirmed delete refresh the list', async () => {
  const rows = [{
    id: 'subject',
    name: 'English',
    code: 'EN',
    isActive: true,
    canDelete: true
  }];
  api.getSubjects.mockImplementation(async () => ({
    subjects: rows.map(row => ({
      ...row
    }))
  }));
  api.createSubject.mockImplementation(async body => {
    const row = {
      ...body,
      id: 'new',
      canDelete: true
    };
    rows.push(row);
    return {
      ok: true,
      subject: row
    };
  });
  api.updateSubject.mockImplementation(async (id, body) => {
    Object.assign(rows.find(row => row.id === id), body);
    return {
      ok: true
    };
  });
  api.deleteSubject.mockImplementation(async id => {
    rows.splice(rows.findIndex(row => row.id === id), 1);
    return {
      ok: true,
      deleted: true
    };
  });
  render(<SubjectsPage />);
  await userEvent.click(screen.getByRole('button', {
    name: 'Thêm môn học'
  }));
  let dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Tên môn học'), 'Art');
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  expect(await screen.findByText('Art')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', {
    name: 'Sửa Art'
  }));
  dialog = screen.getByRole('dialog');
  await userEvent.clear(within(dialog).getByLabelText('Tên môn học'));
  await userEvent.type(within(dialog).getByLabelText('Tên môn học'), 'Art edited');
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  expect(await screen.findByText('Art edited')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', {
    name: 'Xóa Art edited'
  }));
  expect(api.deleteSubject).not.toHaveBeenCalled();
  await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', {
    name: 'Xác nhận xóa'
  }));
  await waitFor(() => expect(screen.queryByText('Art edited')).toBeNull());
});
test('class CRUD: selected branch and block are sent, and cancel sends no write', async () => {
  api.createClass.mockResolvedValue({
    ok: true
  });
  render(<ClassesPage />);
  await userEvent.click(screen.getByRole('button', {
    name: 'Thêm lớp'
  }));
  let dialog = screen.getByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Hủy'
  }));
  expect(api.createClass).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', {
    name: 'Thêm lớp'
  }));
  dialog = screen.getByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Tên lớp'), 'New class');
  await userEvent.selectOptions(within(dialog).getByLabelText('Phân hiệu'), 'home');
  await userEvent.selectOptions(within(dialog).getByLabelText('Khối'), 'grade');
  await userEvent.click(within(dialog).getByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  await waitFor(() => expect(api.createClass).toHaveBeenCalled());
  expect(api.createClass.mock.calls[0][0]).toMatchObject({
    name: 'New class',
    branchId: 'home',
    blockId: 'grade',
    homeroomTeacherId: null
  });
});
test('CRUD: save errors retain the form and referenced records cannot be deleted', async () => {
  api.getTeachers.mockResolvedValue({
    teachers: [{
      ...teacher,
      canDelete: false
    }]
  });
  const error = Object.assign(new Error('Mã đã được sử dụng.'), {
    errors: [{
      field: 'code'
    }]
  });
  api.updateTeacher.mockRejectedValue(error);
  render(<TeachersPage />);
  const remove = await screen.findByRole('button', {
    name: 'Xóa Teacher'
  });
  expect(remove.disabled).toBe(true);
  await userEvent.click(screen.getByRole('button', {
    name: 'Sửa Teacher'
  }));
  const dialog = screen.getByRole('dialog');
  await userEvent.click(await within(dialog).findByRole('button', {
    name: 'Lưu',
    exact: true
  }));
  expect(await within(dialog).findByRole('alert')).toHaveProperty('textContent', 'Mã đã được sử dụng.');
  expect(within(dialog).getByLabelText('Họ tên').value).toBe('Teacher');
  expect(within(dialog).getByLabelText('Mã').getAttribute('aria-invalid')).toBe('true');
});
