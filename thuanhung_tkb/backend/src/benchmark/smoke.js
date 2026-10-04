// PHASE 31 — TIER A: REAL AIRLLM RUNTIME SMOKE TEST.
//
// Brief §1 requires the two tiers to be kept apart:
//
//   TIER A  "does the AirLLM service actually work"
//   TIER B  "is the AirLLM strategy actually useful"
//
// This file is Tier A and nothing else. It calls the service, records
// what the service said about itself, and reports PASS / FAIL /
// BLOCKED. It contains no quality comparison, no baseline, and no
// verdict about whether the AI is any good. A Tier A PASS says
// exactly one thing: the model loaded, `/ready` reported MODEL_READY,
// and `/plan` returned a decision the Node validator accepted.
//
// WHAT THIS MODULE REFUSES TO DO
// ------------------------------
// It never manufactures a ready state. Every field it reports is
// either something the service returned or `null`. Brief §7 is
// explicit — "do not change code to fake model ready" — and the
// practical version of that rule is the one enforced here: there is
// no code path from "the probe failed" to "ready: true", and a
// BLOCKED result is a first-class outcome rather than a failure to
// be worked around (brief §35).
//
// MODEL METADATA (brief §8, §9, §10)
// ----------------------------------
// The harness reports exactly what `/health` and `/ready` carried:
//
//   airllmVersion, pythonVersion, torchVersion, transformersVersion,
//   modelIdentifier, device, cudaAvailable, dtype,
//   temperature, maxNewTokens, topP, seed
//
// Anything the service did not report is `null` — never "latest",
// never "unknown", never "recommended". `topP` and `seed` are `null`
// on this build because the service does not expose them, and the
// harness does not invent them: a generation setting that is not
// reported is a generation setting that cannot be claimed to have
// been held constant.
//
// The instruct-model requirement (brief §9) is recorded as
// `UNVERIFIED`, not as true or false. Nothing `/health` returns can
// distinguish an instruct checkpoint from a base one, and a
// heuristic that guesses would be precisely the kind of unverified
// claim brief §8 prohibits. The benchmark therefore reports the
// quality numbers and refuses to interpret a parser-failure rate as
// evidence about strategy quality (brief §9).

import { planStrategy } from '../domain/ai/index.js';
import { AirLLMPlanner, probeAirLLMService } from '../domain/ai/providers/airllm-planner.js';
import { AIRLLM_FAILURE, classifyAirLLMOutcome } from './classification.js';

export const RUNTIME_RESULT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  // The environment cannot answer the question. Distinct from FAIL:
  // "no AirLLM on this host" is not evidence about AirLLM.
  BLOCKED: 'BLOCKED',
});

export const RUNTIME_FAILURE_CODE = 'AIRLLM_RUNTIME_FAILURE';

/**
 * Is this planner actually an AirLLM provider?
 *
 * `instanceof` alone is too strict for a test double, and a duck-typed
 * check alone is too loose, so both are accepted. The check exists
 * because of a specific failure it prevents: `AI_PROVIDER` defaults to
 * `mock`, and a Tier A run handed the mock planner would load no
 * model, call no service, and report PASS — a green tick for a model
 * that was never involved. Tier A asks whether AIRLLM works; anything
 * else is not a Tier A run.
 */
export function isAirLLMPlanner(planner) {
  if (!planner) return false;
  if (planner instanceof AirLLMPlanner) return true;
  return /airllm/i.test(String(planner.name ?? ''));
}

/**
 * runRuntimeSmokeTest({ planner, serviceUrl, serviceToken, fetchImpl, input, timeoutMs })
 *   -> RuntimeSmokeResult
 *
 *   {
 *     tier: 'TIER_A_RUNTIME_SMOKE',
 *     result: 'PASS' | 'FAIL' | 'BLOCKED',
 *     modelReady: true | false | null,   // null = not established
 *     blocked: boolean,
 *     blockReason: string | null,
 *     steps: [{ name, ok, detail, ms }],
 *     decision: { accepted, fallbackUsed, status, strategyHash } | null,
 *     environment: { ... brief §8 fields ... },
 *     generation: { ... brief §10 fields ... },
 *     determinism: { guaranteed, reason },
 *     instruct: { status, note },
 *     failure: { class, code, detail } | null,
 *     rootCause: string | null,
 *   }
 */
export async function runRuntimeSmokeTest(options = {}) {
  const {
    planner = null,
    serviceUrl,
    serviceToken = null,
    fetchImpl = undefined,
    input = null,
    timeoutMs = 5_000,
    planTimeoutMs = 600_000,
  } = options;

  const startedAt = Date.now();
  const steps = [];
  const step = (name, ok, detail, ms) => {
    steps.push({ name, ok, detail, ms });
    return ok;
  };

  // ---- 1. PROBE ---------------------------------------------------
  const probeStart = Date.now();
  let probe = null;
  let probeError = null;
  try {
    probe = await probeAirLLMService({ serviceUrl, serviceToken, timeoutMs, fetchImpl });
  } catch (e) {
    probeError = String(e?.message ?? e);
  }
  const probeMs = Date.now() - probeStart;

  if (probeError) {
    step('probe', false, `the probe threw: ${probeError}`, probeMs);
    return blockedOrFail({
      steps,
      probe: null,
      environment: emptyEnvironment(),
      failure: {
        class: AIRLLM_FAILURE.SERVICE_UNREACHABLE,
        code: RUNTIME_FAILURE_CODE,
        detail: probeError,
      },
      rootCause: `the readiness probe itself failed: ${probeError}`,
      startedAt,
    });
  }

  if (!probe.reachable) {
    step('health', false, probe.error ?? 'the service did not answer /health', probeMs);
    return blockedOrFail({
      steps,
      probe,
      environment: emptyEnvironment(),
      failure: {
        class: AIRLLM_FAILURE.SERVICE_UNREACHABLE,
        code: RUNTIME_FAILURE_CODE,
        detail: probe.error ?? 'the service is not reachable on the configured loopback URL',
      },
      rootCause: 'no AirLLM service is listening. Start ai-service, or set AIRLLM_SERVICE_URL to the right port.',
      startedAt,
    });
  }

  const ready = step(
    'ready',
    probe.state === 'MODEL_READY',
    `service state is ${probe.state ?? 'unknown'}`,
    probeMs,
  );
  if (!ready) {
    const classification = classifyAirLLMOutcome({ probe });
    return blockedOrFail({
      steps,
      probe,
      environment: environmentFrom(probe),
      failure: {
        class: classification.class ?? AIRLLM_FAILURE.MODEL_NOT_READY,
        code: RUNTIME_FAILURE_CODE,
        detail: probe.ready?.error
          ?? probe.ready?.errors?.[0]
          ?? `the service is ${probe.state}, not MODEL_READY`,
      },
      rootCause: 'the process is up but the model is not servable. See /ready for the loader error.',
      startedAt,
    });
  }

  // ---- 2. PLAN ----------------------------------------------------
  // `modelReady: true` is established HERE and nowhere earlier. It is
  // set from the service's own `/ready`, never inferred.
  let planResult = null;
  let planError = null;
  const planStart = Date.now();
  if (!planner || !input) {
    planError = 'no planner or no SchedulingInput was supplied to the smoke test';
  } else if (!isAirLLMPlanner(planner)) {
    // Not a "the model failed" failure. A wiring error, reported as
    // such, because the alternative — planning with the mock and
    // calling the result an AirLLM runtime pass — is exactly the
    // substitution brief §7 and §35 forbid.
    planError =
      `Tier A must exercise an AirLLM provider, but the planner supplied is `
      + `${planner.name ?? 'unnamed'}. Set AI_PROVIDER=airllm. No model was loaded and no `
      + 'inference was run, so this is not a runtime verdict either way.';
  } else {
    try {
      planResult = await planStrategy(input, {
        planner,
        timeoutMs: planTimeoutMs,
        revalidate: true,
      });
    } catch (e) {
      planError = String(e?.message ?? e);
    }
  }
  const planMs = Date.now() - planStart;

  if (planError) {
    step('plan', false, planError, planMs);
    return {
      tier: 'TIER_A_RUNTIME_SMOKE',
      result: RUNTIME_RESULT.FAIL,
      modelReady: true,
      blocked: false,
      blockReason: null,
      steps,
      decision: null,
      environment: environmentFrom(probe),
      generation: generationFrom(probe),
      determinism: determinismFrom(probe),
      instruct: instructNote(probe),
      failure: {
        class: AIRLLM_FAILURE.INFERENCE_FAILURE,
        code: RUNTIME_FAILURE_CODE,
        detail: planError,
      },
      rootCause: `the model reported ready but /plan failed: ${planError}`,
      totalMs: Date.now() - startedAt,
    };
  }

  const accepted = planResult.fallbackUsed === false;
  step(
    'plan',
    accepted,
    accepted
      ? 'the service returned a decision the Node validator accepted'
      : `fell back: ${planResult.failure?.detail ?? planResult.validation?.reason ?? 'no reason recorded'}`,
    planMs,
  );

  const classification = classifyAirLLMOutcome({ plan: planResult, probe, solutions: { solutions: [] } });
  const environment = environmentFrom(probe);
  const generation = generationFrom(probe);

  return {
    tier: 'TIER_A_RUNTIME_SMOKE',
    result: accepted ? RUNTIME_RESULT.PASS : RUNTIME_RESULT.FAIL,
    modelReady: true,
    blocked: false,
    blockReason: null,
    steps,
    decision: {
      accepted,
      fallbackUsed: planResult.fallbackUsed === true,
      status: planResult.validation?.status ?? null,
      optimizationMode: planResult.decision?.optimizationMode ?? null,
      candidateCount: planResult.decision?.candidateCount ?? null,
      strategyHash: planResult.decision ? hashOfDecision(planResult.decision) : null,
      corrections: (planResult.validation?.events ?? []).length,
    },
    environment,
    generation,
    determinism: determinismFrom(probe),
    instruct: instructNote(probe),
    failure: accepted ? null : {
      class: classification.class ?? AIRLLM_FAILURE.INFERENCE_FAILURE,
      code: RUNTIME_FAILURE_CODE,
      detail: classification.detail ?? 'the service answered but no decision was approved',
    },
    rootCause: accepted ? null : (classification.detail ?? 'the service answered but no decision was approved'),
    totalMs: Date.now() - startedAt,
  };
}

// ============================================================================
// Metadata projections (brief §8, §9, §10)
// ============================================================================

function environmentFrom(probe) {
  const health = probe?.health ?? null;
  const runtime = health?.runtime ?? null;
  const cfg = health?.config ?? null;
  const ready = probe?.ready ?? null;
  return {
    // Exactly the eight fields brief §8 names, plus the state. `null`
    // means "the service did not report it" and is never filled in
    // with a guess.
    airllmVersion: runtime?.airllmVersion ?? null,
    pythonVersion: runtime?.pythonVersion ?? null,
    torchVersion: runtime?.torchVersion ?? null,
    transformersVersion: runtime?.transformersVersion ?? null,
    modelIdentifier: health?.model ?? null,
    device: cfg?.device ?? null,
    cudaAvailable: typeof runtime?.cudaAvailable === 'boolean' ? runtime.cudaAvailable : null,
    dtype: cfg?.dtype ?? null,
    // Context beyond the required eight, all service-reported.
    fastapiVersion: runtime?.fastapiVersion ?? null,
    platform: runtime?.platform ?? null,
    modelLoaded: health?.modelLoaded === true,
    modelSource: cfg?.modelSource ?? null,
    modelResolvesLocally: cfg?.modelResolvesLocally === null ? null : cfg?.modelResolvesLocally === true,
    allowRemoteCode: cfg?.allowRemoteCode === true,
    serviceState: probe?.state ?? ready?.state ?? null,
    remoteCodeUsed: ready?.remoteCodeUsed === true,
    // TRUE only when every one of the eight required fields has a
    // value. A report may not present a partially-observed
    // environment as a described one.
    metadataComplete: Boolean(
      runtime?.airllmVersion && runtime?.pythonVersion && runtime?.torchVersion
      && runtime?.transformersVersion && health?.model && cfg?.device
      && typeof runtime?.cudaAvailable === 'boolean' && cfg?.dtype,
    ),
  };
}

function emptyEnvironment() {
  return {
    airllmVersion: null,
    pythonVersion: null,
    torchVersion: null,
    transformersVersion: null,
    modelIdentifier: null,
    device: null,
    cudaAvailable: null,
    dtype: null,
    fastapiVersion: null,
    platform: null,
    modelLoaded: false,
    modelSource: null,
    modelResolvesLocally: null,
    allowRemoteCode: false,
    serviceState: null,
    remoteCodeUsed: false,
    metadataComplete: false,
  };
}

function generationFrom(probe) {
  const cfg = probe?.health?.config ?? null;
  return {
    temperature: numberOrNull(cfg?.temperature),
    topP: null, // not exposed by the service on this build
    maxTokens: numberOrNull(cfg?.maxNewTokens),
    seed: null, // not exposed by the service on this build
    // Set to false wherever a value is null: an unreported setting
    // means the benchmark cannot claim it held constant.
    fullyReported: cfg?.temperature !== undefined
      && cfg?.maxNewTokens !== undefined
      && cfg?.topP !== undefined
      && cfg?.seed !== undefined,
  };
}

function determinismFrom(probe) {
  const gen = generationFrom(probe);
  if (gen.temperature === 0 && gen.seed !== null) {
    return {
      guaranteed: true,
      reason: 'temperature is 0 and the provider reports a seed.',
    };
  }
  return {
    guaranteed: false,
    reason:
      'AirLLM declares no determinism guarantee and this service reports no generation seed. '
      + 'Temperature is reported; topP and seed are not exposed. Sampling variance is therefore '
      + 'DOCUMENTED and measured across repetitions, not assumed away. The Node solver seed is '
      + 'unaffected either way: AI sampling cannot reach solver randomness.',
  };
}

function instructNote(probe) {
  return {
    // Brief §9. Neither /health nor /ready can distinguish an instruct
    // checkpoint from a base one, so the harness does not try.
    status: 'UNVERIFIED',
    modelIdentifier: probe?.health?.model ?? null,
    note:
      'Brief §9 requires an instruct model for a quality benchmark. Nothing this service reports '
      + 'can establish that, so the harness records UNVERIFIED rather than guessing. A high '
      + 'INVALID_JSON / SCHEMA_INVALID rate is consistent with a base model, but it is not proof, '
      + 'and the parser is never relaxed to make the numbers look better.',
  };
}

// ============================================================================
// Helpers
// ============================================================================

function blockedOrFail({ steps, probe, environment, failure, rootCause, startedAt }) {
  // BLOCKED, not FAIL. A host with no AirLLM installed has produced
  // no evidence about AirLLM, and brief §35 requires that state to be
  // represented honestly rather than counted as a pass or dressed as
  // a failure of the thing being measured.
  const blocked = !probe || probe.reachable === false;
  return {
    tier: 'TIER_A_RUNTIME_SMOKE',
    result: blocked ? RUNTIME_RESULT.BLOCKED : RUNTIME_RESULT.FAIL,
    modelReady: false,
    blocked,
    blockReason: blocked ? (rootCause ?? 'no AirLLM service is reachable on this host') : null,
    steps,
    decision: null,
    environment,
    generation: generationFrom(probe),
    determinism: determinismFrom(probe),
    instruct: instructNote(probe),
    failure,
    rootCause,
    totalMs: Date.now() - startedAt,
  };
}

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function hashOfDecision(decision) {
  // Local, duplicated from runner.js on purpose: a smoke result must
  // not depend on the benchmark runner being importable, and a
  // one-line hash of a three-field object is not worth a cycle of
  // import risk.
  const keys = Object.keys(decision.scoringWeights ?? {}).sort();
  const text = JSON.stringify({
    optimizationMode: decision.optimizationMode ?? null,
    candidateCount: decision.candidateCount ?? null,
    scoringWeights: Object.fromEntries(keys.map((k) => [k, decision.scoringWeights[k]])),
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
