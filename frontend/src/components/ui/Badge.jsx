import './Badge.css';

const TONE = {
  active: 'success',
  inactive: 'warn',
  locked: 'danger',
  success: 'success',
  warn: 'warn',
  danger: 'danger',
  info: 'info',
  violet: 'violet',
  neutral: 'neutral',
};

export function Badge({ children, tone = 'neutral' }) {
  const t = TONE[tone] || 'neutral';
  return <span className={`gp-badge gp-badge--${t}`}>{children}</span>;
}