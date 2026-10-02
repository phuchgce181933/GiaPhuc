import { useEffect, useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import { Input, Select } from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import { roleService } from '../service';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'locked', label: 'Locked' },
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
    if (!form.email) errs.email = 'Email is required';
    if (!initial && (!form.password || form.password.length < 8)) {
      errs.password = 'Min 8 characters';
    }
    if (!form.roleId) errs.roleId = 'Role is required';
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
      title={initial ? 'Edit user' : 'Create user'}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={handleSubmit} loading={submitting}>{initial ? 'Save' : 'Create'}</Button>
        </>
      }
    >
      <form className="gp-col" onSubmit={handleSubmit}>
        <Input id="email" label="Email" type="email" value={form.email} onChange={bind('email')} error={errors.email} disabled={!!initial} />
        {!initial ? (
          <Input id="password" label="Initial password" type="password" value={form.password} onChange={bind('password')} error={errors.password} hint="Min 8 characters. The user should change this after first login." />
        ) : null}
        <Select id="roleId" label="Role" value={form.roleId} onChange={bind('roleId')} error={errors.roleId}>
          <option value="">Select role…</option>
          {roles.map((r) => <option key={r._id} value={r._id}>{r.name} ({r.key})</option>)}
        </Select>
        <Select id="status" label="Status" value={form.status} onChange={bind('status')}>
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <Input id="fullName" label="Full name" value={form.fullName} onChange={bind('fullName')} />
        <Input id="phone" label="Phone" value={form.phone} onChange={bind('phone')} />
      </form>
    </Modal>
  );
}