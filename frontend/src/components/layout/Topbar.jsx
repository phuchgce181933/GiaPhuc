import { useEffect, useRef, useState } from 'react';
import './Topbar.css';
import { useAuth } from '../../features/auth/hooks';
import Button from '../ui/Button';
import { useNavigate } from 'react-router-dom';
import { Badge } from '../ui/Badge';
import Icon from '../ui/Icon';
import { useUnsavedChanges } from '../common/UnsavedChangesProvider.jsx';

const STATUS_TONE = { active: 'success', inactive: 'warn', locked: 'danger' };

export default function Topbar({ title, subtitle, breadcrumbs = [] }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { requestAction } = useUnsavedChanges();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    }
    if (menuOpen) document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [menuOpen]);

  function onLogout() {
    setMenuOpen(false);
    requestAction(() => { logout(); navigate('/login', { replace: true }); });
  }

  function goProfile() {
    setMenuOpen(false);
    navigate('/profile');
  }

  return (
    <header className="gp-topbar">
      <div className="gp-topbar__title-block">
        {breadcrumbs.length > 0 ? (
          <nav className="gp-topbar__crumbs" aria-label="Breadcrumb">
            {breadcrumbs.map((c, i) => (
              <span key={c.path || c.label} className="gp-topbar__crumb">
                {i > 0 ? <Icon name="chevronRight" size={12} /> : null}
                {c.path ? (
                  <a href={c.path} className="gp-topbar__crumb-link">{c.label}</a>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        ) : null}
        <div className="gp-topbar__title">{title || 'Welcome'}</div>
        {subtitle ? <div className="gp-topbar__subtitle">{subtitle}</div> : null}
      </div>

      <div className="gp-topbar__actions">
        {user ? (
          <div className="gp-topbar__user-row">
            <Badge tone={STATUS_TONE[user.status] || 'neutral'}>{user.status}</Badge>
            <button
              type="button"
              className="gp-topbar__user"
              onClick={() => setMenuOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
            >
              <div className="gp-topbar__avatar" aria-hidden>
                {(user.profile?.fullName || user.email || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="gp-topbar__user-meta">
                <div className="gp-topbar__user-name">
                  {user.profile?.fullName || user.username || user.email}
                </div>
                <div className="gp-topbar__user-role">
                  {user.role?.name || user.role?.key}
                </div>
              </div>
              <Icon name="chevronDown" size={14} />
            </button>
            {menuOpen ? (
              <div ref={menuRef} className="gp-topbar__menu" role="menu">
                <button type="button" role="menuitem" className="gp-topbar__menu-item" onClick={goProfile}>
                  <Icon name="user" size={15} />
                  <span>My profile</span>
                </button>
                <div className="gp-topbar__menu-divider" />
                <button type="button" role="menuitem" className="gp-topbar__menu-item gp-topbar__menu-item--danger" onClick={onLogout}>
                  <Icon name="logout" size={15} />
                  <span>Sign out</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <Button variant="secondary" size="sm" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        )}
      </div>
    </header>
  );
}
