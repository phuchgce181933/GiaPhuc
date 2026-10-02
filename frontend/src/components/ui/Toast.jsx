import { useEffect, useState } from 'react';
import Icon from './Icon';

const ICON_BY_TONE = {
  info: 'infoCircle',
  success: 'checkCircle',
  warn: 'warning',
  danger: 'alertCircle',
};

export function useToast() {
  const [toasts, setToasts] = useState([]);
  function push(message, tone = 'info', ttl = 3500) {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), ttl);
  }
  function remove(id) { setToasts((t) => t.filter((x) => x.id !== id)); }

  const View = () => (
    <div className="gp-toasts" role="region" aria-label="Notifications">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`gp-toast gp-toast--${t.tone}`}
          role={t.tone === 'danger' || t.tone === 'warn' ? 'alert' : 'status'}
          onClick={() => remove(t.id)}
        >
          <span className="gp-toast__icon" aria-hidden>
            <Icon name={ICON_BY_TONE[t.tone] || 'infoCircle'} size={14} />
          </span>
          <span className="gp-toast__msg">{t.message}</span>
        </div>
      ))}
    </div>
  );

  return { push, View };
}

export function ToastHost() { return null; }