import { api, unwrap } from '../../lib/axios';

export const userService = {
  async list(params = {}) {
    // Backend shape: { success, message, data: [...items], meta: { items, total, page, limit, pages } }
    const res = await api.get('/users', { params });
    return res.data?.meta || { items: [], total: 0, page: 1, limit: 20, pages: 1 };
  },
  async getOne(id) {
    const data = unwrap(await api.get(`/users/${id}`));
    return data;
  },
  async create(payload) {
    const data = unwrap(await api.post('/users', payload));
    return data;
  },
  async update(id, payload) {
    const data = unwrap(await api.patch(`/users/${id}`, payload));
    return data;
  },
  async changeRole(id, roleId) {
    const data = unwrap(await api.patch(`/users/${id}/role`, { roleId }));
    return data;
  },
  async changeStatus(id, status) {
    const data = unwrap(await api.patch(`/users/${id}/status`, { status }));
    return data;
  },
  async remove(id) {
    const data = unwrap(await api.delete(`/users/${id}`));
    return data;
  },
};

export const roleService = {
  async list(params = {}) {
    // Backend shape: { success, message, data: [...items], meta: { items, total, page, limit, pages } }
    const res = await api.get('/roles', { params });
    return res.data?.meta || { items: [], total: 0, page: 1, limit: 20, pages: 1 };
  },
  async listAll() {
    const res = await this.list({ limit: 100 });
    return res.items || [];
  },
  async getOne(id) {
    const data = unwrap(await api.get(`/roles/${id}`));
    return data;
  },
  async create(payload) {
    const data = unwrap(await api.post('/roles', payload));
    return data;
  },
  async update(id, payload) {
    const data = unwrap(await api.patch(`/roles/${id}`, payload));
    return data;
  },
  async remove(id) {
    const data = unwrap(await api.delete(`/roles/${id}`));
    return data;
  },
};

export const permissionService = {
  async catalog() {
    const data = unwrap(await api.get('/permissions'));
    return data;
  },
};