/**
 * The shared API base.
 *
 * The prefix lives here and NOWHERE ELSE. A feature's `service.js`
 * writes its paths relative to this (`/schedules/generate`), because
 * `request()` joins `${API}${path}` — so writing `/api/schedules/generate`
 * in a feature produces `/api/api/schedules/generate` and comes back as
 * a catch-all 404 that reads as "the API is broken".
 *
 * The value itself comes from `lib/env.js`, the single reader of
 * `import.meta.env` (AGENTS.md §3).
 */

import { API_BASE } from '../lib/env.js';

export const API = API_BASE;
