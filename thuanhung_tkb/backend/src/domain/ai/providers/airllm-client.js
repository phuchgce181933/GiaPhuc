// PHASE 30 — AIRLLM HTTP CLIENT (Node side of the provider boundary).
//
// The Node backend never embeds a Python interpreter. It speaks
// plain HTTP to a local `ai-service` process, which owns AirLLM,
// torch, and the model weights (brief §1).
//
//   Node ──POST /plan──▶ ai-service (Python, AirLLM)
//   Node ◀─{decision}────
//
// This module is the ONLY place that knows the service exists. It
// knows nothing about AirLLM, torch, prompts, or models, and it must
// not: the AI strategy contract is provider-agnostic (brief §2, §3).
//
// WHAT CROSSES THE WIRE
// ---------------------
// One way: `{ situationReport }` — the Phase 29 report, which is
// already aggregate-only, PII-free, and slot-free. The SchedulingInput
// is never serialized, so the service cannot see teachers, e-mail
// addresses, or the 802 schedule slots even if it wanted to
// (brief §21, §22, §55).
//
// HOW FAILURES ARE CLASSIFIED
// ---------------------------
// The service can be down, slow, broken, or lying. Each maps onto an
// existing `AI_FAILURE` kind so the Phase 29 orchestrator falls back
// with an accurate reason instead of a generic one:
//
//   condition                          AI_FAILURE
//   ---------------------------------  --------------------------
//   DNS/connect refused, ECONNREFUSED  UNAVAILABLE
//   socket hangup / truncated body     UNAVAILABLE
//   HTTP 503 / not ready               UNAVAILABLE
//   HTTP 400 (bad request)             UNSUPPORTED_REQUEST
//   abort caused by our own timer      TIMEOUT
//   HTTP 200, body is not JSON         PARSE_ERROR
//   HTTP 200, JSON is not an object    PARSE_ERROR
//   HTTP 200, `decision` missing       INVALID_OUTPUT
//
// Every one of these ends in the same place — the deterministic
// fallback — but they are operationally very different, and an
// operator debugging a dead service needs to see which one it was.

import { AIProviderError } from '../planner.js';
import { AI_FAILURE } from '../strategy-schema.js';

export const AIRLLM_CLIENT_DEFAULTS = Object.freeze({
  /**
   * Per-request ceiling. The planner passes its own `AbortSignal`
   * deadline; this is the backstop for a transport that ignores it.
   */
  timeoutMs: 30_000,
  /**
   * The Phase 29 orchestrator already races the provider against its
   * own timeout and abandons a provider that never settles. That
   * abandons the PROMISE, not the socket, so the planner cancels the
   * request itself instead of leaking an in-flight HTTP call per
   * timeout (brief §12).
   */
  keepAliveMs: 5_000,
});

/**
 * Reject a service URL that is not a local, plain-HTTP endpoint.
 *
 * The service holds model weights and may hold a shared secret. It
 * must never be reachable from the public internet, and TLS is the
 * Python service's business (it binds loopback). Anything else is a
 * misconfiguration we refuse rather than quietly dial (brief §43).
 */
export function assertServiceUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, reason: 'AIRLLM_SERVICE_URL is not set' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: `AIRLLM_SERVICE_URL is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== 'http:') {
    return {
      ok: false,
      reason: `AIRLLM_SERVICE_URL must use http:// on a loopback address, got ${parsed.protocol}//`,
    };
  }
  const host = parsed.hostname;
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (!isLoopback) {
    return {
      ok: false,
      reason:
        `AIRLLM_SERVICE_URL must point at a loopback address (127.0.0.1 / localhost / ::1), got "${host}". ` +
        'The AirLLM service holds model weights and is not a public endpoint.',
    };
  }
  return { ok: true, reason: null };
}

/**
 * Classify a thrown transport error into an `AI_FAILURE` kind.
 * Exported so the mapping is unit-testable on its own.
 */
export function classifyTransportError(err) {
  if (err?.aiFailureKind) return err.aiFailureKind;
  // A timeout we raised ourselves: the abort reason is set below
  // before we abort, so a marker on the error is enough to tell
  // "too slow" apart from "connection refused".
  if (err?.name === 'AbortError' || err?.aiTimeout === true) return AI_FAILURE.TIMEOUT;

  const code = String(err?.code ?? err?.cause?.code ?? '').toUpperCase();
  const message = String(err?.message ?? err ?? '').toLowerCase();

  // A server that answers but is not ready to serve inference.
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || code === 'ECONNRESET' || code === 'EPIPE' || code === 'EHOSTUNREACH'
    || code === 'ENETUNREACH' || code === 'EHOSTDOWN'
    || message.includes('fetch failed') || message.includes('socket hang up')
    || message.includes('terminated')) {
    return AI_FAILURE.UNAVAILABLE;
  }
  if (message.includes('timeout') || message.includes('timed out') || code === 'ETIMEDOUT') {
    return AI_FAILURE.TIMEOUT;
  }
  // Anything we cannot place is treated as a broken service rather
  // than as "the model said something odd": a transport fault and a
  // model fault have different fixes.
  return AI_FAILURE.UNAVAILABLE;
}

/**
 * Map an HTTP status onto a failure kind. The service is expected to
 * answer 503 while its model is still loading or after a model error
 * (brief §11), which is an availability problem, not a bad request.
 */
export function classifyStatus(status) {
  if (status === 400) return AI_FAILURE.UNSUPPORTED_REQUEST;
  if (status === 422) return AI_FAILURE.UNSUPPORTED_REQUEST;
  if (status === 401 || status === 403) return AI_FAILURE.UNAVAILABLE;
  if (status === 503) return AI_FAILURE.UNAVAILABLE;
  if (status === 504) return AI_FAILURE.TIMEOUT;
  if (status >= 500) return AI_FAILURE.UNAVAILABLE;
  return AI_FAILURE.INVALID_OUTPUT;
}

/**
 * postPlan({ url, token, report, timeoutMs, signal, fetchImpl })
 *   -> { decision, provider, model, promptVersion, latencyMs, usage }
 *
 * Resolves with the service's `decision` object — an UNVALIDATED
 * candidate decision. Validating it is the caller's job
 * (`validateStrategyDecision`), which this module never does and
 * must never do: the Python service is not the security boundary
 * (brief §16). A second, untrusted layer that cannot widen the Node
 * allow-list is worth having; a single one is not.
 *
 * Throws `AIProviderError` for every failure, never a bare Error and
 * never a raw fetch rejection, so the orchestrator's classification
 * is total.
 */
export async function postPlan(options = {}) {
  const {
    url,
    token = null,
    report,
    timeoutMs = AIRLLM_CLIENT_DEFAULTS.timeoutMs,
    signal = null,
    fetchImpl = globalThis.fetch,
  } = options;

  const urlCheck = assertServiceUrl(url);
  if (!urlCheck.ok) {
    throw new AIProviderError(AI_FAILURE.UNAVAILABLE, urlCheck.reason);
  }
  if (report === null || typeof report !== 'object') {
    throw new AIProviderError(AI_FAILURE.UNSUPPORTED_REQUEST, 'a situation report is required to call /plan');
  }
  if (typeof fetchImpl !== 'function') {
    throw new AIProviderError(
      AI_FAILURE.UNAVAILABLE,
      'no fetch implementation is available; Node 18+ or an injected fetchImpl is required',
    );
  }

  const endpoint = new URL('/plan', url).toString();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Chain the caller's signal so an outer deadline (the Phase 29
  // orchestrator) still cancels the socket.
  const onOuterAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const started = Date.now();
  try {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ situationReport: report }),
        signal: controller.signal,
      });
    } catch (e) {
      const kind = timedOut ? AI_FAILURE.TIMEOUT : classifyTransportError(e);
      const err = new AIProviderError(
        kind,
        timedOut
          ? `the AirLLM service did not answer within ${timeoutMs} ms`
          : `the AirLLM service is unreachable: ${String(e?.message ?? e)}`,
      );
      err.aiTimeout = timedOut;
      throw err;
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new AIProviderError(
        classifyStatus(response.status),
        `the AirLLM service returned HTTP ${response.status}${body ? `: ${truncate(body, 200)}` : ''}`,
        { status: response.status },
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch (e) {
      throw new AIProviderError(
        AI_FAILURE.PARSE_ERROR,
        `the AirLLM service returned a body that is not JSON: ${String(e?.message ?? e)}`,
      );
    }

    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new AIProviderError(AI_FAILURE.PARSE_ERROR, 'the AirLLM service returned a non-object JSON body');
    }
    // The service may answer 200 while its own model failed, because
    // "I could not infer" is a legitimate answer. That is an
    // availability problem, and it must fall back rather than be
    // handed to the validator as if it were a decision.
    if (payload.fallbackUsed === true && (payload.decision === undefined || payload.decision === null)) {
      throw new AIProviderError(
        AI_FAILURE.UNAVAILABLE,
        payload.error
          ? `the AirLLM service could not produce a decision: ${truncate(String(payload.error), 200)}`
          : 'the AirLLM service could not produce a decision',
        { serviceState: payload.state ?? null },
      );
    }
    if (payload.decision === null || typeof payload.decision !== 'object' || Array.isArray(payload.decision)) {
      throw new AIProviderError(
        AI_FAILURE.INVALID_OUTPUT,
        'the AirLLM service returned no usable "decision" field',
      );
    }

    return {
      decision: payload.decision,
      provider: typeof payload.provider === 'string' ? payload.provider : 'airllm',
      model: typeof payload.model === 'string' ? payload.model : null,
      promptVersion: typeof payload.promptVersion === 'string' ? payload.promptVersion : null,
      latencyMs: typeof payload.latencyMs === 'number' ? payload.latencyMs : Date.now() - started,
      serviceLatencyMs: typeof payload.serviceLatencyMs === 'number' ? payload.serviceLatencyMs : null,
      // The service's own verdict. It does NOT gate anything here —
      // Node validates independently — but it is recorded so the
      // audit log shows both layers agreed, or did not.
      serviceValidated: payload.validated === true,
      serviceCorrections: Array.isArray(payload.corrections) ? payload.corrections : [],
      state: typeof payload.state === 'string' ? payload.state : null,
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncate(s, n) {
  const str = String(s);
  return str.length <= n ? str : `${str.slice(0, n)}…`;
}
