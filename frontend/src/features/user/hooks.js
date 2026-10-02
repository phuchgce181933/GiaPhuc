import { useEffect, useState, useCallback } from 'react';
import { userService } from './service';
import { useUsersStore } from './store';

export function useUsersList() {
  const filters = useUsersStore((s) => s.filters);
  const [items, setItems] = useState([]);
  const [meta, setMeta] = useState({ total: 0, page: 1, pages: 1, limit: 20 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = {
        ...filters,
        page: filters.page,
        limit: filters.limit,
      };
      const data = await userService.list(params);
      setItems(data.items || []);
      setMeta({ total: data.total || 0, page: data.page || 1, pages: data.pages || 1, limit: data.limit || 20 });
    } catch (e) {
      setError(e?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { reload(); }, [reload]);

  return { items, meta, loading, error, reload };
}

export function useUser(id) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const u = await userService.getOne(id);
      setUser(u);
    } catch (e) {
      setError(e?.message || 'Failed to load user');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  return { user, loading, error, setUser, reload };
}