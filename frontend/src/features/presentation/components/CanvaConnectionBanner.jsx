import Button from '../../../components/ui/Button';
export default function CanvaConnectionBanner({ status, onConnect, canConnect }) {
  return <section className="presentation-connection" role="status">
    <div><strong>{status.loading ? 'Đang kiểm tra kết nối Canva…' : status.connected ? 'Đã kết nối tài khoản Canva' : 'Chưa kết nối tài khoản Canva'}</strong>
      {!status.loading && !status.connected && <p>{status.configured
        ? 'Cấu hình đã sẵn sàng. Bấm Kết nối Canva, đăng nhập và cho phép GiaPhuc truy cập. Sau khi quay về trang này mới có thể tạo thiết kế.'
        : 'Backend chưa có đủ cấu hình Canva OAuth. Bạn vẫn có thể dùng AI để soạn cấu trúc slide.'}</p>}
    </div>
    {!status.loading && !status.connected && status.configured && canConnect && <Button onClick={onConnect}>Kết nối Canva</Button>}
  </section>;
}
