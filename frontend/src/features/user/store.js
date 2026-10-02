import { create } from 'zustand';

export const useUsersStore = create((set) => ({
  filters: { q: '', roleId: '', status: '', page: 1, limit: 20 },
  setFilter: (key, value) =>
    set((s) => ({ filters: { ...s.filters, [key]: value, page: key === 'page' ? value : 1 } })),
  resetFilters: () => set({ filters: { q: '', roleId: '', status: '', page: 1, limit: 20 } }),
}));