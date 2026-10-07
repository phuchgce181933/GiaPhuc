import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { fetchCommittedScheduleFull } from '../service.js';
import { ScheduleGrid } from '../components/ScheduleGrid.jsx';
import { ScheduleSummaryTable, buildTeacherSummary, filterTeacherScheduleRows, SUMMARY_COLUMNS, SUMMARY_HEADER_ROWS } from '../components/ScheduleSummaryTable.jsx';
import { downloadExcel, printPdf } from '../export.js';
export default function SavedSchedulePage() {
  const {
    id
  } = useParams();
  const [state, setState] = useState({
    loading: true,
    schedule: null,
    error: ''
  });
  const [mode, setMode] = useState('SUMMARY');
  const [branch, setBranch] = useState('ALL');
  const [subject, setSubject] = useState('ALL');
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
  const filtered = options.filter(row => (branch === 'ALL' || (mode === 'CLASS' ? row.branchId === branch : row.homeBranchId === branch || schedule.slots?.some(slot => slot.teacherId === row.id && slot.branchId === branch))) && (subject === 'ALL' || schedule.slots?.some(slot => slot[mode === 'CLASS' ? 'classId' : 'teacherId'] === row.id && slot.subjectId === subject && (branch === 'ALL' || slot.branchId === branch))));
  useEffect(() => {
    if (!filtered.some(row => row.id === entity)) setEntity(filtered[0]?.id ?? '');
  }, [mode, branch, subject, entity, schedule]);
  const names = { teachers: new Map((directory?.teachers ?? []).map(row => [row.id, row.name])), classes: new Map((directory?.classes ?? []).map(row => [row.id, row.name])), subjects: new Map((directory?.subjects ?? []).map(row => [row.id, row.name])), branches: new Map((directory?.branches ?? []).map(row => [row.id, row.name])) };
  const visibleSlots = mode === 'CLASS' ? (schedule?.slots ?? []).filter(row => (branch === 'ALL' || row.branchId === branch) && (subject === 'ALL' || row.subjectId === subject)) : filterTeacherScheduleRows(schedule?.slots ?? [], branch, subject);
  const summaryRows = visibleSlots.map(row => { const teacher = directory?.teachers?.find(item => item.id === row.teacherId); return { ...row, teacherName: names.teachers.get(row.teacherId) ?? row.teacherId, teacherHomeBranchId: teacher?.homeBranchId ?? null, teacherHomeBranchName: names.branches.get(teacher?.homeBranchId) ?? null, className: names.classes.get(row.classId) ?? row.classId, subjectName: names.subjects.get(row.subjectId) ?? row.subjectId, branchName: names.branches.get(row.branchId) ?? row.branchId }; }).sort((a, b) => a.teacherName.localeCompare(b.teacherName) || a.day - b.day || a.period - b.period);
  const columns = mode === 'SUMMARY' ? SUMMARY_COLUMNS : [{ key: 'teacherName', label: 'Giáo viên' }, { key: 'subjectName', label: 'Môn' }, { key: 'className', label: 'Lớp' }, { key: 'branchName', label: 'Phân hiệu' }, { key: 'day', label: 'Thứ' }, { key: 'session', label: 'Buổi' }, { key: 'period', label: 'Tiết' }];
  function exportCurrent(type) {
    const title = `TKB phiên bản ${schedule?.version ?? ''} · ${mode === 'SUMMARY' ? 'Tổng hợp' : mode === 'CLASS' ? 'Theo lớp' : 'Theo giáo viên'}`;
    let exportColumns = columns; let rows; let headers;
    if (mode === 'SUMMARY') { rows = buildTeacherSummary(summaryRows); headers = SUMMARY_HEADER_ROWS; }
    else {
      const source = summaryRows.filter(row => mode === 'CLASS' ? row.classId === entity : row.teacherId === entity);
      const byTime = new Map(source.map(row => [`${row.day}|${row.session}|${row.period}`, row]));
      exportColumns = [{ key: 'sessionLabel', label: 'Buổi' }, { key: 'periodLabel', label: 'Tiết' }, ...[1, 2, 3, 4, 5].map(day => ({ key: `day${day}`, label: `Thứ ${day + 1}` }))];
      headers = [[{ label: 'Buổi' }, { label: 'Tiết' }, ...[1, 2, 3, 4, 5].map(day => ({ label: `Thứ ${day + 1}` }))]];
      rows = ['sang', 'chieu'].flatMap(session => [1, 2, 3, ...(session === 'sang' ? [4] : [])].map(period => { const actual = session === 'chieu' ? period + 4 : period; const row = { sessionLabel: session === 'sang' ? 'Sáng' : 'Chiều', periodLabel: String(period) }; for (let day = 1; day <= 5; day += 1) { const cell = byTime.get(`${day}|${session}|${actual}`); row[`day${day}`] = cell ? (mode === 'TEACHER' ? `${cell.subjectName} · ${cell.className}` : `${cell.teacherName} · ${cell.subjectName}`) : '—'; } return row; }));
    }
    if (type === 'excel') downloadExcel(`tkb-phien-ban-${schedule?.version ?? 'x'}`, title, exportColumns, rows, headers); else printPdf(title, exportColumns, rows, headers);
  }
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
        <div className="tkb-controls"><label className="tkb-control"><span>Xem theo</span><select value={mode} onChange={e => setMode(e.target.value)}><option value="SUMMARY">Tổng hợp</option><option value="CLASS">Cá nhân · Lớp</option><option value="TEACHER">Cá nhân · Giáo viên</option></select></label>
          <label className="tkb-control"><span>Phân hiệu</span><select value={branch} onChange={e => setBranch(e.target.value)}><option value="ALL">Tất cả phân hiệu</option>{directory.branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label className="tkb-control"><span>Môn dạy</span><select value={subject} onChange={e => setSubject(e.target.value)}><option value="ALL">Tất cả môn</option>{directory.subjects.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          {mode !== 'SUMMARY' && <label className="tkb-control"><span>{mode === 'CLASS' ? 'Lớp' : 'Giáo viên'}</span><select value={entity} onChange={e => setEntity(e.target.value)}><option value="">Chọn…</option>{filtered.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}<div className="tkb-export-actions"><button onClick={() => exportCurrent('excel')}>Xuất Excel</button><button onClick={() => exportCurrent('pdf')}>Xuất PDF</button></div></div>
        {mode === 'TEACHER' && <p className="tkb-hint">Hiển thị mọi phân hiệu giáo viên này dạy để kiểm tra toàn bộ lịch.</p>}
        <div className="tkb-print-heading"><h2>{mode === 'SUMMARY' ? 'PHÂN CÔNG GIÁO VIÊN BỘ MÔN' : 'THỜI KHÓA BIỂU CÁ NHÂN'}</h2><p>Năm học 2026–2027</p>{mode !== 'SUMMARY' && entity && <strong>{mode === 'TEACHER' ? `Giáo viên: ${options.find(item => item.id === entity)?.name ?? ''}` : `Lớp: ${options.find(item => item.id === entity)?.name ?? ''}`}</strong>}</div>
        {mode === 'SUMMARY' ? <ScheduleSummaryTable rows={summaryRows} /> : <ScheduleGrid days={schedule.calendar.days} placements={visibleSlots} mode={mode} entityId={entity} branchFilter={mode === 'TEACHER' ? 'ALL' : branch} directory={directory} />}
      </>}
      <details><summary>Thông tin kiểm tra</summary><p><code>{schedule.scheduleId}</code></p><p className="tkb-mono">{schedule.contentHash}</p></details>
    </>}
  </div>;
}
