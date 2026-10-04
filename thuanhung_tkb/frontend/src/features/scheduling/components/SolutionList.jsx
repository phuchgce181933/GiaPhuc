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

function fmt(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
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
      <h2>Solutions</h2>
      <p className="tkb-hint">
        {solutions.length} candidate{solutions.length === 1 ? '' : 's'}, ranked by the backend
        scorer. Quality and diversity are separate measurements. Generating does not save any of
        them — saving is a separate, confirmed action.
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
          Solution {s.rank}
        </button>
        <span className="tkb-solution-id" data-testid="solution-id">{s.id}</span>
        {s.rank === 1 ? <span className="tkb-badge">rank 1</span> : null}
        {infeasible ? (
          <span className="tkb-badge tkb-badge-warn" data-testid="infeasible-badge">infeasible</span>
        ) : null}
        {isCommitted ? (
          <span className="tkb-badge tkb-badge-ok" data-testid="committed-badge">committed</span>
        ) : null}
      </div>

      <dl className="tkb-metrics" data-testid="quality-metrics">
        <Metric label="globalScore" value={fmt(s.globalScore, 4)} />
        <Metric label="qualityScore" value={fmt(s.qualityScore, 4)} />
        <Metric label="workloadSpread" value={fmt(s.metrics?.workloadSpread, 1)} />
        <Metric label="maxTeacherLoad" value={fmt(s.metrics?.maxTeacherLoad, 0)} />
        <Metric label="workloadStdev" value={fmt(s.metrics?.workloadStdev, 3)} />
        <Metric label="teacherCount" value={fmt(s.metrics?.teacherCount, 0)} />
        <Metric label="totalPeriods" value={fmt(s.metrics?.totalPeriods, 0)} />
        <Metric label="hardViolations" value={fmt(hardViolations, 0)} />
      </dl>

      <div className="tkb-diversity" data-testid="diversity-metrics">
        <h4>Compared with Solution 1</h4>
        <dl>
          <Metric label="slot diversity" value={fmt(s.diversity?.slotToBest, 4)} />
          <Metric label="teacher/day diversity" value={fmt(s.diversity?.teacherDay, 4)} />
          <Metric label="session structure" value={fmt(s.diversity?.sessionMix, 4)} />
          <Metric label="structural diversity" value={fmt(s.diversity?.overall, 4)} />
        </dl>
        <p className="tkb-hint">
          These describe how far this schedule differs from Solution 1. They are not a quality
          judgement — a higher diversity number is not a better timetable.
        </p>
      </div>

      <details className="tkb-scoring" data-testid="scoring-detail">
        <summary>Why this rank</summary>
        {/* Verbatim from the backend. Not authored here. */}
        <p className="tkb-rank-reason" data-testid="rank-reason">{s.scoring?.rankReason}</p>
        <table className="tkb-dimension-table">
          <thead>
            <tr>
              <th scope="col">Dimension</th>
              <th scope="col">Raw</th>
              <th scope="col">Normalized</th>
              <th scope="col">Weight</th>
              <th scope="col">Contribution</th>
              <th scope="col">State</th>
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
                <td title={d.reason ?? ''}>{d.active ? 'active' : (d.reason ?? 'inactive')}</td>
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
          Save this schedule…
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
          {selected ? 'Showing this' : 'Preview'}
        </button>

        {commitState?.state === COMMIT_STATE.COMMITTING ? (
          <span className="tkb-commit-result" data-testid="commit-pending">
            Re-validating and saving…
          </span>
        ) : null}

        {commitState?.state === COMMIT_STATE.COMMITTED ? (
          <span className="tkb-commit-result tkb-commit-ok" data-testid="commit-result">
            Committed as <code>{commitState.result?.scheduleId}</code>
            {commitState.result?.slotCount != null ? ` · ${commitState.result.slotCount} slots` : ''}
            {commitState.result?.duplicate ? ' · already saved (no duplicate created)' : ''}
          </span>
        ) : null}

        {/* The failure text always leads with "not saved". A rejected
            commit that rendered anything else — or that rendered
            nothing, leaving the previous "Committed" line in place —
            would read as success (brief §15). */}
        {commitState?.state === COMMIT_STATE.FAILED ? (
          <span className="tkb-commit-result tkb-commit-failed" data-testid="commit-failed">
            The schedule was not saved. {commitState.error?.message ?? 'The server refused the commit.'}
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