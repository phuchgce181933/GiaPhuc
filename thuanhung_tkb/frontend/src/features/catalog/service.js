import { API } from '../../services/api.js';

export async function catalogRequest(path, options = {}) {
  const response = await fetch(`${API}${path}`, { headers: options.body ? { 'content-type': 'application/json' } : undefined, ...options });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.errors?.[0]?.message ?? 'Không thể tải dữ liệu.');
  return payload;
}
export const getTeachers = () => catalogRequest('/teachers');
export const getTeacher = (id) => catalogRequest(`/teachers/${id}`);
export const getSubjects = () => catalogRequest('/subjects');
export const getClasses = () => catalogRequest('/classes');
export const getClass = (id) => catalogRequest(`/classes/${id}`);
export const getBranches = () => catalogRequest('/branches');
export const getBranch = (id) => catalogRequest(`/branches/${id}`);
export const getPreference = (id) => catalogRequest(`/teachers/${id}/preferences`);
export const savePreference = (id, preference) => catalogRequest(`/teachers/${id}/preferences`, { method: 'PUT', body: JSON.stringify(preference) });
export const getDashboard = () => catalogRequest('/dashboard');
