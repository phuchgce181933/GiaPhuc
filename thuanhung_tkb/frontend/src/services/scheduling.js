import { API } from './api.js';

export async function previewScheduling(options) {
  const res = await fetch(`${API}/scheduling/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ options }),
  });
  if (!res.ok) throw new Error(`preview failed: ${res.status}`);
  return res.json();
}

export async function commitScheduling(solutionId) {
  const res = await fetch(`${API}/scheduling/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ solutionId }),
  });
  return res.json();
}
