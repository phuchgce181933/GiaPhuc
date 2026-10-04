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
      <h2>Saved schedules</h2>
      <div className="tkb-committed-head">
        <p className="tkb-hint" data-testid="committed-count">
          {schedules.length === 0
            ? 'No schedule has been committed yet. Generating a timetable does not save it.'
            : `${schedules.length} schedule${schedules.length === 1 ? '' : 's'} committed.`}
        </p>
        <button
          type="button"
          onClick={onRefresh}
          disabled={refreshing}
          data-testid="committed-refresh"
        >
          {refreshing ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {schedules.length > 0 ? (
        <table className="tkb-committed-table">
          <thead>
            <tr>
              <th scope="col">Schedule</th>
              <th scope="col">Version</th>
              <th scope="col">Source solution</th>
              <th scope="col">Slots</th>
              <th scope="col">Committed at</th>
              <th scope="col">Content hash</th>
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
