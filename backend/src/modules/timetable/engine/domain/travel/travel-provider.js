// PHASE 26 — TravelProvider contract.
//
// The TravelProvider is the abstraction the future travel
// constraints (H14, soft travel penalties) will consult. Phase 26
// does NOT activate H14. The provider is exported so that a real
// travel source (e.g. a matrix loaded from data/config/travel.js,
// or a runtime OSRM client) can be plugged in without changing
// any other module.
//
// The contract is:
//
//   status(): 'READY' | 'MISSING' | 'UNSUPPORTED'
//   travelTime(fromBranchId, toBranchId, fromPeriod): number | null
//
// The `status` function is the authoritative report. The
// `travelTime` function is the data interface.
//
//   - READY       → a real travel time is returned (a non-negative
//                   number of minutes).
//   - MISSING     → no data; travelTime returns null. NOT zero.
//   - UNSUPPORTED → the provider is not configured for this
//                   deployment; travelTime throws OR returns null
//                   (callers MUST consult status() first).
//
// The contract is PURE. The provider does not perform IO. Data
// arrives via the matrix / configuration that was set up at
// construction time. The provider is the single point where
// "unknown" / "missing" / "unsupported" semantics live.

// ============================================================================
// Status constants
// ============================================================================

export const TRAVEL_PROVIDER_STATUS = Object.freeze({
  READY: 'READY',
  MISSING: 'MISSING',
  UNSUPPORTED: 'UNSUPPORTED',
});

// ============================================================================
// Phase 26 contract: a TravelProvider is just an object with two
// functions. The shape is intentionally narrow so the type can be
// read in one place.
// ============================================================================

/**
 * @typedef {{
 *   status: () => 'READY'|'MISSING'|'UNSUPPORTED',
 *   travelTime: (fromBranchId: string, toBranchId: string, fromPeriod: number) => number | null,
 * }} TravelProvider
 */

/**
 * The contract a future `checkStatus` helper returns. Today's
 * helper just exposes the same string the provider's `status()`
 * returns, normalized.
 */
export function getTravelProviderStatus(provider) {
  if (!provider || typeof provider.status !== 'function') return TRAVEL_PROVIDER_STATUS.UNSUPPORTED;
  const s = provider.status();
  if (s === TRAVEL_PROVIDER_STATUS.READY) return TRAVEL_PROVIDER_STATUS.READY;
  if (s === TRAVEL_PROVIDER_STATUS.MISSING) return TRAVEL_PROVIDER_STATUS.MISSING;
  return TRAVEL_PROVIDER_STATUS.UNSUPPORTED;
}

// ============================================================================
// Factory: in-memory matrix provider
// ============================================================================

/**
 * Build an in-memory travel provider from a matrix object.
 *
 *   matrix[fromBranchId][toBranchId] = minutes
 *
 *   - matrix[branchA][branchA] = 0    (same branch → 0 minutes,
 *                                      per the contract below)
 *   - missing key → null               (no data for the pair)
 *
 * The factory does NOT validate the matrix. It trusts the
 * caller. The provider's `status()` returns READY regardless of
 * the matrix contents; a "ready" provider with an empty matrix
 * is still a READY provider that returns null for every pair.
 */
export function makeTravelProvider(matrix) {
  return {
    status: () => TRAVEL_PROVIDER_STATUS.READY,
    travelTime(branchA, branchB, _periodA) {
      if (branchA === branchB) return 0;
      const row = matrix?.[branchA];
      if (!row) return null;
      const v = row[branchB];
      return typeof v === 'number' ? v : null;
    },
  };
}

// ============================================================================
// Factory: missing-data provider
// ============================================================================

/**
 * A provider that always reports MISSING. travelTime returns
 * null for every pair. Use this when a travel matrix SHOULD
 * exist (a real deployment) but is not loaded yet.
 *
 * The provider does NOT return 0. The Phase 26 contract is
 * explicit: "unknown travel does not become 0".
 */
export function makeMissingTravelProvider() {
  return {
    status: () => TRAVEL_PROVIDER_STATUS.MISSING,
    travelTime(_branchA, _branchB, _periodA) {
      return null;
    },
  };
}

// ============================================================================
// Factory: unsupported provider
// ============================================================================

/**
 * A provider that always reports UNSUPPORTED. travelTime
 * returns null for every pair. Use this when the deployment has
 * decided not to support travel at all (e.g. a single-branch
 * school).
 */
export function makeUnsupportedTravelProvider() {
  return {
    status: () => TRAVEL_PROVIDER_STATUS.UNSUPPORTED,
    travelTime(_branchA, _branchB, _periodA) {
      return null;
    },
  };
}

// ============================================================================
// Legacy alias (preserved for backward compatibility)
// ============================================================================

/**
 * Returns `null` as a sentinel for "no provider registered".
 * Kept for callers that already check for `provider == null`
 * (notably the Phase 22 catalog's H14 entry, which short-
 * circuits on `input.travelTime == null`).
 *
 * The Phase 26 contract normalises this case to UNSUPPORTED;
 * callers that consult the new contract should use
 * `makeUnsupportedTravelProvider()` instead.
 */
export function nullTravelProvider() {
  return null;
}
