import { api, errorMessage, unwrap } from '../../lib/axios';
export const presentationApi = {
  downloadPptx: async (id, outline, mediaIds = []) => {
    try { return (await api.post(`/presentations/${id}/pptx`, { outline, mediaIds }, { responseType: 'blob', timeout: 180000 })).data; }
    catch (error) { if (error.response?.data instanceof Blob) { try { error.response.data = JSON.parse(await error.response.data.text()); } catch {} } throw error; }
  },
  list: async () => unwrap(await api.get('/presentations')),
  remove: async (id) => unwrap(await api.delete(`/presentations/${id}`)),
  listMedia: async (id) => unwrap(await api.get(`/presentations/${id}/media`)),
  suggestMedia: async (id, outline) => unwrap(await api.post(`/presentations/${id}/media-plan`, {outline}, {timeout:330000})),
  createMedia: async (id, input) => unwrap(await api.post(`/presentations/${id}/media`, input, { timeout: 150000 })),
  refreshMedia: async (id, assetId) => unwrap(await api.post(`/presentations/${id}/media/${assetId}/refresh`, {}, { timeout: 150000 })),
  mediaContent: async (id, assetId) => (await api.get(`/presentations/${id}/media/${assetId}/content`, { responseType:'blob', timeout: 120000 })).data,
  createOutline: async (input) => unwrap(await api.post('/presentations', input, { timeout: 330000 })),
  update: async (id, input) => unwrap(await api.patch(`/presentations/${id}`, input)),
  createCanva: async (id, key) => unwrap(await api.post(`/presentations/${id}/canva`, {}, { headers: { 'Idempotency-Key': key }, timeout: 180_000 })),
  connectCanva: async () => unwrap(await api.get('/presentations/canva/connect')),
  connectionStatus: async () => unwrap(await api.get('/presentations/canva/status')),
  export: async (id, format) => unwrap(await api.post(`/presentations/${id}/export`, { format })),
};
export { errorMessage };
