/**
 * Phase 32 — the honest status banner.
 *
 * WHY THIS COMPONENT EXISTS
 * -------------------------
 * A timetable UI can make three claims the response does not support,
 * and each is a one-line mistake to write:
 *
 *   "Generated with AI"        when the deterministic fallback
 *                              produced the schedule.
 *   "Travel time optimized"    when H14 is UNSUPPORTED and no travel
 *                              matrix exists.
 *   "Teacher transfers applied" when H13 is INACTIVE and no teacher
 *                              carries a transfer policy.
 *
 * The backend reports all three truthfully in the `ai`, `travel` and
 * `transfer` blocks precisely so the browser does not have to infer
 * them. This component renders those blocks and nothing else
 * (brief §6, §24, §25, §26).
 *
 * WHAT IT MUST NOT DO
 * -------------------
 * It must not soften a false statement into a vague one. There is no
 * "AI-assisted" and no "travel considered" wording here: a fallback
 * run says the deterministic path produced it, and an unsupported
 * dimension says it was not scored. A hedge is still a claim.
 *
 * `ai.detail` and the `detail` fields are rendered VERBATIM. They are
 * the backend's own sentences about what happened, written by the
 * layer that knows.
 */

/** The three states a user has to be able to tell apart. */
function stateOf(block) {
  if (!block) return 'unknown';
  if (block.used === true) return 'used';
  if (block.requested === false) return 'not-requested';
  if (block.fallbackUsed === true || block.available === false) return 'fallback';
  return 'unknown';
}

export function StatusBanner({ ai, travel, transfer, generation }) {
  const aiState = stateOf(ai);
  const travelReady = travel?.available === true;
  const transferActive = transfer?.active === true;

  return (
    <section className="tkb-status" data-testid="status-banner" aria-label="Generation status">
      <ul className="tkb-status-list">
        <li
          className={`tkb-status-item tkb-status-${aiState}`}
          data-testid="ai-status"
          data-state={aiState}
        >
          <span className="tkb-status-key">Strategy source</span>
          <span className="tkb-status-value">
            {/* A fallback run is never described as an AI run. The
                three branches are exhaustive on purpose: "unknown"
                gets its own honest text rather than falling through
                to the AI sentence. */}
            {aiState === 'used' ? 'AI strategy, approved' : null}
            {aiState === 'not-requested' ? 'Deterministic (AI not requested)' : null}
            {aiState === 'fallback' ? 'Deterministic fallback' : null}
            {aiState === 'unknown' ? 'Not reported' : null}
          </span>
          {ai?.reason ? (
            <span className="tkb-status-code" data-testid="ai-reason">{ai.reason}</span>
          ) : null}
          {ai?.detail ? <span className="tkb-status-detail">{ai.detail}</span> : null}
        </li>

        <li
          className={`tkb-status-item ${travelReady ? 'tkb-status-used' : 'tkb-status-unavailable'}`}
          data-testid="travel-status"
        >
          <span className="tkb-status-key">Travel between branches</span>
          <span className="tkb-status-value">
            {/* H14 UNSUPPORTED means travel is not a scoring
                dimension at all, so "not optimized" would still be
                wrong — it was never on the scale. */}
            {travelReady ? 'Scored' : `Not scored (${travel?.h14 ?? 'unreported'})`}
          </span>
          {travel?.detail ? <span className="tkb-status-detail">{travel.detail}</span> : null}
        </li>

        <li
          className={`tkb-status-item ${transferActive ? 'tkb-status-used' : 'tkb-status-unavailable'}`}
          data-testid="transfer-status"
        >
          <span className="tkb-status-key">Teacher transfers</span>
          <span className="tkb-status-value">
            {transferActive
              ? `Allowed for ${transfer.allowedTeacherCount} teacher(s)`
              : `Inactive (${transfer?.h13 ?? 'unreported'})`}
          </span>
          {transfer?.detail ? <span className="tkb-status-detail">{transfer.detail}</span> : null}
        </li>

        {generation ? (
          <li className="tkb-status-item tkb-status-neutral" data-testid="generation-status">
            <span className="tkb-status-key">Generation</span>
            <span className="tkb-status-value">
              {generation.status}
              {typeof generation.totalTimeMs === 'number' ? ` · ${generation.totalTimeMs} ms` : ''}
            </span>
            {Array.isArray(generation.stages) && generation.stages.length > 0 ? (
              <ol className="tkb-stage-list" data-testid="stage-list">
                {generation.stages.map((s) => (
                  <li key={`${s.status}-${s.atMs}`} className="tkb-stage">
                    <span className="tkb-stage-name">{s.status}</span>
                    <span className="tkb-stage-ms">{s.atMs} ms</span>
                  </li>
                ))}
              </ol>
            ) : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}