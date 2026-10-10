import { useEffect, useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import { Input, Select } from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import { roleService } from '../service';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Đang hoạt động' },
  { value: 'inactive', label: 'Ngừng hoạt động' },
  { value: 'locked', label: 'Đã khóa' },
];

export function UserFormModal({ open, onClose, onSubmit, initial }) {
  const [roles, setRoles] = useState([]);
  const [form, setForm] = useState({
    email: '',
    password: '',
    roleId: '',
    status: 'active',
    fullName: '',
    phone: '',
  });
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    roleService.listAll().then(setRoles).catch(() => setRoles([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setForm({
        email: initial.email || '',
        password: '',
        roleId: initial.role?._id || initial.roleId || '',
        status: initial.status || 'active',
        fullName: initial.profile?.fullName || '',
        phone: initial.profile?.phone || '',
      });
    } else {
      setForm({ email: '', password: '', roleId: '', status: 'active', fullName: '', phone: '' });
    }
    setErrors({});
  }, [open, initial]);

  function bind(key) {
    return (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const errs = {};
    if (!form.email) errs.email = 'Vui lòng nhập email';
    if (!initial && (!form.password || form.password.length < 8)) {
      errs.password = 'Mật khẩu cần ít nhất 8 ký tự';
    }
    if (!form.roleId) errs.roleId = 'Vui lòng chọn vai trò';
    setErrors(errs);
    if (Object.keys(errs).length) return;

    setSubmitting(true);
    try {
      const payload = {
        email: form.email,
        roleId: form.roleId,
        status: form.status,
        profile: { fullName: form.fullName, phone: form.phone },
      };
      if (!initial) payload.password = form.password;
      await onSubmit(payload);
      onClose();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Sửa người dùng' : 'Tạo người dùng'}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Hủy</Button>
          <Button onClick={handleSubmit} loading={submitting}>{initial ? 'Lưu' : 'Tạo'}</Button>
        </>
      }
    >
      <form className="gp-col" onSubmit={handleSubmit}>
        <Input id="email" label="Email" type="email" value={form.email} onChange={bind('email')} error={errors.email} disabled={!!initial} />
        {!initial ? (
          <Input id="password" label="Mật khẩu ban đầu" type="password" value={form.password} onChange={bind('password')} error={errors.password} hint="Ít nhất 8 ký tự. Người dùng nên đổi mật khẩu sau lần đăng nhập đầu tiên." />
        ) : null}
        <Select id="roleId" label="Vai trò" value={form.roleId} onChange={bind('roleId')} error={errors.roleId}>
          <option value="">Chọn vai trò…</option>
          {roles.map((r) => <option key={r._id} value={r._id}>{r.name} ({r.key})</option>)}
        </Select>
        <Select id="status" label="Trạng thái" value={form.status} onChange={bind('status')}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <Input id="fullName" label="Họ và tên" value={form.fullName} onChange={bind('fullName')} />
        <Input id="phone" label="Điện thoại" value={form.phone} onChange={bind('phone')} />
      </form>
    </Modal>
  );
}
