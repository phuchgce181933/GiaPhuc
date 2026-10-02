import { api, unwrap } from '../../lib/axios';

export const profileService = {
  async getMine() { return unwrap(await api.get('/users/me')); },
  async updateMine(payload) { return unwrap(await api.patch(`/users/${payload.id}/profile`, payload.profile)); },
};