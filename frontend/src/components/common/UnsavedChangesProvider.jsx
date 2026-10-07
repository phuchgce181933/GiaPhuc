import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { Modal } from '../ui/Modal.jsx';
import Button from '../ui/Button.jsx';

const Context = createContext({ dirty: false, setDirty: () => {}, requestAction: (action) => action() });
export function useUnsavedChanges() { return useContext(Context); }

export default function UnsavedChangesProvider({ children }) {
  const [dirty, setDirtyState] = useState(false);
  const [pending, setPending] = useState(null);
  const dirtyRef = useRef(false);
  const setDirty = useCallback((value) => { dirtyRef.current = value; setDirtyState(value); }, []);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirtyRef.current && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    const beforeUnload = (event) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const requestAction = (action) => { if (dirtyRef.current) setPending(() => action); else action(); };
  const stay = () => { setPending(null); blocker.reset?.(); };
  const leave = () => {
    setDirty(false);
    if (pending) { const action = pending; setPending(null); action(); }
    else blocker.proceed();
  };
  return <Context.Provider value={{ dirty, setDirty, requestAction }}>{children}
    <Modal open={blocker.state === 'blocked' || !!pending} title="Bạn có thay đổi chưa lưu" onClose={stay}>
      <p>Rời trang sẽ bỏ nội dung đang nhập. Bạn có thể ở lại để lưu trước.</p>
      <div className="gp-row"><Button variant="ghost" onClick={stay}>Ở lại</Button><Button onClick={leave}>Bỏ thay đổi và tiếp tục</Button></div>
    </Modal>
  </Context.Provider>;
}
