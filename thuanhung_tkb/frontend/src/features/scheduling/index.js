/**
 * Public surface of the scheduling feature.
 *
 * The rest of the app imports from here, so a component's location
 * inside the feature is an implementation detail. Nothing outside
 * `features/scheduling/` reaches into `components/` or reaches for
 * `service.js` directly.
 *
 * `ApiError` is exported because a caller has to be able to ask
 * `error.isInvalidInput` — a 400 and a 500 are different user-facing
 * outcomes, and the page decides which.
 */

export { SchedulePage } from './pages/SchedulePage.jsx';
export { useScheduleGeneration } from './hooks.js';
export { useCommitState, COMMIT_STATE } from './useCommitState.js';
export {
  ApiError,
  generateSchedules,
  commitSolution,
  fetchHealth,
  fetchCommittedSchedules,
  fetchCommittedSchedule,
} from './service.js';
export { SolutionList } from './components/SolutionList.jsx';
export { ScheduleGrid, dayLabel, sessionLabel } from './components/ScheduleGrid.jsx';
export { StatusBanner } from './components/StatusBanner.jsx';
export { DataReport } from './components/DataReport.jsx';
export { CommitDialog } from './components/CommitDialog.jsx';
export { CommittedPanel } from './components/CommittedPanel.jsx';
