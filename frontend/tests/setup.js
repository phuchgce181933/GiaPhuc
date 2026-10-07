import { vi } from 'vitest';

// Legacy functional fixtures emulate HTTP; production uses the authenticated,
// refreshable GiaPhuc Axios client. Routing remains real in component tests.
vi.mock('../src/lib/axios.js', () => ({ api: { request: async ({ url, method, data, signal }) => {
  const response = await fetch(`/api${url}`, { method, signal, headers: data ? { 'content-type': 'application/json' } : undefined,
    body: data === undefined ? undefined : JSON.stringify(data) });
  let payload; try { payload = response.json ? await response.json() : JSON.parse(await response.text()); } catch { payload = null; }
  if (!response.ok) { const error = new Error('HTTP error'); error.response = { status: response.status, data: payload }; throw error; }
  return { data: payload };
} } }));
vi.mock('../src/features/auth/hooks.js', () => ({ usePermission: vi.fn(() => ({ hasAll: () => true, hasAny: () => true, granted: [] })) }));
if (!HTMLDialogElement.prototype.showModal) HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
if (!HTMLDialogElement.prototype.close) HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
