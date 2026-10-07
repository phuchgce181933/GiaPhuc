import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchCommittedSchedules } from '../service.js';
import { CommittedPanel } from '../components/CommittedPanel.jsx';
export default function SavedSchedulesPage() {
  const [state, setState] = useState({
    schedules: [],
    loading: true,
    error: ''
  });
  const navigate = useNavigate();
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
  return <div className="tkb-page"><header className="tkb-page-head"><h1>Lịch bộ môn đã lưu</h1>
    <p className="tkb-hint">Mở lại đúng phiên bản đã xác nhận, không cần tạo lịch mới.</p></header>
    {state.error && <p role="alert" className="tkb-error">{state.error}</p>}
    <CommittedPanel schedules={state.schedules} refreshing={state.loading} onRefresh={load} onOpen={id => navigate(`/timetable/schedules/${id}`)} />
  </div>;
}
