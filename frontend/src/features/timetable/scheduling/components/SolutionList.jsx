import { COMMIT_STATE } from '../useCommitState.js';
import { localizeSchedulingMessage } from '../messages.js';
function fmt(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}
function rankReasonText(reason) {
  const spread = reason?.match(/workloadSpread=([\d.]+)/)?.[1];
  const maxLoad = reason?.match(/maxLoad=([\d.]+)/)?.[1];
  if (reason?.startsWith('quality-first:')) {
    return `Được xếp hạng cao theo điểm chất lượng${spread ? ` (chênh lệch tải ${spread} tiết` : ''}${maxLoad ? `${spread ? ', ' : ' ('}tải cao nhất ${maxLoad} tiết` : ''}${spread || maxLoad ? ')' : ''}.`;
  }
  if (reason?.startsWith('quality+diversity blend:')) {
    return 'Phương án kết hợp điểm chất lượng và độ khác nhau so với phương án đầu tiên.';
  }
  return 'Phương án được xếp theo điểm chất lượng và các tiêu chí cân bằng.';
}
export function SolutionList({
  solutions = [],
  selectedId,
  onSelect,
  onRequestCommit,
  commitState,
  committed = []
}) {
  if (solutions.length === 0) return null;
  return <section className="tkb-solutions" data-testid="solution-list">
      <h2>Các phương án</h2>
      <p className="tkb-hint">
        Có {solutions.length} phương án, được hệ thống xếp hạng. Điểm chất lượng và độ khác nhau là hai chỉ số riêng.
        Tạo phương án chưa lưu lịch; cần chọn lưu và xác nhận.
      </p>
      <ol className="tkb-solution-list">
        {solutions.map(s => <SolutionCard key={s.id} solution={s} selected={s.id === selectedId} onSelect={onSelect} onRequestCommit={onRequestCommit} commitState={commitState?.solutionId === s.id ? commitState : null} isCommitted={committed.some(c => c.solutionId === s.id)} />)}
      </ol>
    </section>;
}
function SolutionCard({
  solution: s,
  selected,
  onSelect,
  onRequestCommit,
  commitState,
  isCommitted
}) {
  const hardViolations = s.scoring?.hardViolations ?? s.metrics?.hardViolations ?? null;
  const infeasible = s.scoring?.feasibility === 'INFEASIBLE';
  return <li className={`tkb-solution${selected ? ' tkb-solution-selected' : ''}`} data-testid="solution-card" data-solution-id={s.id}>
      <div className="tkb-solution-head">
        <button type="button" className="tkb-solution-select" aria-pressed={selected} onClick={() => onSelect(s.id)}>
          Phương án {s.rank}
        </button>
        <span className="tkb-solution-id" data-testid="solution-id">{s.id}</span>
        {s.rank === 1 ? <span className="tkb-badge">Hạng 1</span> : null}
        {infeasible ? <span className="tkb-badge tkb-badge-warn" data-testid="infeasible-badge">Không hợp lệ</span> : null}
        {isCommitted ? <span className="tkb-badge tkb-badge-ok" data-testid="committed-badge">Đã lưu</span> : null}
      </div>

      <dl className="tkb-metrics" data-testid="quality-metrics">
        <Metric label="Điểm xếp hạng" value={fmt(s.globalScore, 4)} />
        <Metric label="Điểm chất lượng" value={fmt(s.qualityScore, 4)} />
        <Metric label="Chênh lệch tải" value={fmt(s.metrics?.workloadSpread, 1)} />
        <Metric label="Tải cao nhất (tiết)" value={fmt(s.metrics?.maxTeacherLoad, 0)} />
        <Metric label="Độ lệch chuẩn tải" value={fmt(s.metrics?.workloadStdev, 3)} />
        <Metric label="Số giáo viên" value={fmt(s.metrics?.teacherCount, 0)} />
        <Metric label="Tổng số tiết" value={fmt(s.metrics?.totalPeriods, 0)} />
        <Metric label="Vi phạm quy tắc" value={fmt(hardViolations, 0)} />
      </dl>

      {s.metrics?.teacherWorkloads?.length > 0 ? <details className="tkb-scoring" data-testid="overall-workload">
          <summary>Tải giáo viên toàn hệ thống</summary>
          <dl className="tkb-metrics">
            <Metric label="Độ lệch tổng" value={fmt(s.metrics.overallWorkloadSpread, 1)} />
            <Metric label="Độ lệch chuẩn" value={fmt(s.metrics.overallWorkloadStdev, 3)} />
          </dl>
          <div className="tkb-grid-wrap">
            <table className="tkb-grid" aria-label="Tải giáo viên toàn hệ thống">
              <thead><tr><th scope="col">Giáo viên</th><th scope="col">Số tiết</th><th scope="col">Giới hạn tuần</th></tr></thead>
              <tbody>{s.metrics.teacherWorkloads.map(teacher => <tr key={teacher.teacherId}><td>{teacher.teacherName ?? teacher.teacherId}</td><td>{teacher.periods}</td><td>{teacher.capacityPeriodsPerWeek ?? 'Chưa xác nhận'}</td></tr>)}</tbody>
            </table>
          </div>
        </details> : null}

      {Object.keys(s.metrics?.subjectWorkload ?? {}).length > 0 ? <details className="tkb-scoring" data-testid="subject-workload">
          <summary>Cân bằng tải giáo viên theo môn</summary>
          <dl className="tkb-metrics">
            <Metric label="Độ lệch tổng" value={fmt(s.metrics?.subjectWorkloadSpread, 1)} />
            {Object.entries(s.metrics.subjectWorkload).map(([subject, report]) => <div className="tkb-metric" key={report.subjectId ?? subject}>
                <dt>{report.subjectName ?? subject} (lệch {fmt(report.spread, 1)})</dt>
                <dd>{(report.teachers ?? []).map(teacher => `${teacher.teacherName ?? teacher.teacherId}: ${teacher.periods} tiết`).join(' · ')}</dd>
              </div>)}
          </dl>
        </details> : null}

      <details className="tkb-diversity" data-testid="diversity-metrics">
        <summary>So với phương án 1</summary>
        <dl>
          <Metric label="Khác biệt về tiết" value={fmt(s.diversity?.slotToBest, 4)} />
          <Metric label="Khác biệt lịch giáo viên" value={fmt(s.diversity?.teacherDay, 4)} />
          <Metric label="Khác biệt ca dạy" value={fmt(s.diversity?.sessionMix, 4)} />
          <Metric label="Khác biệt tổng thể" value={fmt(s.diversity?.overall, 4)} />
        </dl>
        <p className="tkb-hint">
          Các số liệu cho biết phương án này khác phương án 1 như thế nào; khác nhiều hơn không có nghĩa là tốt hơn.
        </p>
      </details>

      <details className="tkb-scoring" data-testid="scoring-detail">
        <summary>Chi tiết cách xếp hạng</summary>
        {}
        <p className="tkb-rank-reason" data-testid="rank-reason">{rankReasonText(s.scoring?.rankReason)}</p>
        <table className="tkb-dimension-table">
          <thead>
            <tr>
              <th scope="col">Tiêu chí</th>
              <th scope="col">Giá trị</th>
              <th scope="col">Chuẩn hóa</th>
              <th scope="col">Trọng số</th>
              <th scope="col">Đóng góp</th>
              <th scope="col">Trạng thái</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(s.scoring?.dimensions ?? {}).map(([id, d]) => <tr key={id} data-dimension={id} className={d.active ? '' : 'tkb-dim-inactive'}>
                <th scope="row">{id}</th>
                <td>{fmt(d.raw, 3)}</td>
                <td>{fmt(d.normalized, 3)}</td>
                <td>{fmt(d.weight, 2)}</td>
                <td>{fmt(d.contribution, 4)}</td>
                {}
                <td title={d.reason ?? ''}>{d.active ? 'Đang áp dụng' : 'Chưa áp dụng'}</td>
              </tr>)}
          </tbody>
        </table>
      </details>

      <div className="tkb-solution-actions">
        <button type="button" disabled={!onRequestCommit} title={!onRequestCommit ? 'Bạn chưa có quyền lưu TKB' : undefined} onClick={() => onRequestCommit?.(s.id)} data-testid="commit-button">
          Lưu phương án này…
        </button>
        {}
        <button type="button" onClick={() => onSelect(s.id)} aria-pressed={selected} data-testid="preview-button">
          {selected ? 'Đang xem' : 'Xem thử'}
        </button>

        {commitState?.state === COMMIT_STATE.COMMITTING ? <span className="tkb-commit-result" data-testid="commit-pending">
            Đang kiểm tra và lưu…
          </span> : null}

        {commitState?.state === COMMIT_STATE.COMMITTED ? <span className="tkb-commit-result tkb-commit-ok" data-testid="commit-result">
            Đã lưu lịch <code>{commitState.result?.scheduleId}</code>
            {commitState.result?.slotCount != null ? ` · ${commitState.result.slotCount} tiết` : ''}
            {commitState.result?.duplicate ? ' · lịch đã tồn tại, không tạo bản trùng' : ''}
          </span> : null}

        {}
        {commitState?.state === COMMIT_STATE.FAILED ? <span className="tkb-commit-result tkb-commit-failed" data-testid="commit-failed">
            Chưa lưu được lịch. {localizeSchedulingMessage(commitState.error?.message ?? 'Máy chủ từ chối lưu phương án.')}
          </span> : null}
      </div>
    </li>;
}
function Metric({
  label,
  value
}) {
  return <div className="tkb-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>;
}
