import { api, errorMessage, unwrap } from '../../lib/axios';
export const presentationApi = {
  list: async () => unwrap(await api.get('/presentations')),
  createOutline: async (input) => unwrap(await api.post('/presentations', input)),
  update: async (id, input) => unwrap(await api.patch(`/presentations/${id}`, input)),
  createCanva: async (id, key) => unwrap(await api.post(`/presentations/${id}/canva`, {}, { headers: { 'Idempotency-Key': key } })),
  connectCanva: async () => unwrap(await api.get('/presentations/canva/connect')),
  export: async (id, format) => unwrap(await api.post(`/presentations/${id}/export`, { format })),
};
export { errorMessage };
