import { useCallback, useRef, useState } from 'react';
import { ApiError, generateSchedules } from './service.js';
const INITIAL = {
  loading: false,
  response: null,
  error: null,
  errorMessage: null,
  selectedSolutionId: null,
  viewMode: 'CLASS',
  entityId: null,
  branchFilter: 'ALL'
};
export function useScheduleGeneration() {
  const [state, setState] = useState(INITIAL);
  const busyRef = useRef(false);
  const activeController = useRef(null);
  const requestSeq = useRef(0);
  const generate = useCallback(async (options = {}) => {
    if (busyRef.current) return null;
    busyRef.current = true;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    setState(s => ({
      ...s,
      loading: true,
      error: null,
      errorMessage: null
    }));
    try {
      const response = await generateSchedules({
        candidateCount: options.candidateCount ?? 3,
        ...(options.optimizationMode ? {
          optimizationMode: options.optimizationMode
        } : {}),
      }, {
        placementDetail: options.placementDetail ?? 'all',
        signal: controller.signal
      });
      if (requestSeq.current !== seq) return null;
      setState(s => ({
        ...s,
        loading: false,
        response,
        error: null,
        errorMessage: null,
        selectedSolutionId: response?.solutions?.[0]?.id ?? null,
        entityId: response?.directory?.classes?.[0]?.id ?? null
      }));
      return response;
    } catch (e) {
      if (requestSeq.current !== seq) return null;
      if (e?.name === 'AbortError') {
        setState(s => ({
          ...s,
          loading: false
        }));
        return null;
      }
      setState(s => ({
        ...s,
        loading: false,
        response: null,
        error: e instanceof ApiError ? e : new ApiError('Unexpected error.', {
          status: 0
        }),
        errorMessage: messageOf(e)
      }));
      return null;
    } finally {
      if (requestSeq.current === seq) busyRef.current = false;
    }
  }, []);
  const selectSolution = useCallback(solutionId => {
    setState(s => ({
      ...s,
      selectedSolutionId: solutionId
    }));
  }, []);
  const setViewMode = useCallback(viewMode => {
    setState(s => ({
      ...s,
      viewMode
    }));
  }, []);
  const setEntity = useCallback(entityId => {
    setState(s => ({
      ...s,
      entityId
    }));
  }, []);
  const setBranchFilter = useCallback(branchFilter => {
    setState(s => ({
      ...s,
      branchFilter
    }));
  }, []);
  const reset = useCallback(() => {
    activeController.current?.abort();
    requestSeq.current += 1;
    busyRef.current = false;
    setState(INITIAL);
  }, []);
  const selectedSolution = state.response?.solutions?.find(s => s.id === state.selectedSolutionId) ?? null;
  return {
    ...state,
    selectedSolution,
    busy: busyRef.current,
    generate,
    selectSolution,
    setViewMode,
    setEntity,
    setBranchFilter,
    reset
  };
}
function messageOf(e) {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong while generating the timetable.';
}
