import { api } from '../../lib/axios.js';
export async function request(path, options = {}) {
  const {
    body,
    method = 'GET',
    signal
  } = options;
  try {
    const result = await api.request({
      url: `/timetable${path}`,
      method,
      data: typeof body === 'string' ? JSON.parse(body) : body,
      signal,
      timeout: path.startsWith('/schedules/generate') ? 180_000 : path.startsWith('/assistant/preview') ? 90_000 : 20_000
    });
    return result.data;
  } catch (failure) {
    if (failure.code === 'ERR_CANCELED' || failure.name === 'AbortError') {
      const canceled = new Error('Request canceled');
      canceled.name = 'AbortError';
      throw canceled;
    }
    const payload = failure.response?.data;
    const error = new Error(failure.response?.status === 403 ? 'Bạn chưa có quyền thực hiện thao tác này.' : payload?.errors?.[0]?.message ?? payload?.error?.message ?? payload?.message ?? (failure.response ? 'Không thể thực hiện thao tác.' : 'Không kết nối được máy chủ.'));
    error.status = failure.response?.status ?? 0;
    error.errors = payload?.errors ?? (payload?.error ? [payload.error] : []);
    error.payload = payload;
    throw error;
  }
}
