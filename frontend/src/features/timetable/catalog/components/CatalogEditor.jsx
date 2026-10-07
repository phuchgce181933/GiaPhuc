import { Modal } from '../../../../components/ui/Modal.jsx';
import { useEffect, useState } from 'react';
import * as service from '../service.js';
import './catalog.css';
const NAMES = {
  teachers: 'giáo viên',
  subjects: 'môn học',
  classes: 'lớp'
};
const METHODS = {
  teachers: [service.createTeacher, service.updateTeacher],
  subjects: [service.createSubject, service.updateSubject],
  classes: [service.createClass, service.updateClass]
};
export function CatalogDialog({
  title,
  children,
  busy,
  onClose
}) {
  return <Modal open title={title} onClose={onClose} busy={busy} width={740}>{children}</Modal>;
}
export default function CatalogEditor({
  type,
  record,
  onSaved,
  onClose
}) {
  const [form, setForm] = useState({
    name: record?.name ?? '',
    code: record?.code ?? '',
    isActive: record?.isActive ?? true,
    email: record?.email ?? '',
    phone: record?.phone ?? '',
    description: record?.description ?? '',
    homeBranchId: record?.homeBranchId ?? '',
    specializationIds: (record?.specializations ?? []).map(row => row.id),
    capacityPeriodsPerWeek: record?.capacityPeriodsPerWeek ?? '',
    branchId: record?.branch ?? '',
    blockId: record?.blockId ?? record?.block?.id ?? '',
    homeroomTeacherId: record?.homeroomTeacher ?? '',
    curriculum: (record?.curriculum ?? []).map((item) => ({ subjectId: item.subjectId ?? item.subject?.id ?? item.subject, periodsPerWeek: item.periodsPerWeek ?? 0 }))
  });
  const [options, setOptions] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    let active = true;
    const loads = type === 'teachers'
      ? { branches: service.getBranches(), subjects: service.getSubjects() }
      : type === 'classes'
        ? { bootstrap: service.getCatalogBootstrap ? service.getCatalogBootstrap() : Promise.all([service.getBranches(), service.getBlocks(), service.getTeachers(), service.getSubjects()]).then(([branches, blocks, teachers, subjects]) => ({ branches: branches.branches, blocks: blocks.blocks, teachers: teachers.teachers, subjects: subjects.subjects })) }
        : {};
    setOptions({ branches: [], subjects: [], blocks: [], teachers: [] });
    Promise.all(Object.entries(loads).map(async ([key, promise]) => {
      try { return [key, await promise, null]; } catch (failure) { return [key, null, failure]; }
    })).then((results) => {
      if (!active) return;
      const next = { branches: [], subjects: [], blocks: [], teachers: [] };
      const failures = [];
      for (const [key, payload, failure] of results) {
        if (payload && key === 'bootstrap') {
          next.branches = payload.branches ?? []; next.blocks = payload.blocks ?? []; next.teachers = payload.teachers ?? []; next.subjects = payload.subjects ?? [];
        } else if (payload) next[key] = payload[key] ?? [];
        if (failure) failures.push(`${key}: ${failure.message}`);
      }
      setOptions(next);
      if (failures.length) setError(new Error(`Không tải được một phần danh mục. ${failures.join('; ')}`));
    });
    return () => {
      active = false;
    };
  }, [type]);
  const change = (field, value) => {
    setForm(current => ({
      ...current,
      [field]: value
    }));
    setError(null);
  };
  const invalid = field => error?.errors?.some(item => item.field === field);
  const textField = (field, label, kind = 'text') => <label className="catalog-field"><span>{label}</span><input type={kind} value={form[field]} required={field === 'name'} aria-invalid={invalid(field) || undefined} aria-describedby={invalid(field) ? 'catalog-error' : undefined} onChange={event => change(field, event.target.value)} /></label>;
  const selection = (field, label, rows, optional = false) => <div className="catalog-field"><label htmlFor={`catalog-${field}`}>{label}</label><select id={`catalog-${field}`} value={form[field]} required={!optional} aria-invalid={invalid(field) || undefined} onChange={event => change(field, event.target.value)}><option value="">{optional ? 'Không chọn' : 'Chọn…'}</option>{rows.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></div>;
  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    const body = {
      name: form.name.trim(),
      code: form.code.trim(),
      isActive: form.isActive
    };
    if (type === 'teachers') Object.assign(body, {
      email: form.email.trim(),
      phone: form.phone.trim(),
      specializationIds: form.specializationIds,
      capacityPeriodsPerWeek: form.capacityPeriodsPerWeek === '' ? null : Number(form.capacityPeriodsPerWeek),
      ...(!record ? {
        homeBranchId: form.homeBranchId
      } : {})
    });
    if (type === 'subjects') body.description = form.description.trim();
    if (type === 'classes') Object.assign(body, {
      branchId: form.branchId,
      blockId: form.blockId,
      homeroomTeacherId: form.homeroomTeacherId || null,
      ... (record ? { curriculum: form.curriculum } : {})
    });
    setSaving(true);
    setError(null);
    try {
      const [create, update] = METHODS[type];
      const saved = record ? await update(record.id, body) : await create(body);
      onSaved(saved);
    } catch (failure) {
      setError(failure);
    } finally {
      setSaving(false);
    }
  }
  return <CatalogDialog title={`${record ? 'Sửa' : 'Thêm'} ${NAMES[type]}`} onClose={onClose} busy={saving}>
    <form onSubmit={submit} className="catalog-form">
      {textField('name', type === 'teachers' ? 'Họ tên' : type === 'subjects' ? 'Tên môn học' : 'Tên lớp')}
      {textField('code', 'Mã')}
      {type === 'teachers' ? <>
        {textField('email', 'Email', 'email')}{textField('phone', 'Điện thoại', 'tel')}
        <div className="catalog-field"><label htmlFor="catalog-capacity">Giới hạn tiết/tuần</label><input id="catalog-capacity" type="number" min="0" step="1" value={form.capacityPeriodsPerWeek} onChange={event => change('capacityPeriodsPerWeek', event.target.value)} /><small>Để trống khi chưa xác nhận. Số tiết lịch sử không tự trở thành giới hạn.</small></div>
        {record ? <div className="catalog-field"><label htmlFor="catalog-home-branch">Phân hiệu chính</label><input id="catalog-home-branch" readOnly value={record.homeBranchName ?? 'Chưa có trong hồ sơ'} aria-describedby="catalog-home-hint" /><small id="catalog-home-hint">Cố định theo hồ sơ, không được sửa.</small></div> : selection('homeBranchId', 'Phân hiệu chính', options?.branches ?? [])}
        <fieldset className="catalog-wide"><legend>Môn chuyên môn</legend><div className="catalog-checks">{(options?.subjects ?? []).map(subject => <label key={subject.id}><input type="checkbox" checked={form.specializationIds.includes(subject.id)} onChange={event => change('specializationIds', event.target.checked ? [...form.specializationIds, subject.id] : form.specializationIds.filter(id => id !== subject.id))} />{subject.name}{subject.isActive === false ? ' (ngừng sử dụng)' : ''}</label>)}</div></fieldset>
      </> : null}
      {type === 'classes' ? <>
        {selection('branchId', 'Phân hiệu', options?.branches ?? [])}{selection('blockId', 'Khối', options?.blocks ?? [])}
        {selection('homeroomTeacherId', 'Giáo viên chủ nhiệm', options?.teachers ?? [], true)}
        <fieldset className="catalog-wide"><legend>Môn / tiết mỗi tuần</legend><p className="tkb-hint">Điều chỉnh riêng cho lớp này. Số tiết là số nguyên từ 0 đến 20.</p>
          {(options?.subjects ?? []).filter((subject) => subject.isActive !== false).map((subject) => { const row = form.curriculum.find((item) => item.subjectId === subject.id); return <label className="catalog-curriculum-row" key={subject.id}><span>{subject.name}</span><input aria-label={`Số tiết ${subject.name}`} type="number" min="0" max="20" step="1" value={row?.periodsPerWeek ?? 0} onChange={(event) => { const periodsPerWeek = Number(event.target.value); setForm((current) => ({ ...current, curriculum: [...current.curriculum.filter((item) => item.subjectId !== subject.id), { subjectId: subject.id, periodsPerWeek }] })); setError(null); }} /></label>; })}
        </fieldset>
      </> : null}
      {type === 'subjects' ? <label className="catalog-field catalog-wide"><span>Mô tả</span><textarea value={form.description} onChange={event => change('description', event.target.value)} rows={3} /></label> : null}
      <label className="catalog-check catalog-wide"><input type="checkbox" checked={form.isActive} onChange={event => change('isActive', event.target.checked)} />Đang sử dụng</label>
      {!options && !error ? <p className="tkb-hint catalog-wide">Đang tải danh mục…</p> : null}
      {error ? <div id="catalog-error" role="alert" className="tkb-error catalog-wide">{error.message}</div> : null}
      <div className="catalog-actions catalog-wide"><button type="button" disabled={saving} onClick={onClose}>Hủy</button><button className="catalog-primary" type="submit" disabled={saving || !options}>{saving ? 'Đang lưu…' : 'Lưu'}</button></div>
    </form>
  </CatalogDialog>;
}
