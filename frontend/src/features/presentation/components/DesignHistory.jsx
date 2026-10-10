import { useState } from 'react';
import { PERMISSIONS } from '../../../lib/env';
import { usePermission } from '../../auth/hooks';
import Button from '../../../components/ui/Button';
import Icon from '../../../components/ui/Icon';
import { Modal } from '../../../components/ui/Modal';
import { presentationApi, errorMessage } from '../service';

export default function DesignHistory({ rows, onOpen, onDeleted }) {
  const [target,setTarget]=useState(null),[deleting,setDeleting]=useState(false),[error,setError]=useState('');
  const canDelete=usePermission().hasAll([PERMISSIONS.PRESENTATION_DELETE]);
  async function confirmDelete() {
    setDeleting(true);setError('');
    try { await presentationApi.remove(target._id);onDeleted(target._id);setTarget(null); }
    catch (e) { setError(errorMessage(e)); }
    finally { setDeleting(false); }
  }
  return <section className="presentation-history">
    <div className="card-heading"><div><span className="eyebrow">KHÔNG GIAN LÀM VIỆC</span><h2>Lịch sử thiết kế</h2></div></div>
    {rows.length?<div className="history-list">{rows.map(row=><article className="history-row" key={row._id}>
      <button type="button" className="history-row__open" onClick={()=>onOpen(row)} aria-label={`Mở ${row.title}`}>
        <span><b>{row.title}</b><small>{new Date(row.createdAt).toLocaleString('vi-VN')}</small></span>
        <em>{({ready:'Đã sẵn sàng',creating:'Đang tạo trên Canva',completed:'Đã tạo',failed:'Lỗi'})[row.status]||row.status}</em>
      </button>
      {canDelete&&<button type="button" className="history-row__delete" onClick={()=>{setError('');setTarget(row)}} aria-label={`Xóa ${row.title}`} title="Xóa lịch sử thiết kế"><Icon name="trash" size={18}/></button>}
    </article>)}</div>:<p className="gp-muted">Chưa có bài thuyết trình nào.</p>}
    <Modal open={!!target} title="Xóa lịch sử thiết kế" busy={deleting} onClose={()=>{setTarget(null);setError('')}} footer={<><Button variant="ghost" onClick={()=>setTarget(null)} disabled={deleting}>Hủy</Button><Button variant="danger" onClick={confirmDelete} loading={deleting}>Xóa</Button></>}>
      <p>Bạn có chắc muốn xóa <b>{target?.title}</b>?</p>
      <p className="gp-muted">Bản thiết kế và các ảnh/video đã lưu của bản này sẽ bị xóa. Thao tác không thể hoàn tác.</p>
      {error&&<div className="presentation-alert" role="alert">{error}</div>}
    </Modal>
  </section>;
}
