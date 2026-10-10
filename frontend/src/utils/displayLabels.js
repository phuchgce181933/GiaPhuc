const STATUS_LABELS = { active: 'Đang hoạt động', inactive: 'Ngừng hoạt động', locked: 'Đã khóa' };
const ROLE_LABELS = { administrator: 'Quản trị viên', admin: 'Quản trị viên', user: 'Người dùng', teacher: 'Giáo viên', student: 'Học sinh' };

export function statusLabel(value) {
  return STATUS_LABELS[String(value || '').toLowerCase()] || value || '—';
}

export function roleLabel(role) {
  const value = role?.name || role?.key || role;
  return ROLE_LABELS[String(value || '').toLowerCase()] || value || '—';
}
