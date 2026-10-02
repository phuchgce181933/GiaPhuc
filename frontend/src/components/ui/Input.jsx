import './Input.css';

function cx(...parts) {
  return parts.filter(Boolean).join(' ');
}

export function Input({ label, error, hint, id, className = '', ...props }) {
  return (
    <div className="gp-field">
      {label ? <label className="gp-field__label" htmlFor={id}>{label}</label> : null}
      <input id={id} className={cx('gp-input', error && 'gp-input--error', className)} {...props} />
      {hint && !error ? <div className="gp-field__hint">{hint}</div> : null}
      {error ? <div className="gp-field__error">{error}</div> : null}
    </div>
  );
}

export function Textarea({ label, error, hint, id, className = '', ...props }) {
  return (
    <div className="gp-field">
      {label ? <label className="gp-field__label" htmlFor={id}>{label}</label> : null}
      <textarea id={id} className={cx('gp-textarea', error && 'gp-textarea--error', className)} rows={props.rows || 3} {...props} />
      {hint && !error ? <div className="gp-field__hint">{hint}</div> : null}
      {error ? <div className="gp-field__error">{error}</div> : null}
    </div>
  );
}

export function Select({ label, error, hint, id, className = '', children, ...props }) {
  return (
    <div className="gp-field">
      {label ? <label className="gp-field__label" htmlFor={id}>{label}</label> : null}
      <select id={id} className={cx('gp-select', error && 'gp-select--error', className)} {...props}>
        {children}
      </select>
      {hint && !error ? <div className="gp-field__hint">{hint}</div> : null}
      {error ? <div className="gp-field__error">{error}</div> : null}
    </div>
  );
}

export function Checkbox({ label, id, checked, onChange, ...rest }) {
  return (
    <label className="gp-checkbox" htmlFor={id}>
      <input id={id} type="checkbox" checked={!!checked} onChange={onChange} {...rest} />
      <span>{label}</span>
    </label>
  );
}