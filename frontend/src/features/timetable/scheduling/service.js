import { request as send } from '../service.js';
export class ApiError extends Error {
  constructor(message, {
    status,
    errors,
    payload
  } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status ?? 0;
    this.errors = errors ?? [];
    this.payload = payload ?? null;
  }
  get isInvalidInput() {
    return this.status === 400;
  }
}
export async function fetchHealth() {
  return request('/schedules/health', {
    method: 'GET'
  });
}
export async function generateSchedules(body, {
  placementDetail = 'all',
  signal
} = {}) {
  const query = placementDetail ? `?placements=${encodeURIComponent(placementDetail)}` : '';
  return request(`/schedules/generate${query}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal
  });
}
export async function commitSolution({
  requestId,
  solutionId
}) {
  return request('/schedules/commit', {
    method: 'POST',
    body: JSON.stringify({
      requestId,
      solutionId
    })
  });
}
export async function fetchCommittedSchedules() {
  return request('/schedules/committed', {
    method: 'GET'
  });
}
export async function fetchCommittedSchedule(scheduleId) {
  return request(`/schedules/committed/${encodeURIComponent(scheduleId)}`, {
    method: 'GET'
  });
}
async function request(path, options = {}) {
  try {
    return await send(path, options);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError(error.message, {
      status: error.status,
      errors: error.errors,
      payload: error.payload
    });
  }
}
export const fetchCommittedScheduleFull = id => request(`/schedules/committed/${encodeURIComponent(id)}/full`);
export async function previewAssistantAdjustment(body) { return request('/assistant/preview', { method: 'POST', body: JSON.stringify(body) }); }
export async function confirmAssistantAdjustment(planId) { return request('/assistant/confirm', { method: 'POST', body: JSON.stringify({ planId }) }); }
