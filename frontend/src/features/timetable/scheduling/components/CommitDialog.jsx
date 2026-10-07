import { Modal } from '../../../../components/ui/Modal.jsx';
import { COMMIT_STATE } from '../useCommitState.js';
import { localizeSchedulingMessage } from '../messages.js';
function fmt(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}
function fmtInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}
export function CommitDialog({
  solution,
  state,
  onConfirm,
  onCancel,
  error,
  travel
}) {
  if (!solution) return null;
  const committing = state === COMMIT_STATE.COMMITTING;
  const failed = state === COMMIT_STATE.FAILED;
  return <Modal open testId="commit-dialog" title="Xác nhận lưu thời khóa biểu" busy={committing} onClose={onCancel} width={560}>
      <div className="tkb-commit-dialog-content">
        <p className="tkb-hint" data-testid="commit-dialog-subject">
          Phương án {solution.rank} · <code>{solution.id}</code>
        </p>

        {}
        <dl className="tkb-metrics" data-testid="commit-summary">
          <Row label="Hạng phương án" value={fmtInt(solution.rank)} />
          <Row label="Điểm xếp hạng" value={fmt(solution.globalScore, 4)} />
          <Row label="Điểm chất lượng" value={fmt(solution.qualityScore, 4)} />
          <Row label="Chênh lệch tải giáo viên" value={fmt(solution.metrics?.workloadSpread, 1)} />
          <Row label="Tải cao nhất (tiết)" value={fmtInt(solution.metrics?.maxTeacherLoad)} />
          <Row label="Số tiết" value={fmtInt(solution.placements?.length)} />
          <Row label="Vi phạm quy tắc" value={fmtInt(solution.validation?.hardViolations)} />
        </dl>

        {travel?.available !== true && <p className="tkb-travel-warning" role="note">Lịch này chưa được kiểm tra thời gian di chuyển giữa các phân hiệu. Bạn có thể lưu với cảnh báo này theo quy tắc của trường.</p>}
        {failed ? <div className="tkb-commit-error" role="alert" data-testid="commit-dialog-error">
            <p className="tkb-commit-error-headline" data-testid="commit-dialog-error-headline">
              Chưa lưu được thời khóa biểu.
            </p>
            <p data-testid="commit-dialog-error-detail">
              {errorMessageOf(error)}
            </p>
            {Array.isArray(error?.errors) && error.errors.length > 0 ? <ul className="tkb-issue-list" data-testid="commit-dialog-error-codes">
                {error.errors.map((e, i) => <li key={`${e.code}-${i}`}><code>{e.code}</code> {localizeSchedulingMessage(e.message)}</li>)}
              </ul> : null}
          </div> : null}

        <div className="tkb-commit-dialog-actions">
          <button type="button" onClick={onConfirm} disabled={committing} data-testid="commit-confirm">
            {committing ? 'Đang lưu…' : 'Xác nhận lưu'}
          </button>
          <button type="button" onClick={onCancel} disabled={committing} data-testid="commit-cancel">
            {failed ? 'Đóng' : 'Hủy'}
          </button>
        </div>
      </div>
    </Modal>;
}
function Row({
  label,
  value
}) {
  return <div className="tkb-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>;
}
function errorMessageOf(error) {
  if (error?.status === 0) return 'Không kết nối được máy chủ xếp lịch. Chưa có gì được lưu.';
  if (typeof error?.message === 'string' && error.message.trim() !== '') return localizeSchedulingMessage(error.message);
  return 'Chưa lưu được thời khóa biểu.';
}
