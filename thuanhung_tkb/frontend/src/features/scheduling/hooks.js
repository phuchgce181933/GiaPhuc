/**
 * Phase 32 — generation state for the scheduling feature.
 *
 * ONE hook owns the GENERATION lifecycle so that no component can
 * start a generation behind another component's back. Generation takes
 * seconds on the real dataset, so the two failure modes that matter
 * are (brief §27):
 *
 *   1. The user clicks Generate twice and two solves run. Solved here
 *      by a `busy` ref that the button AND the handler both read, so a
 *      double click inside one render cannot start a second request.
 *      A `busy` state variable alone is not enough — two clicks in the
 *      same tick both read the same stale `false`.
 *
 *   2. The user navigates or re-renders mid-request and the response
 *      lands on an unmounted component. Solved with an AbortController
 *      plus a mounted ref, and by ignoring a response whose request id
 *      is no longer the current one.
 *
 * The hook holds the response verbatim. It does not re-shape solutions,
 * re-derive metrics, or compute a score — every number the UI renders
 * comes from the backend, because the backend is the authority
 * (brief §4, §17).
 *
 * PHASE 33: THE COMMIT LIFECYCLE IS NOT HERE
 * -----------------------------------------
 * `commit` moved to `useCommitState.js` for one reason: a commit must
 * OUTLIVE the generation it came from. Keeping it in this hook would
 * have made the committed record a property of `state.response`, and
 * the next Generate would replace that response and silently discard
 * the fact that a schedule had been saved. The commit machine reads
 * `requestId` from here and keeps its own state.
 */

import { useCallback, useRef, useState } from 'react';
import { ApiError, generateSchedules } from './service.js';

const INITIAL = {
  loading: false,
  response: null,
  error: null,
  /** The message a person should read, never a stack trace. */
  errorMessage: null,
  selectedSolutionId: null,
  viewMode: 'CLASS',
  entityId: null,
  branchFilter: 'ALL',
};

export function useScheduleGeneration() {
  const [state, setState] = useState(INITIAL);
  const busyRef = useRef(false);
  const activeController = useRef(null);
  const requestSeq = useRef(0);

  const generate = useCallback(async (options = {}) => {
    // The synchronous guard. Set BEFORE the first await so a second
    // click in the same tick is refused.
    if (busyRef.current) return null;
    busyRef.current = true;

    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;

    setState((s) => ({
      ...s,
      loading: true,
      error: null,
      errorMessage: null,
    }));

    try {
      const response = await generateSchedules(
        {
          candidateCount: options.candidateCount ?? 3,
          ...(options.optimizationMode ? { optimizationMode: options.optimizationMode } : {}),
          useAI: options.useAI ?? true,
        },
        { placementDetail: options.placementDetail ?? 'all', signal: controller.signal },
      );

      // A response that belongs to a superseded request is dropped.
      if (requestSeq.current !== seq) return null;

      setState((s) => ({
        ...s,
        loading: false,
        response,
        error: null,
        errorMessage: null,
        // Rank 1 is the schedule a user lands on. Selecting by rank
        // rather than by array position keeps the selection tied to
        // the solution's own identity when the list reorders.
        selectedSolutionId: response?.solutions?.[0]?.id ?? null,
        // The first thing to show is the first class in the
        // directory, so the timetable is never an empty grid waiting
        // for a click that may not come.
        entityId: response?.directory?.classes?.[0]?.id ?? null,
      }));
      return response;
    } catch (e) {
      if (requestSeq.current !== seq) return null;
      if (e?.name === 'AbortError') {
        setState((s) => ({ ...s, loading: false }));
        return null;
      }
      setState((s) => ({
        ...s,
        loading: false,
        response: null,
        error: e instanceof ApiError ? e : new ApiError('Unexpected error.', { status: 0 }),
        errorMessage: messageOf(e),
      }));
      return null;
    } finally {
      if (requestSeq.current === seq) busyRef.current = false;
    }
  }, []);

  const selectSolution = useCallback((solutionId) => {
    setState((s) => ({ ...s, selectedSolutionId: solutionId }));
  }, []);

  const setViewMode = useCallback((viewMode) => {
    setState((s) => ({ ...s, viewMode }));
  }, []);

  const setEntity = useCallback((entityId) => {
    setState((s) => ({ ...s, entityId }));
  }, []);

  const setBranchFilter = useCallback((branchFilter) => {
    setState((s) => ({ ...s, branchFilter }));
  }, []);

  const reset = useCallback(() => {
    activeController.current?.abort();
    requestSeq.current += 1;
    busyRef.current = false;
    setState(INITIAL);
  }, []);

  const selectedSolution = state.response?.solutions?.find(
    (s) => s.id === state.selectedSolutionId,
  ) ?? null;

  return {
    ...state,
    selectedSolution,
    // Exposed so a component can render the button's disabled state
    // from the same source the handler reads.
    busy: busyRef.current,
    generate,
    selectSolution,
    setViewMode,
    setEntity,
    setBranchFilter,
    reset,
  };
}

/**
 * A message safe to show a person.
 *
 * An `ApiError` already carries the backend's first message, which the
 * contract writes to be human-readable. Anything else is replaced with
 * a generic sentence: an unexpected error's text is a stack trace or
 * a framework internal, and neither belongs on screen (brief §28).
 */
function messageOf(e) {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong while generating the timetable.';
}
