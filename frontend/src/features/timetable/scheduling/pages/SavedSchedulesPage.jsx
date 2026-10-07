import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCommittedSchedules, deleteCommittedSchedule } from '../service.js';
import { CommittedPanel } from '../components/CommittedPanel.jsx';
import { usePermission } from '../../../auth/hooks.js';
import { PERMISSIONS } from '../../../auth/permissions.js';
export default function SavedSchedulesPage() {
  const [state, setState] = useState({
    schedules: [],
    loading: true,
    error: ''
  });
  const navigate = useNavigate();
  const permissions = usePermission();
  async function load() {
    setState(s => ({
      ...s,
      loading: true,
      error: ''
    }));
    try {
      const response = await fetchCommittedSchedules();
      setState({
        schedules: response.schedules,
        loading: false,
        error: ''
      });
    } catch (error) {
      setState(s => ({
        ...s,
        loading: false,
        error: error.message
      }));
    }
  }
  useEffect(() => {
    load();
  }, []);
  async function remove(id) {
    if (!window.confirm('Xóa phiên bản này? Dữ liệu sẽ không còn trong danh sách phiên bản đã lưu.')) return;
    try { await deleteCommittedSchedule(id); await load(); } catch (error) { setState(s => ({ ...s, error: error.message })); }
  }
  return <div className="tkb-page"><header className="tkb-page-head"><h1>Lịch bộ môn đã lưu</h1>
    <p className="tkb-hint">Mở lại đúng phiên bản đã xác nhận, không cần tạo lịch mới.</p></header>
    {state.error && <p role="alert" className="tkb-error">{state.error}</p>}
    <CommittedPanel schedules={state.schedules} refreshing={state.loading} onRefresh={load} onOpen={id => navigate(`/timetable/schedules/${id}`)} onDelete={permissions.hasAll([PERMISSIONS.TKB_DELETE]) ? remove : undefined} />
  </div>;
}
