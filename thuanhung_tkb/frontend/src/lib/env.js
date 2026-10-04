/**
 * The only place `import.meta.env` is read.
 *
 * Vite statically replaces `import.meta.env.VITE_*` at build time, so
 * the value is baked into the bundle — which is precisely why it must
 * be read once, in one file, and exported as a plain constant. Every
 * other module importing `import.meta.env` directly would be a second
 * place to change when the base URL moves, and a second place where a
 * misspelled key silently becomes `undefined` (AGENTS.md §3).
 *
 * WHY THE FALLBACK IS `??` AND NOT `||`
 * ------------------------------------
 * An empty string in a `.env` file is a real, if mistaken, value —
 * someone emptied the variable to point the app at the same origin
 * through a different path. `||` would discard it and silently
 * substitute `/api`; `??` keeps it and lets the mistake be visible.
 */

/** The API base, without a trailing slash. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export default { API_BASE };
