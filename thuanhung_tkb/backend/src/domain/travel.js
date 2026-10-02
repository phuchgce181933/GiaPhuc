// TravelProvider interface.
//
// In production, this wraps the configuration in
// data/config/travel.js. In tests, an in-memory implementation
// can be injected. When no provider is registered, the validator
// reports MISSING_CONFIGURATION for H_TRAVEL_FEASIBLE and the
// solver does not emit transfer candidates.

/**
 * @typedef {{
 *   travelTime: (branchA: string, branchB: string, periodA: number) => number | null
 * }} TravelProvider
 */

/**
 * @returns {TravelProvider | null}
 */
export function nullTravelProvider() {
  return null;
}

/**
 * In-memory travel provider keyed by ordered branch pair.
 * Pass-through for tests.
 */
export function makeTravelProvider(matrix) {
  // matrix[branchA][branchB] = minutes, or null when no transition.
  return {
    travelTime(branchA, branchB, _periodA) {
      if (branchA === branchB) return 0;
      const row = matrix?.[branchA];
      if (!row) return null;
      const v = row[branchB];
      return typeof v === 'number' ? v : null;
    },
  };
}

/**
 * Given two consecutive slots and a travel provider, return
 * { feasible, minutes, reason }.
 */
export function checkTransition(prevSlot, nextSlot, provider, transitionMinutes) {
  if (prevSlot.branchId === nextSlot.branchId) {
    return { feasible: true, minutes: 0, reason: 'same_branch' };
  }
  if (!provider) {
    return { feasible: false, minutes: null, reason: 'MISSING_CONFIGURATION' };
  }
  const minutes = provider.travelTime(prevSlot.branchId, nextSlot.branchId, prevSlot.period);
  if (minutes === null) {
    return { feasible: false, minutes: null, reason: 'NO_TRAVEL_DATA' };
  }
  if (minutes > transitionMinutes) {
    return { feasible: false, minutes, reason: 'INSUFFICIENT_TIME' };
  }
  return { feasible: true, minutes, reason: 'OK' };
}
