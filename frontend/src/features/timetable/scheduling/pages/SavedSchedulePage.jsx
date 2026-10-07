import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchCommittedScheduleFull } from '../service.js';
import { ScheduleGrid } from '../components/ScheduleGrid.jsx';
export default function SavedSchedulePage() {
  const {
    id
  } = useParams();
  const [state, setState] = useState({
    loading: true,
    schedule: null,
    error: ''
  });
  const [mode, setMode] = useState('CLASS');
  const [branch, setBranch] = useState('ALL');
  const [entity, setEntity] = useState('');
  useEffect(() => {
    let active = true;
    setState({
      loading: true,
      schedule: null,
      error: ''
    });
    fetchCommittedScheduleFull(id).then(out => {
      if (active) setState({
        loading: false,
        schedule: out.schedule,
        error: ''
      });
    }).catch(error => {
      if (active) setState({
        loading: false,
        schedule: null,
        error: error.message
      });
    });
    return () => {
      active = false;
    };
  }, [id]);
  const schedule = state.schedule;
  const directory = schedule?.directory;
  const options = (mode === 'CLASS' ? directory?.classes : directory?.teachers) ?? [];
  const filtered = options.filter(row => branch === 'ALL' || (mode === 'CLASS' ? row.branchId === branch : row.homeBranchId === branch || schedule.slots?.some(slot => slot.teacherId === row.id && slot.branchId === branch)));
  useEffect(() => {
    if (!filtered.some(row => row.id === entity)) setEntity(filtered[0]?.id ?? '');
  }, [mode, branch, entity, schedule]);
  return <div className="tkb-page"><Link to="/timetable/schedules">← Danh sách lịch đã lưu</Link>
    <header className="tkb-page-head"><h1>TKB bộ môn · Phiên bản {schedule?.version ?? '…'}</h1></header>
    {state.loading && <p>Đang mở lịch…</p>}{state.error && <p role="alert" className="tkb-error">{state.error}</p>}
    {schedule && <><p className="tkb-hint">Đã lưu {new Intl.DateTimeFormat('vi-VN', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Bangkok'
        }).format(new Date(schedule.committedAt))} · {schedule.slotCount} tiết. Đây là bản đã lưu; thay đổi danh mục không sửa bản này.</p>
      {schedule.travel?.available !== true && <p className="tkb-travel-warning">Chưa kiểm tra thời gian di chuyển giữa các phân hiệu.</p>}
      {!directory || !schedule.calendar ? <p role="alert">Lịch cũ chưa có snapshot danh mục để hiển thị. Dữ liệu tiết vẫn được giữ nguyên.</p> : <>
        <div className="tkb-controls"><label className="tkb-control"><span>Xem theo</span><select value={mode} onChange={e => setMode(e.target.value)}><option value="CLASS">Lớp</option><option value="TEACHER">Giáo viên</option></select></label>
          <label className="tkb-control"><span>Phân hiệu</span><select value={branch} onChange={e => setBranch(e.target.value)}><option value="ALL">Tất cả phân hiệu</option>{directory.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="tkb-control"><span>{mode === 'CLASS' ? 'Lớp' : 'Giáo viên'}</span><select value={entity} onChange={e => setEntity(e.target.value)}><option value="">Chọn…</option>{filtered.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label></div>
        {mode === 'TEACHER' && <p className="tkb-hint">Hiển thị mọi phân hiệu giáo viên này dạy để kiểm tra toàn bộ lịch.</p>}
        <ScheduleGrid days={schedule.calendar.days} placements={schedule.slots} mode={mode} entityId={entity} branchFilter={mode === 'TEACHER' ? 'ALL' : branch} directory={directory} />
      </>}
      <details><summary>Thông tin kiểm tra</summary><p><code>{schedule.scheduleId}</code></p><p className="tkb-mono">{schedule.contentHash}</p></details>
    </>}
  </div>;
}
