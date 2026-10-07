import { NavLink } from 'react-router-dom';
import './Sidebar.css';
import { useAuth, usePermission } from '../../features/auth/hooks';
import { PERMISSIONS } from '../../features/auth/permissions';
import Icon from '../ui/Icon';

const NAV = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', require: null },
  { to: '/users', label: 'Users', icon: 'users', require: [PERMISSIONS.USER_VIEW] },
  { to: '/roles', label: 'Roles & permissions', icon: 'shield', require: [PERMISSIONS.ROLE_VIEW] },
  { to: '/timetable', label: 'Thời khóa biểu', icon: 'dashboard', require: [PERMISSIONS.TKB_VIEW] },
  { to: '/progress-test', label: 'Progress Test', icon: 'dashboard', require: [PERMISSIONS.PROGRESS_VIEW] },
  { to: '/profile', label: 'My profile', icon: 'user', require: null },
];

export default function Sidebar() {
  const { user } = useAuth();
  const perm = usePermission();
  return (
    <aside className="gp-sidebar">
      <div className="gp-sidebar__brand">
        <div className="gp-sidebar__brand-mark" aria-hidden>
          <Icon name="spark" size={18} />
        </div>
        <div>
          <div className="gp-sidebar__brand-name">Gia Phuc</div>
          <div className="gp-sidebar__brand-sub">Admin console</div>
        </div>
      </div>

      <nav className="gp-sidebar__nav" aria-label="Primary">
        {NAV.map((item) => {
          if (item.require && !perm.hasAll(item.require)) return null;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                'gp-sidebar__link' + (isActive ? ' gp-sidebar__link--active' : '')
              }
            >
              <span className="gp-sidebar__icon" aria-hidden>
                <Icon name={item.icon} size={17} />
              </span>
              <span className="gp-sidebar__label">{item.label}</span>
            </NavLink>
          );
        })}
      </nav>

      <div className="gp-sidebar__footer">
        <div className="gp-sidebar__user">
          <div className="gp-sidebar__avatar" aria-hidden>
            {(user?.profile?.fullName || user?.email || '?').slice(0, 1).toUpperCase()}
          </div>
          <div className="gp-sidebar__user-meta">
            <div className="gp-sidebar__user-name">
              {user?.profile?.fullName || user?.username || user?.email}
            </div>
            <div className="gp-sidebar__user-role">{user?.role?.name || user?.role?.key}</div>
          </div>
        </div>
        <div className="gp-sidebar__version">v1.0.0</div>
      </div>
    </aside>
  );
}
