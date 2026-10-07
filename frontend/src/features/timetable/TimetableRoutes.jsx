import { NavLink, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTopbar } from '../../layouts/AdminLayout.jsx';
import { DashboardPage, TeacherPage, ClassPage, BranchesPage, BranchPage, PreferencesPage } from './catalog/pages/CatalogPages.jsx';
import { TeachersPage, SubjectsPage, ClassesPage } from './catalog/pages/CatalogCrudPages.jsx';
import { SchedulePage } from './scheduling/pages/SchedulePage.jsx';
import SavedSchedulesPage from './scheduling/pages/SavedSchedulesPage.jsx';
import SavedSchedulePage from './scheduling/pages/SavedSchedulePage.jsx';
import './timetable.css';
const NAV = [['', 'Tổng quan'], ['generate', 'Tạo TKB'], ['schedules', 'Lịch đã lưu'], ['teachers', 'Giáo viên'], ['subjects', 'Môn học'], ['classes', 'Lớp'], ['branches', 'Phân hiệu'], ['teacher-preferences', 'Nguyện vọng']];
export default function TimetableRoutes() {
  const {
    set
  } = useTopbar();
  useEffect(() => {
    set({
      title: 'Thời khóa biểu',
      subtitle: 'Thuận Hưng',
      breadcrumbs: []
    });
  }, [set]);
  return <div className="tkb-feature">
    <div className="tkb-feature-title"><span className="tkb-eyebrow">THUẬN HƯNG</span><h1>Quản lý thời khóa biểu bộ môn</h1>
      <p>Danh mục, nguyện vọng và lịch dạy trong cùng hệ thống phân quyền GiaPhuc.</p></div>
    <nav className="tkb-tabs" aria-label="Thời khóa biểu">{NAV.map(([path, label]) => <NavLink key={path} to={`/timetable${path ? `/${path}` : ''}`} end={path === ''}>{label}</NavLink>)}</nav>
    <Routes><Route index element={<DashboardPage />} /><Route path="generate" element={<SchedulePage />} />
      <Route path="schedules" element={<SavedSchedulesPage />} /><Route path="schedules/:id" element={<SavedSchedulePage />} />
      <Route path="teachers" element={<TeachersPage />} /><Route path="teachers/:id" element={<TeacherPage />} />
      <Route path="subjects" element={<SubjectsPage />} /><Route path="classes" element={<ClassesPage />} />
      <Route path="classes/:id" element={<ClassPage />} /><Route path="branches" element={<BranchesPage />} />
      <Route path="branches/:id" element={<BranchPage />} /><Route path="teacher-preferences" element={<PreferencesPage />} />
      <Route path="*" element={<Navigate to="/timetable" replace />} /></Routes>
  </div>;
}
