import { useEffect, useState } from 'react';
import * as service from '../service.js';
import CatalogEditor, { CatalogDialog } from '../components/CatalogEditor.jsx';

const SETTINGS = {
  teachers:{ title:'Giáo viên', singular:'giáo viên', load:service.getTeachers, remove:service.deleteTeacher },
  subjects:{ title:'Môn học', singular:'môn học', load:service.getSubjects, remove:service.deleteSubject },
  classes:{ title:'Lớp', singular:'lớp', load:service.getClasses, remove:service.deleteClass },
};
export function TeachersPage() { return <CatalogCrudPage type="teachers" />; }
export function SubjectsPage() { return <CatalogCrudPage type="subjects" />; }
export function ClassesPage() { return <CatalogCrudPage type="classes" />; }

function CatalogCrudPage({ type }) {
  const cfg = SETTINGS[type];
  const [revision,setRevision] = useState(0);
  const [state,setState] = useState({ loading:true });
  const [branches,setBranches] = useState([]);
  const [subjects,setSubjects] = useState([]);
  const [query,setQuery] = useState('');
  const [active,setActive] = useState('all');
  const [branch,setBranch] = useState('all');
  const [subject,setSubject] = useState('all');
  const [block,setBlock] = useState('all');
  const [editing,setEditing] = useState(undefined);
  const [deleting,setDeleting] = useState(null);
  const [deleteBusy,setDeleteBusy] = useState(false);
  const [deleteError,setDeleteError] = useState(null);
  const [notice,setNotice] = useState('');
  useEffect(() => {
    let alive = true; setState({ loading:true });
    Promise.all([cfg.load(),type !== 'subjects' ? service.getBranches() : Promise.resolve({ branches:[] }),type === 'teachers' ? service.getSubjects() : Promise.resolve({ subjects:[] })])
      .then(([data,branchData,subjectData]) => { if (alive) { setState({ loading:false,rows:data[type] });setBranches(branchData.branches);setSubjects(subjectData.subjects); } })
      .catch((error) => { if (alive) setState({ loading:false,error:error.message }); });
    return () => { alive = false; };
  }, [type,revision]);
  const rows = (state.rows ?? []).filter((row) => {
    const matches = `${row.name} ${row.code ?? ''} ${row.homeBranchName ?? ''} ${(row.specializations ?? []).map((item) => item.name).join(' ')}`.toLowerCase().includes(query.toLowerCase());
    return matches && (active === 'all' || String(row.isActive) === active)
      && (branch === 'all' || (type === 'teachers' ? row.homeBranchId : row.branch) === branch)
      && (subject === 'all' || row.specializations?.some((item) => item.id === subject))
      && (block === 'all' || row.block?.id === block);
  });
  const headers = type === 'teachers' ? ['Giáo viên','Chuyên môn','Phân hiệu chính','Workload lịch sử','Giới hạn tiết/tuần','Môn có thể dạy','Nguyện vọng đã lưu','Thao tác']
    : type === 'subjects' ? ['Mã','Tên','Trạng thái','Thao tác'] : ['Lớp','Khối','Phân hiệu','Môn / tiết mỗi tuần','Trạng thái','Thao tác'];
  const badge = (row) => <span className="tkb-badge">{row.isActive ? 'Active' : 'Inactive'}</span>;
  const actions = (row) => <td><div className="catalog-actions"><button type="button" aria-label={`Sửa ${row.name}`} onClick={() => { setNotice('');setEditing(row); }}>Sửa</button>
    <button type="button" aria-label={`Xóa ${row.name}`} disabled={row.canDelete === false} title={row.canDelete === false ? 'Đang được sử dụng. Có thể sửa trạng thái thành ngừng sử dụng.' : undefined}
      onClick={() => { setDeleting(row);setDeleteError(null); }}>Xóa</button></div></td>;
  async function confirmDelete() {
    if (deleteBusy) return; setDeleteBusy(true);setDeleteError(null);
    try { const result = await cfg.remove(deleting.id); if (result.deleted !== true) throw new Error('Máy chủ chưa xác nhận xóa bản ghi.');
      setDeleting(null);setNotice(`Đã xóa ${cfg.singular}.`);setRevision((value) => value + 1);
    } catch (error) { setDeleteError(error.message); } finally { setDeleteBusy(false); }
  }
  return <div className="tkb-page">
    <header className="tkb-page-head"><h1>{cfg.title}</h1></header>
    <div className="catalog-toolbar"><div className="tkb-controls">
      <input className="tkb-search" aria-label={`Tìm ${cfg.singular}`} placeholder={`Tìm ${cfg.singular}`} value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="Lọc trạng thái" value={active} onChange={(event) => setActive(event.target.value)}><option value="all">Mọi trạng thái</option><option value="true">Active</option><option value="false">Inactive</option></select>
      {type !== 'subjects' ? <select aria-label="Lọc phân hiệu" value={branch} onChange={(event) => setBranch(event.target.value)}><option value="all">Mọi phân hiệu</option>{branches.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select> : null}
      {type === 'teachers' ? <select aria-label="Lọc chuyên môn" value={subject} onChange={(event) => setSubject(event.target.value)}><option value="all">Mọi môn</option>{subjects.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select> : null}
      {type === 'classes' ? <select aria-label="Lọc khối" value={block} onChange={(event) => setBlock(event.target.value)}><option value="all">Mọi khối</option>{[...new Map((state.rows ?? []).filter((row) => row.block).map((row) => [row.block.id,row.block])).values()].map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select> : null}
    </div><button className="catalog-primary" type="button" onClick={() => { setNotice('');setEditing(null); }}>Thêm {cfg.singular}</button></div>
    {notice ? <p role="status" className="tkb-notice">{notice}</p> : null}
    {state.loading ? <p className="tkb-empty">Đang tải dữ liệu…</p> : state.error ? <p role="alert" className="tkb-error">{state.error}</p> : <div className="tkb-grid-wrap"><table className="tkb-grid">
      <thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map((row) => <tr key={row.id}>
        {type === 'teachers' ? <>
          <td><a href={`/teachers/${row.id}`}>{row.name}</a><br />{badge(row)}</td>
          <td>{row.specializations.map((item) => item.name).join(', ') || '—'}</td><td>{row.homeBranchName ?? '—'}</td><td>{row.workload.teaching ?? row.workload.standard ?? '—'}</td><td>{row.capacityPeriodsPerWeek ?? 'Chưa khai báo'}</td><td>{row.specializations.length}</td>
          <td><span title="Đây là số nhóm nguyện vọng do người dùng đã lưu có giá trị; không phải tỷ lệ TKB đáp ứng nguyện vọng. Giá trị kế thừa legacy không được tính.">Đã cấu hình: {row.preferenceConfiguration?.configuredCount ?? 0}/5</span></td>
        </> : type === 'subjects' ? <><td>{row.code || '—'}</td><td>{row.name}</td><td>{badge(row)}</td></>
          : <><td><a href={`/classes/${row.id}`}>{row.name}</a></td><td>{row.block?.name ?? '—'}</td><td>{branches.find((item) => item.id === row.branch)?.name ?? '—'}</td><td>{row.curriculum.map((item) => `${item.subject?.name ?? '—'} (${item.periodsPerWeek})`).join(', ') || '—'}</td><td>{badge(row)}</td></>}
        {actions(row)}
      </tr>) : <tr><td colSpan={headers.length}>Không có dữ liệu.</td></tr>}</tbody>
    </table></div>}
    {editing !== undefined ? <CatalogEditor type={type} record={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined);setNotice(`Đã lưu ${cfg.singular}.`);setRevision((value) => value + 1); }} /> : null}
    {deleting ? <CatalogDialog title={`Xóa ${cfg.singular}`} busy={deleteBusy} onClose={() => setDeleting(null)}>
      <p>Xóa “{deleting.name}” khỏi danh mục?</p><p className="tkb-hint">Bản ghi đang được sử dụng không thể xóa. Bạn có thể sửa trạng thái thành ngừng sử dụng.</p>
      {deleteError ? <p role="alert" className="tkb-error">{deleteError}</p> : null}
      <div className="catalog-actions"><button disabled={deleteBusy} onClick={() => setDeleting(null)}>Hủy</button><button className="catalog-danger" disabled={deleteBusy} onClick={confirmDelete}>{deleteBusy ? 'Đang xóa…' : 'Xác nhận xóa'}</button></div>
    </CatalogDialog> : null}
  </div>;
}
