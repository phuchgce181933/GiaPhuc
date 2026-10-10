import { confirmDialog } from "../../../components/common/AppDialog";
import { useEffect, useState } from 'react';
import { Card } from '../../../components/ui/Card';
import { Table } from '../../../components/ui/Table';
import { Modal } from '../../../components/ui/Modal';
import { Input, Textarea, Select } from '../../../components/ui/Input';
import Button from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import Icon from '../../../components/ui/Icon';
import { roleService, permissionService } from '../../user/service';
import { errorMessage } from '../../../lib/axios';
import { PERMISSION_GROUPS, PERMISSION_LABELS } from '../../../lib/env';
import { useTopbar } from '../../../layouts/AdminLayout';
import { useToast } from '../../../components/ui/Toast';

export default function RoleListPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ key: '', name: '', description: '', permissions: [] });
  const [collapsedGroups, setCollapsedGroups] = useState({});

  const { set } = useTopbar();
  const { push, View } = useToast();

  useEffect(() => {
    set({
      title: 'Vai trò và quyền',
      subtitle: 'Quy định chức năng mỗi vai trò được xem và sử dụng',
      breadcrumbs: [{ label: 'Tổng quan', path: '/dashboard' }, { label: 'Vai trò' }],
    });
    return () => set({ title: '', subtitle: '', breadcrumbs: [] });
  }, [set]);

  async function reload() {
    setLoading(true);
    try {
      const data = await roleService.list({ limit: 100 });
      setItems(data.items || []);
    } catch (e) {
      push(errorMessage(e), 'danger');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); }, []);

  function openCreate() {
    setEditing(null);
    setForm({ key: '', name: '', description: '', permissions: [] });
    setOpen(true);
  }
  function openEdit(row) {
    setEditing(row);
    setForm({
      key: row.key, name: row.name, description: row.description || '', permissions: row.permissions || [],
    });
    setOpen(true);
  }
  function togglePerm(p) {
    setForm((s) => ({
      ...s,
      permissions: s.permissions.includes(p) ? s.permissions.filter((x) => x !== p) : [...s.permissions, p],
    }));
  }
  function toggleGroup(group) {
    setForm((s) => {
      const has = group.permissions.every((p) => s.permissions.includes(p));
      return {
        ...s,
        permissions: has
          ? s.permissions.filter((p) => !group.permissions.includes(p))
          : Array.from(new Set([...s.permissions, ...group.permissions])),
      };
    });
  }
  function toggleCollapse(g) {
    setCollapsedGroups((s) => ({ ...s, [g]: !s[g] }));
  }

  async function save() {
    try {
      if (editing) {
        await roleService.update(editing._id, {
          name: form.name,
          description: form.description,
          permissions: form.permissions,
        });
        push('Đã cập nhật vai trò', 'success');
      } else {
        await roleService.create({
          key: form.key,
          name: form.name,
          description: form.description,
          permissions: form.permissions,
        });
        push('Đã tạo vai trò', 'success');
      }
      setOpen(false);
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
    }
  }
  async function remove(row) {
    if (!await confirmDialog(`Xóa vai trò "${row.name}"?`)) return;
    try {
      await roleService.remove(row._id);
      push('Đã xóa vai trò', 'success');
      reload();
    } catch (e) {
      push(errorMessage(e), 'danger');
    }
  }

  const columns = [
    {
      key: 'name',
      label: 'Vai trò',
      render: (r) => (
        <div className="gp-role-cell">
          <div className="gp-role-cell__name">{r.name}</div>
          {r.description ? (
            <div className="gp-role-cell__desc gp-muted">{r.description}</div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'key',
      label: 'Mã vai trò',
      render: (r) => <code className="gp-code-chip">{r.key}</code>,
    },
    {
      key: 'perms',
      label: 'Số quyền',
      render: (r) => (
        <div className="gp-row" style={{ gap: 6 }}>
          <Badge tone="violet">{r.permissions?.length || 0}</Badge>
          <span className="gp-muted" style={{ fontSize: 12 }}>đã cấp</span>
        </div>
      ),
    },
    {
      key: 'system',
      label: 'Loại',
      render: (r) => r.isSystem ? <Badge tone="info">Hệ thống</Badge> : <Badge tone="neutral">Tùy chỉnh</Badge>,
    },
    {
      key: 'actions',
      label: '',
      width: 180,
      render: (r) => (
        <div className="gp-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            variant="secondary"
            icon={<Icon name="edit" size={14} />}
            onClick={() => openEdit(r)}
            disabled={r.isSystem}
          >
            Sửa
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon name="trash" size={14} />}
            onClick={() => remove(r)}
            disabled={r.isSystem}
            aria-label={`Xóa vai trò ${r.name}`}
          />
        </div>
      ),
    },
  ];

  return (
    <div className="gp-page">
      <div className="gp-toolbar">
        <div className="gp-toolbar__spacer" />
        <Button onClick={openCreate} icon={<Icon name="plus" size={14} />}>
          Tạo vai trò
        </Button>
      </div>

      <Card>
        <Table
          columns={columns}
          rows={items}
          loading={loading}
          empty={
            <div className="gp-empty">
              <div className="gp-empty__icon"><Icon name="shield" size={28} /></div>
              <div className="gp-empty__title">Chưa có vai trò</div>
              <div className="gp-empty__hint gp-muted">Tạo vai trò đầu tiên để bắt đầu phân quyền.</div>
            </div>
          }
        />
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={editing ? `Sửa vai trò: ${editing.name}` : 'Tạo vai trò'}
        width={720}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>Hủy</Button>
            <Button onClick={save}>Lưu</Button>
          </>
        }
      >
        <div className="gp-col">
          <Input
            label="Mã vai trò"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            disabled={!!editing}
            hint="Chỉ dùng chữ thường, số, dấu gạch ngang hoặc gạch dưới. Không thể đổi sau khi tạo."
          />
          <Input
            label="Tên vai trò"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Textarea
            label="Mô tả"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            rows={2}
          />

          <div className="gp-perm-summary">
            <Badge tone="violet">{form.permissions.length}</Badge>
            <span className="gp-muted" style={{ fontSize: 12 }}>quyền đã cấp</span>
          </div>

          <div className="gp-perm-groups">
            {PERMISSION_GROUPS.map((g) => {
              const granted = g.permissions.filter((p) => form.permissions.includes(p)).length;
              const total = g.permissions.length;
              const collapsed = collapsedGroups[g.key];
              return (
                <div key={g.key} className="gp-perm-group">
                  <button
                    type="button"
                    className="gp-perm-group__head"
                    onClick={() => toggleCollapse(g.key)}
                    aria-expanded={!collapsed}
                  >
                    <span className="gp-perm-group__chevron" aria-hidden>
                      <Icon name={collapsed ? 'chevronRight' : 'chevronDown'} size={14} />
                    </span>
                    <span className="gp-perm-group__label">{g.label}</span>
                    <Badge tone={granted === total ? 'success' : granted === 0 ? 'neutral' : 'info'}>
                      {granted}/{total}
                    </Badge>
                    <span className="gp-perm-group__spacer" />
                    <span
                      role="button"
                      tabIndex={0}
                      className="gp-perm-group__bulk"
                      onClick={(e) => { e.stopPropagation(); toggleGroup(g); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(g); } }}
                    >
                      {granted === total ? 'Bỏ chọn nhóm' : 'Chọn tất cả'}
                    </span>
                  </button>
                  {!collapsed ? (
                    <div className="gp-perm-grid">
                      {g.permissions.map((p) => (
                        <label key={p} className="gp-perm">
                          <input
                            type="checkbox"
                            checked={form.permissions.includes(p)}
                            onChange={() => togglePerm(p)}
                          />
                          <span className="gp-perm__key">{PERMISSION_LABELS[p] || p}</span>
                        </label>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      </Modal>

      <View />

      <style>{`
        .gp-role-cell { display: flex; flex-direction: column; }
        .gp-role-cell__name { font-weight: 600; }
        .gp-role-cell__desc { font-size: 12px; max-width: 36ch; }

        .gp-code-chip {
          font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace;
          font-size: 11.5px;
          padding: 2px 8px;
          border-radius: 6px;
          background: rgba(255,255,255,0.05);
          border: 1px solid var(--border);
          color: var(--text-dim);
        }

        .gp-perm-summary { display: flex; align-items: center; gap: 8px; }
        .gp-perm-groups { display: flex; flex-direction: column; gap: 8px; }
        .gp-perm-group {
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: rgba(255,255,255,0.02);
          overflow: hidden;
        }
        .gp-perm-group__head {
          display: flex;
          align-items: center;
          gap: 10px;
          width: 100%;
          padding: 10px 12px;
          background: transparent;
          border: 0;
          color: var(--text);
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          text-align: left;
        }
        .gp-perm-group__head:hover { background: rgba(255,255,255,0.04); }
        .gp-perm-group__chevron { color: var(--text-mute); display: grid; place-items: center; }
        .gp-perm-group__spacer { flex: 1; }
        .gp-perm-group__bulk {
          font-size: 11.5px;
          font-weight: 500;
          color: var(--brand);
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(99,102,241,0.12);
        }
        .gp-perm-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 6px;
          padding: 6px 10px 12px;
        }
        .gp-perm {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          border: 1px solid var(--border);
          border-radius: 8px;
          cursor: pointer;
          background: rgba(255,255,255,0.02);
          font-size: 12px;
          transition: background-color .12s ease, border-color .12s ease;
        }
        .gp-perm:hover { background: rgba(255,255,255,0.06); border-color: var(--border-strong); }
        .gp-perm__key { font-family: ui-monospace, 'JetBrains Mono', Menlo, monospace; color: var(--text-dim); }
      `}</style>
    </div>
  );
}
