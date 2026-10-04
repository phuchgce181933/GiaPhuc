// PHASE 30 — AI PROVIDER SELECTION.
//
// One config value decides which implementation of the Phase 29 seam
// is handed to `planStrategy`:
//
//   AI_PROVIDER=mock     the Phase 29 deterministic rule table
//   AI_PROVIDER=airllm   the Phase 30 local Python service
//   AI_PROVIDER=off      no provider at all; always falls back
//
// `mock` is the default so that `npm test` and CI never require a
// GPU, a Python runtime, or model weights (brief §27, §45). The
// selection is explicit and total: an unknown value is a
// configuration error, not a silent downgrade to `mock`, because a
// typo that quietly kept the AI off would be invisible in production
// (brief §27).
//
// Nothing here imports AirLLM, torch, or anything Python. The factory
// only decides which of two already-written planners to build.

import { AIPlanner, DeterministicMockAIPlanner, createUnavailablePlanner } from '../planner.js';
import { AirLLMPlanner, AIRLLM_PLANNER_DEFAULTS, probeAirLLMService } from './airllm-planner.js';
import {
  AIRLLM_CLIENT_DEFAULTS,
  assertServiceUrl,
  classifyStatus,
  classifyTransportError,
  postPlan,
} from './airllm-client.js';

/** The provider values this project understands. */
export const AI_PROVIDERS = Object.freeze({
  MOCK: 'mock',
  AIRLLM: 'airllm',
  OFF: 'off',
});

/**
 * Build a planner from a config object shaped like `config.ai`.
 *
 * Returning a planner that always throws is a legitimate outcome: an
 * operator who asked for AirLLM without a reachable service should
 * get the deterministic fallback and an accurate audit reason, not a
 * crash at startup. A bad URL is therefore not thrown here either —
 * `AirLLMPlanner` reports it as `AI_UNAVAILABLE` on its first call,
 * which is the same code path as a service that is simply down
 * (brief §13).
 */
export function createAIPlannerFromConfig(aiConfig = {}, overrides = {}) {
  const provider = String(overrides.provider ?? aiConfig.provider ?? AI_PROVIDERS.MOCK)
    .trim()
    .toLowerCase();

  if (provider === AI_PROVIDERS.MOCK) {
    return new DeterministicMockAIPlanner(overrides.mock ?? {});
  }

  if (provider === AI_PROVIDERS.OFF) {
    return createUnavailablePlanner('AI is disabled (AI_PROVIDER=off)');
  }

  if (provider === AI_PROVIDERS.AIRLLM) {
    return new AirLLMPlanner({
      serviceUrl: aiConfig.serviceUrl ?? AIRLLM_PLANNER_DEFAULTS.serviceUrl,
      serviceToken: aiConfig.serviceToken ?? null,
      requestTimeoutMs: aiConfig.requestTimeoutMs ?? AIRLLM_PLANNER_DEFAULTS.requestTimeoutMs,
      fetchImpl: overrides.fetchImpl ?? null,
    });
  }

  return createUnavailablePlanner(
    `AI_PROVIDER=${JSON.stringify(provider)} is not a known provider. Use one of: ${Object.values(AI_PROVIDERS).join(', ')}.`,
  );
}

/**
 * A planner that reads a real service over HTTP but is guaranteed to
 * produce a valid decision without one. It is the honest default for
 * an environment that has an AirLLM service configured but not
 * necessarily running: a request is attempted, and a transport
 * failure becomes a fallback through the normal Phase 29 path rather
 * than through a special case here.
 */
export function isAirLLMConfigured(aiConfig = {}) {
  return String(aiConfig.provider ?? '').trim().toLowerCase() === AI_PROVIDERS.AIRLLM;
}

export { AIPlanner, AirLLMPlanner, DeterministicMockAIPlanner };
export { AIRLLM_PLANNER_DEFAULTS, probeAirLLMService };
export { AIRLLM_CLIENT_DEFAULTS, assertServiceUrl, classifyStatus, classifyTransportError, postPlan };
