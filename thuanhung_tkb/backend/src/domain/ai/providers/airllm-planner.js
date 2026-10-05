// PHASE 30 — AIRLLM LOCAL PROVIDER.
//
// AirLLM becomes one implementation of the Phase 29 seam. That is
// the whole change: a different `plan()` body behind the same
// interface, reached over HTTP instead of computed in-process.
//
//   SituationReport ──▶ AirLLMPlanner.plan ──▶ raw decision
//                                                  │
//                              validateStrategyDecision (unchanged)
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO
// ---------------------------------------
//  - It does not validate the decision. `validateStrategyDecision`
//    is still the only path to a Strategy, and it still runs in Node
//    even though the Python service already validated (brief §16).
//    Two independent layers, because the service is not trusted and
//    Node is the authority (brief §20).
//  - It does not import the solver, the multi-solution generator, or
//    the global scorer. It cannot influence feasibility or ranking
//    except through the validated strategy (brief §36).
//  - It does not build a prompt, read a model file, import torch, or
//    know what AirLLM is. All of that is the Python service's
//    problem; this file moves JSON (brief §3).
//  - It does not touch the solver seed. AI sampling can vary freely
//    without moving the solver's randomness (brief §57).
//
// SECURE REMOTE CODE
// ------------------
// The operator-facing promise is "no arbitrary model repository code
// runs by default" (brief §8). AirLLM cannot keep that promise on
// its own: its `AutoModel.get_module_class` resolves the config
// with `trust_remote_code=True` unconditionally, and there is no
// keyword to turn that off. So this provider refuses to point at a
// model whose architecture is not recognised by Transformers natively
// unless `allowRemoteCode` was set to true by hand, and even then the
// decision is recorded in the audit log rather than made silently.
// The check itself lives in the Python service, which is the only
// side that can read the config; this side only carries the flag.

import { AIPlanner, AIProviderError } from '../planner.js';
import { AI_FAILURE } from '../strategy-schema.js';
import { AIRLLM_CLIENT_DEFAULTS, assertServiceUrl, postPlan } from './airllm-client.js';

export const AIRLLM_PLANNER_DEFAULTS = Object.freeze({
  serviceUrl: 'http://127.0.0.1:8077',
  serviceToken: null,
  requestTimeoutMs: 30_000,
  // Injected for tests and for hosts with a custom agent. Production
  // leaves it null and the global fetch is used.
  fetchImpl: null,
});

export class AirLLMPlanner extends AIPlanner {
  /**
   * @param {object} [options]
   * @param {string} [options.serviceUrl]  - loopback URL of ai-service
   * @param {string|null} [options.serviceToken] - optional internal shared secret
   * @param {number} [options.requestTimeoutMs] - per-call ceiling
   * @param {Function|null} [options.fetchImpl] - injected fetch
   */
  constructor(options = {}) {
    super();
    this.options = { ...AIRLLM_PLANNER_DEFAULTS, ...(options ?? {}) };
  }

  get name() {
    return 'AirLLMPlanner';
  }

  /**
   * @param {object} report - the Phase 29 SituationReport. The only
   *   thing this provider is given; it never sees the
   *   SchedulingInput, the candidates, or the constraint catalog.
   * @returns {Promise<object>} the service's decision, UNVALIDATED.
   */
  async plan(report) {
    const urlCheck = assertServiceUrl(this.options.serviceUrl);
    if (!urlCheck.ok) {
      throw new AIProviderError(AI_FAILURE.UNAVAILABLE, urlCheck.reason);
    }

    const result = await postPlan({
      url: this.options.serviceUrl,
      token: this.options.serviceToken,
      report,
      timeoutMs: this.options.requestTimeoutMs ?? AIRLLM_CLIENT_DEFAULTS.timeoutMs,
      // PHASE 35: passed through UNCHANGED, including when it is null.
      // A null `fetchImpl` is what selects the client's `node:http`
      // transport, whose deadline the caller controls; coercing it to
      // `globalThis.fetch` here would reinstate undici's 300 s
      // headersTimeout, which no AbortSignal can raise, and every real
      // AirLLM decision would fail at 300 s while the model was still
      // answering. A function is still honoured verbatim; that is the
      // test seam.
      fetchImpl: this.options.fetchImpl,
    });

    // Record what the service said about itself, on the decision
    // itself, so the audit log carries the provenance without the
    // orchestrator having to know the provider exists. `source` is an
    // allowed decision field, so this survives validation.
    const decision = {
      ...result.decision,
      source: typeof result.decision.source === 'string' && result.decision.source
        ? result.decision.source
        : 'AirLLMPlanner',
    };
    // Non-enumerable so the validator's unknown-field check is not
    // confused, but the orchestrator's audit can still read it.
    Object.defineProperty(decision, '__airllm', {
      value: Object.freeze({
        provider: result.provider,
        model: result.model,
        promptVersion: result.promptVersion,
        latencyMs: result.latencyMs,
        serviceLatencyMs: result.serviceLatencyMs,
        serviceValidated: result.serviceValidated,
        serviceCorrections: Object.freeze([...result.serviceCorrections]),
        state: result.state,
      }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return decision;
  }
}

/**
 * Health/readiness probe, used by operators and by the integration
 * test. It is deliberately NOT part of the `AIPlanner` contract: the
 * orchestrator never calls it, because "is the service up" is an
 * operational question, and a planner that had to ask would be
 * slower for no benefit (brief §11).
 */
export async function probeAirLLMService(options = {}) {
  const {
    serviceUrl = AIRLLM_PLANNER_DEFAULTS.serviceUrl,
    serviceToken = null,
    timeoutMs = 5_000,
    fetchImpl = globalThis.fetch,
  } = options;

  const urlCheck = assertServiceUrl(serviceUrl);
  if (!urlCheck.ok) return { reachable: false, state: null, error: urlCheck.reason };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { accept: 'application/json' };
    if (serviceToken) headers.authorization = `Bearer ${serviceToken}`;

    const [health, ready] = await Promise.all([
      getJson(new URL('/health', serviceUrl).toString(), headers, controller.signal, fetchImpl),
      getJson(new URL('/ready', serviceUrl).toString(), headers, controller.signal, fetchImpl),
    ]);

    return {
      reachable: health.ok,
      health: health.body,
      ready: ready.ok ? ready.body : null,
      // The one field that matters to a caller: can this service
      // actually serve a decision right now?
      state: ready.ok ? (ready.body?.state ?? null) : null,
      error: health.ok ? (ready.ok ? null : 'the service answered /health but not /ready') : health.error,
    };
  } catch (e) {
    return { reachable: false, state: null, error: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, headers, signal, fetchImpl) {
  if (typeof fetchImpl !== 'function') return { ok: false, body: null, error: 'no fetch implementation' };
  try {
    const res = await fetchImpl(url, { method: 'GET', headers, signal });
    if (!res.ok) return { ok: false, body: null, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json(), error: null };
  } catch (e) {
    return { ok: false, body: null, error: String(e?.message ?? e) };
  }
}
