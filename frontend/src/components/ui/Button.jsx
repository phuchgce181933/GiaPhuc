import './Button.css';

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  loading = false,
  disabled = false,
  fullWidth = false,
  icon,
  onClick,
  ...rest
}) {
  return (
    <button
      type={type}
      className={['gp-btn', `gp-btn--${variant}`, `gp-btn--${size}`, fullWidth ? 'gp-btn--full' : ''].join(' ').trim()}
      disabled={disabled || loading}
      onClick={onClick}
      {...rest}
    >
      {loading ? (
        <span className="gp-btn__spinner" aria-hidden />
      ) : icon ? (
        <span className="gp-btn__icon" aria-hidden>{icon}</span>
      ) : null}
      <span className={loading ? 'gp-btn__label gp-btn__label--loading' : 'gp-btn__label'}>{children}</span>
    </button>
  );
}