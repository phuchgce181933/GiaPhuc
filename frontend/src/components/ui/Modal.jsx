import './Modal.css';
import { useEffect } from 'react';
import Icon from './Icon';

export function Modal({ open, title, onClose, children, footer, width = 480 }) {
  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="gp-modal__overlay" onMouseDown={onClose} role="presentation">
      <div
        className="gp-modal"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {title ? (
          <header className="gp-modal__head">
            <h3>{title}</h3>
            <button
              type="button"
              className="gp-modal__close"
              onClick={onClose}
              aria-label="Close"
            >
              <Icon name="x" size={16} />
            </button>
          </header>
        ) : null}
        <div className="gp-modal__body">{children}</div>
        {footer ? <footer className="gp-modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}