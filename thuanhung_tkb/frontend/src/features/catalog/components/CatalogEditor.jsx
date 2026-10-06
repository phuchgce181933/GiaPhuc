import { useEffect, useRef, useState } from 'react';
import * as service from '../service.js';
import './catalog.css';

const NAMES = { teachers:'giáo viên', subjects:'môn học', classes:'lớp' };
const METHODS = { teachers:[service.createTeacher,service.updateTeacher], subjects:[service.createSubject,service.updateSubject], classes:[service.createClass,service.updateClass] };

export function CatalogDialog({ title, children, busy, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open','');
    return () => { if (dialog.close && dialog.open) dialog.close(); };
  }, []);
  return <dialog ref={ref} className="catalog-dialog" aria-label={title} aria-modal="true" onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <h2>{title}</h2>{children}
  </dialog>;
}

export default function CatalogEditor({ type, record, onSaved, onClose }) {
  const [form,setForm] = useState({ name:record?.name ?? '', code:record?.code ?? '', isActive:record?.isActive ?? true,
    email:record?.email ?? '', phone:record?.phone ?? '', description:record?.description ?? '',
    homeBranchId:record?.homeBranchId ?? '', specializationIds:(record?.specializations ?? []).map((row) => row.id),
    capacityPeriodsPerWeek:record?.capacityPeriodsPerWeek ?? '',
    branchId:record?.branch ?? '', blockId:record?.blockId ?? record?.block?.id ?? '', homeroomTeacherId:record?.homeroomTeacher ?? '' });
  const [options,setOptions] = useState(null);
  const [saving,setSaving] = useState(false);
  const [error,setError] = useState(null);
  useEffect(() => {
    let active = true;
    const loads = type === 'teachers' ? [service.getBranches(),service.getSubjects()]
      : type === 'classes' ? [service.getBranches(),service.getBlocks(),service.getTeachers()] : [];
    Promise.all(loads).then(([branches,other,teachers]) => { if (active) setOptions({ branches:branches?.branches ?? [], subjects:other?.subjects ?? [], blocks:other?.blocks ?? [], teachers:teachers?.teachers ?? [] }); })
      .catch((failure) => { if (active) setError(failure); });
    return () => { active = false; };
  }, [type]);
  const change = (field,value) => { setForm((current) => ({ ...current,[field]:value })); setError(null); };
  const invalid = (field) => error?.errors?.some((item) => item.field === field);
  const textField = (field,label,kind = 'text') => <label className="catalog-field"><span>{label}</span><input type={kind} value={form[field]} required={field === 'name'} aria-invalid={invalid(field) || undefined} aria-describedby={invalid(field) ? 'catalog-error' : undefined} onChange={(event) => change(field,event.target.value)} /></label>;
  const selection = (field,label,rows,optional = false) => <div className="catalog-field"><label htmlFor={`catalog-${field}`}>{label}</label><select id={`catalog-${field}`} value={form[field]} required={!optional} aria-invalid={invalid(field) || undefined} onChange={(event) => change(field,event.target.value)}><option value="">{optional ? 'Không chọn' : 'Chọn…'}</option>{rows.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>;
  async function submit(event) {
    event.preventDefault(); if (saving) return;
    const body = { name:form.name.trim(),code:form.code.trim(),isActive:form.isActive };
    if (type === 'teachers') Object.assign(body,{email:form.email.trim(),phone:form.phone.trim(),specializationIds:form.specializationIds,
      capacityPeriodsPerWeek:form.capacityPeriodsPerWeek === '' ? null : Number(form.capacityPeriodsPerWeek),...(!record ? {homeBranchId:form.homeBranchId} : {})});
    if (type === 'subjects') body.description = form.description.trim();
    if (type === 'classes') Object.assign(body,{branchId:form.branchId,blockId:form.blockId,homeroomTeacherId:form.homeroomTeacherId || null});
    setSaving(true); setError(null);
    try { const [create,update] = METHODS[type]; const saved = record ? await update(record.id,body) : await create(body); onSaved(saved); }
    catch (failure) { setError(failure); } finally { setSaving(false); }
  }
  return <CatalogDialog title={`${record ? 'Sửa' : 'Thêm'} ${NAMES[type]}`} onClose={onClose} busy={saving}>
    <form onSubmit={submit} className="catalog-form">
      {textField('name',type === 'teachers' ? 'Họ tên' : type === 'subjects' ? 'Tên môn học' : 'Tên lớp')}
      {textField('code','Mã')}
      {type === 'teachers' ? <>
        {textField('email','Email','email')}{textField('phone','Điện thoại','tel')}
        <div className="catalog-field"><label htmlFor="catalog-capacity">Giới hạn tiết/tuần</label><input id="catalog-capacity" type="number" min="0" step="1" value={form.capacityPeriodsPerWeek} onChange={(event) => change('capacityPeriodsPerWeek',event.target.value)} /><small>Để trống khi chưa xác nhận. Workload lịch sử không tự trở thành giới hạn.</small></div>
        {record ? <div className="catalog-field"><label htmlFor="catalog-home-branch">Phân hiệu chính</label><input id="catalog-home-branch" readOnly value={record.homeBranchName ?? 'Chưa có trong hồ sơ'} aria-describedby="catalog-home-hint" /><small id="catalog-home-hint">Cố định theo hồ sơ, không được sửa.</small></div>
          : selection('homeBranchId','Phân hiệu chính',options?.branches ?? [])}
        <fieldset className="catalog-wide"><legend>Môn chuyên môn</legend><div className="catalog-checks">{(options?.subjects ?? []).map((subject) => <label key={subject.id}><input type="checkbox" checked={form.specializationIds.includes(subject.id)} onChange={(event) => change('specializationIds',event.target.checked ? [...form.specializationIds,subject.id] : form.specializationIds.filter((id) => id !== subject.id))} />{subject.name}{subject.isActive === false ? ' (ngừng sử dụng)' : ''}</label>)}</div></fieldset>
      </> : null}
      {type === 'classes' ? <>
        {selection('branchId','Phân hiệu',options?.branches ?? [])}{selection('blockId','Khối',options?.blocks ?? [])}
        {selection('homeroomTeacherId','Giáo viên chủ nhiệm',options?.teachers ?? [],true)}
        <p className="tkb-hint catalog-wide">Môn và số tiết của lớp lấy theo định mức đã khai báo cho khối.</p>
      </> : null}
      {type === 'subjects' ? <label className="catalog-field catalog-wide"><span>Mô tả</span><textarea value={form.description} onChange={(event) => change('description',event.target.value)} rows={3} /></label> : null}
      <label className="catalog-check catalog-wide"><input type="checkbox" checked={form.isActive} onChange={(event) => change('isActive',event.target.checked)} />Đang sử dụng</label>
      {!options && !error ? <p className="tkb-hint catalog-wide">Đang tải danh mục…</p> : null}
      {error ? <div id="catalog-error" role="alert" className="tkb-error catalog-wide">{error.message}</div> : null}
      <div className="catalog-actions catalog-wide"><button type="button" disabled={saving} onClick={onClose}>Hủy</button><button className="catalog-primary" type="submit" disabled={saving || !options}>{saving ? 'Đang lưu…' : 'Lưu'}</button></div>
    </form>
  </CatalogDialog>;
}
