/**
 * Phase 33 — the confirmation dialog.
 *
 * EXPLICIT CONFIRMATION IS THE POINT
 * ----------------------------------
 * The dialog exists so that "commit" is an event a person caused,
 * not a consequence of clicking a solution card. Nothing is sent while
 * it is open: the dialog is the last point at which the user can see
 * the schedule and back out, and the request only leaves when they
 * press Confirm (brief §1, §14).
 *
 * THE NUMBERS ARE THE BACKEND'S
 * -----------------------------
 * Every figure below is read from the solution the response carried.
 * This component computes nothing, derives nothing, and rounds
 * nothing — a dialog that summarised a schedule with its own
 * arithmetic would be a second, unsynchronized account of the same
 * facts. If a number is `null` the backend did not measure it, and it
 * renders as an em dash rather than as a zero (brief §14).
 *
 * WHAT IS NOT IN HERE
 * -------------------
 * No AI explanation, no "why this is a good timetable", no predicted
 * outcome. The dialog states facts about the schedule and asks one
 * question: save this one? Anything persuasive would be the UI
 * editorialising on the scheduler's behalf, and the brief asks for a
 * confirmation, not a pitch.
 */

import { COMMIT_STATE } from '../useCommitState.js';
import { localizeSchedulingMessage } from '../messages.js';

function fmt(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
}

function fmtInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

/**
 * @param {object}   props
 * @param {object}   props.solution      the selected solution, verbatim
 * @param {string}   props.state         the current COMMIT_STATE
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @param {Error|null} props.error       the failure, when state is FAILED
 */
export function CommitDialog({ solution, state, onConfirm, onCancel, error }) {
  // No solution means nothing to confirm; the dialog is not rendered
  // at all rather than rendered empty.
  if (!solution) return null;

  const committing = state === COMMIT_STATE.COMMITTING;
  const failed = state === COMMIT_STATE.FAILED;

  return (
    <div className="tkb-commit-overlay" data-testid="commit-dialog">
      <div
        className="tkb-commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tkb-commit-title"
      >
        <h2 id="tkb-commit-title">Xác nhận lưu thời khóa biểu</h2>
        <p className="tkb-hint" data-testid="commit-dialog-subject">
          Solution {solution.rank} · <code>{solution.id}</code>
        </p>

        {/* The minimum the brief names, and nothing derived. */}
        <dl className="tkb-metrics" data-testid="commit-summary">
          <Row label="Hạng phương án" value={fmtInt(solution.rank)} />
          <Row label="Điểm xếp hạng" value={fmt(solution.globalScore, 4)} />
          <Row label="Điểm chất lượng" value={fmt(solution.qualityScore, 4)} />
          <Row label="Chênh lệch tải giáo viên" value={fmt(solution.metrics?.workloadSpread, 1)} />
          <Row label="Tải cao nhất (tiết)" value={fmtInt(solution.metrics?.maxTeacherLoad)} />
          <Row label="Số tiết" value={fmtInt(solution.placements?.length)} />
          <Row label="Vi phạm quy tắc" value={fmtInt(solution.validation?.hardViolations)} />
        </dl>

        {failed ? (
          <div className="tkb-commit-error" role="alert" data-testid="commit-dialog-error">
            <p className="tkb-commit-error-headline" data-testid="commit-dialog-error-headline">
              Chưa lưu được thời khóa biểu.
            </p>
            <p data-testid="commit-dialog-error-detail">
              {errorMessageOf(error)}
            </p>
            {Array.isArray(error?.errors) && error.errors.length > 0 ? (
              <ul className="tkb-issue-list" data-testid="commit-dialog-error-codes">
                {error.errors.map((e, i) => (
                  <li key={`${e.code}-${i}`}><code>{e.code}</code> {localizeSchedulingMessage(e.message)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <div className="tkb-commit-dialog-actions">
          <button
            type="button"
            onClick={onConfirm}
            disabled={committing}
            data-testid="commit-confirm"
          >
            {committing ? 'Đang lưu…' : 'Xác nhận lưu'}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={committing}
            data-testid="commit-cancel"
          >
            {failed ? 'Đóng' : 'Hủy'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="tkb-metric">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The backend's own message when there is one.
 *
 * An `ApiError` already carries the first `errors[].message` the
 * contract wrote to be human-readable, so it is shown verbatim rather
 * than paraphrased. Anything else gets a fixed sentence: an
 * unexpected error's text is a stack trace, and a stack trace does
 * not belong on a dialog a person is reading.
 */
function errorMessageOf(error) {
  if (error?.status === 0) return 'Không kết nối được máy chủ xếp lịch. Chưa có gì được lưu.';
  if (typeof error?.message === 'string' && error.message.trim() !== '') return localizeSchedulingMessage(error.message);
  return 'Chưa lưu được thời khóa biểu.';
}
