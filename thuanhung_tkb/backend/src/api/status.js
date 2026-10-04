// PHASE 32 — STATUS REPORTING: AI, travel, transfer.
//
// The three status blocks in a Phase 32 response exist for one
// reason: a UI cannot honestly render a capability the response does
// not describe. "AI generated schedule" when the deterministic
// fallback produced it, and "Travel OK" when H14 is UNSUPPORTED, are
// both claims the browser would have to invent. This module is where
// the backend supplies the claim instead (brief §6, §24, §25, §26).
//
// THE HONESTY RULE, STATED ONCE
// ------------------------------
// `used` means a provider's output became the strategy. Nothing else
// qualifies. A provider that was constructed, handed a situation
// report, timed out, or returned output the validator rejected is
// `available: false` and NOT `used`; when it failed, `fallbackUsed` is
// true and `reason` says which failure it was. There is no reading of
// these fields under which a fallback run can be presented as an AI
// run, and `reason` is a value from the AI layer's own failure
// vocabulary rather than a sentence written here.

import { AI_FAILURE } from '../domain/ai/index.js';
import { TRANSFER_POLICY_STATUS, allowedTransferBranchesOf } from '../domain/transfer/transfer.js';
import {
  TRAVEL_PROVIDER_STATUS,
  getTravelProviderStatus,
  makeMissingTravelProvider,
  makeTravelProvider,
  makeUnsupportedTravelProvider,
} from '../domain/travel/travel-provider.js';

/**
 * mapAiStatus -> { provider, available, used, fallbackUsed, reason }
 *
 * `available` describes the PROVIDER, not the request. A configured
 * AirLLM whose service is down is `available: false` with
 * `reason: 'AI_UNAVAILABLE'` — the value the AI layer assigned — and
 * a configured mock that answered is `available: true`.
 *
 * `requested` is reported alongside so a client can render "AI was
 * not requested" differently from "AI was requested and could not be
 * used". Collapsing the two would tell a user who deliberately chose
 * the deterministic path that a provider had failed, which is the
 * sort of false status this module exists to prevent.
 */
export function mapAiStatus({ request, planner, planned, configuredProvider }) {
  const provider = planner?.name ?? (request.useAI ? (configuredProvider ?? 'unknown') : 'none');
  const fallbackUsed = planned?.fallbackUsed === true;

  if (!request.useAI) {
    return {
      provider: 'none',
      requested: false,
      available: false,
      used: false,
      fallbackUsed: true,
      reason: 'AI_NOT_REQUESTED',
      detail: 'The request set useAI=false, so the deterministic path produced this schedule by design.',
    };
  }

  const failure = planned?.failure ?? null;

  return {
    provider,
    requested: true,
    // A planner that exists and produced an APPROVED decision is
    // available. A planner that exists and did not is not — the
    // provider was tried and did not deliver, and calling that
    // "available" would be the same lie in a different coat.
    available: !fallbackUsed,
    used: !fallbackUsed,
    fallbackUsed,
    reason: fallbackUsed ? failureCodeOf(failure) : 'AI_USED',
    detail: fallbackUsed
      ? (failure?.detail ?? planned?.validation?.reason ?? 'No AI strategy was approved; the deterministic fallback was used.')
      : (planned?.decision?.rationale ?? 'An AI strategy was approved and used.'),
    // `decision` is the AI's, and ONLY the AI's. `planStrategy`
    // resolves an unapproved run to `fallbackDecision(...)`, so
    // `planned.decision` is non-null even when no provider was
    // consulted. Forwarding it under `ai.decision` would let a UI
    // read "here is the strategy the AI chose" for a run where no AI
    // ran at all — the precise dishonesty this block exists to
    // prevent. So a fallback run reports `decision: null` and the
    // deterministic decision under its own name.
    decision: fallbackUsed ? null : decisionSummary(planned?.decision),
    fallbackDecision: fallbackUsed ? decisionSummary(planned?.decision) : null,
    validation: {
      status: planned?.validation?.status ?? null,
      events: planned?.validation?.events ?? [],
      reason: planned?.validation?.reason ?? null,
    },
    timing: {
      reportMs: planned?.timing?.reportMs ?? null,
      providerMs: planned?.timing?.aiMs ?? null,
      validationMs: planned?.timing?.validationMs ?? null,
    },
  };
}

function failureCodeOf(failure) {
  if (!failure) return 'AI_UNAVAILABLE';
  if (failure.kind === AI_FAILURE.TIMEOUT) return 'AI_TIMEOUT';
  if (failure.kind === AI_FAILURE.UNAVAILABLE) return 'AI_UNAVAILABLE';
  if (failure.kind) return `${failure.kind}`;
  return failure.code ?? 'AI_UNAVAILABLE';
}

/** The decision, minus the rationale (it is already in `detail`). */
function decisionSummary(decision) {
  if (!decision) return null;
  return {
    optimizationMode: decision.optimizationMode ?? null,
    candidateCount: decision.candidateCount ?? null,
    scoringWeights: decision.scoringWeights ?? null,
    source: decision.source ?? null,
  };
}

// ============================================================================
// Travel (H14)
// ============================================================================

/**
 * mapTravelStatus -> { h14, status, available, detail }
 *
 * The status is read from the TRAVEL PROVIDER, which is the Phase 26
 * seam the rest of the domain already consults — not from
 * `input.travelTime` being truthy, and not from a constant. When a
 * matrix does exist, the provider is built from it and reports
 * `READY`; when it does not, the provider reports `UNSUPPORTED` or
 * `MISSING` and the UI must not print "Travel OK".
 *
 * There is deliberately NO `optimized` field. Travel is not merely
 * unavailable on this deployment, it is not a dimension the scorer
 * uses, so there is no quantity to report. A boolean the backend
 * cannot honestly produce should not exist in the contract.
 */
export function mapTravelStatus(input, topSolution) {
  const hasMatrix = Boolean(input?.travelTime && typeof input.travelTime === 'object');
  const provider = hasMatrix
    ? makeTravelProvider(input.travelTime)
    : makeMissingTravelProvider();

  const status = hasMatrix
    ? getTravelProviderStatus(provider)
    : // No matrix at all. The Phase 26 vocabulary distinguishes
      // "a matrix should exist and is missing" from "travel is not
      // supported by this deployment". The dimension catalog reports
      // H14 as UNSUPPORTED for this dataset, so that is what the
      // response says; MISSING would overstate how much is known.
      TRAVEL_PROVIDER_STATUS.UNSUPPORTED;

  return {
    h14: status,
    available: status === TRAVEL_PROVIDER_STATUS.READY,
    // The scorer is the authority on whether travel influenced the
    // result, and it answers this per-dimension. Reading it from the
    // score vector means this block cannot disagree with the score
    // the same response reports.
    usedInScoring: Boolean(topSolution?.scoring?.dimensions?.TRAVEL?.active === true),
    detail: status === TRAVEL_PROVIDER_STATUS.READY
      ? 'A travel matrix is present and travel is a live scoring dimension.'
      : 'No travel matrix is configured. Travel times between branches are unknown and are not scored (H14 = UNSUPPORTED).',
  };
}

// ============================================================================
// Transfer (H13)
// ============================================================================

/**
 * mapTransferStatus -> { h13, active, allowedTeacherCount, detail }
 *
 * H13 is INACTIVE when no teacher carries `allowedTransferBranches`.
 * That is a fact about the data, so it is measured here rather than
 * asserted: a future dataset that does record a transfer policy will
 * flip this block to `ACTIVE` without a change to the response
 * shape.
 *
 * The block does NOT report whether a transfer was optimized. It
 * cannot: `selectFinalSolutions` reports the TRANSFER dimension as
 * inactive with weight 0, so no transfer entered the score. The UI is
 * given the fact that would make "Transfer optimized" true if it
 * were ever true, and is given no field that would let it assert the
 * claim on its own (brief §26).
 */
export function mapTransferStatus(input, topSolution) {
  const teachers = input?.teachers ?? [];
  const allowedTeacherCount = teachers.filter((t) => {
    const allowed = allowedTransferBranchesOf(t);
    return Array.isArray(allowed) && allowed.length > 0;
  }).length;

  const active = allowedTeacherCount > 0;

  return {
    h13: active ? TRANSFER_POLICY_STATUS.ALLOWED : TRANSFER_POLICY_STATUS.INACTIVE,
    active,
    allowedTeacherCount,
    usedInScoring: Boolean(topSolution?.scoring?.dimensions?.TRANSFER?.active === true),
    detail: active
      ? `${allowedTeacherCount} teacher(s) carry an allowedTransferBranches policy.`
      : 'No teacher carries an allowedTransferBranches policy, so the transfer constraint is inactive (H13 = INACTIVE) and transfers are not optimized.',
  };
}

/** Provider for tests that need to assert H14 stays UNSUPPORTED. */
export function unsupportedTravelProvider() {
  return makeUnsupportedTravelProvider();
}
