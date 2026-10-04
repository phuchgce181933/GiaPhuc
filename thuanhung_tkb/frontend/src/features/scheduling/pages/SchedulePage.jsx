/**
 * Phase 32 — the generate-and-compare screen.
 *
 * The whole Phase 32 flow in one component: choose a request, watch
 * the pipeline, compare the solutions the backend returned, read one
 * timetable.
 *
 * WHAT THIS PAGE DOES NOT OWN
 * ---------------------------
 *   - the request lifecycle (hooks.js)
 *   - the commit lifecycle (useCommitState.js)
 *   - HTTP (features/scheduling/service.js)
 *   - the numbers (the backend)
 *   - the meaning of a cell (ScheduleGrid.jsx)
 *
 * It owns exactly one thing: the layout, and the wiring between the
 * hook's state and the components. Every value rendered here
 * came from a response or from a control the user touched.
 *
 * THE REQUEST CONTROLS ARE THE CONTRACT'S VOCABULARY
 * --------------------------------------------------
 * `candidateCount` and `optimizationMode` are rendered as closed
 * option sets rather than free inputs, and the allowed values are
 * read from `/api/schedules/health` when it answers. A user cannot
 * type a value the contract refuses, and the page does not hard-code
 * a second copy of the vocabulary that could drift from the backend
 * (brief §22, §23). When health is unavailable the controls fall back
 * to the documented defaults and say so.
 *
 * `useAI` defaults to `true`, matching the contract, and the banner
 * reports honestly when the deterministic path is what actually ran.
 *
 * PHASE 33 — GENERATE IS NOT SAVE
 * -------------------------------
 * The Generate button calls `gen.generate` and nothing else. No
 * commit is chained to it, no store is touched, and the committed
 * panel is rendered from the BACKEND's own record rather than from
 * anything this component did. Saving is a separate click on a
 * solution card, then a dialog, then Confirm (brief §1, §34).
 */

import { useCallback, useEffect, useState } from 'react';
import { useScheduleGeneration } from '../hooks.js';
import { useCommitState, COMMIT_STATE } from '../useCommitState.js';
import { fetchHealth } from '../service.js';
import { SolutionList } from '../components/SolutionList.jsx';
import { ScheduleGrid, dayLabel } from '../components/ScheduleGrid.jsx';
import { StatusBanner } from '../components/StatusBanner.jsx';
import { DataReport } from '../components/DataReport.jsx';
import { CommitDialog } from '../components/CommitDialog.jsx';
import { CommittedPanel } from '../components/CommittedPanel.jsx';

/**
 * Fallback vocabulary, used only until `/health` answers. These are
 * the values the contract documents, so the control is never wrong —
 * it is at worst unconfirmed, and it says so once health resolves.
 */
const FALLBACK_VOCABULARY = {
  candidateCounts: [1, 3, 5, 10],
  optimizationModes: [],
};

const CANDIDATE_COUNTS = [1, 3, 5, 10];

export function SchedulePage() {
  const gen = useScheduleGeneration();
  const [health, setHealth] = useState(null);
  const [candidateCount, setCandidateCount] = useState(3);
  const [optimizationMode, setOptimizationMode] = useState('');
  const [useAI, setUseAI] = useState(true);
  const [refreshingCommitted, setRefreshingCommitted] = useState(false);

  // The commit machine is keyed on the CURRENT generation's id. A new
  // generation does not clear it: a schedule that is already on disk
  // stays on disk, and the panel below is read from the backend
  // rather than from this render (brief §34).
  const commit = useCommitState({ requestId: gen.response?.requestId ?? null });

  // One health read on mount. A failure is not surfaced as an error
  // because it changes nothing: the contract's documented defaults
  // are still the right request, and generation itself reports
  // anything that actually matters.
  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((h) => {
        if (cancelled || !h) return;
        setHealth(h);
        // Adopt the first allowed mode so the control shows the real
        // vocabulary rather than an empty list.
        const modes = h?.request?.allowedOptimizationModes ?? [];
        if (modes.length > 0) setOptimizationMode((current) => current || modes[0]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // The committed list is read from the BACKEND on mount, which is
  // what makes a page reload show the schedule that is already saved
  // instead of an empty panel (brief §24).
  const onRefreshCommitted = useCallback(async () => {
    setRefreshingCommitted(true);
    try {
      await commit.refreshCommitted();
    } finally {
      setRefreshingCommitted(false);
    }
  }, [commit]);

  useEffect(() => { onRefreshCommitted(); /* eslint-disable-next-line */ }, []);

  const modes = health?.request?.allowedOptimizationModes ?? FALLBACK_VOCABULARY.optimizationModes;
  const counts = health?.request?.allowedCandidateCounts ?? CANDIDATE_COUNTS;

  const onGenerate = useCallback(() => {
    gen.generate({ candidateCount, optimizationMode: optimizationMode || undefined, useAI });
  }, [gen, candidateCount, optimizationMode, useAI]);

  const response = gen.response;
  const solutions = response?.solutions ?? [];
  const selected = gen.selectedSolution;

  // The dialog always shows the solution it is about, even after the
  // user picks a different card while it is open — otherwise the
  // summary would describe one schedule and the request would commit
  // another. If the user selects another card, the dialog follows.
  const dialogSolution = solutions.find((s) => s.id === commit.solutionId) ?? null;
  const dialogOpen = commit.state === COMMIT_STATE.CONFIRMING
    || commit.state === COMMIT_STATE.COMMITTING
    || commit.state === COMMIT_STATE.FAILED;

  // A commit result belongs to ONE generation. If the user generated
  // again, the new cards must not inherit the previous generation's
  // "Committed" line — the committed panel below is what carries the
  // history (brief §34).
  const currentRequestId = response?.requestId ?? null;
  const commitState = commit.scopedTo(currentRequestId);

  return (
    <div className="tkb-page">
      <header className="tkb-page-head">
        <h1>Timetable generator</h1>
        <p className="tkb-hint">
          The backend owns the data, the constraints, and the ranking. This screen asks for a
          schedule, shows what came back, and saves a schedule only when you confirm it.
        </p>
      </header>

      <section className="tkb-controls" data-testid="generate-controls">
        <label className="tkb-control">
          <span>Solutions</span>
          <select
            value={candidateCount}
            onChange={(e) => setCandidateCount(Number(e.target.value))}
            data-testid="candidate-count"
          >
            {counts.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label className="tkb-control">
          <span>Optimization mode</span>
          <select
            value={optimizationMode}
            onChange={(e) => setOptimizationMode(e.target.value)}
            disabled={modes.length === 0}
            data-testid="optimization-mode"
          >
            {modes.length === 0 ? (
              <option value="">default</option>
            ) : (
              modes.map((m) => <option key={m} value={m}>{m}</option>)
            )}
          </select>
        </label>

        <label className="tkb-control tkb-control-inline">
          <input
            type="checkbox"
            checked={useAI}
            onChange={(e) => setUseAI(e.target.checked)}
            data-testid="use-ai"
          />
          <span>Ask the AI layer for a strategy</span>
        </label>

        <button
          type="button"
          className="tkb-generate"
          onClick={onGenerate}
          disabled={gen.loading || gen.busy}
          data-testid="generate-button"
        >
          {gen.loading ? 'Generating…' : 'Generate'}
        </button>

        {health ? (
          <p className="tkb-hint" data-testid="health-note">
            API {health.apiVersion} · commit mode {health.commit?.mode ?? 'unknown'} · travel{' '}
            {health.travel?.h14 ?? 'unreported'} · transfer {health.transfer?.h13 ?? 'unreported'}
          </p>
        ) : null}
      </section>

      {gen.errorMessage ? (
        <p className="tkb-error" role="alert" data-testid="generate-error">{gen.errorMessage}</p>
      ) : null}

      {response ? (
        <StatusBanner
          ai={response.ai}
          travel={response.travel}
          transfer={response.transfer}
          generation={response.generation}
        />
      ) : null}

      {response ? <DataReport diagnostics={response.diagnostics} /> : null}

      {/* EMPTY and MISSING_DATA are 200s with a real reason, and they
          are NOT the same reason. Collapsing them into one "no
          results" line would hide the difference between "the solver
          found nothing hard-feasible" and "the data is not there"
          (brief §9, §35). */}
      {response && solutions.length === 0 ? (
        <section className="tkb-empty-state" data-testid="empty-state">
          <h2>
            {response.status === 'MISSING_DATA'
              ? 'The data needed to build a timetable is missing'
              : 'No hard-feasible schedule was found'}
          </h2>
          <p className="tkb-hint">
            {response.status === 'MISSING_DATA'
              ? 'The request was valid; the source data is what is absent. Nothing was generated.'
              : 'The solver ran and no candidate satisfied every hard constraint. Nothing was generated, and nothing was written.'}
          </p>
          {Array.isArray(response.errors) && response.errors.length > 0 ? (
            <ul className="tkb-issue-list" data-testid="empty-errors">
              {response.errors.map((e, i) => (
                <li key={`${e.code}-${i}`}>
                  <code>{e.code}</code> {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      <SolutionList
        solutions={solutions}
        selectedId={gen.selectedSolutionId}
        onSelect={gen.selectSolution}
        onRequestCommit={commit.requestCommit}
        commitState={commitState}
        committed={commit.committed}
      />

      {/* Rendered after the list and before the grid so the two
          "what you are looking at" and "what is saved" answers are
          adjacent. */}
      <CommittedPanel
        schedules={commit.committed}
        onRefresh={onRefreshCommitted}
        refreshing={refreshingCommitted}
      />

      {dialogOpen ? (
        <CommitDialog
          solution={dialogSolution}
          state={commit.state}
          error={commit.error}
          onConfirm={() => commit.confirmCommit(commit.solutionId)}
          onCancel={commit.clearCommitState}
        />
      ) : null}

      {selected ? (
        <section className="tkb-timetable" data-testid="timetable-section">
          <h2>Timetable</h2>

          <div className="tkb-entity-controls">
            <label className="tkb-control">
              <span>View</span>
              <select
                value={gen.viewMode}
                onChange={(e) => gen.setViewMode(e.target.value)}
                data-testid="view-mode"
              >
                <option value="CLASS">By class</option>
                <option value="TEACHER">By teacher</option>
              </select>
            </label>

            <label className="tkb-control">
              <span>{gen.viewMode === 'TEACHER' ? 'Teacher' : 'Class'}</span>
              <select
                value={gen.entityId ?? ''}
                onChange={(e) => gen.setEntity(e.target.value || null)}
                data-testid="entity-select"
              >
                <option value="">Select…</option>
                {(gen.viewMode === 'TEACHER'
                  ? response?.directory?.teachers
                  : response?.directory?.classes
                )?.map((e) => (
                  <option key={e.id} value={e.id}>{e.name}</option>
                ))}
              </select>
            </label>

            <label className="tkb-control">
              <span>Branch</span>
              <select
                value={gen.branchFilter}
                onChange={(e) => gen.setBranchFilter(e.target.value)}
                data-testid="branch-filter"
              >
                <option value="ALL">All branches</option>
                {response?.directory?.branches?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({dayLabel({ day: b.schoolDays?.[0] })} profile)
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="tkb-hint" data-testid="placement-note">
            {placementsNote(response)}
          </p>

          <ScheduleGrid
            days={response?.calendar?.days ?? []}
            placements={selected.placements ?? []}
            mode={gen.viewMode}
            entityId={gen.entityId}
            branchFilter={gen.branchFilter}
            directory={response?.directory}
          />
        </section>
      ) : null}
    </div>
  );
}

/**
 * Say what the response actually delivered.
 *
 * `placementDetail` exists because a 10-solution `all` response is
 * ~5 MB. When the backend sends a reduced level, the empty cells in
 * the grid are a direct consequence of the request, and the page
 * reports that instead of letting the user conclude the schedule has
 * holes in it.
 */
function placementsNote(response) {
  const level = response?.placementDetail?.level ?? 'all';
  const included = response?.placementDetail?.includedSolutionRanks ?? [];
  if (level === 'all') {
    return 'Every solution carries its full slot table.';
  }
  return (
    `This response was requested with placements=${level}, so only Solution `
    + `${included.join(', ') || '—'} carries its slot table. Other solutions can be ranked and compared, `
    + 'but not drawn as a grid. Re-generate with placements=all for the full timetables.'
  );
}
