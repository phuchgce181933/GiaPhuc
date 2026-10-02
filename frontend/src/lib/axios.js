import axios from 'axios';
import { env } from './env';

const ACCESS_KEY = 'giaphuc.access';
const REFRESH_KEY = 'giaphuc.refresh';

export const tokenStorage = {
  getAccess() { return localStorage.getItem(ACCESS_KEY); },
  setAccess(v) { if (v) localStorage.setItem(ACCESS_KEY, v); },
  clearAccess() { localStorage.removeItem(ACCESS_KEY); },
  getRefresh() { return localStorage.getItem(REFRESH_KEY); },
  setRefresh(v) { if (v) localStorage.setItem(REFRESH_KEY, v); },
  clearRefresh() { localStorage.removeItem(REFRESH_KEY); },
  clearAll() { this.clearAccess(); this.clearRefresh(); },
};

export const api = axios.create({
  baseURL: env.API_BASE_URL,
  timeout: 20_000,
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const t = tokenStorage.getAccess();
  if (t) config.headers.Authorization = `Bearer ${t}`;
  return config;
});

let refreshing = null;

async function doRefresh() {
  if (refreshing) return refreshing;
  const r = tokenStorage.getRefresh();
  if (!r) throw new Error('No refresh token');
  refreshing = axios
    .post(`${env.API_BASE_URL}/auth/refresh`, { refreshToken: r })
    .then((res) => {
      const { accessToken, refreshToken } = res.data?.data || {};
      if (accessToken) tokenStorage.setAccess(accessToken);
      if (refreshToken) tokenStorage.setRefresh(refreshToken);
      return accessToken;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

api.interceptors.response.use(
  (r) => r,
  async (error) => {
    const original = error.config || {};
    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;
      try {
        const newAccess = await doRefresh();
        original.headers.Authorization = `Bearer ${newAccess}`;
        return api.request(original);
      } catch (e) {
        tokenStorage.clearAll();
        // Hard reload to login if running in browser.
        if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
          window.location.assign('/login');
        }
      }
    }
    return Promise.reject(error);
  }
);

export function unwrap(response) {
  return response?.data?.data ?? response?.data ?? null;
}

export function errorMessage(error) {
  const body = error?.response?.data;
  if (body?.details?.issues) {
    return body.details.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
  }
  return body?.message || error?.message || 'Request failed';
}