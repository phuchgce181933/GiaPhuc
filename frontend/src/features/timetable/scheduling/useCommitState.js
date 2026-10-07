import { useCallback, useRef, useState } from 'react';
import { ApiError, commitSolution, fetchCommittedSchedules } from './service.js';
export const COMMIT_STATE = Object.freeze({
  IDLE: 'IDLE',
  CONFIRMING: 'CONFIRMING',
  COMMITTING: 'COMMITTING',
  COMMITTED: 'COMMITTED',
  FAILED: 'FAILED'
});
const INITIAL = {
  state: COMMIT_STATE.IDLE,
  solutionId: null,
  result: null,
  error: null,
  committed: []
};
export function useCommitState({
  requestId
} = {}) {
  const [state, setState] = useState(INITIAL);
  const [commitRequestId, setCommitRequestId] = useState(null);
  const busyRef = useRef(false);
  const seqRef = useRef(0);
  const requestCommit = useCallback(solutionId => {
    if (!solutionId) return;
    setCommitRequestId(requestId ?? null);
    setState(s => ({
      ...s,
      state: COMMIT_STATE.CONFIRMING,
      solutionId,
      result: null,
      error: null
    }));
  }, [requestId]);
  const cancelCommit = useCallback(() => {
    setState(s => s.state === COMMIT_STATE.COMMITTING ? s : {
      ...s,
      state: COMMIT_STATE.IDLE,
      solutionId: null,
      result: null,
      error: null
    });
  }, []);
  const confirmCommit = useCallback(async solutionId => {
    const target = solutionId ?? state.solutionId;
    if (!requestId || !target) return null;
    if (busyRef.current) return null;
    busyRef.current = true;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setState(s => ({
      ...s,
      state: COMMIT_STATE.COMMITTING,
      solutionId: target,
      error: null
    }));
    try {
      const result = await commitSolution({
        requestId,
        solutionId: target
      });
      if (result?.committed !== true) {
        throw new ApiError('The server did not confirm that the schedule was saved.', {
          status: 200,
          errors: [{
            field: 'commit',
            code: 'NOT_CONFIRMED',
            message: 'persisted was not true.'
          }],
          payload: result
        });
      }
      if (seqRef.current !== seq) return null;
      const record = toRecord(result);
      setState(s => ({
        ...s,
        state: COMMIT_STATE.COMMITTED,
        solutionId: target,
        result,
        error: null,
        committed: [record, ...s.committed.filter(r => r.scheduleId !== record.scheduleId)]
      }));
      return result;
    } catch (e) {
      if (seqRef.current !== seq) return null;
      setState(s => ({
        ...s,
        state: COMMIT_STATE.FAILED,
        solutionId: target,
        result: null,
        error: e
      }));
      return null;
    } finally {
      if (seqRef.current === seq) busyRef.current = false;
    }
  }, [requestId, state.solutionId]);
  const refreshCommitted = useCallback(async () => {
    try {
      const payload = await fetchCommittedSchedules();
      const list = Array.isArray(payload?.schedules) ? payload.schedules.map(toRecord) : [];
      setState(s => ({
        ...s,
        committed: list
      }));
      return list;
    } catch {
      return null;
    }
  }, []);
  const clearCommitState = useCallback(() => {
    setState(s => ({
      ...s,
      state: COMMIT_STATE.IDLE,
      solutionId: null,
      result: null,
      error: null
    }));
  }, []);
  return {
    ...state,
    busy: busyRef.current,
    requestId: commitRequestId,
    scopedTo: currentRequestId => commitRequestId === (currentRequestId ?? null) ? state : null,
    requestCommit,
    cancelCommit,
    confirmCommit,
    refreshCommitted,
    clearCommitState,
    committedScheduleId: state.result?.scheduleId ?? null
  };
}
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
    validated: payload?.validated === true
  };
}
