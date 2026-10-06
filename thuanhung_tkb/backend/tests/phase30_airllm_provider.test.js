// PHASE 30 — AIRLLM LOCAL AI PROVIDER (Node side).
//
// SCOPE
// -----
// Phase 30 replaces `DeterministicMockAIPlanner` with a LOCAL AirLLM
// provider WITHOUT touching the Phase 29 contract. This file covers
// brief checks 1-17:
//
//    1. provider selection works
//    2. mock provider still works
//    3. AirLLM provider URL/config validation
//    4. timeout fallback
//    5. unavailable fallback
//    6. malformed response rejected
//    7. invalid strategy rejected
//    8. inactive travel cannot be activated
//    9. inactive transfer cannot be activated
//   10. hard constraints cannot be disabled
//   11. candidateCount bounded
//   12. weights bounded
//   13. provider metadata captured
//   14. decisionHash deterministic
//   15. input not mutated
//   16. no raw schedule passed to AI provider
//   17. no PII passed to AI provider
//
// THE INVARIANT THIS FILE EXISTS TO PROTECT
// -----------------------------------------
//   AirLLM is a PROVIDER, not a scheduler. It may propose a mode, a
//   candidate count, and bounded weights. It may not create a
//   schedule slot, name a teacher-period pair, disable a hard
//   constraint, activate TRAVEL/TRANSFER, or choose a count outside
//   {1,3,5,10} — and every one of those attempts must end in the
//   same place: the Phase 29 deterministic fallback, with the solver
//   still reachable and the SchedulingInput untouched.
//
// NOTHING HERE NEEDS A GPU, A MODEL, OR PYTHON.
// Every test drives an injected `fetch`, so `npm test` passes on a
// machine that has never installed AirLLM (brief §45). The real
// service is exercised only by `tests/integration/airllm/`, which is
// gated behind AIRLLM_INTEGRATION=1 (brief §28).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

import { loadLegacySchedulingFixture } from './helpers/scheduling-fixture.js';
import { STRATEGY_C, OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../src/domain/strategies.js';
import { generateSolutions } from '../src/domain/multi-solution.js';
import { DIMENSION_CATALOG } from '../src/domain/dimension-catalog.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { selectFinalSolutions } from '../src/domain/global-scoring.js';

import * as ai from '../src/domain/ai/index.js';
import {
  AI_PROVIDERS,
  AirLLMPlanner,
  assertServiceUrl,
  classifyStatus,
  classifyTransportError,
  createAIPlannerFromConfig,
  isAirLLMConfigured,
  probeAirLLMService,
} from '../src/domain/ai/providers/index.js';
import { AI_FAILURE, validateStrategyDecision, buildAllowList } from '../src/domain/ai/strategy-schema.js';
import { findPersonalData, canonicalStringify } from '../src/domain/ai/situation-report.js';
import { AI_STRATEGY_DEFAULTS } from '../src/domain/ai/index.js';
import { aiConfig, config } from '../src/config/index.js';

// ============================================================================
// Fixtures
// ============================================================================

const REAL = loadLegacySchedulingFixture().scheduling;
const INPUT = { ...REAL, strategy: STRATEGY_C };

/** Directory of this test file, for the structural source checks. */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A decision the validator accepts, mirroring a real AirLLM answer. */
function goodDecision(overrides = {}) {
  return {
    optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED,
    candidateCount: 3,
    scoringWeights: {
      WORKLOAD_BALANCE: 1.0,
      MAX_TEACHER_LOAD: 0.6,
      WORKLOAD_STDEV: 0.4,
      PREFERENCE: 0.3,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
    },
    rationale: 'Workload spread is the dominant issue; keep structural variety.',
    ...overrides,
  };
}

/**
 * A fake service. `handler(req)` returns `{ status, body }`; the
 * body is serialized as JSON. `bodies` records every request body so
 * tests 16 and 17 can inspect exactly what crossed the wire.
 */
function fakeService(handler) {
  const bodies = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {} });
    if (init.body) bodies.push(JSON.parse(init.body));
    const { status = 200, body = null } = await handler({ url: String(url), init, bodies }) ?? {};
    const text = body === null ? '' : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return JSON.parse(text); },
      async text() { return text; },
    };
  };
  return { fetchImpl, bodies, calls };
}

/** A service that always answers with one fixed decision. */
function serviceWith(decision, extra = {}) {
  return fakeService(() => ({
    status: 200,
    body: {
      decision,
      rationale: decision?.rationale ?? '',
      provider: 'airllm',
      model: 'test-model',
      promptVersion: '1',
      fallbackUsed: false,
      validated: true,
      latencyMs: 12,
      ...extra,
    },
  }));
}

/** The planner under test, wired to an injected transport. */
function plannerWith(decision, extra = {}) {
  const svc = serviceWith(decision, extra);
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: svc.fetchImpl,
  });
  return { planner, ...svc };
}

// PHASE 31.1 — DETERMINISTIC_SEARCH. The iteration bound, not the
// wall clock, is what makes the generation below reproducible. The
// time budgets are unchanged and are now only a safety valve: if one
// of them ever binds, the `searchLimited` assertion in test 20 fails
// loudly with a message naming the cause, instead of the suite
// flaking on a loaded host.
const SOLVE_OPTS = Object.freeze({
  count: 3,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  maxSearchIterations: 12,
});

// ============================================================================
// 1. provider selection works
// ============================================================================

test('01 provider selection works', () => {
  const mock = createAIPlannerFromConfig({ provider: 'mock' });
  assert.equal(mock.name, 'DeterministicMockAIPlanner');
  assert.equal(isAirLLMConfigured({ provider: 'mock' }), false);

  const air = createAIPlannerFromConfig({ provider: 'airllm', serviceUrl: 'http://127.0.0.1:8077' });
  assert.ok(air instanceof AirLLMPlanner, 'AI_PROVIDER=airllm must build the AirLLM provider');
  assert.equal(isAirLLMConfigured({ provider: 'airllm' }), true);

  // Case and whitespace are normalized, so a stray space in .env is
  // not a silent misconfiguration.
  assert.equal(createAIPlannerFromConfig({ provider: '  AirLLM ' }).name, 'AirLLMPlanner');

  // `off` yields a planner that always reports UNAVAILABLE, which
  // the orchestrator turns into the deterministic fallback.
  const off = createAIPlannerFromConfig({ provider: 'off' });
  assert.equal(off.name, 'UnavailablePlanner');

  // An unknown provider is a CONFIG ERROR, not a silent downgrade to
  // mock. A typo that quietly kept the AI off would be invisible.
  const bogus = createAIPlannerFromConfig({ provider: 'airLlm-plu' });
  assert.equal(bogus.name, 'UnavailablePlanner');

  // The default, with no config at all, is mock — CI needs no GPU.
  assert.equal(createAIPlannerFromConfig({}).name, 'DeterministicMockAIPlanner');
  assert.equal(createAIPlannerFromConfig().name, 'DeterministicMockAIPlanner');
  assert.equal(Object.values(AI_PROVIDERS).join(','), 'mock,airllm,off');
});

test('01b an unknown provider explains itself and falls back end to end', async () => {
  const planner = createAIPlannerFromConfig({ provider: 'gpt9' });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 2_000 });
  assert.equal(r.fallbackUsed, true, 'an unknown provider must fall back, not crash');
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
  assert.match(String(r.audit.failure?.detail ?? ''), /AI_PROVIDER="gpt9"/);
});

// ============================================================================
// 2. mock provider still works
// ============================================================================

test('02 the mock provider is unchanged and still the default', async () => {
  const planner = createAIPlannerFromConfig({ provider: 'mock' });
  const r = await ai.planStrategy(INPUT, { planner });
  assert.equal(r.fallbackUsed, false, 'Phase 29 behaviour must be untouched');
  assert.ok(Object.values(OPTIMIZATION_MODES).includes(r.decision.optimizationMode));
  assert.ok(ALLOWED_CANDIDATE_COUNTS.includes(r.decision.candidateCount));
  for (const [dim, w] of Object.entries(r.decision.scoringWeights)) {
    assert.ok(DIMENSION_CATALOG.some((d) => d.id === dim), `mock must not invent dimension ${dim}`);
    assert.ok(Number.isFinite(w) && w >= 0);
  }
  // The Phase 30 module did not change the mock's determinism.
  const again = await ai.planStrategy(INPUT, { planner });
  assert.deepEqual(again.decision, r.decision);
});

test('02b the default strategy needs no provider at all', async () => {
  const r = await ai.planStrategy(INPUT, { planner: null });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.decision.optimizationMode, OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED);
  assert.equal(r.applied.candidateCount, 3);
});

// ============================================================================
// 3. AirLLM provider URL/config validation
// ============================================================================

test('03 the service URL must be a loopback http endpoint', () => {
  for (const good of ['http://127.0.0.1:8077', 'http://localhost:8077', 'http://[::1]:8077']) {
    assert.equal(assertServiceUrl(good).ok, true, `${good} must be accepted`);
  }
  // The service holds model weights and may hold a shared secret. It
  // must never be dialable from outside the host.
  for (const bad of [
    'https://127.0.0.1:8077',      // TLS is not this service's business
    'http://0.0.0.0:8077',        // wildcard bind is a public endpoint
    'http://10.0.0.5:8077',       // LAN address
    'http://example.com:8077',    // public host
    'not-a-url',
    '',
    null,
    undefined,
  ]) {
    const check = assertServiceUrl(bad);
    assert.equal(check.ok, false, `${String(bad)} must be rejected`);
    assert.ok(check.reason.length > 0, 'a rejection must explain itself');
  }
  assert.match(assertServiceUrl('http://10.0.0.5:8077').reason, /loopback/);
});

test('03b a bad URL surfaces as AI_UNAVAILABLE, not a crash', async () => {
  const planner = new AirLLMPlanner({ serviceUrl: 'http://0.0.0.0:8077' });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 2_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.UNAVAILABLE);
  assert.match(String(r.audit.failure?.detail), /loopback/);
});

test('03c transport errors and statuses map onto the AI failure taxonomy', () => {
  // The mapping is the whole point: an operator must be able to tell
  // "service is down" from "model returned junk".
  const cases = [
    [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }), AI_FAILURE.UNAVAILABLE],
    [Object.assign(new Error('fetch failed'), { code: undefined }), AI_FAILURE.UNAVAILABLE],
    [Object.assign(new Error('getaddrinfo ENOTFOUND ai'), { code: 'ENOTFOUND' }), AI_FAILURE.UNAVAILABLE],
    [Object.assign(new Error('socket hang up'), {}), AI_FAILURE.UNAVAILABLE],
    [Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }), AI_FAILURE.TIMEOUT],
    [Object.assign(new Error('aborted'), { name: 'AbortError' }), AI_FAILURE.TIMEOUT],
    [new Error('something unclassifiable'), AI_FAILURE.UNAVAILABLE],
  ];
  for (const [err, expected] of cases) {
    assert.equal(classifyTransportError(err), expected, `${err.message} must classify as ${expected}`);
  }

  assert.equal(classifyStatus(400), AI_FAILURE.UNSUPPORTED_REQUEST);
  assert.equal(classifyStatus(422), AI_FAILURE.UNSUPPORTED_REQUEST);
  assert.equal(classifyStatus(503), AI_FAILURE.UNAVAILABLE, 'not-ready is an availability problem');
  assert.equal(classifyStatus(504), AI_FAILURE.TIMEOUT);
  assert.equal(classifyStatus(401), AI_FAILURE.UNAVAILABLE);
  assert.equal(classifyStatus(200), AI_FAILURE.INVALID_OUTPUT);
});

test('03d config reads every documented AI variable with a safe default', () => {
  const c = aiConfig();
  assert.equal(c.provider, 'mock', 'the default provider must be mock so CI needs no GPU');
  assert.equal(c.requestTimeoutMs, 30_000);
  assert.equal(c.allowRemoteCode, false, 'remote model code must be off by default');
  assert.equal(c.integrationEnabled, false, 'AirLLM integration tests must be opt-in');
  assert.equal(config.ai.provider, 'mock', 'config.ai mirrors aiConfig()');
  // No model is hard-coded anywhere; an unconfigured service simply
  // falls back.
  assert.ok(c.serviceUrl.startsWith('http://127.0.0.1'), 'the default service URL must be loopback');
});

// ============================================================================
// 4. timeout fallback
// ============================================================================

test('04 a slow service times out and falls back (brief §12)', async () => {
  // A transport that never answers. The planner's own AbortController
  // must fire, because abandoning the promise (what the Phase 29
  // orchestrator does) would otherwise leak a socket per call.
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 120,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
      });
    }),
  });

  const started = Date.now();
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  const elapsed = Date.now() - started;

  assert.equal(r.fallbackUsed, true, 'a timeout must never fail the schedule');
  assert.equal(r.audit.failure?.kind, AI_FAILURE.TIMEOUT);
  assert.ok(elapsed < 3_000, `the timeout must actually fire (took ${elapsed}ms)`);
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
  // The fallback is a usable strategy, not a placeholder.
  assert.equal(r.input.strategy.optimizationMode, OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED);
  assert.ok(Object.keys(r.decision.scoringWeights).length > 0);
});

test('04b the orchestrator timeout still wins when it is shorter', async () => {
  // Defence in depth: even if the planner's own deadline is longer
  // than the orchestrator's, the outer race must produce a fallback
  // rather than hang the pipeline.
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 60_000,
    fetchImpl: () => new Promise(() => {}),
  });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 150 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.TIMEOUT);
  assert.ok(AI_STRATEGY_DEFAULTS.timeoutMs > 0);
});

// ============================================================================
// 5. unavailable fallback
// ============================================================================

test('05 a refused connection falls back (brief §13)', async () => {
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8077'), { code: 'ECONNREFUSED' });
    },
  });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.UNAVAILABLE);
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
});

test('05b a service that is up but not ready is UNAVAILABLE, not a decision', async () => {
  // /ready reports MODEL_LOADING (brief §11). Calling /plan then must
  // not yield a half-built "decision".
  const svc = fakeService(() => ({ status: 503, body: { error: 'model is still loading', state: 'MODEL_LOADING' } }));
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: svc.fetchImpl,
  });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.UNAVAILABLE);
  assert.match(String(r.audit.failure?.detail), /503/);
});

test('05c a 200 response with fallbackUsed and no decision is unavailable', async () => {
  // "I could not infer" is a legitimate answer, but it is not a
  // decision. Handing it to the validator would be a category error.
  const svc = fakeService(() => ({
    status: 200,
    body: { decision: null, fallbackUsed: true, state: 'MODEL_ERROR', error: 'CUDA out of memory', provider: 'airllm' },
  }));
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: svc.fetchImpl,
  });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.UNAVAILABLE);
  assert.match(String(r.audit.failure?.detail), /CUDA out of memory/);
});

test('05d probeAirLLMService reports an unreachable service without throwing', async () => {
  const down = await probeAirLLMService({
    serviceUrl: 'http://127.0.0.1:1',
    timeoutMs: 300,
    fetchImpl: async () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); },
  });
  assert.equal(down.reachable, false);
  assert.equal(down.state, null);
  assert.ok(down.error);

  const bad = await probeAirLLMService({ serviceUrl: 'http://0.0.0.0:8077' });
  assert.equal(bad.reachable, false);
  assert.match(bad.error, /loopback/);
});

// ============================================================================
// 6. malformed response rejected
// ============================================================================

test('06 a malformed body is a PARSE_ERROR, never a decision (brief §14, §15)', async () => {
  const cases = [
    { name: 'not JSON at all', body: 'this is not json', expect: AI_FAILURE.PARSE_ERROR },
    { name: 'a JSON array', body: [goodDecision()], expect: AI_FAILURE.PARSE_ERROR },
    { name: 'a JSON scalar', body: 42, expect: AI_FAILURE.PARSE_ERROR },
    { name: 'null body', body: null, expect: AI_FAILURE.PARSE_ERROR },
  ];

  for (const c of cases) {
    const fetchImpl = async () => ({
      ok: true,
      status: 200,
      async json() {
        if (typeof c.body === 'string') throw new SyntaxError('Unexpected token');
        return c.body;
      },
      async text() { return typeof c.body === 'string' ? c.body : JSON.stringify(c.body); },
    });
    const planner = new AirLLMPlanner({ serviceUrl: 'http://127.0.0.1:8077', requestTimeoutMs: 1_000, fetchImpl });
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, true, `${c.name} must fall back`);
    assert.equal(r.audit.failure?.kind, c.expect, `${c.name} must classify as ${c.expect}`);
  }
});

test('06b a 200 with no decision field is INVALID_OUTPUT', async () => {
  const svc = fakeService(() => ({ status: 200, body: { provider: 'airllm', model: 'm', fallbackUsed: false } }));
  const planner = new AirLLMPlanner({ serviceUrl: 'http://127.0.0.1:8077', requestTimeoutMs: 1_000, fetchImpl: svc.fetchImpl });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.audit.failure?.kind, AI_FAILURE.INVALID_OUTPUT);
});

test('06c a markdown-wrapped decision is rejected by the Node validator, not rescued', async () => {
  // §15: the parser must not "guess" through a wrapper. The Python
  // service strips fences; if it ever fails to, Node must not help.
  const fenced = '```json\n' + JSON.stringify(goodDecision()) + '\n```';
  let parsed = null;
  try { parsed = JSON.parse(fenced); } catch { /* expected */ }
  assert.equal(parsed, null, 'a fenced payload is not valid JSON');

  // And if the service sends the raw string as the decision, Node
  // rejects it as not an object.
  const svc = fakeService(() => ({ status: 200, body: { decision: fenced, fallbackUsed: false, provider: 'airllm' } }));
  const planner = new AirLLMPlanner({ serviceUrl: 'http://127.0.0.1:8077', requestTimeoutMs: 1_000, fetchImpl: svc.fetchImpl });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
});

test('06d extra unexpected fields are rejected, not ignored (brief §15)', async () => {
  const { planner } = plannerWith(goodDecision({ scheduleSlots: [{ day: 2, period: 3, teacherId: 'T01' }] }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true, 'an attempt to smuggle a schedule must be rejected outright');
  assert.match(String(r.audit.failure?.detail ?? r.audit.validation.reason), /scheduleSlots/);
});

// ============================================================================
// 7. invalid strategy rejected
// ============================================================================

test('07 a structurally invalid decision is rejected by the Node validator', async () => {
  const bad = [
    { label: 'unknown mode', d: goodDecision({ optimizationMode: 'FREE_FORM' }) },
    { label: 'mode absent', d: { candidateCount: 3, scoringWeights: { WORKLOAD_BALANCE: 1 } } },
    { label: 'count outside the vocabulary', d: goodDecision({ candidateCount: 20 }) },
    { label: 'count not an integer', d: goodDecision({ candidateCount: 2.5 }) },
    { label: 'no weights at all', d: { optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE, candidateCount: 3 } },
    { label: 'weights not an object', d: goodDecision({ scoringWeights: 0.5 }) },
    { label: 'invented dimension', d: goodDecision({ scoringWeights: { VIBES: 1 } }) },
    { label: 'string weight', d: goodDecision({ scoringWeights: { WORKLOAD_BALANCE: 'high' } }) },
    { label: 'NaN weight', d: goodDecision({ scoringWeights: { WORKLOAD_BALANCE: Number.NaN } }) },
    { label: 'infinite weight', d: goodDecision({ scoringWeights: { WORKLOAD_BALANCE: Number.POSITIVE_INFINITY } }) },
    { label: 'negative weight', d: goodDecision({ scoringWeights: { WORKLOAD_BALANCE: -1 } }) },
  ];

  for (const c of bad) {
    const { planner } = plannerWith(c.d);
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, true, `${c.label} must fall back`);
    assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK', `${c.label} must use the deterministic fallback`);
    assert.equal(r.audit.failure?.kind, AI_FAILURE.INVALID_OUTPUT, `${c.label} must be INVALID_OUTPUT`);
  }
});

test('07b a valid decision is accepted and reaches the solver input', async () => {
  const { planner } = plannerWith(goodDecision({ optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, false, 'a good decision must not be discarded');
  assert.equal(r.decision.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
  assert.equal(r.decision.candidateCount, 3);
  // The influence check of brief §33: the validated decision is
  // visible in the input the solver will actually receive.
  assert.equal(r.input.strategy.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
  assert.notEqual(INPUT.strategy.optimizationMode, r.input.strategy.optimizationMode);
  assert.deepEqual(r.applied.scoringConfig.weights, { ...r.decision.scoringWeights });
});

// ============================================================================
// 8 & 9. inactive dimensions cannot be activated
// ============================================================================

test('08 TRAVEL cannot be activated (H14 UNSUPPORTED, brief §18, §53)', async () => {
  const { planner } = plannerWith(goodDecision({
    scoringWeights: {
      WORKLOAD_BALANCE: 1.0,
      MAX_TEACHER_LOAD: 0.6,
      WORKLOAD_STDEV: 0.4,
      PREFERENCE: 0.3,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
      TRAVEL: 5,
    },
  }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, false, 'an extra weight is an overshoot, not a fatal error');
  assert.equal(r.decision.scoringWeights.TRAVEL, 0, 'TRAVEL must be clamped to 0, never activated');
  const clamped = r.audit.validation.events.filter((e) => e.dimension === 'TRAVEL');
  assert.ok(clamped.length > 0, 'the clamp must be recorded, never silent');
  assert.equal(clamped[0].to, 0);
  // And the allow-list never offered it in the first place.
  assert.ok(!r.allowList.allowedDimensions.includes('TRAVEL'));
  assert.ok(r.allowList.blockedDimensions.includes('TRAVEL'));
  // H14 stays unsupported regardless of what the AI asked for.
  assert.equal(r.allowList.weightBounds.TRAVEL.max, 3);
  assert.equal(r.decision.scoringWeights.TRAVEL, 0);
});

test('09 TRANSFER and CHANGED_ASSIGNMENTS cannot be activated either', async () => {
  for (const dim of ['TRANSFER', 'CHANGED_ASSIGNMENTS']) {
    const { planner } = plannerWith(goodDecision({
      scoringWeights: { WORKLOAD_BALANCE: 1.0, MAX_TEACHER_LOAD: 0.5, WORKLOAD_STDEV: 0.3, PREFERENCE: 0.2, STRUCTURAL_DIVERSITY: 0.4, SLOT_DIVERSITY: 0.2, [dim]: 9 },
    }));
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, false, `${dim} weight is clamped, not fatal`);
    assert.equal(r.decision.scoringWeights[dim], 0, `${dim} must be 0`);
    assert.ok(r.audit.validation.events.some((e) => e.dimension === dim && e.to === 0));
  }

  // A priority on an inactive dimension IS fatal, because priorities
  // are an explicit annotation rather than a magnitude to overshoot.
  const { planner } = plannerWith(goodDecision({ priorities: { TRAVEL: 'HIGH' } }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
});

// ============================================================================
// 10. hard constraints cannot be disabled
// ============================================================================

test('10 there is no field with which to disable a hard constraint (brief §25)', async () => {
  // The mechanism is structural: the schema has no constraint field,
  // and unknown fields are REJECTED rather than ignored. An ignored
  // field would still be a lie in the audit log.
  for (const attempt of [
    { disableConstraints: ['H01'] },
    { hardConstraints: { H01: false } },
    { constraints: [] },
    { relaxHard: true },
    { ignoreEvaluator: true },
  ]) {
    const { planner } = plannerWith(goodDecision(attempt));
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, true, `attempting ${Object.keys(attempt)[0]} must fall back`);
    assert.match(String(r.audit.failure?.detail ?? ''), new RegExp(Object.keys(attempt)[0]));
  }

  // The base strategy's objectives are carried over VERBATIM, so even
  // a legal decision cannot turn one off.
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.deepEqual(r.input.strategy.objectives, INPUT.strategy.objectives);
  assert.equal(r.input.strategy.objectives.noGapTeacherDay, true);
});

// ============================================================================
// 11. candidateCount bounded
// ============================================================================

test('11 candidateCount is confined to the vocabulary (brief §19)', async () => {
  for (const count of [1, 3, 5, 10]) {
    const { planner } = plannerWith(goodDecision({ candidateCount: count }));
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, false, `count=${count} is legal and must be honoured`);
    assert.equal(r.applied.candidateCount, count);
  }
  for (const count of [0, 2, 4, 7, 20, 1000, -3, 3.5, 'five', null]) {
    const { planner } = plannerWith(goodDecision({ candidateCount: count }));
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
    assert.equal(r.fallbackUsed, true, `count=${String(count)} must be rejected`);
    assert.equal(r.applied.candidateCount, 3, 'and the fallback count must be the default 3');
  }
  // The AI cannot widen the vocabulary through the service response.
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.deepEqual([...r.allowList.counts], [...ALLOWED_CANDIDATE_COUNTS]);
});

// ============================================================================
// 12. weights bounded
// ============================================================================

test('12 weights are clamped to the Node-side bounds (brief §20)', async () => {
  const { planner } = plannerWith(goodDecision({
    scoringWeights: {
      WORKLOAD_BALANCE: 99,       // over max -> clamp to 3
      MAX_TEACHER_LOAD: -0.5,     // negative -> REJECT, not clamp
      WORKLOAD_STDEV: 0.4,
      PREFERENCE: 0.3,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
    },
  }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true, 'a negative weight inverts an axis and is rejected');
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');

  // An overshoot alone is accepted and clamped.
  const { planner: p2 } = plannerWith(goodDecision({
    scoringWeights: {
      WORKLOAD_BALANCE: 99,
      MAX_TEACHER_LOAD: 0.6,
      WORKLOAD_STDEV: 0.4,
      PREFERENCE: 0.3,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
    },
  }));
  const r2 = await ai.planStrategy(INPUT, { planner: p2, timeoutMs: 5_000 });
  assert.equal(r2.fallbackUsed, false);
  assert.equal(r2.decision.scoringWeights.WORKLOAD_BALANCE, 3, '99 must clamp to the max bound');
  assert.ok(r2.audit.validation.events.some((e) => e.dimension === 'WORKLOAD_BALANCE' && e.to === 3));

  // An all-zero vector would make the Phase 28 global score 0/0.
  const { planner: p3 } = plannerWith(goodDecision({
    scoringWeights: { WORKLOAD_BALANCE: 0, MAX_TEACHER_LOAD: 0, WORKLOAD_STDEV: 0, PREFERENCE: 0, STRUCTURAL_DIVERSITY: 0, SLOT_DIVERSITY: 0 },
  }));
  const r3 = await ai.planStrategy(INPUT, { planner: p3, timeoutMs: 5_000 });
  assert.equal(r3.fallbackUsed, false);
  const sum = Object.values(r3.decision.scoringWeights).reduce((a, b) => a + b, 0);
  assert.ok(sum > 0, 'the weight vector must never sum to zero');
  assert.ok(r3.audit.validation.events.some((e) => e.code === 'AI_OUTPUT_ZERO_WEIGHT_SUM'));

  // Node is the authority: the service's own verdict is recorded but
  // never trusted as the gate.
  const { planner: p4 } = plannerWith(goodDecision(), { validated: false, corrections: [{ dimension: 'WORKLOAD_BALANCE' }] });
  const r4 = await ai.planStrategy(INPUT, { planner: p4, timeoutMs: 5_000 });
  assert.equal(r4.fallbackUsed, false, 'a service that says it failed to validate does not block Node validation');
});

// ============================================================================
// 13. provider metadata captured
// ============================================================================

test('13 provider metadata is captured for the audit (brief §35)', async () => {
  const { planner } = plannerWith(goodDecision(), {
    provider: 'airllm',
    model: 'local-small-7b',
    promptVersion: '3',
    latencyMs: 4210,
    serviceLatencyMs: 4000,
    validated: true,
  });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 10_000 });

  assert.equal(r.fallbackUsed, false);
  assert.equal(r.audit.provider, 'AirLLMPlanner');
  const meta = r.rawOutput.__airllm;
  assert.ok(meta, 'the service metadata must travel with the decision');
  assert.equal(meta.provider, 'airllm');
  assert.equal(meta.model, 'local-small-7b');
  assert.equal(meta.promptVersion, '3');
  assert.equal(meta.serviceLatencyMs, 4000);
  assert.equal(meta.latencyMs, 4210, 'the service-reported latency must be preserved');
  assert.equal(meta.serviceValidated, true);
  // The measured round trip is recorded too. A stubbed transport can
  // answer inside the same millisecond, so the assertion is that the
  // clock was read, not that it read a large number.
  assert.ok(Number.isFinite(r.timing.aiMs) && r.timing.aiMs >= 0, 'AI latency must be measured');
  assert.ok(r.timing.totalMs >= r.timing.aiMs);
  assert.ok(r.timing.reportMs >= 0);

  // The metadata is non-enumerable, so it cannot be mistaken for a
  // decision field by the validator's unknown-field check.
  assert.ok(!Object.keys(r.rawOutput).includes('__airllm'));

  // And the decision itself is attributed.
  assert.equal(r.decision.source, 'AirLLMPlanner');
});

test('13b the audit record stores no raw prompt and no personal data (brief §35, §36)', async () => {
  const { planner } = plannerWith(goodDecision({ rationale: 'Teacher Nguyen Van A is overloaded on Tuesday.' }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  const auditJson = canonicalStringify(r.audit);
  assert.ok(auditJson.length > 0);
  // The report itself is deliberately NOT in the audit — only its hash.
  assert.equal(Object.keys(r.audit).includes('report'), false);
  assert.equal(r.audit.inputSummaryHash, r.report.hash);
  // No token, no model path, no environment value leaks into the log.
  for (const secret of ['AIRLLM_SERVICE_TOKEN', 'HF_TOKEN', 'authorization']) {
    assert.ok(!auditJson.includes(secret), `${secret} must not appear in the audit log`);
  }
  // The rationale is provider prose; it is not parsed and not trusted.
  assert.match(r.decision.rationale, /Nguyen Van A/);
  assert.equal(r.decision.confidence, null);
});

// ============================================================================
// 14. decisionHash deterministic
// ============================================================================

test('14 an identical decision produces an identical hash (brief §58)', async () => {
  // The hash covers the decision's MEANING, not its prose: rationale
  // and confidence are annotations, so two runs of the same policy
  // with different wording must hash the same.
  const hashOf = (d) => {
    const core = {
      optimizationMode: d.optimizationMode,
      candidateCount: d.candidateCount,
      scoringWeights: Object.fromEntries(Object.entries(d.scoringWeights).sort(([a], [b]) => a.localeCompare(b))),
    };
    return ai.hashSituationReport({ decision: core });
  };

  const a = hashOf(goodDecision());
  const b = hashOf(goodDecision({ rationale: 'A completely different sentence.' }));
  assert.equal(a, b, 'rationale must not change the decision hash');

  const c = hashOf(goodDecision({ optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST }));
  assert.notEqual(a, c, 'a different mode must change the hash');

  const d = hashOf(goodDecision({ scoringWeights: { ...goodDecision().scoringWeights, WORKLOAD_BALANCE: 0.9 } }));
  assert.notEqual(a, d, 'a different weight must change the hash');

  // And the same decision served twice by the service is stable.
  const { planner } = plannerWith(goodDecision());
  const r1 = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  const r2 = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.deepEqual(r1.decision.scoringWeights, r2.decision.scoringWeights);
  assert.equal(r1.decision.optimizationMode, r2.decision.optimizationMode);
});

// ============================================================================
// 15. input not mutated
// ============================================================================

test('15 the AirLLM path does not mutate the SchedulingInput (brief §34)', async () => {
  const before = {
    strategy: JSON.stringify(INPUT.strategy),
    teachers: INPUT.teachers?.length,
    assignments: INPUT.assignments?.length,
  };
  const { planner } = plannerWith(goodDecision({ optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  assert.equal(JSON.stringify(INPUT.strategy), before.strategy, 'input.strategy must be byte-identical');
  assert.equal(INPUT.teachers.length, before.teachers);
  assert.equal(INPUT.assignments.length, before.assignments);
  // The returned input is a different object with a different strategy.
  assert.notEqual(r.input, INPUT);
  assert.notEqual(r.input.strategy, INPUT.strategy);
  assert.equal(r.input.strategy.optimizationMode, OPTIMIZATION_MODES.PREFERENCE_FIRST);
  assert.equal(INPUT.strategy.optimizationMode, STRATEGY_C.optimizationMode);
  // The report is derived, not aliased.
  assert.notEqual(r.report, INPUT);
});

// ============================================================================
// 16 & 17. nothing sensitive crosses the wire
// ============================================================================

test('16 no raw schedule is sent to the AI service (brief §22)', async () => {
  const { planner, bodies } = plannerWith(goodDecision());
  await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  assert.equal(bodies.length, 1, 'exactly one request');
  const payload = bodies[0];
  assert.deepEqual(Object.keys(payload), ['situationReport'], 'the request carries nothing but the report');

  // The report is AGGREGATE-ONLY. The meaningful property is not the
  // absence of a key named "assignments" — `counts.assignments` is a
  // number and is exactly what the AI should see. The property is
  // that no raw ENTITY crosses: no array of teacher objects, no slot
  // list, no teacher-period pair.
  const text = JSON.stringify(payload);
  for (const forbidden of ['teacherId', 'placement', 'timeSlots', 'scheduleSlots', '"slots"']) {
    assert.ok(!text.includes(forbidden), `the payload must not contain "${forbidden}"`);
  }

  const report = payload.situationReport;
  // Counts are scalars.
  for (const [k, v] of Object.entries(report.counts)) {
    assert.equal(typeof v, 'number', `counts.${k} must be an aggregate number, got ${typeof v}`);
  }
  // Nothing in the report is a list of raw ENTITIES. The report does
  // contain small aggregate entry lists — 7 branches, 5 subjects, 14
  // hard constraints, 9 dimensions — and those are exactly what the
  // AI is meant to reason about. What must never appear is a list
  // scaled to the raw data: 40 teachers, 479 assignments, 802 slots.
  const listSizes = [];
  (function walk(node, p) {
    if (Array.isArray(node)) {
      listSizes.push({ path: p, len: node.length, objects: node.some((x) => x !== null && typeof x === 'object') });
      node.forEach((x, i) => walk(x, `${p}[${i}]`));
    } else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, p ? `${p}.${k}` : k);
    }
  }(report, ''));

  const rawCounts = [INPUT.teachers.length, INPUT.assignments.length, INPUT.counts?.requiredPeriods ?? 802];
  const smallestRaw = Math.min(...rawCounts.filter((n) => Number.isFinite(n) && n > 0));
  const bigLists = listSizes.filter((l) => l.objects && l.len >= 20);
  assert.deepEqual(bigLists, [],
    `no list may be scaled to raw data; the smallest raw collection is ${smallestRaw}`);
  // Every object list is a domain dimension, so it is small by
  // construction rather than by truncation.
  for (const l of listSizes.filter((x) => x.objects)) {
    assert.ok(l.len <= DIMENSION_CATALOG.length + 10,
      `${l.path} has ${l.len} entries, which is too many to be an aggregate`);
  }

  // And the Phase 29 privacy guarantee, re-checked on the exact bytes.
  assert.deepEqual(findPersonalData(payload), [], 'the payload must contain no personal data');
});

test('17 no PII is sent to the AI service (brief §21)', async () => {
  const { planner, bodies } = plannerWith(goodDecision());
  await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  const text = JSON.stringify(bodies[0]);
  // The real dataset has 40 teachers. Sample a few identifiers out of
  // it and prove none of them appear anywhere in the request.
  const sample = (INPUT.teachers ?? []).slice(0, 40);
  for (const t of sample) {
    for (const field of ['id', 'name', 'email', 'phone', 'address']) {
      const v = t?.[field];
      if (typeof v === 'string' && v.length >= 3) {
        assert.ok(!text.includes(v), `teacher ${field} "${v}" must not be sent to the AI service`);
      }
    }
  }
  assert.deepEqual(findPersonalData(bodies[0]), []);
  // And no free-text teacher preference, which can contain a name.
  assert.ok(!text.includes('preferenceNotes'));
});

// ============================================================================
// 18-28. the Python service contract, verified over real HTTP
// ============================================================================

test('18 the planner works over a REAL http round trip', async () => {
  // The unit tests above inject a transport. This one binds a real
  // loopback server so the request line, headers, body and status
  // handling are genuinely exercised. It is still not a GPU test:
  // the server is a stub of the Python service, not the service.
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        decision: goodDecision(),
        provider: 'airllm',
        model: 'stub',
        promptVersion: '1',
        fallbackUsed: false,
        validated: true,
        latencyMs: 5,
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const planner = new AirLLMPlanner({
      serviceUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 5_000,
    });
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 10_000 });

    assert.equal(r.fallbackUsed, false, 'a real round trip must work with the global fetch');
    assert.equal(r.decision.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/plan');
    assert.match(received[0].headers['content-type'], /application\/json/);
    assert.deepEqual(Object.keys(JSON.parse(received[0].body)), ['situationReport']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('19 the service token is sent as a bearer header and never echoed', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ decision: goodDecision(), provider: 'airllm', fallbackUsed: false }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const planner = new AirLLMPlanner({
      serviceUrl: `http://127.0.0.1:${port}`,
      serviceToken: 'internal-shared-secret',
      requestTimeoutMs: 5_000,
    });
    const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 10_000 });
    assert.equal(r.fallbackUsed, false);
    assert.equal(seen[0], 'Bearer internal-shared-secret');
    // The token must not appear anywhere in what comes back to a log.
    assert.ok(!canonicalStringify(r.audit).includes('internal-shared-secret'));
    assert.ok(!canonicalStringify(r.decision).includes('internal-shared-secret'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('20 the AI service cannot make the solver worse than the fallback (brief §34, §59)', async () => {
  // The decision is honoured, and the resulting schedule is still
  // judged by the independent evaluator. AI influence stops at the
  // strategy; it does not extend to feasibility.
  const { planner } = plannerWith(goodDecision({ optimizationMode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, false);

  const out = generateSolutions(r.input, { ...SOLVE_OPTS, respectStrategyMode: true });
  assert.equal(out.diagnostics.searchLimited, false, 'the search must complete or the check proves nothing');
  assert.notEqual(out.diagnostics.searchStoppedBy.includes('TIME_BUDGET'), true,
    `the search stopped on the wall clock (${out.diagnostics.searchStoppedBy.join(', ')}); `
    + 'the candidate below would be host-dependent');
  assert.ok(out.solutions.length >= 1, 'an approved AI strategy must still yield a schedule');
  assert.equal(out.diagnostics.optimizationMode, OPTIMIZATION_MODES.ASSIGNMENT_BALANCED);

  for (const s of out.solutions) {
    const evaluation = evaluateCandidate(s.candidate, r.input);
    assert.equal(evaluation.summary.accepted, true, 'the evaluator, not the AI, decides feasibility');
    assert.equal(evaluation.hard.violations.length, 0, 'no hard constraint may be violated');
  }

  // And the Phase 28 scorer still ranks, unchanged. It takes the raw
  // candidates (not the multi-solution wrappers) and the input, so
  // that its `active()` predicates see the same dataset.
  const sel = selectFinalSolutions(out.solutions.map((s) => s.candidate), { count: 3, input: r.input });
  assert.ok(sel.solutions.length >= 1, 'global scoring must surface at least one solution');
  assert.ok(sel.solutions.length <= 3, 'selection must not invent solutions');
  for (const s of sel.solutions) {
    assert.equal(s.scoring.feasibility, 'FEASIBLE', 'only hard-feasible candidates may be selected');
    assert.equal(s.scoring.hardViolations, 0);
    assert.ok(s.qualityScore > 0);
  }
});

test('21 the solver seed is independent of the AI (brief §57)', async () => {
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  const a = generateSolutions(r.input, { ...SOLVE_OPTS, seed: 0xC0FFEE });
  const b = generateSolutions(r.input, { ...SOLVE_OPTS, seed: 0xC0FFEE });
  // Premise for the id equality below: neither run was truncated by
  // the wall clock. PHASE 31.1 makes this an iteration-bounded
  // search, so it holds on a loaded host as well as an idle one.
  for (const [label, out] of [['run A', a], ['run B', b]]) {
    assert.equal(out.diagnostics.searchLimited, false,
      `${label}: a clock-truncated search would make the id comparison meaningless`);
    assert.equal(out.diagnostics.searchStoppedBy.includes('TIME_BUDGET'), false,
      `${label}: searchStoppedBy reported TIME_BUDGET`);
  }
  assert.deepEqual(
    a.solutions.map((s) => s.id),
    b.solutions.map((s) => s.id),
    'the same solver seed must give the same result whatever the AI said',
  );

  // And a different AI decision does not perturb the seed derivation:
  // the solver is handed `input` plus an explicit seed, never AI state.
  const { planner: p2 } = plannerWith(goodDecision({ candidateCount: 5, optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST }));
  const r2 = await ai.planStrategy(INPUT, { planner: p2, timeoutMs: 5_000 });
  const c = generateSolutions(r2.input, { ...SOLVE_OPTS, seed: 0xC0FFEE });
  assert.ok(c.solutions.length >= 1, 'a different strategy still produces candidates from the same seed');
});

// ============================================================================
// 22. integration tests are opt-in, and this file must not require AirLLM
// ============================================================================

test('22 the default suite does not require AirLLM, Python, or a GPU (brief §45)', () => {
  // This is the assertion that keeps CI honest: nothing in this file
  // imports airllm or torch, spawns a process, or shells out to
  // Python, and the integration gate is closed by default. The check
  // is over real import statements and spawn calls — not a substring
  // scan, which would match this comment.
  assert.equal(config.ai.integrationEnabled, false);
  assert.equal(config.ai.provider, 'mock');

  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  for (const m of source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)) {
    assert.ok(!/^(airllm|torch|transformers)\b/.test(m[1]), `the unit suite must not import ${m[1]}`);
  }

  // The providers module must not reach for Python either. These are
  // the files that ship, and none of them may spawn a process or name
  // a Python file: the boundary is HTTP (brief §1).
  const providersDir = path.join(HERE, '..', 'src', 'domain', 'ai', 'providers');
  for (const f of readdirSync(providersDir)) {
    const text = readFileSync(path.join(providersDir, f), 'utf8');
    assert.ok(!/child_process|spawnSync|execSync|spawn\(/.test(text), `providers/${f} must not shell out to Python`);
    assert.ok(!/\.py\b/.test(text), `providers/${f} must not reference a Python file`);
  }

  // The integration suite exists and is gated.
  const integrationDir = path.join(HERE, 'integration', 'airllm');
  const files = readdirSync(integrationDir);
  assert.ok(files.some((f) => f.endsWith('.test.js')), 'an integration test must exist');
  const body = readFileSync(path.join(integrationDir, files.find((f) => f.endsWith('.test.js'))), 'utf8');
  assert.match(body, /AIRLLM_INTEGRATION/, 'the integration test must be gated on AIRLLM_INTEGRATION');
});

test('22b the integration suite is outside the default test glob (brief §28, §45)', () => {
  // `npm test` runs `node --test tests/*.test.js`. That glob is
  // one level deep, so `tests/integration/**` is NOT picked up. The
  // integration suite therefore cannot fail a default run even if
  // AirLLM is missing, no GPU exists, and no service is listening.
  const pkg = JSON.parse(
    readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'),
  );
  assert.match(pkg.scripts.test, /tests\/\*\.test\.js/);
  assert.ok(
    !pkg.scripts.test.includes('integration'),
    'the default test command must not reference the integration directory',
  );

  // And the integration file gates itself, so running it explicitly
  // is still a skip rather than a failure.
  const integrationDir = path.join(HERE, 'integration', 'airllm');
  const entry = readdirSync(integrationDir).find((f) => f.endsWith('.test.js'));
  const body = readFileSync(path.join(integrationDir, entry), 'utf8');
  assert.match(body, /AIRLLM_INTEGRATION/);
  assert.match(body, /skip|t\.skip/, 'the gated suite must skip, not fail');
});

// ============================================================================
// 23-24. the AI service boundary itself
// ============================================================================

test('23 no domain module other than providers/ may know about AirLLM (brief §1, §36)', () => {
  // `domain/ai/` is the provider-agnostic contract, and this checks
  // its CODE, not its prose: no file there may import, name, or
  // construct a concrete provider. A comment explaining that the
  // seam is deliberately provider-agnostic is exactly what should
  // be there, so the scan is over identifiers and import paths.
  const forbiddenCode = [
    /AirLLMPlanner/,            // the class
    /airllm-client/,            // the transport module
    /airllm-planner/,
    /from\s+'\.\/providers/,    // any provider import at all
    /\bpostPlan\b/,
    /\bprobeAirLLMService\b/,
    /\bassertServiceUrl\b/,
    /\bcreateAIPlannerFromConfig\b/,
    /\bAIRLLM_[A-Z_]+/,
  ];

  const aiDir = path.join(HERE, '..', 'src', 'domain', 'ai');
  for (const f of readdirSync(aiDir)) {
    if (f === 'providers' || !f.endsWith('.js')) continue;
    const text = readFileSync(path.join(aiDir, f), 'utf8');
    for (const re of forbiddenCode) {
      assert.ok(!re.test(text), `domain/ai/${f} references ${re} — the seam must stay provider-agnostic`);
    }
  }

  // The solver, the multi-solution generator and the scorer must not
  // know an AI provider exists at all.
  const domainDir = path.join(HERE, '..', 'src', 'domain');
  for (const f of ['solver.js', 'multi-solution.js', 'global-scoring.js', 'comparator.js', 'metrics.js', 'strategies.js']) {
    const text = readFileSync(path.join(domainDir, f), 'utf8');
    assert.ok(!/airllm/i.test(text), `domain/${f} must not mention any AI provider`);
  }

  // Sanity: the provider IS reachable, from its own directory only.
  const providersDir = path.join(aiDir, 'providers');
  assert.ok(
    readdirSync(providersDir).some((f) => f.includes('airllm')),
    'the AirLLM provider must exist under domain/ai/providers/',
  );
});

test('24 the AI service is never given the solver, scorer, or a database handle', () => {
  // Structural check on the import graph, not on behaviour: the
  // provider package may only import the two Phase 29 seam modules
  // and its own siblings. It is handed a report and nothing else,
  // and it provably cannot reach the solver, the scorer, or a
  // database client even if it wanted to (brief §36, §55).
  const providersDir = path.join(HERE, '..', 'src', 'domain', 'ai', 'providers');
  // PHASE 35. `node:<builtin>` is permitted in addition to the seam.
  // airllm-client.js uses `node:http` for the loopback POST because a
  // real AirLLM /plan takes minutes and undici's 300 s headersTimeout
  // cannot be raised by an AbortSignal (see that file's header note).
  // A runtime builtin cannot import this repository's solver, scorer,
  // or a database client, so the invariant this test exists to protect
  // is unchanged; the relaxation is one alternative, and it admits no
  // package and no deeper relative path.
  const allowed = /^(\.\.\/(planner|strategy-schema)\.js|\.\/(airllm-client|airllm-planner|index)\.js|node:[a-z_]+)$/;
  for (const f of readdirSync(providersDir)) {
    const text = readFileSync(path.join(providersDir, f), 'utf8');
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      assert.match(m[1], allowed, `providers/${f} imports ${m[1]}, which is outside the provider seam`);
    }
    for (const forbidden of ['mongodb', 'mongoose', 'bson', 'mongoUri']) {
      assert.ok(!new RegExp(forbidden, 'i').test(text), `providers/${f} must not reference ${forbidden}`);
    }
  }
});
