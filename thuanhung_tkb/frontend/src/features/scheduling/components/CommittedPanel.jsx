/**
 * Phase 33 — what is actually on disk.
 *
 * WHY THIS PANEL IS SEPARATE FROM THE SOLUTION LIST
 * -------------------------------------------------
 * A committed schedule outlives the preview it came from. The moment
 * the user presses Generate again, the response is a NEW generation
 * with new solution ids, and the solution the previous one committed
 * is no longer in the list at all.
 *
 * If the only record of a commit were a badge on a solution card, the
 * evidence would vanish on the next generation and the UI would look
 * like nothing was ever saved — while the store holds 802 slots. So
 * the committed schedules are listed from the BACKEND's own record
 * (keyed by `scheduleId`, read back on mount and after every commit),
 * and the solution cards only show which of the CURRENT solutions
 * carries a commit (brief §33, §34).
 *
 * THE HASH IS SHOWN, NOT JUST "SAVED"
 * -----------------------------------
 * `contentHash` is the value the commit response computed over the
 * exact rows that were written. Printing it makes a later read-back
 * checkable by eye — and makes a schedule that was silently altered
 * visible instead of merely wrong.
 */

function fmtInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

function shortHash(hash) {
  return typeof hash === 'string' && hash.length > 16 ? `${hash.slice(0, 16)}…` : (hash ?? '—');
}

export function CommittedPanel({ schedules = [], onRefresh, refreshing = false }) {
  return (
    <section className="tkb-committed" data-testid="committed-panel">
      <h2>Thời khóa biểu đã lưu</h2>
      <div className="tkb-committed-head">
        <p className="tkb-hint" data-testid="committed-count">
          {schedules.length === 0
            ? 'Chưa có thời khóa biểu nào được lưu. Tạo lịch không đồng nghĩa với lưu lịch.'
            : `Đã lưu ${schedules.length} thời khóa biểu.`}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="committed-refresh"
        >
          {refreshing ? 'Đang tải…' : 'Tải lại'}
        </button>
      </div>

      {schedules.length > 0 ? (
        <table className="tkb-committed-table">
          <thead>
            <tr>
              <th scope="col">Mã lịch</th>
              <th scope="col">Phiên bản</th>
              <th scope="col">Phương án nguồn</th>
              <th scope="col">Số tiết</th>
              <th scope="col">Thời điểm lưu</th>
              <th scope="col">Mã kiểm tra nội dung</th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.scheduleId} data-testid="committed-row" data-schedule-id={s.scheduleId}>
                <th scope="row"><code>{s.scheduleId}</code></th>
                <td>{fmtInt(s.version)}</td>
                <td><code>{s.solutionId ?? '—'}</code></td>
                <td>{fmtInt(s.slotCount)}</td>
                <td>{s.committedAt ?? '—'}</td>
                <td title={s.contentHash ?? ''}>{shortHash(s.contentHash)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
