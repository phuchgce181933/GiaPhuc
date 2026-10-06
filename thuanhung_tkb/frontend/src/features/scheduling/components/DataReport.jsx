/**
 * Phase 32 — the data report.
 *
 * Answers "what data produced this timetable, and what is missing
 * from it" from the response's own provenance block.
 *
 * WHY IT IS A SEPARATE SURFACE AND NOT A FOOTNOTE
 * -----------------------------------------------
 * `provenance.status` carries three flags, and one of them is a
 * capability gap: `travel: MISSING_CONFIGURATION` on this dataset.
 * A reader who does not see it will read "travel was considered and
 * found acceptable" into a timetable that never scored travel at
 * all. The gap has to be visible next to the counts, not three
 * screens away.
 *
 * THE COUNTS ARE THE BACKEND'S, NOT A RE-COUNT
 * ---------------------------------------------
 * `provenance.counts` is the loader's own effective-count block,
 * re-projected field by field by `mapProvenance`. This component
 * renders those numbers and never counts a directory array itself.
 * Two sources of truth for "how many teachers are there" would
 * disagree the first time a teacher carried no active
 * specialization, and the disagreement would be invisible.
 *
 * THE HASHES ARE SHOWN BECAUSE THEY ARE THE PROOF
 * ----------------------------------------------
 * `benchmarkInputHash` and `datasetShapeHash` are what make "these
 * two runs used the same data and the same scorer" checkable rather
 * than assumed. Truncating them to a friendly prefix would keep the
 * look and lose the property, so they are rendered in full.
 */

const STATUS_LABELS = {
  OK: 'Đã có',
  MISSING_CONFIGURATION: 'Chưa cấu hình',
  MISSING: 'Còn thiếu',
  UNSUPPORTED: 'Chưa hỗ trợ',
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
  scoringDefaultsVersion: 'Phiên bản trọng số mặc định',
};

const STATUS_NAMES = { travel: 'Di chuyển', branches: 'Phân hiệu', curriculum: 'Chương trình học' };

/**
 * @param {object} props
 * @param {object} props.diagnostics  `response.diagnostics`
 */
export function DataReport({ diagnostics }) {
  const data = diagnostics?.data;
  const provenance = data?.provenance;
  if (!provenance && !data) return null;

  const counts = provenance?.counts ?? {};
  const status = provenance?.status ?? {};
  const missing = data?.missingData ?? [];
  const warnings = data?.warnings ?? [];
  const timing = diagnostics?.timing;

  return (
    <details className="tkb-data-report" data-testid="data-report">
      <summary>Dữ liệu và thông tin kiểm tra</summary>

      {provenance ? (
        <section className="tkb-report-block">
          <h4>Nguồn</h4>
          <dl className="tkb-metrics">
            <Row label={LABELS.source} value={provenance.source ?? '—'} />
            <Row label={LABELS.legacyServerVersion} value={provenance.legacyServerVersion ?? '—'} />
            <Row label={LABELS.legacyToolVersion} value={provenance.legacyToolVersion ?? '—'} />
          </dl>

          <h4>Số liệu</h4>
          <dl className="tkb-metrics" data-testid="data-counts">
            {Object.entries(counts).map(([key, value]) => (
              <div className="tkb-metric" key={key}>
                <dt>{LABELS[key] ?? key}</dt>
                <dd>{typeof value === 'number' ? value : '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      {/* The capability flags, each labelled by what its absence
          means. A bare "MISSING_CONFIGURATION" is a code a user
          cannot act on. */}
      {Object.keys(status).length > 0 ? (
        <section className="tkb-report-block">
          <h4>Trạng thái dữ liệu</h4>
          <ul className="tkb-status-flags" data-testid="data-status">
            {Object.entries(status).map(([key, value]) => (
              <li key={key} className={`tkb-flag tkb-flag-${String(value).toLowerCase()}`}>
                <span className="tkb-flag-key">{STATUS_NAMES[key] ?? key}</span>
                <span className="tkb-flag-value">{STATUS_LABELS[value] ?? value ?? 'Chưa có thông tin'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {provenance ? (
        <section className="tkb-report-block">
          <h4>Đối chiếu lần chạy</h4>
          <dl className="tkb-metrics">
            <Row label={LABELS.benchmarkInputHash} value={provenance.benchmarkInputHash ?? '—'} mono />
            <Row label={LABELS.datasetShapeHash} value={provenance.datasetShapeHash ?? '—'} mono />
            <Row label={LABELS.dimensionCatalogVersion} value={provenance.dimensionCatalogVersion ?? '—'} mono />
            <Row label={LABELS.scoringDefaultsVersion} value={provenance.scoringDefaultsVersion ?? '—'} mono />
          </dl>
        </section>
      ) : null}

      {missing.length > 0 ? (
        <section className="tkb-report-block">
          <h4>Dữ liệu tùy chọn còn thiếu</h4>
          <ul className="tkb-issue-list" data-testid="missing-data">
            {missing.map((m, i) => (
              <li key={`${m.entity}-${m.entityId}-${m.field}-${i}`}>
                <code>{m.entity}{m.entityId ? `/${m.entityId}` : ''}/{m.field}</code> — {m.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {warnings.length > 0 ? (
        <section className="tkb-report-block">
          <h4>Cảnh báo khi đọc dữ liệu</h4>
          <ul className="tkb-issue-list" data-testid="loader-warnings">
            {warnings.map((w, i) => <li key={i}>{String(w)}</li>)}
          </ul>
        </section>
      ) : null}

      {/* A duplicate solution id would make "select solution" point at
          the wrong row. It is a backend defect, so it is surfaced as
          one rather than absorbed. */}
      {Array.isArray(diagnostics?.duplicateSolutionIds) && diagnostics.duplicateSolutionIds.length > 0 ? (
        <p className="tkb-error" data-testid="duplicate-ids">
          Duplicate solution ids: {diagnostics.duplicateSolutionIds.join(', ')}. Selecting a solution
          may highlight the wrong row.
        </p>
      ) : null}

      {timing?.breakdown ? (
        <section className="tkb-report-block">
          <h4>Thời gian xử lý</h4>
          <dl className="tkb-metrics" data-testid="timing-breakdown">
            {Object.entries(timing.breakdown).map(([key, value]) => (
              <div className="tkb-metric" key={key}>
                <dt>{({ solveMs: 'Thời gian xếp', scoreMs: 'Thời gian chấm điểm', strategyMs: 'Thời gian chọn chiến lược', apiOverheadMs: 'Thời gian xử lý API' })[key] ?? key}</dt>
                <dd>{typeof value === 'number' ? `${value} mili giây` : '—'}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </details>
  );
}

function Row({ label, value, mono = false }) {
  return (
    <div className="tkb-metric">
      <dt>{label}</dt>
      <dd className={mono ? 'tkb-mono' : undefined}>{value}</dd>
    </div>
  );
}
