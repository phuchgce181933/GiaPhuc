import { api, errorMessage, unwrap } from '../../lib/axios';
export const presentationApi = {
  downloadPptx: async (id, outline) => {
    try { return (await api.post(`/presentations/${id}/pptx`, { outline }, { responseType: 'blob', timeout: 60000 })).data; }
    catch (error) { if (error.response?.data instanceof Blob) { try { error.response.data = JSON.parse(await error.response.data.text()); } catch {} } throw error; }
  },
  list: async () => unwrap(await api.get('/presentations')),
  createOutline: async (input) => unwrap(await api.post('/presentations', input, { timeout: 90_000 })),
  update: async (id, input) => unwrap(await api.patch(`/presentations/${id}`, input)),
  createCanva: async (id, key) => unwrap(await api.post(`/presentations/${id}/canva`, {}, { headers: { 'Idempotency-Key': key }, timeout: 180_000 })),
  connectCanva: async () => unwrap(await api.get('/presentations/canva/connect')),
  connectionStatus: async () => unwrap(await api.get('/presentations/canva/status')),
  export: async (id, format) => unwrap(await api.post(`/presentations/${id}/export`, { format })),
};
export { errorMessage };
