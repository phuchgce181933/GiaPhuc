import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Button from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import Icon from '../../../components/ui/Icon';
import { useAuth } from '../hooks';
import { errorMessage } from '../../../lib/axios';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-panel auth-panel--brand">
        <div className="auth-brand">
          <div className="auth-brand__mark"><Icon name="spark" size={22} /></div>
          <div className="auth-brand__name">Gia Phuc</div>
        </div>
        <div className="auth-hero">
          <h1 className="auth-hero__title">Admin console for your organization.</h1>
          <p className="auth-hero__subtitle">
            Manage staff, roles and access from one place. Built for clarity,
            speed and day-to-day operations.
          </p>
        </div>
        <ul className="auth-features">
          <li><Icon name="users" size={16} /><span>Centralised user management</span></li>
          <li><Icon name="shield" size={16} /><span>Granular role-based permissions</span></li>
          <li><Icon name="key" size={16} /><span>Secure password and session control</span></li>
        </ul>
        <div className="auth-foot gp-muted">© {new Date().getFullYear()} Gia Phuc · Internal use only</div>
      </div>

      <div className="auth-panel auth-panel--form">
        <form className="auth-form" onSubmit={onSubmit}>
          <h2 className="auth-form__title">Welcome back</h2>
          <p className="gp-muted auth-form__hint">Sign in with your work credentials.</p>

          <div className="auth-fields">
              <Input
                id="email"
                label="Email"
                type="email"
                autoComplete="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
              <div className="auth-field-with-action">
                <Input
                  id="password"
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="auth-eye"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                </button>
              </div>
            </div>

          {error ? (
            <div className="auth-error" role="alert">
              <Icon name="warning" size={14} />
              <span>{error}</span>
            </div>
          ) : null}

          <Button type="submit" fullWidth loading={loading} size="lg">
            {loading ? 'Signing in…' : 'Sign in'}
          </Button>

          <p className="gp-muted auth-form__legal">
            By signing in you agree to the internal usage policy.
          </p>
        </form>
      </div>

      <style>{`
        .auth-shell {
          min-height: 100vh;
          display: grid;
          grid-template-columns: minmax(320px, 1fr) minmax(420px, 480px);
          padding: 0;
        }
        .auth-panel { display: flex; flex-direction: column; padding: 48px 56px; min-height: 100vh; }
        .auth-panel--brand {
          background: linear-gradient(160deg, rgba(99,102,241,0.22), rgba(139,92,246,0.18) 60%, rgba(11,16,32,0.0));
          border-right: 1px solid var(--border);
          justify-content: space-between;
          gap: 32px;
        }
        .auth-panel--form { background: rgba(11,16,32,0.6); justify-content: center; }

        .auth-brand { display: flex; align-items: center; gap: 12px; }
        .auth-brand__mark {
          width: 40px; height: 40px;
          border-radius: 12px;
          display: grid; place-items: center;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          color: #fff;
          box-shadow: 0 8px 22px rgba(99,102,241,0.45);
        }
        .auth-brand__name {
          font-size: 18px;
          font-weight: 700;
          letter-spacing: .02em;
          background: linear-gradient(135deg, var(--brand), var(--brand-2));
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }

        .auth-hero { display: flex; flex-direction: column; gap: 14px; }
        .auth-hero__title {
          font-size: 32px;
          font-weight: 700;
          line-height: 1.15;
          margin: 0;
          background: linear-gradient(135deg, #f8fafc, #c7d2fe);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
          max-width: 18ch;
        }
        .auth-hero__subtitle { font-size: 14.5px; line-height: 1.6; color: var(--text-dim); max-width: 44ch; margin: 0; }

        .auth-features {
          list-style: none;
          padding: 0; margin: 0;
          display: flex; flex-direction: column; gap: 10px;
        }
        .auth-features li {
          display: flex; align-items: center; gap: 10px;
          color: var(--text-dim); font-size: 13.5px;
          padding: 8px 12px;
          border-radius: 10px;
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border);
        }
        .auth-features li svg { color: var(--brand); }
        .auth-foot { font-size: 11.5px; letter-spacing: .04em; }

        .auth-form { display: flex; flex-direction: column; gap: 18px; max-width: 360px; width: 100%; margin: 0 auto; }
        .auth-form__title { font-size: 24px; font-weight: 700; margin: 0; }
        .auth-form__hint { margin: -6px 0 0; }
        .auth-form__legal { font-size: 11.5px; margin: 0; }

        .auth-fields { display: flex; flex-direction: column; gap: 14px; }
        .auth-field-with-action { position: relative; }
        .auth-field-with-action .gp-input { padding-right: 42px; }
        .auth-eye {
          position: absolute;
          right: 8px; bottom: 8px;
          width: 28px; height: 28px;
          display: grid; place-items: center;
          background: transparent;
          border: 0;
          color: var(--text-mute);
          border-radius: 6px;
          cursor: pointer;
        }
        .auth-eye:hover { color: var(--text); background: rgba(255,255,255,0.06); }

        .auth-error {
          display: flex; align-items: center; gap: 8px;
          color: #fca5a5;
          background: rgba(239,68,68,0.08);
          border: 1px solid rgba(239,68,68,0.3);
          padding: 9px 12px;
          border-radius: var(--radius-sm);
          font-size: 13px;
        }
        .auth-error svg { flex-shrink: 0; }

        @media (max-width: 760px) {
          .auth-shell { grid-template-columns: 1fr; }
          .auth-panel--brand { display: none; }
          .auth-panel { padding: 36px 24px; }
        }
      `}</style>
    </div>
  );
}