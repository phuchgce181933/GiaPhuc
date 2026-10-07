const STATUS_LABELS = {
  OK: 'Đã có',
  MISSING_CONFIGURATION: 'Chưa cấu hình',
  MISSING: 'Còn thiếu',
  UNSUPPORTED: 'Chưa hỗ trợ'
};
const LABELS = {
  source: 'Nguồn dữ liệu',
  legacyServerVersion: 'Phiên bản máy chủ nguồn',
  legacyToolVersion: 'Phiên bản công cụ nguồn',
  teachers: 'Giáo viên',
  branches: 'Phân hiệu',
  classes: 'Lớp',
  subjects: 'Môn học',
  activeSubjects: 'Môn đang hoạt động',
  assignments: 'Phân công',
  curriculum: 'Nội dung chương trình',
  timeSlots: 'Tiết khả dụng',
  travel: 'Di chuyển',
  benchmarkInputHash: 'Mã kiểm tra dữ liệu đầu vào',
  datasetShapeHash: 'Mã kiểm tra cấu trúc dữ liệu',
  dimensionCatalogVersion: 'Phiên bản danh mục tiêu chí',
  scoringDefaultsVersion: 'Phiên bản trọng số mặc định'
};
const STATUS_NAMES = {
  travel: 'Di chuyển',
  branches: 'Phân hiệu',
  curriculum: 'Chương trình học'
};
export function DataReport({
  diagnostics
}) {
  const data = diagnostics?.data;
  const provenance = data?.provenance;
  if (!provenance && !data) return null;
  const counts = provenance?.counts ?? {};
  const status = provenance?.status ?? {};
  const missing = data?.missingData ?? [];
  const warnings = data?.warnings ?? [];
  const timing = diagnostics?.timing;
  return <details className="tkb-data-report" data-testid="data-report">
      <summary>Dữ liệu và thông tin kiểm tra</summary>

      {provenance ? <section className="tkb-report-block">
          <h4>Nguồn</h4>
          <dl className="tkb-metrics">
            <Row label={LABELS.source} value={provenance.source ?? '—'} />
            <Row label={LABELS.legacyServerVersion} value={provenance.legacyServerVersion ?? '—'} />
            <Row label={LABELS.legacyToolVersion} value={provenance.legacyToolVersion ?? '—'} />
          </dl>

          <h4>Số liệu</h4>
          <dl className="tkb-metrics" data-testid="data-counts">
            {Object.entries(counts).map(([key, value]) => <div className="tkb-metric" key={key}>
                <dt>{LABELS[key] ?? key}</dt>
                <dd>{typeof value === 'number' ? value : '—'}</dd>
              </div>)}
          </dl>
        </section> : null}

      {}
      {Object.keys(status).length > 0 ? <section className="tkb-report-block">
          <h4>Trạng thái dữ liệu</h4>
          <ul className="tkb-status-flags" data-testid="data-status">
            {Object.entries(status).map(([key, value]) => <li key={key} className={`tkb-flag tkb-flag-${String(value).toLowerCase()}`}>
                <span className="tkb-flag-key">{STATUS_NAMES[key] ?? key}</span>
                <span className="tkb-flag-value">{STATUS_LABELS[value] ?? value ?? 'Chưa có thông tin'}</span>
              </li>)}
          </ul>
        </section> : null}

      {provenance ? <section className="tkb-report-block">
          <h4>Đối chiếu lần chạy</h4>
          <dl className="tkb-metrics">
            <Row label={LABELS.benchmarkInputHash} value={provenance.benchmarkInputHash ?? '—'} mono />
            <Row label={LABELS.datasetShapeHash} value={provenance.datasetShapeHash ?? '—'} mono />
            <Row label={LABELS.dimensionCatalogVersion} value={provenance.dimensionCatalogVersion ?? '—'} mono />
            <Row label={LABELS.scoringDefaultsVersion} value={provenance.scoringDefaultsVersion ?? '—'} mono />
          </dl>
        </section> : null}

      {missing.length > 0 ? <section className="tkb-report-block">
          <h4>Dữ liệu tùy chọn còn thiếu</h4>
          <ul className="tkb-issue-list" data-testid="missing-data">
            {missing.map((m, i) => <li key={`${m.entity}-${m.entityId}-${m.field}-${i}`}>
                <code>{m.entity}{m.entityId ? `/${m.entityId}` : ''}/{m.field}</code> — {m.reason}
              </li>)}
          </ul>
        </section> : null}

      {warnings.length > 0 ? <section className="tkb-report-block">
          <h4>Cảnh báo khi đọc dữ liệu</h4>
          <ul className="tkb-issue-list" data-testid="loader-warnings">
            {warnings.map((w, i) => <li key={i}>{String(w)}</li>)}
          </ul>
        </section> : null}

      {}
      {Array.isArray(diagnostics?.duplicateSolutionIds) && diagnostics.duplicateSolutionIds.length > 0 ? <p className="tkb-error" data-testid="duplicate-ids">
          Duplicate solution ids: {diagnostics.duplicateSolutionIds.join(', ')}. Selecting a solution
          may highlight the wrong row.
        </p> : null}

      {timing?.breakdown ? <section className="tkb-report-block">
          <h4>Thời gian xử lý</h4>
          <dl className="tkb-metrics" data-testid="timing-breakdown">
            {Object.entries(timing.breakdown).map(([key, value]) => <div className="tkb-metric" key={key}>
                <dt>{{
              solveMs: 'Thời gian xếp',
              scoreMs: 'Thời gian chấm điểm',
              strategyMs: 'Thời gian chọn chiến lược',
              apiOverheadMs: 'Thời gian xử lý API'
            }[key] ?? key}</dt>
                <dd>{typeof value === 'number' ? `${value} mili giây` : '—'}</dd>
              </div>)}
          </dl>
        </section> : null}
    </details>;
}
function Row({
  label,
  value,
  mono = false
}) {
  return <div className="tkb-metric">
      <dt>{label}</dt>
      <dd className={mono ? 'tkb-mono' : undefined}>{value}</dd>
    </div>;
}
