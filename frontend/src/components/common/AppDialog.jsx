import { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
const queue = [];
let notify;
function ask(options) {
  return new Promise(resolve => { queue.push({ ...options, resolve }); notify?.(); });
}
export const confirmDialog = message => ask({ title: 'Xác nhận', message, kind: 'confirm' });
export const promptDialog = (message, initial = '') => ask({ title: 'Đổi tên', message, initial, kind: 'prompt' });
export default function AppDialog() {
  const [current, setCurrent] = useState(null);
  const [value, setValue] = useState('');
  useEffect(() => {
    const show = () => { const next = queue[0] ?? null; setCurrent(next); setValue(next?.initial ?? ''); };
    notify = show; show();
    return () => { notify = null; while (queue.length) queue.shift().resolve(false); };
  }, []);
  function close(accepted) {
    const next = queue.shift();
    next?.resolve(accepted ? next.kind === 'prompt' ? value.trim() : true : next.kind === 'prompt' ? null : false);
    notify?.();
  }
  return <Modal open={!!current} title={current?.title} onClose={() => close(false)} footer={<><button type="button" onClick={() => close(false)}>Hủy</button><button type="button" disabled={current?.kind === 'prompt' && !value.trim()} onClick={() => close(true)}>Xác nhận</button></>}>
    {current?.kind === 'prompt' ? <label>{current.message}<input autoFocus value={value} maxLength={120} onChange={event => setValue(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && value.trim()) { event.preventDefault(); close(true); } }} style={{ width: '100%', marginTop: 10, padding: 12, background: 'var(--bg-elev-2)', color: 'var(--text)', border: '1px solid var(--border-strong)', borderRadius: 8 }} /></label> : <p>{current?.message}</p>}
  </Modal>;
}
