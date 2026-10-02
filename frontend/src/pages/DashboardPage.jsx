import { useEffect } from 'react';
import { Card } from '../components/ui/Card';
import { useAuth, usePermission } from '../features/auth/hooks';
import { PERMISSIONS } from '../features/auth/permissions';
import Icon from '../components/ui/Icon';
import { useTopbar } from '../layouts/AdminLayout';
import { roleService, userService } from '../features/user/service';
import { useState } from 'react';

const NAV = [
  { to: '/users', label: 'Users', icon: 'users', require: [PERMISSIONS.USER_VIEW] },
  { to: '/roles', label: 'Roles', icon: 'shield', require: [PERMISSIONS.ROLE_VIEW] },
  { to: '/profile', label: 'Profile', icon: 'user', require: null },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const perm = usePermission();
  const { set } = useTopbar();
  const isAdmin = perm.hasAll([PERMISSIONS.USER_VIEW]);

  const [stats, setStats] = useState({ users: 0, roles: 0, activeUsers: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    set({
      title: `Welcome, ${user?.profile?.fullName || user?.email}`,
      subtitle: 'Your account overview and quick actions',
      breadcrumbs: [{ label: 'Dashboard' }],
    });
    return () => set({ title: '', subtitle: '', breadcrumbs: [] });
  }, [set, user]);

  useEffect(() => {
    if (!isAdmin) { setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const [usersRes, rolesRes] = await Promise.all([
          userService.list({ limit: 100 }),
          roleService.list({ limit: 100 }),
        ]);
        if (cancelled) return;
        const totalUsers = usersRes.total || usersRes.items?.length || 0;
        const activeUsers = (usersRes.items || []).filter((u) => u.status === 'active').length;
        setStats({
          users: totalUsers,
          roles: rolesRes.total || rolesRes.items?.length || 0,
          activeUsers,
        });
      } catch {
        // Non-blocking — dashboard should still render
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  return (
    <div className="gp-page">
      {isAdmin ? (
        <section className="gp-stat-grid" aria-label="System stats">
          <StatCard
            icon="users"
            label="Total users"
            value={loading ? '—' : stats.users}
            tone="indigo"
          />
          <StatCard
            icon="checkCircle"
            label="Active users"
            value={loading ? '—' : stats.activeUsers}
            tone="emerald"
          />
          <StatCard
            icon="shield"
            label="Roles configured"
            value={loading ? '—' : stats.roles}
            tone="violet"
          />
          <StatCard
            icon="clock"
            label="Last login"
            value={user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : '—'}
            tone="slate"
          />
        </section>
      ) : null}

      <div className="gp-col" style={{ maxWidth: 720 }}>
        <Card title="Account">
          <div className="gp-col">
            <DetailRow label="Email" value={user?.email} />
            <DetailRow label="Role" value={user?.role?.name || user?.role?.key} />
            <DetailRow label="Status" value={user?.status} />
            <DetailRow
              label="Member since"
              value={user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
            />
          </div>
        </Card>

        <Card title="Quick actions">
          <div className="gp-row" style={{ gap: 10, flexWrap: 'wrap' }}>
            {NAV.filter((n) => !n.require || perm.hasAll(n.require)).map((n) => (
              <a key={n.to} href={n.to} className="gp-action">
                <span className="gp-action__icon" aria-hidden><Icon name={n.icon} size={16} /></span>
                <span>{n.label}</span>
              </a>
            ))}
          </div>
        </Card>

        {!isAdmin ? (
          <Card title="Tip">
            <p className="gp-muted" style={{ margin: 0 }}>
              You can update your profile from the menu.
            </p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, tone }) {
  return (
    <div className={`gp-stat gp-stat--${tone}`}>
      <div className="gp-stat__icon" aria-hidden><Icon name={icon} size={20} /></div>
      <div className="gp-stat__body">
        <div className="gp-stat__label">{label}</div>
        <div className="gp-stat__value">{value}</div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }) {
  return (
    <div className="gp-detail-row">
      <span className="gp-detail-row__label">{label}</span>
      <span className="gp-detail-row__value">{value}</span>
    </div>
  );
}