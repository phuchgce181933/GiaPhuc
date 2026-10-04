// PHASE 26 — travel feasibility interface.
//
// The interface is a pure function. It does NOT enforce H14; the
// constraint catalog still has H14 = UNSUPPORTED because no
// travel matrix is in the real dataset. The interface is the
// future hook: when a real TravelProvider arrives, the constraint
// catalog can be switched from UNSUPPORTED to ACTIVE without
// changing the call signature.
//
// The interface is the Phase 26 §10 / §12 / §13 / §14 contract:
//
//   isTravelFeasible(
//     previousPlacement: { branchId, day, period, session? },
//     nextPlacement:     { branchId, day, period, session? },
//     travelProvider,     // TravelProvider | null
//     transitionMinutes   // number
//   ) → {
//     feasible: boolean,
//     minutes:  number | null,
//     reason:   'SAME_BRANCH' | 'OK' | 'MISSING_PROVIDER' |
//               'NO_TRAVEL_DATA' | 'INSUFFICIENT_TIME' |
//               'PROVIDER_UNSUPPORTED' | 'MISSING_PREV' |
//               'MISSING_NEXT' | 'MISSING_TRANSITION'
//   }
//
// The reasons are stable strings. The function does NOT throw;
// every miss is reported via `reason`. The function does NOT
// fabricate data. The function does NOT silently return 0 for
// unknown travel times.
//
// Adjacent-slot ordering is the caller's responsibility. The
// function does not assume "period 5 → period 6 is always
// adjacent"; it only checks the temporal fields on the two
// placements (same-day, period ordering). The helper
// `getNextTemporalSlot` is provided for callers that want a
// canonical ordering, but it is independent of the feasibility
// check.

import { getTravelProviderStatus, TRAVEL_PROVIDER_STATUS } from './travel-provider.js';

// ============================================================================
// Reason codes
// ============================================================================

export const TRAVEL_FEASIBILITY_REASON = Object.freeze({
  SAME_BRANCH: 'SAME_BRANCH',                  // from and to branch are equal
  OK: 'OK',                                    // provider has data, transition is in time
  MISSING_PROVIDER: 'MISSING_PROVIDER',        // provider is null
  PROVIDER_UNSUPPORTED: 'PROVIDER_UNSUPPORTED', // provider reports UNSUPPORTED
  NO_TRAVEL_DATA: 'NO_TRAVEL_DATA',            // provider reports MISSING (or returns null for the pair)
  INSUFFICIENT_TIME: 'INSUFFICIENT_TIME',      // travel minutes > available transition
  MISSING_PREV: 'MISSING_PREV',                // previousPlacement is missing
  MISSING_NEXT: 'MISSING_NEXT',                // nextPlacement is missing
  MISSING_TRANSITION: 'MISSING_TRANSITION',    // transitionMinutes is missing or non-positive
});

// ============================================================================
// Temporal helpers
// ============================================================================

/**
 * Decide whether `next` is the next temporal slot after `prev`
 * on the same day. The function is PURE: it does NOT consult the
 * provider, the time model, or the branch profile.
 *
 *   - Same day + same period → SAME_SLOT (the two are the same
 *     placement; should not happen in a real candidate but is
 *     defensible to detect).
 *   - Same day + next.period > prev.period → ADJACENT.
 *   - Different day → NOT_ADJACENT.
 *
 * The function does NOT assume a global period ordering. The
 * "next" relation is `prev.day === next.day && next.period > prev.period`.
 * Sessions (sang / chieu) are NOT consulted: the catalog already
 * separates them as distinct (day, session, period) identities.
 */
export const SLOT_ORDER = Object.freeze({
  SAME_SLOT: 'SAME_SLOT',
  ADJACENT: 'ADJACENT',
  NOT_ADJACENT: 'NOT_ADJACENT',
  DIFFERENT_DAY: 'DIFFERENT_DAY',
});

export function getNextTemporalSlot(prev, next) {
  if (!prev || !next) return SLOT_ORDER.NOT_ADJACENT;
  if (prev.day !== next.day) return SLOT_ORDER.DIFFERENT_DAY;
  if (next.period === prev.period) return SLOT_ORDER.SAME_SLOT;
  if (next.period > prev.period) return SLOT_ORDER.ADJACENT;
  return SLOT_ORDER.NOT_ADJACENT;
}

// ============================================================================
// isTravelFeasible
// ============================================================================

/**
 * Decide whether a teacher can physically move from
 * `previousPlacement` to `nextPlacement` within the available
 * transition window. The function is PURE and total: every pair
 * of inputs produces a structured result. It NEVER throws on
 * missing data; every miss is reported via `reason`.
 *
 * The function does NOT enforce H14. The H14 constraint entry
 * is responsible for converting this result into a violation
 * (or staying parked when the provider is missing / unsupported).
 *
 * Phase 26 §10 / §11 — same branch semantics:
 *
 *   "If fromBranchId === toBranchId then travel may be treated as
 *    'same branch' but not auto-0 unless the contract defines it."
 *
 * The contract below DOES treat same-branch as zero. This is the
 * "short-circuit" the Phase 22 catalog relies on for H04
 * (slot-in-branch): two slots on the same branch can be visited
 * by the same teacher without travel time. Cross-branch is
 * always queried from the provider; an empty / null response is
 * reported as `NO_TRAVEL_DATA` (never as 0).
 */
export function isTravelFeasible(previousPlacement, nextPlacement, travelProvider, transitionMinutes) {
  // Missing inputs
  if (!previousPlacement) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.MISSING_PREV };
  }
  if (!nextPlacement) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.MISSING_NEXT };
  }
  if (typeof transitionMinutes !== 'number' || transitionMinutes <= 0) {
    // No transition budget is a configuration error. We still
    // return a structured result; the caller decides.
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.MISSING_TRANSITION };
  }
  // Same branch → 0 minutes, feasible.
  if (previousPlacement.branchId === nextPlacement.branchId) {
    return { feasible: true, minutes: 0, reason: TRAVEL_FEASIBILITY_REASON.SAME_BRANCH };
  }
  // No provider
  if (!travelProvider) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.MISSING_PROVIDER };
  }
  const status = getTravelProviderStatus(travelProvider);
  if (status === TRAVEL_PROVIDER_STATUS.UNSUPPORTED) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.PROVIDER_UNSUPPORTED };
  }
  if (status === TRAVEL_PROVIDER_STATUS.MISSING) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA };
  }
  // READY provider
  const minutes = travelProvider.travelTime(
    previousPlacement.branchId,
    nextPlacement.branchId,
    previousPlacement.period,
  );
  if (minutes == null) {
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA };
  }
  if (typeof minutes !== 'number' || minutes < 0) {
    // Provider returned a non-number / negative → treat as missing
    return { feasible: false, minutes: null, reason: TRAVEL_FEASIBILITY_REASON.NO_TRAVEL_DATA };
  }
  if (minutes > transitionMinutes) {
    return { feasible: false, minutes, reason: TRAVEL_FEASIBILITY_REASON.INSUFFICIENT_TIME };
  }
  return { feasible: true, minutes, reason: TRAVEL_FEASIBILITY_REASON.OK };
}

// ============================================================================
// Backward-compatible alias: checkTransition
// ============================================================================
//
// The Phase 22 catalog's H14 entry still imports
// `checkTransition` from `domain/travel.js`. The new interface is
// `isTravelFeasible`; the old name is preserved as a thin
// adapter so the catalog does not need to change.
//
// The new contract returns a richer object (with `reason` always
// populated). The old adapter keeps the same shape: { feasible,
// minutes, reason } — but its `reason` is now always one of the
// TRAVEL_FEASIBILITY_REASON codes.

export function checkTransition(prevSlot, nextSlot, provider, transitionMinutes) {
  return isTravelFeasible(prevSlot, nextSlot, provider, transitionMinutes);
}
