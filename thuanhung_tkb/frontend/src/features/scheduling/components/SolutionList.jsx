/**
 * Phase 32 — the multi-solution selector.
 *
 * Shows every returned solution as `Solution 1`, `Solution 2`, … with
 * the numbers that explain the ranking, rather than an opaque
 * "Solution A" (brief §16).
 *
 * WHERE THE RANK REASONS COME FROM
 * --------------------------------
 * Every "why is this ranked here" string on this component comes from
 * the backend: `scoring.rankReason` and the per-dimension vector in
 * `scoring.dimensions`. The component does not compose its own
 * explanation and does not compute a score. A UI-authored explanation
 * would be a second, unsynchronized account of the same ranking, and
 * the two would disagree the first time a weight was retuned
 * (brief §17).
 *
 * DIVERSITY IS NOT QUALITY
 * ------------------------
 * The diversity numbers are labelled as a comparison against Solution
 * 1, never as a score contribution or a "better" marker.
 * `diversity.slotToBest` and `diversity.overall` are separate axes
 * from `globalScore`, and this component never says "more diverse =
 * better" (brief §18).
 *
 * A MISSING NUMBER IS SHOWN, NOT FILLED
 * -------------------------------------
 * The backend serializes every metric through `numberOrNull`, so an
 * unmeasurable dimension arrives as `null` rather than `0`. `fmt`
 * renders `null` as an em dash. Rendering it as `0.000` would be a
 * false claim: the scorer did not measure this, and a reader who sees
 * zero cannot tell that apart from a measured zero.
 *
 * PHASE 33 — THE COMMIT BUTTON
 * ---------------------------
 * The button says "Save this schedule" and it OPENS THE DIALOG. It
 * does not commit. That distinction is the whole point of the phase:
 * a button labelled "Commit" that writes on click is an auto-commit
 * with a confirmation step somewhere else, and a user who clicks it
 * twice has saved two things (brief §1).
 *
 * A card shows `COMMITTED` only when the backend confirmed a write for
 * THAT solution id, and a card never shows the result of another
 * card's commit — a user reading "Committed" under Solution 2 must
 * not be looking at Solution 1's write (brief §33).
 */

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

/**
 * @param {object}   props
 * @param {object[]} props.solutions    `response.solutions`, verbatim
 * @param {string}   props.selectedId
 * @param {(id: string) => void} props.onSelect
 * @param {(id: string) => void} props.onRequestCommit
 *   opens the confirmation dialog; it does NOT write
 * @param {object}   props.commitState   the COMMIT_STATE machine
 * @param {object[]} props.committed     the backend's committed list
 */
export function SolutionList({
  solutions = [],
  selectedId,
  onSelect,
  onRequestCommit,
  commitState,
  committed = [],
}) {
  if (solutions.length === 0) return null;

  return (
    <section className="tkb-solutions" data-testid="solution-list">
      <h2>Các phương án</h2>
      <p className="tkb-hint">
        Có {solutions.length} phương án, được hệ thống xếp hạng. Điểm chất lượng và độ khác nhau là hai chỉ số riêng.
        Tạo phương án chưa lưu lịch; cần chọn lưu và xác nhận.
      </p>
      <ol className="tkb-solution-list">
        {solutions.map((s) => (
          <SolutionCard
            key={s.id}
            solution={s}
            selected={s.id === selectedId}
            onSelect={onSelect}
            onRequestCommit={onRequestCommit}
            // The commit result belongs to ONE solution. A card that
            // is not the committed one must not render it, or a user
            // would read "Committed" under a schedule that was not
            // the one committed.
            commitState={commitState?.solutionId === s.id ? commitState : null}
            // A solution from an EARLIER generation can be in the
            // committed list even though it is not in `solutions` at
            // all. The panel renders those; a card only needs to know
            // about its own id.
            isCommitted={committed.some((c) => c.solutionId === s.id)}
          />
        ))}
      </ol>
    </section>
  );
}

function SolutionCard({
  solution: s,
  selected,
  onSelect,
  onRequestCommit,
  commitState,
  isCommitted,
}) {
  // `scoring.hardViolations` is the scorer's own count; `metrics` is
  // the independent evaluator's. They are read from their own owners
  // rather than from a made-up `validation` object, so a count is
  // never attributed to a component that did not produce it.
  const hardViolations = s.scoring?.hardViolations ?? s.metrics?.hardViolations ?? null;
  const infeasible = s.scoring?.feasibility === 'INFEASIBLE';

  return (
    <li
      className={`tkb-solution${selected ? ' tkb-solution-selected' : ''}`}
      data-testid="solution-card"
      data-solution-id={s.id}
    >
      <div className="tkb-solution-head">
        <button
          type="button"
          className="tkb-solution-select"
          aria-pressed={selected}
          onClick={() => onSelect(s.id)}
        >
          Phương án {s.rank}
        </button>
        <span className="tkb-solution-id" data-testid="solution-id">{s.id}</span>
        {s.rank === 1 ? <span className="tkb-badge">Hạng 1</span> : null}
        {infeasible ? (
          <span className="tkb-badge tkb-badge-warn" data-testid="infeasible-badge">Không hợp lệ</span>
        ) : null}
        {isCommitted ? (
          <span className="tkb-badge tkb-badge-ok" data-testid="committed-badge">Đã lưu</span>
        ) : null}
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

      {s.metrics?.teacherWorkloads?.length > 0 ? (
        <details className="tkb-scoring" data-testid="overall-workload">
          <summary>Tải giáo viên toàn hệ thống</summary>
          <dl className="tkb-metrics">
            <Metric label="Độ lệch tổng" value={fmt(s.metrics.overallWorkloadSpread, 1)} />
            <Metric label="Độ lệch chuẩn" value={fmt(s.metrics.overallWorkloadStdev, 3)} />
          </dl>
          <div className="tkb-grid-wrap">
            <table className="tkb-grid" aria-label="Tải giáo viên toàn hệ thống">
              <thead><tr><th scope="col">Giáo viên</th><th scope="col">Số tiết</th><th scope="col">Giới hạn tuần</th></tr></thead>
              <tbody>{s.metrics.teacherWorkloads.map((teacher) => (
                <tr key={teacher.teacherId}><td>{teacher.teacherName ?? teacher.teacherId}</td><td>{teacher.periods}</td><td>{teacher.capacityPeriodsPerWeek ?? 'Chưa xác nhận'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </details>
      ) : null}

      {Object.keys(s.metrics?.subjectWorkload ?? {}).length > 0 ? (
        <details className="tkb-scoring" data-testid="subject-workload">
          <summary>Cân bằng tải giáo viên theo môn</summary>
          <dl className="tkb-metrics">
            <Metric label="Độ lệch tổng" value={fmt(s.metrics?.subjectWorkloadSpread, 1)} />
            {Object.entries(s.metrics.subjectWorkload).map(([subject, report]) => (
              <div className="tkb-metric" key={report.subjectId ?? subject}>
                <dt>{report.subjectName ?? subject} (lệch {fmt(report.spread, 1)})</dt>
                <dd>{(report.teachers ?? []).map((teacher) =>
                  `${teacher.teacherName ?? teacher.teacherId}: ${teacher.periods} tiết`,
                ).join(' · ')}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <div className="tkb-diversity" data-testid="diversity-metrics">
        <h4>So với phương án 1</h4>
        <dl>
          <Metric label="Khác biệt về tiết" value={fmt(s.diversity?.slotToBest, 4)} />
          <Metric label="Khác biệt lịch giáo viên" value={fmt(s.diversity?.teacherDay, 4)} />
          <Metric label="Khác biệt ca dạy" value={fmt(s.diversity?.sessionMix, 4)} />
          <Metric label="Khác biệt tổng thể" value={fmt(s.diversity?.overall, 4)} />
        </dl>
        <p className="tkb-hint">
          Các số liệu cho biết phương án này khác phương án 1 như thế nào; khác nhiều hơn không có nghĩa là tốt hơn.
        </p>
      </div>

      <details className="tkb-scoring" data-testid="scoring-detail">
        <summary>Chi tiết cách xếp hạng</summary>
        {/* Verbatim from the backend. Not authored here. */}
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
            {Object.entries(s.scoring?.dimensions ?? {}).map(([id, d]) => (
              <tr key={id} data-dimension={id} className={d.active ? '' : 'tkb-dim-inactive'}>
                <th scope="row">{id}</th>
                <td>{fmt(d.raw, 3)}</td>
                <td>{fmt(d.normalized, 3)}</td>
                <td>{fmt(d.weight, 2)}</td>
                <td>{fmt(d.contribution, 4)}</td>
                {/* An inactive dimension is excluded from the blend
                    because the data cannot support it. Showing the
                    backend's reason is what stops a reader from
                    assuming a missing dimension was simply forgotten. */}
                <td title={d.reason ?? ''}>{d.active ? 'Đang áp dụng' : 'Chưa áp dụng'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="tkb-solution-actions">
        <button
          type="button"
          onClick={() => onRequestCommit(s.id)}
          data-testid="commit-button"
        >
          Lưu phương án này…
        </button>
        {/* A second button, because "select" and "save" are different
            decisions. The card header button only changes what is
            being looked at; nothing is written by either one until
            the dialog is confirmed. */}
        <button
          type="button"
          onClick={() => onSelect(s.id)}
          aria-pressed={selected}
          data-testid="preview-button"
        >
          {selected ? 'Đang xem' : 'Xem thử'}
        </button>

        {commitState?.state === COMMIT_STATE.COMMITTING ? (
          <span className="tkb-commit-result" data-testid="commit-pending">
            Đang kiểm tra và lưu…
          </span>
        ) : null}

        {commitState?.state === COMMIT_STATE.COMMITTED ? (
          <span className="tkb-commit-result tkb-commit-ok" data-testid="commit-result">
            Đã lưu lịch <code>{commitState.result?.scheduleId}</code>
            {commitState.result?.slotCount != null ? ` · ${commitState.result.slotCount} tiết` : ''}
            {commitState.result?.duplicate ? ' · lịch đã tồn tại, không tạo bản trùng' : ''}
          </span>
        ) : null}

        {/* The failure text always leads with "not saved". A rejected
            commit that rendered anything else — or that rendered
            nothing, leaving the previous "Committed" line in place —
            would read as success (brief §15). */}
        {commitState?.state === COMMIT_STATE.FAILED ? (
          <span className="tkb-commit-result tkb-commit-failed" data-testid="commit-failed">
            Chưa lưu được lịch. {localizeSchedulingMessage(commitState.error?.message ?? 'Máy chủ từ chối lưu phương án.')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function Metric({ label, value }) {
  return (
    <div className="tkb-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
