/**
 * Phase 32 — the API client for the scheduling feature.
 *
 * ALL network access for this feature goes through this module. No
 * component calls `fetch` itself, which is what makes "the UI talks to
 * the backend only over HTTP" a property of the code rather than a
 * convention (brief §1).
 *
 * WHAT THIS MODULE DOES NOT KNOW
 * ------------------------------
 * It does not know what a solver is, what a placement is, or what a
 * scoring dimension means. It knows a request has three fields and a
 * response has a documented shape. The UI never imports
 * `solver.js`, `constraints/`, `global-scoring.js` or
 * `multi-solution.js` — those are backend modules and are not on this
 * side of the boundary.
 *
 * ERROR SHAPE
 * -----------
 * An HTTP failure becomes an `ApiError` carrying the BACKEND's status
 * and its `errors[]` array, not a string. A UI that has to show "why
 * was this rejected" needs the per-field codes the contract already
 * produces; flattening them to `e.message` would throw that away
 * (brief §28).
 */

import { API } from '../../services/api.js';

/** An HTTP failure with the backend's own error payload attached. */
export class ApiError extends Error {
  constructor(message, { status, errors, payload } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.errors = errors ?? [];
    this.payload = payload ?? null;
  }

  /** True when the request itself was malformed (400). */
  get isInvalidInput() {
    return this.status === 400;
  }
}

/**
 * `API` ALREADY IS `/api`.
 *
 * The paths below are therefore written WITHOUT the `/api` prefix,
 * because `request` joins `${API}${path}`. Writing
 * `/api/schedules/generate` here produced `/api/api/schedules/generate`,
 * which the backend answered with its catch-all 404 — a failure that
 * reads as "the API is broken" rather than "this string is doubled".
 * The prefix lives in exactly one place, `src/services/api.js`.
 */

/** `GET /api/schedules/health` — what this deployment can do. */
export async function fetchHealth() {
  return request('/schedules/health', { method: 'GET' });
}

/**
 * `POST /api/schedules/generate`
 *
 * `placementDetail` mirrors the backend's `?placements=` level. The
 * default is `all` because the API's default is `all` and a silent
 * downgrade would hand the UI empty timetables it never asked for
 * (brief §10, §40).
 */
export async function generateSchedules(body, { placementDetail = 'all', signal } = {}) {
  const query = placementDetail ? `?placements=${encodeURIComponent(placementDetail)}` : '';
  return request(`/schedules/generate${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * `POST /api/schedules/commit`
 *
 * PHASE 33: the body is exactly `{ requestId, solutionId }`. The
 * service sends those two fields and nothing else, so a client cannot
 * post a timetable even by accident — and the backend refuses a body
 * that tries, so the guarantee does not depend on this module being
 * careful.
 *
 * A 200 is NOT assumed to mean "saved". The caller must read
 * `committed` and `persisted`: a rejected commit answers 409 with
 * `persisted: false`, and a read-back mismatch answers 500 with
 * `persisted: false` even though the write technically happened.
 * `commitSolution` surfaces both on the `ApiError` it throws.
 */
export async function commitSolution({ requestId, solutionId }) {
  return request('/schedules/commit', {
    method: 'POST',
    body: JSON.stringify({ requestId, solutionId }),
  });
}

/** `GET /api/schedules/committed` — headers of every committed schedule. */
export async function fetchCommittedSchedules() {
  return request('/schedules/committed', { method: 'GET' });
}

/** `GET /api/schedules/committed/:scheduleId` — one schedule header. */
export async function fetchCommittedSchedule(scheduleId) {
  return request(`/schedules/committed/${encodeURIComponent(scheduleId)}`, { method: 'GET' });
}

async function request(path, { method, body, signal } = {}) {
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body,
      signal,
    });
  } catch (e) {
    // A network failure is not a backend status. It gets its own
    // shape so a UI can say "could not reach the server" instead of
    // rendering a scheduler status it never received.
    throw new ApiError('Could not reach the scheduling API.', {
      status: 0,
      errors: [{ field: 'network', code: 'NETWORK_ERROR', message: String(e?.message ?? e) }],
    });
  }

  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    throw new ApiError('The scheduling API returned a response that was not JSON.', {
      status: res.status,
      errors: [{ field: 'response', code: 'INVALID_RESPONSE', message: 'Response was not JSON.' }],
    });
  }

  if (!res.ok) {
    const errors = payload?.errors ?? (payload?.error ? [payload.error] : []);
    const first = errors[0]?.message ?? `Request failed with status ${res.status}.`;
    throw new ApiError(first, { status: res.status, errors, payload });
  }
  return payload;
}
