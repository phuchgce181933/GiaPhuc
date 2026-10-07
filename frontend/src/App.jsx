import { useEffect } from 'react';
import AppRouter from './routes/AppRouter';
import { useAuth } from './features/auth/hooks';
import AppDialog from './components/common/AppDialog';

export default function App() {
  const { bootstrap } = useAuth();
  useEffect(() => { bootstrap(); }, [bootstrap]);
  return <><AppRouter /><AppDialog /></>;
}
