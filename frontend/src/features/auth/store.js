import { create } from 'zustand';
import { api, tokenStorage, unwrap } from '../../lib/axios';

export const useAuthStore = create((set, get) => ({
  user: null,
  bootstrapped: false,

  bootstrap: async () => {
    if (get().bootstrapped) return;
    if (!tokenStorage.getAccess()) {
      set({ bootstrapped: true });
      return;
    }
    try {
      const me = unwrap(await api.get('/users/me'));
      set({ user: me, bootstrapped: true });
    } catch {
      tokenStorage.clearAll();
      set({ user: null, bootstrapped: true });
    }
  },

  login: async (email, password) => {
    const res = unwrap(await api.post('/auth/login', { email, password }));
    tokenStorage.setAccess(res.tokens.accessToken);
    tokenStorage.setRefresh(res.tokens.refreshToken);
    set({ user: res.user });
    return res.user;
  },

  logout: async () => {
    tokenStorage.clearAll();
    set({ user: null });
  },

  setUser: (user) => set({ user }),
}));

export function selectIsAuthed(s) { return !!s.user; }
export function selectRole(s) { return s.user?.role; }
export function selectPermissions(s) { return s.user?.role?.permissions || []; }