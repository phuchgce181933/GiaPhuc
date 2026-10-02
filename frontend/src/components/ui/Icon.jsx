/**
 * Inline SVG icon library. Each icon renders at `size` × `size` pixels, inherits
 * `currentColor`, and exposes a `<title>` for screen readers when `label` is given.
 *
 * Keep this file as the single source of truth for icons in the app.
 */

const PATHS = {
  dashboard:
    'M3 3h7v9H3V3Zm0 11h7v7H3v-7Zm11-11h7v5h-7V3Zm0 7h7v11h-7V10Z',
  users:
    'M16 11a4 4 0 1 0-4-4a4 4 0 0 0 4 4Zm-8 0a3.5 3.5 0 1 0-3.5-3.5A3.5 3.5 0 0 0 8 11Zm0 2c-2.67 0-8 1.34-8 4v3h10v-3a5.4 5.4 0 0 1 1.45-3.6A14.6 14.6 0 0 0 8 13Zm8 0a8.3 8.3 0 0 0-1.85.21A5.65 5.65 0 0 1 16 17v3h8v-3c0-2.66-5.33-4-8-4Z',
  shield:
    'M12 2 4 5v7c0 4.78 3.4 8.92 8 10c4.6-1.08 8-5.22 8-10V5l-8-3Zm-1 6 4 4l-6 6l-2-2l4-4l-2-2l2-2Z',
  user:
    'M12 12a4 4 0 1 0-4-4a4 4 0 0 0 4 4Zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4Z',
  logout:
    'M16 17l-1.4-1.4l2.6-2.6H9v-2h8.2l-2.6-2.6L16 7l5 5l-5 5Zm-3-13a8 8 0 1 0 0 16h-1v-2h1a6 6 0 1 1 0-12v-2Z',
  search:
    'M10 4a6 6 0 1 0 3.82 10.62l4.24 4.24l1.42-1.42l-4.24-4.24A6 6 0 0 0 10 4Zm0 2a4 4 0 1 1 0 8a4 4 0 0 1 0-8Z',
  plus:
    'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  check:
    'M9 16.17 5.53 12.7a1 1 0 1 0-1.41 1.41l4.18 4.18a1 1 0 0 0 1.41 0L20.71 7.29a1 1 0 0 0-1.41-1.41L9 16.17Z',
  x:
    'M18.3 5.71 12 12l6.3 6.29a1 1 0 1 1-1.42 1.42L10.59 13.41L4.3 19.71a1 1 0 1 1-1.42-1.42L9.17 12L2.88 5.71a1 1 0 0 1 1.42-1.42l6.29 6.29l6.29-6.29a1 1 0 1 1 1.42 1.42Z',
  trash:
    'M9 3v1H4v2h1v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V6h1V4h-5V3H9Zm2 5h2v9h-2V8Zm-4 0h2v9H7V8Zm8 0h2v9h-2V8Z',
  edit:
    'M3 17.25V21h3.75l11-11.04l-3.75-3.75L3 17.25Zm17.71-10.04a1 1 0 0 0 0-1.42l-2.5-2.5a1 1 0 0 0-1.42 0l-1.83 1.83l3.75 3.75l2-1.66Z',
  filter:
    'M3 4h18v2l-7 8v6l-4-2v-4L3 6V4Z',
  chevronDown:
    'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6l-6-6l1.41-1.41Z',
  chevronRight:
    'M9 6l6 6l-6 6l-1.41-1.41L12.17 12L7.59 7.41L9 6Z',
  bell:
    'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2Zm6-6V11a6 6 0 0 0-5-5.91V4a1 1 0 0 0-2 0v1.09A6 6 0 0 0 6 11v5l-2 2v1h16v-1l-2-2Z',
  warning:
    'M12 5.99 19.53 19H4.47L12 5.99M12 2 1 21h22L12 2Zm1 14h-2v2h2v-2Zm0-6h-2v5h2v-5Z',
  infoCircle:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 15h-2v-6h2v6Zm0-8h-2V7h2v2Z',
  checkCircle:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm-1 13.59L6.41 11L7.83 9.59L11 12.76l5.17-5.17L17.59 9L11 15.59Z',
  alertCircle:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 15h-2v-2h2v2Zm0-4h-2V7h2v6Z',
  cog:
    'M19.43 12.98a7.86 7.86 0 0 0 0-1.96l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.92 7.92 0 0 0-1.69-.98l-.38-2.65A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42L9.13 5.07a7.92 7.92 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65a7.86 7.86 0 0 0 0 1.96L2.46 14.63a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1a7.92 7.92 0 0 0 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65a7.92 7.92 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65ZM12 15.5A3.5 3.5 0 1 1 15.5 12A3.5 3.5 0 0 1 12 15.5Z',
  refresh:
    'M17.65 6.35A7.96 7.96 0 0 0 12 2a8 8 0 1 0 7.74 10h-2a6 6 0 1 1-1.76-7.75L13 7h7V0l-2.35 2.35Z',
  list:
    'M3 5h2v2H3V5Zm0 6h2v2H3v-2Zm0 6h2v2H3v-2Zm4 0h14v2H7v-2Zm0-6h14v2H7v-2Zm0-6h14v2H7V5Z',
  mail:
    'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v.4l8 5l8-5V6H4Zm16 2.84-7.39 5.23a1 1 0 0 1-1.22 0L4 8.84V18h16V8.84Z',
  lock:
    'M17 9V6a5 5 0 0 0-10 0v3H5v13h14V9h-2Zm-8-3a3 3 0 0 1 6 0v3H9V6Zm3 11a2 2 0 1 1 2-2a2 2 0 0 1-2 2Z',
  spark:
    'M12 2 14.39 9.07 22 11.5L14.39 13.93 12 21L9.61 13.93 2 11.5L9.61 9.07 12 2Z',
  building:
    'M19 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Zm-2 18H7v-3h10v3Zm0-5H7v-3h10v3Zm0-5H7V7h10v3Z',
  clock:
    'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm1 11h-5v-2h3V6h2v7Z',
  receipt: `M6 2h12a2 2 0 0 1 2 2v18l-3-2l-3 2l-3-2l-3 2l-3-2V4a2 2 0 0 1 2-2Zm2 6h8v2H8V8Zm0 4h8v2H8v-2Zm0 4h5v2H8v-2Z`,
  wallet:
    'M21 7H5V6a1 1 0 0 1 1-1h13V3H6a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3h15a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1Zm-2 7h-4v2h4v2H6a1 1 0 0 1-1-1V9h14a1 1 0 0 1 1 1v4Z',
  chevronLeft:
    'M15 18l-6-6l6-6l1.41 1.41L10.83 12l5.58 5.59L15 18Z',
  eye:
    'M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Zm0 12a5 5 0 1 1 5-5 5 5 0 0 1-5 5Zm0-8a3 3 0 1 0 3 3 3 3 0 0 0-3-3Z',
  eyeOff:
    'M2 4.27 4.46 5.73l2.12 2.12A11.7 11.7 0 0 0 1 12c1.73 3.89 6 7 11 7a11.6 11.6 0 0 0 5.39-1.32l2.45 2.45l1.42-1.42L3.42 2.85Zm6.85 6.85 2.31 2.31a3 3 0 0 1-4.85-1.84 3 3 0 0 1 .84-2.13l1.7 1.66Zm4.74 4.74-9.46-9.46A11.79 11.79 0 0 1 12 5c5 0 9.27 3.11 11 7a11.74 11.74 0 0 1-3.41 4.27Z',
  key:
    'M21 10h-8.35A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H13l2 2l2-2l2 2l4-4l-4-4Zm-14 4a2 2 0 1 1 2-2 2 2 0 0 1-2 2Z',
};

export default function Icon({ name, size = 18, label, className = '', stroke }) {
  const d = PATHS[name];
  if (!d) return null;
  const isFilled = !stroke;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label ? 'img' : 'presentation'}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      fill={isFilled ? 'currentColor' : 'none'}
      stroke={isFilled ? 'none' : 'currentColor'}
      strokeWidth={isFilled ? undefined : 1.8}
      strokeLinecap={isFilled ? undefined : 'round'}
      strokeLinejoin={isFilled ? undefined : 'round'}
      className={className}
    >
      <path d={d} />
    </svg>
  );
}