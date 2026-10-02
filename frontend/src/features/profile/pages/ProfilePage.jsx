import { useEffect, useState } from 'react';
import { Card } from '../../../components/ui/Card';
import { Input, Select, Textarea } from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import Icon from '../../../components/ui/Icon';
import { useAuth, usePermission } from '../../auth/hooks';
import { PERMISSIONS } from '../../auth/permissions';
import { profileService } from '../service';
import { errorMessage } from '../../../lib/axios';
import { useToast } from '../../../components/ui/Toast';
import { useTopbar } from '../../../layouts/AdminLayout';

export default function ProfilePage() {
  const { user, setUser } = useAuth();
  const perm = usePermission();
  const { push, View } = useToast();
  const { set } = useTopbar();

  const [form, setForm] = useState({
    fullName: '',
    phone: '',
    dob: '',
    gender: '',
    address: '',
    avatarUrl: '',
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    set({
      title: 'My profile',
      subtitle: 'Update your visible details and contact info',
      breadcrumbs: [{ label: 'Dashboard', path: '/' }, { label: 'Profile' }],
    });
    return () => set({ title: '', subtitle: '', breadcrumbs: [] });
  }, [set]);

  useEffect(() => {
    if (!user) return;
    setForm({
      fullName: user.profile?.fullName || '',
      phone: user.profile?.phone || '',
      dob: user.profile?.dob ? String(user.profile.dob).slice(0, 10) : '',
      gender: user.profile?.gender || '',
      address: user.profile?.address || '',
      avatarUrl: user.profile?.avatarUrl || '',
    });
  }, [user]);

  function bind(key) { return (e) => setForm((f) => ({ ...f, [key]: e.target.value })); }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await profileService.updateMine({
        id: user._id,
        profile: { ...form, dob: undefined },
      });
      setUser({ ...user, ...updated });
      push('Profile saved', 'success');
    } catch (err) {
      push(errorMessage(err), 'danger');
    } finally {
      setSaving(false);
    }
  }

  const canEditSelf = perm.hasAll([PERMISSIONS.SELF_PROFILE_UPDATE]);

  return (
    <div className="gp-page">
      <div className="gp-col" style={{ maxWidth: 720, flexDirection: 'row', flexWrap: 'wrap', gap: 20 }}>
        <Card title="Account" className="gp-col" >
          <div className="gp-col">
            <DetailRow icon="mail" label="Email" value={user?.email} />
            <DetailRow icon="key" label="Username" value={user?.username} />
            <DetailRow icon="shield" label="Role" value={user?.role?.name || user?.role?.key} />
            <DetailRow icon="checkCircle" label="Status" value={user?.status} />
            <DetailRow icon="clock" label="Member since" value={user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'} />
          </div>
        </Card>

        <Card title="Profile">
          <form className="gp-col" style={{ maxWidth: 520 }} onSubmit={save}>
            <Input id="fullName" label="Full name" value={form.fullName} onChange={bind('fullName')} disabled={!canEditSelf} />
            <Input id="phone" label="Phone" value={form.phone} onChange={bind('phone')} disabled={!canEditSelf} />
            <Input id="dob" label="Date of birth" type="date" value={form.dob} onChange={bind('dob')} disabled={!canEditSelf} />
            <Select id="gender" label="Gender" value={form.gender} onChange={bind('gender')} disabled={!canEditSelf}>
              <option value="">Prefer not to say</option>
              <option value="male">Male</option>
              <option value="female">Female</option>
              <option value="other">Other</option>
            </Select>
            <Textarea id="address" label="Address" value={form.address} onChange={bind('address')} disabled={!canEditSelf} />
            <Input id="avatarUrl" label="Avatar URL" value={form.avatarUrl} onChange={bind('avatarUrl')} disabled={!canEditSelf} />
            {canEditSelf ? (
              <div>
                <Button type="submit" loading={saving} icon={<Icon name="check" size={14} />}>
                  Save profile
                </Button>
              </div>
            ) : (
              <div className="gp-muted" style={{ fontSize: 12 }}>
                You don't have permission to edit your profile.
              </div>
            )}
          </form>
        </Card>
      </div>

      <View />

      <style>{`
        .gp-col > .gp-col { flex: 1; min-width: 320px; }
      `}</style>
    </div>
  );
}

function DetailRow({ icon, label, value }) {
  return (
    <div className="gp-detail-row">
      <span className="gp-detail-row__label">
        <span style={{ marginRight: 6, color: 'var(--brand)' }}><Icon name={icon} size={13} /></span>
        {label}
      </span>
      <span className="gp-detail-row__value">{value || '—'}</span>
    </div>
  );
}