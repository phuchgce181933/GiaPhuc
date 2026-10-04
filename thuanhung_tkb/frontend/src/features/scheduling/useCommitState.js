/**
 * Phase 33 — the commit lifecycle, as an explicit state machine.
 *
 * WHY A STATE MACHINE AND NOT A BOOLEAN
 * -------------------------------------
 * Phase 32 used one flag (`commitState.status`) with three values and
 * one implicit assumption: that a commit is a single moment. It is
 * not. Between "the user picked a solution" and "the schedule is on
 * disk" there are five distinguishable states, and a boolean cannot
 * tell two of them apart without becoming a lie:
 *
 *   IDLE       nothing selected to commit
 *   CONFIRMING a dialog is open and nothing has been sent yet
 *   COMMITTING the request is in flight
 *   COMMITTED  the backend confirmed a write and a read-back
 *   FAILED     the backend refused, or the request never arrived
 *
 * Collapsing these into `isSaved` is how a UI ends up showing "Saved
 * successfully" next to a 409. Every one of these five renders
 * differently, and the backend's own words appear verbatim in the
 * COMMITTED and FAILED cases (brief §13, §15).
 *
 * WHO OWNS WHAT
 * -------------
 * The state lives in the PAGE, not in a component, because it has to
 * survive a re-render of the solution list and because a committed
 * schedule must remain visible after a new generation replaces the
 * preview. `useCommitState` owns the machine; the page renders it.
 *
 * COMMITTED RECORDS SURVIVE A NEW GENERATION
 * ------------------------------------------
 * A committed schedule is a fact about the store, not about the
 * current preview. `committed` is a list keyed by `scheduleId`, and a
 * new generation appends to it instead of clearing it — so
 * "committed schedule + new preview" coexist, and generating again
 * cannot silently un-commit what is already on disk (brief §34).
 *
 * THE SERVER IS THE AUTHORITY
 * ---------------------------
 * `markCommitted` is only ever called with a payload the backend
 * produced, and it requires `committed === true` before recording
 * anything. There is no optimistic write, and no path that sets
 * COMMITTED without a 200 whose body says the schedule was written
 * and read back (brief §2).
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError, commitSolution, fetchCommittedSchedules } from './service.js';

/** The five states, and nothing else. */
export const COMMIT_STATE = Object.freeze({
  IDLE: 'IDLE',
  CONFIRMING: 'CONFIRMING',
  COMMITTING: 'COMMITTING',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED',
});

const INITIAL = {
  state: COMMIT_STATE.IDLE,
  solutionId: null,
  result: null,
  error: null,
  /** Schedules the backend says are on disk, newest first. */
  committed: [],
};

/**
 * useCommitState({ requestId })
 *
 * @param {string|null} requestId  the CURRENT generation's id. A
 *   commit is always against one generation, so it changes whenever
 *   the user generates again.
 */
export function useCommitState({ requestId } = {}) {
  const [state, setState] = useState(INITIAL);
  // The generation this machine last acted on. A commit result is a
  // fact about ONE generation: the next Generate issues a new
  // `requestId` and new solution ids, and a stale "Committed" line
  // must not follow the new cards. The page scopes the machine's
  // state to the current `requestId` using this field.
  const [commitRequestId, setCommitRequestId] = useState(null);
  // A second click while a commit is in flight is refused
  // synchronously, the same way the generate hook refuses a double
  // solve: a state variable alone still allows two clicks in the same
  // tick to both read the same stale value.
  const busyRef = useRef(false);
  const seqRef = useRef(0);

  /** Open the confirmation dialog. Nothing is sent yet. */
  const requestCommit = useCallback((solutionId) => {
    if (!solutionId) return;
    setCommitRequestId(requestId ?? null);
    setState((s) => ({
      ...s,
      state: COMMIT_STATE.CONFIRMING,
      solutionId,
      result: null,
      error: null,
    }));
  }, [requestId]);

  /** Close the dialog without committing. */
  const cancelCommit = useCallback(() => {
    setState((s) => (s.state === COMMIT_STATE.COMMITTING
      ? s
      : { ...s, state: COMMIT_STATE.IDLE, solutionId: null, result: null, error: null }));
  }, []);

  /**
   * Send the commit. Only reachable from the confirmation dialog, so
   * the user has explicitly confirmed — the backend is told what the
   * user decided, and the decision is a UI event rather than a
   * side-effect of selecting a card.
   */
  const confirmCommit = useCallback(async (solutionId) => {
    const target = solutionId ?? state.solutionId;
    if (!requestId || !target) return null;
    if (busyRef.current) return null;
    busyRef.current = true;
    const seq = seqRef.current + 1;
    seqRef.current = seq;

    setState((s) => ({ ...s, state: COMMIT_STATE.COMMITTING, solutionId: target, error: null }));

    try {
      const result = await commitSolution({ requestId, solutionId: target });
      // A 200 whose body does not say "committed" is not a commit.
      // This is the check that keeps a false success off the screen.
      if (result?.committed !== true) {
        throw new ApiError('The server did not confirm that the schedule was saved.', {
          status: 200,
          errors: [{ field: 'commit', code: 'NOT_CONFIRMED', message: 'persisted was not true.' }],
          payload: result,
        });
      }
      if (seqRef.current !== seq) return null;
      const record = toRecord(result);
      setState((s) => ({
        ...s,
        state: COMMIT_STATE.COMMITTED,
        solutionId: target,
        result,
        error: null,
        committed: [record, ...s.committed.filter((r) => r.scheduleId !== record.scheduleId)],
      }));
      return result;
    } catch (e) {
      if (seqRef.current !== seq) return null;
      setState((s) => ({
        ...s,
        state: COMMIT_STATE.FAILED,
        solutionId: target,
        result: null,
        error: e,
      }));
      return null;
    } finally {
      if (seqRef.current === seq) busyRef.current = false;
    }
  }, [requestId, state.solutionId]);

  /**
   * Read the committed schedules the backend already has.
   *
   * This is how the committed state survives a page RELOAD: the store
   * is the source of truth, so a browser refresh re-reads it rather
   * than showing an empty "not committed" screen next to a schedule
   * that is on disk (brief §24).
   */
  const refreshCommitted = useCallback(async () => {
    try {
      const payload = await fetchCommittedSchedules();
      const list = Array.isArray(payload?.schedules) ? payload.schedules.map(toRecord) : [];
      setState((s) => ({ ...s, committed: list }));
      return list;
    } catch {
      // A failure here is not shown as a commit failure: nothing was
      // being committed. It only means the already-committed list
      // could not be refreshed, and the previous list stays.
      return null;
    }
  }, []);

  /** Forget the local view of a schedule. Never deletes server-side. */
  const clearCommitState = useCallback(() => {
    setState((s) => ({
      ...s,
      state: COMMIT_STATE.IDLE,
      solutionId: null,
      result: null,
      error: null,
    }));
  }, []);

  return {
    ...state,
    busy: busyRef.current,
    /**
     * The generation the current commit state belongs to, or null.
     *
     * A page compares this against its CURRENT `requestId` before
     * showing any commit state on a card. Without that comparison, a
     * new generation whose solution ids happened to repeat an old
     * one would inherit an old "Committed" line — a claim about a
     * schedule the user did not commit from this screen.
     */
    requestId: commitRequestId,
    /** The commit state, but only if it belongs to `currentRequestId`. */
    scopedTo: (currentRequestId) => (commitRequestId === (currentRequestId ?? null) ? state : null),
    requestCommit,
    cancelCommit,
    confirmCommit,
    refreshCommitted,
    clearCommitState,
    /** The schedule id the backend recorded, or null. */
    committedScheduleId: state.result?.scheduleId ?? null,
  };
}

/**
 * Project a backend payload into the shape the UI renders.
 *
 * Whitelist, for the same reason `mappers.js` is a whitelist on the
 * other side of the wire: a field that is not named here cannot reach
 * the screen, so a future addition to the response is a deliberate act
 * rather than an accident.
 */
function toRecord(payload) {
  return {
    scheduleId: payload?.scheduleId ?? null,
    version: payload?.version ?? null,
    status: payload?.status ?? null,
    solutionId: payload?.solutionId ?? null,
    requestId: payload?.requestId ?? null,
    slotCount: typeof payload?.slotCount === 'number' ? payload.slotCount : null,
    contentHash: payload?.contentHash ?? null,
    committedAt: payload?.committedAt ?? null,
    duplicate: payload?.duplicate === true,
    validated: payload?.validated === true,
  };
}
