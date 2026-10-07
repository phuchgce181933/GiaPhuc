// PHASE 26 — travel module public surface.
//
// The travel module exports:
//
//   - The TravelProvider contract (status, travelTime).
//   - Three factory functions (ready, missing, unsupported).
//   - The isTravelFeasible interface (the future H14 hook).
//   - The checkTransition alias (preserved for the Phase 22
//     catalog's H14 entry, which has not been migrated).
//
// The module does NOT activate H14. The constraint catalog
// remains the single source of truth for "is the constraint
// enforced"; the travel module only exposes the evaluation
// primitives.

export {
  TRAVEL_PROVIDER_STATUS,
  getTravelProviderStatus,
  makeTravelProvider,
  makeMissingTravelProvider,
  makeUnsupportedTravelProvider,
  nullTravelProvider,
} from './travel-provider.js';

export {
  TRAVEL_FEASIBILITY_REASON,
  SLOT_ORDER,
  getNextTemporalSlot,
  isTravelFeasible,
  checkTransition,
} from './feasibility.js';
