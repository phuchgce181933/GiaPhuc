const GENERATION_LABELS = {
  REQUEST_RECEIVED: 'Đã nhận yêu cầu',
  GENERATING: 'Đang xếp thời khóa biểu',
  SCORING: 'Đang đánh giá phương án',
  COMPLETED: 'Hoàn tất',
  NO_SOLUTION: 'Chưa tìm được phương án hợp lệ',
  FAILED: 'Xảy ra lỗi khi xếp'
};
function travelDetail(detail, available) {
  if (!detail) return null;
  if (!available) return 'Chưa có ma trận thời gian di chuyển giữa các phân hiệu nên hệ thống chưa kiểm tra điều kiện đi lại. Điều này không tắt chức năng điều chuyển giáo viên.';
  return detail;
}
export function StatusBanner({
  travel,
  transfer,
  generation
}) {
  const travelReady = travel?.available === true;
  const transferActive = transfer?.active === true;
  return <section className="tkb-status" data-testid="status-banner" aria-label="Trạng thái xếp thời khóa biểu">
      <ul className="tkb-status-list">
        <li className={`tkb-status-item ${travelReady ? 'tkb-status-used' : 'tkb-status-unavailable'}`} data-testid="travel-status">
          <span className="tkb-status-key">Di chuyển giữa các phân hiệu</span>
          <span className="tkb-status-value">
            {}
            {travelReady ? 'Đã tính đến thời gian di chuyển' : 'Chưa được tính'}
          </span>
          {travel?.detail ? <span className="tkb-status-detail">{travelDetail(travel.detail, travelReady)}</span> : null}
        </li>

        <li className={`tkb-status-item ${transferActive ? 'tkb-status-used' : 'tkb-status-unavailable'}`} data-testid="transfer-status">
          <span className="tkb-status-key">Điều chuyển giáo viên</span>
          <span className="tkb-status-value">
            {transferActive ? transfer.policy === 'AUTO_SHORTAGE' ? 'Tự động xét sau khi xếp tại phân hiệu chính' : `Có ${transfer.allowedTeacherCount} giáo viên được phép điều chuyển` : 'Chưa bật'}
          </span>
          {transfer?.detail ? <span className="tkb-status-detail">{transfer.detail}</span> : null}
        </li>

        {generation ? <li className="tkb-status-item tkb-status-neutral" data-testid="generation-status">
            <span className="tkb-status-key">Tiến trình</span>
            <span className="tkb-status-value">
              {GENERATION_LABELS[generation.status] ?? generation.status}
              {typeof generation.totalTimeMs === 'number' ? ` · ${generation.totalTimeMs} mili giây` : ''}
            </span>
            {Array.isArray(generation.stages) && generation.stages.length > 0 ? <ol className="tkb-stage-list" data-testid="stage-list">
                {generation.stages.map(s => <li key={`${s.status}-${s.atMs}`} className="tkb-stage">
                    <span className="tkb-stage-name">{GENERATION_LABELS[s.status] ?? s.status}</span>
                    <span className="tkb-stage-ms">{s.atMs} mili giây</span>
                  </li>)}
              </ol> : null}
          </li> : null}
      </ul>
    </section>;
}
