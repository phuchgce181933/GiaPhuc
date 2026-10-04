/**
 * Route component for the scheduling feature.
 *
 * It is a thin re-export rather than a re-implementation: the screen
 * lives in `features/scheduling/pages/SchedulePage.jsx` because that
 * is where the feature's own code belongs, and this file exists only
 * so `pages/` keeps meaning "one component per route" (AGENTS.md §3).
 *
 * The legacy `services/scheduling.js` client and the old inline
 * `AI Generate` markup were removed with this change. That surface
 * called `/api/scheduling/preview`, the Phase 14-17 pipeline, whose
 * solution shape (`s.score.overallScore`, `s.validation.coverage`)
 * has no `scoring.dimensions` and no `placements` rows. Rendering the
 * Phase 32 response through that markup would have meant asking the
 * grid to understand a solver's internals, which is exactly the
 * boundary the feature is built to keep.
 */

export { SchedulePage as default } from '../features/scheduling/index.js';
