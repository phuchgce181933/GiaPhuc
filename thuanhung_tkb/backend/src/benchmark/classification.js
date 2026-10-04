// PHASE 31 — AIRLLM FAILURE CLASSIFICATION.
//
// Brief §30 names eight ways an AirLLM-backed strategy request can
// fail and forbids collapsing them into one `AI_ERROR`:
//
//   MODEL_LOAD_FAILURE     the model could not be loaded
//   MODEL_NOT_READY        the service is up; the model is not servable
//   INFERENCE_FAILURE      the model ran and produced nothing usable
//   TIMEOUT                the deadline passed
//   INVALID_JSON           the response was not JSON, or not an object
//   SCHEMA_INVALID         JSON, but the shape is not a decision
//   STRATEGY_REJECTED      well-formed, but the Node validator refused it
//   DOWNSTREAM_NO_SOLUTION accepted strategy, solver found nothing feasible
//
// A ninth, `SERVICE_UNREACHABLE`, is added. It is a refinement, not a
// substitution: ECONNREFUSED is the single most common failure during
// development, and folding it into `MODEL_NOT_READY` would tell an
// operator to go and debug a GPU that was never reached.
//
// WHY THE DISTINCTION IS WORTH THE CODE
// -------------------------------------
// Every one of these ends in the same place — the deterministic
// fallback, and a hard-feasible schedule. That is the Phase 29/30
// guarantee and it is unaffected by anything here. What the
// classification buys is diagnostic: a phase that reports 40% STRATEGY_REJECTED
// needs a different fix than a phase that reports 40% MODEL_LOAD_FAILURE,
// and an aggregate "AI_ERROR" cannot tell them apart.
//
// The classifier is a PURE function of observable facts. It never
// probes, never retries, and never mutates the plan it is given.

import { AI_FAILURE, AI_VALIDATION } from '../domain/ai/strategy-schema.js';

export const AIRLLM_FAILURE = Object.freeze({
  SERVICE_UNREACHABLE: 'SERVICE_UNREACHABLE',
  MODEL_LOAD_FAILURE: 'MODEL_LOAD_FAILURE',
  MODEL_NOT_READY: 'MODEL_NOT_READY',
  INFERENCE_FAILURE: 'INFERENCE_FAILURE',
  TIMEOUT: 'TIMEOUT',
  INVALID_JSON: 'INVALID_JSON',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  STRATEGY_REJECTED: 'STRATEGY_REJECTED',
  DOWNSTREAM_NO_SOLUTION: 'DOWNSTREAM_NO_SOLUTION',
});

/** Every classification, as a frozen set, for report completeness checks. */
export const ALL_AIRLLM_FAILURES = Object.freeze(Object.values(AIRLLM_FAILURE));

/**
 * Service states the Python runtime reports, mapped to the class they
 * imply. Read from `/ready`. A state not listed here is treated as
 * NOT_READY rather than as a success: an unrecognised state is a
 * version skew, and assuming the good case is how a benchmark ends up
 * claiming a model was ready when it was not (brief §35).
 */
const STATE_CLASS = Object.freeze({
  MODEL_READY: null, // ready: no failure
  MODEL_LOADING: AIRLLM_FAILURE.MODEL_NOT_READY,
  SERVICE_RUNNING: AIRLLM_FAILURE.MODEL_NOT_READY,
  MODEL_ERROR: AIRLLM_FAILURE.MODEL_LOAD_FAILURE,
});

/** The `AI_FAILURE` kind from the Phase 29/30 boundary, mapped on. */
const KIND_CLASS = Object.freeze({
  [AI_FAILURE.TIMEOUT]: AIRLLM_FAILURE.TIMEOUT,
  [AI_FAILURE.PARSE_ERROR]: AIRLLM_FAILURE.INVALID_JSON,
  [AI_FAILURE.UNSUPPORTED_REQUEST]: AIRLLM_FAILURE.SCHEMA_INVALID,
  [AI_FAILURE.INVALID_OUTPUT]: AIRLLM_FAILURE.SCHEMA_INVALID,
  // An UNAVAILABLE kind is the broad one. The service's own state,
  // when the probe saw it, disambiguates; without that, the honest
  // answer is "the service was not reachable" rather than a guess
  // about why it was not serving.
  [AI_FAILURE.UNAVAILABLE]: AIRLLM_FAILURE.SERVICE_UNREACHABLE,
});

/**
 * classifyAirLLMOutcome({ plan, probe, solutions, decisionAccepted })
 *   -> { class, code, detail, recoverable }
 *
 * Inputs are all optional and all observed, never inferred:
 *
 *   plan            the `planStrategy` result, if one was produced
 *   probe           the `probeAirLLMService` result, if one ran
 *   solutions       the multi-solution output, if the solver ran
 *
 * Precedence, highest first. Each step is a fact that makes the later
 * ones impossible, so the order is not arbitrary:
 *
 *   1. the service answered and said MODEL_ERROR   -> MODEL_LOAD_FAILURE
 *   2. the service answered and was not ready       -> MODEL_NOT_READY
 *   3. the service could not be reached             -> SERVICE_UNREACHABLE
 *   4. the provider timed out                       -> TIMEOUT
 *   5. the body was not JSON                        -> INVALID_JSON
 *   6. JSON, wrong shape                            -> SCHEMA_INVALID
 *   7. the Node validator rejected it               -> STRATEGY_REJECTED
 *   8. accepted, but the solver found nothing       -> DOWNSTREAM_NO_SOLUTION
 *   9. otherwise                                    -> null (no failure)
 *
 * `recoverable` is true when retrying could plausibly help. It is a
 * hint for an operator, not a scheduler decision — nothing in the
 * pipeline acts on it, because acting on it would mean a benchmark
 * that silently retries until it gets the answer it wanted, which is
 * exactly the cherry-picking brief §22 forbids.
 */
export function classifyAirLLMOutcome(observed = {}) {
  const { plan = null, probe = null, solutions = null } = observed;

  // ---- 1 & 2. Service-level truth --------------------------------
  if (probe) {
    if (probe.reachable === false) {
      return {
        class: AIRLLM_FAILURE.SERVICE_UNREACHABLE,
        code: 'AIRLLM_SERVICE_UNREACHABLE',
        detail: probe.error ?? 'the AirLLM service did not answer /health',
        recoverable: true,
      };
    }
    const state = probe.state ?? probe.ready?.state ?? null;
    if (state !== null && state !== 'MODEL_READY') {
      const mapped = STATE_CLASS[state] ?? AIRLLM_FAILURE.MODEL_NOT_READY;
      return {
        class: mapped,
        code: `AIRLLM_${mapped}`,
        detail: probe.ready?.error
          ?? probe.ready?.errors?.[0]
          ?? `the service reports ${state}`,
        recoverable: true,
      };
    }
  }

  // ---- 4-7. Provider + validator outcomes -------------------------
  if (plan && plan.fallbackUsed) {
    const kind = plan.failure?.kind ?? null;
    const code = plan.failure?.code ?? 'AI_FALLBACK';
    const detail = plan.failure?.detail ?? 'the AI decision was not usable';

    // The validator's own verdict beats the coarse kind when both are
    // present: a REJECTED status with a specific reason is a more
    // useful label than the transport kind that produced it.
    if (plan.validation?.status === AI_VALIDATION.REJECTED) {
      const mapped = KIND_CLASS[kind] ?? AIRLLM_FAILURE.STRATEGY_REJECTED;
      return {
        class: kind === AI_FAILURE.TIMEOUT ? AIRLLM_FAILURE.TIMEOUT : mapped,
        code,
        detail,
        recoverable: kind === AI_FAILURE.TIMEOUT,
      };
    }

    const mapped = KIND_CLASS[kind] ?? AIRLLM_FAILURE.INFERENCE_FAILURE;
    return {
      class: mapped,
      code,
      detail,
      recoverable: kind === AI_FAILURE.UNAVAILABLE || kind === AI_FAILURE.TIMEOUT,
    };
  }

  // ---- 8. The strategy was fine; the solver was not --------------
  if (solutions && (!solutions.solutions || solutions.solutions.length === 0)) {
    return {
      class: AIRLLM_FAILURE.DOWNSTREAM_NO_SOLUTION,
      code: 'DOWNSTREAM_NO_SOLUTION',
      detail: plan?.applied?.strategy
        ? `strategy ${plan.decision?.optimizationMode} was approved, but the solver produced no feasible candidate.`
        : 'the solver produced no feasible candidate.',
      recoverable: false,
    };
  }

  return { class: null, code: null, detail: null, recoverable: false };
}

/**
 * Tally a list of classifications into a count-per-class record,
 * always including every class so a report has a stable shape and a
 * missing category reads as 0 rather than as absent.
 */
export function tallyFailures(classifications) {
  const out = Object.fromEntries(ALL_AIRLLM_FAILURES.map((c) => [c, 0]));
  out.NONE = 0;
  for (const c of classifications) {
    const key = c?.class ?? 'NONE';
    if (key in out) out[key] += 1;
    else out[key] = 1;
  }
  return out;
}
