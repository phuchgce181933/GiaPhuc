import { useEffect, useState } from 'react';
import { Table } from '../../../components/ui/Table';
import Button from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { Select, Input } from '../../../components/ui/Input';
import Icon from '../../../components/ui/Icon';
import { useUsersStore } from '../store';
import { useUsersList } from '../hooks';
import { usePermission } from '../../auth/hooks';
import { PERMISSIONS } from '../../auth/permissions';
import { UserFormModal } from '../components/UserFormModal';
import { userService } from '../service';
import { useTopbar } from '../../../layouts/AdminLayout';
import { useToast } from '../../../components/ui/Toast';
import { errorMessage } from '../../../lib/axios';

const STATUS_TONE = { active: 'success', inactive: 'warn', locked: 'danger' };

export default function UserListPage() {
  const perm = usePermission();
  const filters = useUsersStore((s) => s.filters);
  const setFilter = useUsersStore((s) => s.setFilter);
  const resetFilters = useUsersStore((s) => s.resetFilters);
  const { items, meta, loading, error, reload } = useUsersList();

  const { set } = useTopbar();
  const { push, View } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);

  useEffect(() => {
    set({
      title: 'Users',
      subtitle: `${meta.total} ${meta.total === 1 ? 'user' : 'users'} in your organisation`,
      breadcrumbs: [{ label: 'Dashboard', path: '/' }, { label: 'Users' }],
    });
    return () => set({ title: '', subtitle: '', breadcrumbs: [] });
  }, [set, meta.total]);

  async function handleCreate(payload) {
    try {
      await userService.create(payload);
      push('User created', 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
      throw e;
    }
  }
  async function handleUpdate(payload) {
    try {
      await userService.update(editing._id, payload);
      push('User updated', 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
      throw e;
    }
  }
  async function handleDelete(row) {
    if (!confirm(`Delete user "${row.profile?.fullName || row.email}"?`)) return;
    try {
      await userService.remove(row._id);
      push('User deleted', 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
    }
  }
  async function handleStatus(id, status, row) {
    try {
      await userService.changeStatus(id, status);
      push(`Status updated to ${status}`, 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
    }
  }
  async function handleRole(id, roleId) {
    try {
      await userService.changeRole(id, roleId);
      push('Role changed', 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
    }
  }

  const hasFilters = !!(filters.q || filters.status || filters.roleId);

  const columns = [
    {
      key: 'user',
      label: 'User',
      render: (r) => (
        <div className="gp-user-cell">
          <div className="gp-user-cell__avatar" aria-hidden>
            {(r.profile?.fullName || r.email || '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="gp-user-cell__meta">
            <div className="gp-user-cell__name">{r.profile?.fullName || r.username || '—'}</div>
            <div className="gp-user-cell__email gp-muted">{r.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      render: (r) => r.role?.name
        ? <Badge tone="violet">{r.role.name}</Badge>
        : <span className="gp-muted">—</span>,
    },
    {
      key: 'status',
      label: 'Status',
      render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge>,
    },
    {
      key: 'last',
      label: 'Last login',
      render: (r) => (
        <span className="gp-muted" style={{ fontSize: 12 }}>
          {r.lastLoginAt ? new Date(r.lastLoginAt).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      label: '',
      width: 220,
      render: (r) => (
        <div className="gp-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {perm.hasAll([PERMISSIONS.USER_UPDATE]) ? (
            <Button
              size="sm"
              variant="secondary"
              icon={<Icon name="edit" size={14} />}
              onClick={() => { setEditing(r); setModalOpen(true); }}
            >
              Edit
            </Button>
          ) : null}
          {perm.hasAll([PERMISSIONS.USER_CHANGE_STATUS]) ? (
            <Select
              value={r.status}
              onChange={(e) => handleStatus(r._id, e.target.value, r)}
              className="gp-mini-select"
              aria-label={`Change status for ${r.email}`}
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="locked">Locked</option>
            </Select>
          ) : null}
          {perm.hasAll([PERMISSIONS.USER_DELETE]) ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<Icon name="trash" size={14} />}
              onClick={() => handleDelete(r)}
              aria-label={`Delete ${r.email}`}
            />
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="gp-page">
      <div className="gp-toolbar">
        <Input
          placeholder="Search email, name, phone…"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          className="gp-search"
        />
        <Select
          value={filters.status}
          onChange={(e) => setFilter('status', e.target.value)}
          className="gp-filter"
        >
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
          <option value="locked">Locked</option>
        </Select>
        {hasFilters ? (
          <Button variant="ghost" size="sm" onClick={resetFilters} icon={<Icon name="x" size={14} />}>
            Clear filters
          </Button>
        ) : null}
        <div className="gp-toolbar__spacer" />
        {perm.hasAll([PERMISSIONS.USER_CREATE]) ? (
          <Button
            onClick={() => { setEditing(null); setModalOpen(true); }}
            icon={<Icon name="plus" size={14} />}
          >
            Create user
          </Button>
        ) : null}
      </div>

      {error ? <div className="gp-error-banner">{error}</div> : null}

      <Table
        columns={columns}
        rows={items}
        loading={loading}
        empty={
          <div className="gp-empty">
            <div className="gp-empty__icon"><Icon name="users" size={28} /></div>
            <div className="gp-empty__title">{hasFilters ? 'No users match your filters' : 'No users yet'}</div>
            <div className="gp-empty__hint gp-muted">
              {hasFilters
                ? 'Try clearing filters to see everyone.'
                : 'Create your first user to get started.'}
            </div>
          </div>
        }
      />

      <div className="gp-pager">
        <span className="gp-muted" style={{ fontSize: 12 }}>
          Page {meta.page} of {meta.pages} · {meta.total} total
        </span>
        <div className="gp-row" style={{ gap: 8 }}>
          <Button
            size="sm"
            variant="ghost"
            disabled={meta.page <= 1}
            onClick={() => setFilter('page', meta.page - 1)}
            icon={<Icon name="chevronLeft" size={14} />}
          >
            Previous
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={meta.page >= meta.pages}
            onClick={() => setFilter('page', meta.page + 1)}
          >
            Next
            <Icon name="chevronRight" size={14} />
          </Button>
        </div>
      </div>

      <UserFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={editing ? handleUpdate : handleCreate}
        initial={editing}
      />

      <View />

      <style>{`
        .gp-toolbar {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 14px;
          border-radius: var(--radius);
          border: 1px solid var(--border);
          background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01));
        }
        .gp-toolbar__spacer { flex: 1; }
        .gp-search { flex: 1; max-width: 360px; }
        .gp-filter { width: auto; min-width: 160px; }

        .gp-user-cell { display: flex; align-items: center; gap: 12px; }
        .gp-user-cell__avatar {
          width: 34px; height: 34px;
          border-radius: 10px;
          display: grid; place-items: center;
          background: rgba(99,102,241,0.18);
          color: #c7d2fe;
          font-weight: 700;
          font-size: 13px;
          flex-shrink: 0;
        }
        .gp-user-cell__meta { display: flex; flex-direction: column; min-width: 0; }
        .gp-user-cell__name { font-size: 13.5px; font-weight: 600; }
        .gp-user-cell__email { font-size: 12px; }

        .gp-mini-select {
          padding: 4px 8px !important;
          font-size: 12px !important;
          width: auto !important;
        }

        .gp-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 40px 20px;
        }
        .gp-empty__icon {
          width: 56px; height: 56px;
          border-radius: 14px;
          display: grid; place-items: center;
          background: rgba(99,102,241,0.12);
          color: var(--brand);
        }
        .gp-empty__title { font-weight: 600; font-size: 14px; }
        .gp-empty__hint { font-size: 12.5px; }

        .gp-pager {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 0 4px;
        }

        .gp-error-banner {
          padding: 10px 14px;
          border-radius: var(--radius-sm);
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.3);
          color: #fca5a5;
          font-size: 13px;
        }
      `}</style>
    </div>
  );
}