import { api, unwrap } from '../../lib/axios';

export async function loginRequest(email, password) {
  const data = unwrap(await api.post('/auth/login', { email, password }));
  return data;
}

export async function refreshRequest(refreshToken) {
  const data = unwrap(await api.post('/auth/refresh', { refreshToken }));
  return data;
}

export async function changePasswordRequest(currentPassword, newPassword) {
  const data = unwrap(await api.post('/auth/change-password', { currentPassword, newPassword }));
  return data;
}