import './Modal.css';
import { useEffect, useRef, useId } from 'react';
import Icon from './Icon';

export function Modal({ open, title, onClose, children, footer, width = 480, busy = false, testId }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement;
    const dialog = ref.current;
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      if (dialog.open) dialog.close?.();
      document.body.style.overflow = previousOverflow;
      trigger?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog ref={ref} data-testid={testId} className="gp-modal__overlay" aria-labelledby={title ? titleId : undefined}
      onCancel={(event) => { event.preventDefault(); if (!busy) onClose?.(); }}
      onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose?.(); }}>
      <div
        className="gp-modal"
        style={{ maxWidth: width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title ? (
          <header className="gp-modal__head">
            <h3 id={titleId}>{title}</h3>
            <button
              type="button"
              className="gp-modal__close"
              onClick={onClose}
              disabled={busy}
              aria-label="Đóng"
            >
              <Icon name="x" size={16} />
            </button>
          </header>
        ) : null}
        <div className="gp-modal__body">{children}</div>
        {footer ? <footer className="gp-modal__foot">{footer}</footer> : null}
      </div>
    </dialog>
  );
}
