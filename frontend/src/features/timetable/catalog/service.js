import { request } from '../service.js';
export const catalogRequest = request;
export const getTeachers = () => catalogRequest('/teachers');
export const getTeacher = id => catalogRequest(`/teachers/${id}`);
export const getSubjects = () => catalogRequest('/subjects');
export const getClasses = () => catalogRequest('/classes');
export const getClass = id => catalogRequest(`/classes/${id}`);
export const getBranches = () => catalogRequest('/branches');
export const getBranch = id => catalogRequest(`/branches/${id}`);
export const getPreference = id => catalogRequest(`/teachers/${id}/preferences`);
export const savePreference = (id, preference) => catalogRequest(`/teachers/${id}/preferences`, {
  method: 'PUT',
  body: JSON.stringify(preference)
});
export const getDashboard = () => catalogRequest('/dashboard');
export const getBlocks = () => catalogRequest('/blocks');
export const getCatalogBootstrap = () => catalogRequest('/catalog/bootstrap');
export const createTeacher = body => catalogRequest('/teachers', {
  method: 'POST',
  body: JSON.stringify(body)
});
export const updateTeacher = (id, body) => catalogRequest(`/teachers/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(body)
});
export const deleteTeacher = id => catalogRequest(`/teachers/${encodeURIComponent(id)}`, {
  method: 'DELETE'
});
export const createSubject = body => catalogRequest('/subjects', {
  method: 'POST',
  body: JSON.stringify(body)
});
export const updateSubject = (id, body) => catalogRequest(`/subjects/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(body)
});
export const deleteSubject = id => catalogRequest(`/subjects/${encodeURIComponent(id)}`, {
  method: 'DELETE'
});
export const createClass = body => catalogRequest('/classes', {
  method: 'POST',
  body: JSON.stringify(body)
});
export const updateClass = (id, body) => catalogRequest(`/classes/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  body: JSON.stringify(body)
});
export const deleteClass = id => catalogRequest(`/classes/${encodeURIComponent(id)}`, {
  method: 'DELETE'
});
