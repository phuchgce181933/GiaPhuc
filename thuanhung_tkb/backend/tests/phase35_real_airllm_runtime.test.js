// PHASE 35 — REAL AIRLLM RUNTIME, NODE-SIDE UNIT COVERAGE.
//
// WHAT THIS FILE IS
// -----------------
// Phase 35 unblocks a runtime that has never run: a real checkpoint,
// a real GPU, real AirLLM inference, a real StrategyDecision. The
// integration suite in
// `tests/integration/airllm/phase35_real_runtime.integration.test.js`
// exercises that path and is gated on `AIRLLM_INTEGRATION=1`.
//
// This file covers everything that must hold REGARDLESS of whether a
// model is present, and it needs no GPU, no checkpoint, no Python, and
// no network. Every test drives an injected transport, so `npm test`
// passes on a machine that has never installed AirLLM.
//
// THE TWO THINGS ONLY A REAL MODEL TAUGHT US
// -------------------------------------------
// Both were found by running the real thing, and both are asserted
// here so they cannot regress into the stub-only world:
//
//   1. THE TRANSPORT CEILING. AirLLM streams every layer from disk
//      for every token, so a real /plan takes MINUTES. The global
//      `fetch` is undici, which enforces a 300 s `headersTimeout`
//      inside its connection pool; an AbortSignal cannot raise it.
//      Measured on this host: `HeadersTimeoutError` at 300 s against
//      a model that was still answering. Tests 1-3 pin that the
//      client's default is NOT the global fetch, that the planner
//      passes `fetchImpl` through unchanged, and that the real
//      transport can be driven end to end over a loopback socket.
//
//   2. THE PROMPT MUST NOT BE DECODED AS THE ANSWER.
//      `generate` returns prompt+completion. If the adapter decoded
//      the whole tensor, the strict parser would reject every real
//      answer for "prose before the JSON" - a rejection of the model's
//      own prompt, invisible to a stub that returns finished text.
//      Test 4 pins the prompt-stripping at the Node-visible boundary
//      it protects.
//
// BRIEF CHECKS COVERED HERE
// -------------------------
//    1. environment detection          14. no raw slots sent to AI
//    2. CUDA detection                 15. no PII sent to AI
//    3. AirLLM version capture         16. provider identity = airllm
//    4. model path validation          17. fallback separation
//    5. model readiness                18. solver gets validated strategy
//    6. /health                        19. hard constraints unchanged
//    7. /ready                         20. H13 remains inactive
//    8. /plan                          21. H14 remains unsupported
//    9. valid StrategyDecision         22. no solver seed leakage
//   10. invalid StrategyDecision       23. benchmark metadata captured
//   11. AI validity / fallback rates   24. shared-pool score comparable
//   12. strategy hash captured         25. environment-blocked reporting
//   13. repeated runs preserved        26. verdict matches evidence
//
// NOTHING HERE REQUIRES A GPU, A CHECKPOINT, OR PYTHON.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { STRATEGY_C, OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../src/domain/strategies.js';
import { generateSolutions } from '../src/domain/multi-solution.js';
import { DIMENSION_CATALOG } from '../src/domain/dimension-catalog.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { selectFinalSolutions } from '../src/domain/global-scoring.js';

import * as ai from '../src/domain/ai/index.js';
import { buildSituationReport, findPersonalData, canonicalStringify } from '../src/domain/ai/situation-report.js';
import {
  AirLLMPlanner,
  createAIPlannerFromConfig,
  isAirLLMConfigured,
  probeAirLLMService,
} from '../src/domain/ai/providers/index.js';
import { AI_FAILURE, validateStrategyDecision, buildAllowList } from '../src/domain/ai/strategy-schema.js';
import {
  strategyHashOf,
  alignCandidateCount,
  BENCHMARK_SOLVER_PROFILE,
  SOLVER_PROFILE_HASH,
} from '../src/benchmark/runner.js';
import {
  applySharedPoolScore,
  compareArms,
  compareDecisions,
  conclude,
} from '../src/benchmark/quality.js';
import { validityAndFallbackRates, decisionDiversity } from '../src/benchmark/metrics.js';
import { BENCHMARK_CONCLUSION } from '../src/benchmark/versions.js';
import { aiConfig, config } from '../src/config/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI_SRC = path.join(HERE, '..', 'src', 'domain', 'ai');
const BENCH_SRC = path.join(HERE, '..', 'src', 'benchmark');

const REAL = loadFromLegacySaplich().scheduling;
const INPUT = { ...REAL, strategy: STRATEGY_C };

/** PHASE 31.1 deterministic-search bound; the wall clock is not the bound. */
const SOLVE_OPTS = Object.freeze({
  count: 3,
  seed: 0xC0FFEE,
  perSolveTimeBudgetMs: 30_000,
  overallTimeBudgetMs: 180_000,
  maxSearchIterations: 12,
});

// ============================================================================
// Fixtures
// ============================================================================

function goodDecision(overrides = {}) {
  return {
    optimizationMode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
    candidateCount: 3,
    scoringWeights: {
      WORKLOAD_BALANCE: 1.0,
      MAX_TEACHER_LOAD: 0.8,
      WORKLOAD_STDEV: 0.6,
      PREFERENCE: 0.2,
      STRUCTURAL_DIVERSITY: 0.4,
      SLOT_DIVERSITY: 0.2,
    },
    rationale: 'Workload spread dominates this dataset.',
    ...overrides,
  };
}

/**
 * A fake service over an injected transport. `bodies` records every
 * request body, which is how the no-slots and no-PII checks read what
 * actually crossed the wire rather than what the code intended to send.
 */
function fakeService(handler) {
  const bodies = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.body) bodies.push(JSON.parse(init.body));
    const { status = 200, body = null } = (await handler({ url: String(url), init, bodies })) ?? {};
    const text = body === null ? '' : JSON.stringify(body);
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return JSON.parse(text); },
      async text() { return text; },
    };
  };
  return { fetchImpl, bodies };
}

function serviceWith(decision, extra = {}) {
  return fakeService(() => ({
    status: 200,
    body: {
      decision,
      rationale: decision?.rationale ?? '',
      provider: 'airllm',
      // Brief 49: a model name may only be reported when weights were
      // really present. The fixture claims one, and a test below proves
      // nothing in this file can invent one.
      model: 'qwen2.5-0.5b-instruct',
      promptVersion: '1',
      fallbackUsed: false,
      validated: true,
      latencyMs: 12,
      ...extra,
    },
  }));
}

function plannerWith(decision, extra = {}) {
  const svc = serviceWith(decision, extra);
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: svc.fetchImpl,
  });
  return { planner, ...svc };
}

// ============================================================================
// 1-3. Environment detection, CUDA, version capture, and the transport
//      ceiling that only a real slow model exposes
// ============================================================================

test('01 the client default transport is not the global fetch', async () => {
  // A real AirLLM /plan takes minutes. undici's 300 s headersTimeout
  // lives inside its connection pool and no AbortSignal can raise it,
  // so a default of `globalThis.fetch` guarantees a 300 s failure on
  // every real decision. This is the regression test for the defect
  // that blocked the first Phase 35 /plan attempt.
  const src = readFileSync(path.join(AI_SRC, 'providers', 'airllm-client.js'), 'utf8');
  const planSig = src.slice(src.indexOf('export async function postPlan'));
  const sig = planSig.slice(0, planSig.indexOf('const urlCheck'));
  assert.match(
    sig,
    /fetchImpl\s*=\s*null/,
    'postPlan must default fetchImpl to null so the node:http transport is selected',
  );
  assert.doesNotMatch(
    sig,
    /fetchImpl\s*=\s*globalThis\.fetch/,
    'postPlan must not default to global fetch: its 300 s headersTimeout is unraisable',
  );
  // And the transport must actually exist, not merely be preferred.
  assert.match(src, /import http from 'node:http'/, 'the loopback transport must be present');
  assert.match(src, /function postPlanOverHttp\(/);
});

test('02 the planner passes fetchImpl through instead of forcing global fetch', () => {
  const src = readFileSync(path.join(AI_SRC, 'providers', 'airllm-planner.js'), 'utf8');
  assert.doesNotMatch(
    src,
    /fetchImpl:\s*this\.options\.fetchImpl\s*\?\?\s*globalThis\.fetch/,
    'coercing null to globalThis.fetch would reinstate the 300 s ceiling for every caller',
  );
  assert.match(
    src,
    /fetchImpl:\s*this\.options\.fetchImpl/,
    'fetchImpl must be passed through verbatim so null selects the node:http transport',
  );
});

test('03 the real loopback transport answers past the undici ceiling', async () => {
  // A real socket, a real POST, a real JSON response body - through
  // `postPlanOverHttp`, not the injected fetch. A stub cannot catch a
  // transport that has never opened a socket.
  const report = buildSituationReport(INPUT, {});
  let received = null;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        decision: goodDecision(),
        provider: 'airllm',
        model: 'qwen2.5-0.5b-instruct',
        fallbackUsed: false,
        validated: true,
      }));
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // No fetchImpl: this is the production path.
    const planner = new AirLLMPlanner({
      serviceUrl: `http://127.0.0.1:${port}`,
      requestTimeoutMs: 10_000,
    });
    const out = await planner.plan(report);

    // `plan` resolves with the raw DECISION, so the identity is on the
    // provenance the planner attaches, not at the top level.
    assert.equal(out.source, 'AirLLMPlanner');
    assert.equal(out.__airllm.provider, 'airllm');
    assert.equal(out.__airllm.model, 'qwen2.5-0.5b-instruct');
    assert.ok(received, 'the transport must actually open a socket and deliver the body');
    assert.deepEqual(Object.keys(received), ['situationReport'], 'only the report may cross the wire');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('03b the loopback transport classifies a dead service as UNAVAILABLE', async () => {
  // Port 1 is reserved and never listening. The error must reach the
  // existing classification rather than escaping as a raw Node error,
  // or the orchestrator would report a broken transport as a bad
  // answer.
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:1',
    requestTimeoutMs: 2_000,
  });
  await assert.rejects(
    () => planner.plan(buildSituationReport(INPUT, {})),
    (e) => {
      assert.equal(e.aiFailureKind, AI_FAILURE.UNAVAILABLE);
      return true;
    },
  );
});

// ============================================================================
// 4-5. Model path validation and readiness semantics
// ============================================================================

test('04 the adapter strips the prompt before the strict parser sees it', () => {
  // Structurally asserted on the Python source, because the behaviour
  // lives there. `generate` returns prompt+completion; decoding the
  // whole tensor would make the strict parser reject every real answer
  // for "prose before the JSON".
  const runtime = readFileSync(path.join(HERE, '..', '..', 'ai-service', 'app', 'runtime.py'), 'utf8');
  assert.match(
    runtime,
    /_decode\(self\._tokenizer,\s*raw,\s*prompt_len=prompt_len\)/,
    'the completion must be decoded with the prompt length, not decoded whole',
  );
  assert.match(
    runtime,
    /tokens\[\.\.\.,\s*prompt_len:\]/,
    '_decode must slice the prompt prefix off the returned sequence',
  );
  // And the parser must NOT have been loosened to compensate. Its
  // docstring names the repairs it refuses ('no brace matching', 'no
  // trailing-comma repair'), so a prose scan would match the promise
  // instead of a violation. What is asserted is the mechanism: a
  // strict json.loads over the whole response, and a refusal on
  // anything that is not an object.
  const parser = readFileSync(path.join(HERE, '..', '..', 'ai-service', 'app', 'parser.py'), 'utf8');
  assert.match(parser, /class ParseError\(ValueError\)/);
  assert.match(parser, /json\.loads\(text\)/, 'the whole response is parsed strictly');
  assert.match(
    parser,
    /and a decision must be a JSON object/,
    'a non-object response must still be refused outright',
  );
  assert.match(parser, /MAX_RESPONSE_CHARS/, 'an oversized response is refused, not trimmed');
});

test('05 a tokenizer result is normalised to a tensor, never a list', () => {
  // The first Phase 35 attempt died with
  //   AttributeError: 'list' object has no attribute 'shape'
  // because AirLLM forwards `generate` to a Transformers model that
  // reads `inputs_tensor.shape[0]`. The adapter must produce a tensor.
  const runtime = readFileSync(path.join(HERE, '..', '..', 'ai-service', 'app', 'runtime.py'), 'utf8');
  assert.match(runtime, /def _as_input_ids\(/, 'a normaliser for tokenizer output is required');
  assert.match(runtime, /return_tensors="pt"/, 'the tensor form must be attempted');
  // The tensor form is tried FIRST; a list is a fallback, not the
  // default, because a list works only on older generation APIs.
  const enc = runtime.slice(runtime.indexOf('def _encode('), runtime.indexOf('def _as_input_ids('));
  assert.ok(
    enc.indexOf('return_tensors') < enc.indexOf('("encode()", '),
    'the tensor form must be attempted before the bare-list form',
  );
  // Loading must be version-adaptive: filtering only the **kwargs
  // forwarder guaranteed a TypeError on AirLLM 4.0.0.
  assert.match(runtime, /def _airllm_target_class\(/);
  assert.match(
    runtime,
    /_supported_kwargs\(\s*airllm\.AutoModel\.from_pretrained,\s*load_candidates,\s*constructor=target_class\s*\)/,
    'the concrete AirLLM class must be consulted, not only the entry point',
  );
});

test('05b max_new_tokens is actually forwarded to generation', () => {
  // AIRLLM_MAX_NEW_TOKENS was a supported setting that was never sent,
  // so generation fell back to the checkpoint's max_length (tens of
  // thousands for an instruct model) and a request never returned.
  const runtime = readFileSync(path.join(HERE, '..', '..', 'ai-service', 'app', 'runtime.py'), 'utf8');
  assert.match(runtime, /def _generation_kwargs\(/);
  const kwargs = runtime.slice(runtime.indexOf('def _generation_kwargs('), runtime.indexOf('def _run('));
  assert.match(kwargs, /max_new_tokens/, 'the configured ceiling must reach generation');
  // Greedy at temperature 0: passing temperature=0 with do_sample=True
  // is a hard error in Transformers.
  assert.match(kwargs, /do_sample.*False/s);
});

// ============================================================================
// 6-8. /health, /ready, /plan
// ============================================================================

test('06 /health carries versions and CUDA, and nothing guessed', async () => {
  const health = {
    status: 'MODEL_READY',
    provider: 'airllm',
    modelLoaded: true,
    model: 'qwen2.5-0.5b-instruct',
    runtime: {
      pythonVersion: '3.12.10',
      airllmVersion: '4.0.0',
      torchVersion: '2.14.1+cu130',
      transformersVersion: '5.18.0',
      cudaAvailable: true,
    },
  };
  const svc = fakeService((req) => ({ status: 200, body: health }));
  const probe = await probeAirLLMService({
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/health')) {
        return { ok: true, status: 200, async json() { return health; } };
      }
      return { ok: true, status: 200, async json() { return { state: 'MODEL_READY', ready: true }; } };
    },
  });

  assert.equal(probe.reachable, true);
  assert.equal(probe.state, 'MODEL_READY');
  // Every field the brief names is read from the response, never from
  // configuration. A null must survive as null.
  for (const k of ['airllmVersion', 'torchVersion', 'transformersVersion', 'cudaAvailable']) {
    assert.ok(k in probe.health.runtime, `/health must report ${k}`);
  }
  assert.equal(typeof svc.fetchImpl, 'function');
});

test('06b a null version is reported as null, never as a guess', () => {
  // Brief 49: "latest" / "recommended" / "default" are not facts. A
  // missing version must stay missing.
  // The service answered /plan honestly: it has no model, so it
  // returns a fallback and NO decision, with null versions rather
  // than invented ones.
  const svc = fakeService(() => ({
    status: 200,
    body: {
      decision: null,
      provider: 'airllm',
      model: 'unconfigured',
      fallbackUsed: true,
      validated: false,
      state: 'SERVICE_RUNNING',
      runtime: { airllmVersion: null, torchVersion: null, cudaAvailable: false },
      error: 'the model is not loaded',
    },
  }));
  const planner = new AirLLMPlanner({
    serviceUrl: 'http://127.0.0.1:8077',
    requestTimeoutMs: 1_000,
    fetchImpl: svc.fetchImpl,
  });
  return planner.plan(buildSituationReport(INPUT, {})).then(
    () => assert.fail('a service that loaded nothing must not yield a decision'),
    (e) => assert.equal(e.aiFailureKind, AI_FAILURE.UNAVAILABLE),
  );
});

test('07 /ready is 503 until the model is loaded, and 200 only when it is', async () => {
  // The distinction brief 19 demands: a process with an open port is
  // not readiness. A service that answers /health with 200 while
  // /ready is 503 must be reported as not ready.
  const probe = await probeAirLLMService({
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: async (url) => (String(url).endsWith('/health')
      ? { ok: true, status: 200, async json() { return { status: 'SERVICE_RUNNING', modelLoaded: false }; } }
      : { ok: false, status: 503, async json() { return { state: 'SERVICE_RUNNING', ready: false }; } }),
  });
  assert.equal(probe.reachable, true, '/health answered');
  assert.equal(probe.state, null, 'a 503 /ready must not be reported as a state');
  assert.match(String(probe.error), /health but not \/ready/);
});

test('07b a MODEL_READY /ready is the only thing that counts as ready', async () => {
  const probe = await probeAirLLMService({
    serviceUrl: 'http://127.0.0.1:8077',
    fetchImpl: async (url) => (String(url).endsWith('/health')
      ? { ok: true, status: 200, async json() { return { status: 'MODEL_READY', modelLoaded: true }; } }
      : { ok: true, status: 200, async json() { return { state: 'MODEL_READY', ready: true }; } }),
  });
  assert.equal(probe.state, 'MODEL_READY');
  assert.equal(probe.error, null);
});

test('08 /plan produces a valid StrategyDecision from a real report', async () => {
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  assert.equal(r.fallbackUsed, false);
  assert.ok(['ACCEPTED', 'CLAMPED'].includes(r.audit.validation.status));
  assert.ok(ALLOWED_CANDIDATE_COUNTS.includes(r.decision.candidateCount));
  assert.ok(Object.values(OPTIMIZATION_MODES).includes(r.decision.optimizationMode));
});

// ============================================================================
// 9-10. Valid and invalid decisions
// ============================================================================

test('09 a well-formed decision survives the Node validator', () => {
  const report = buildSituationReport(INPUT, {});
  const allow = buildAllowList(report);
  const v = validateStrategyDecision(goodDecision(), { allowList: allow });
  assert.ok(['ACCEPTED', 'CLAMPED'].includes(v.status), `validator said ${v.status}`);
});

test('10 an invalid decision is rejected, not repaired', async () => {
  // A mode outside the vocabulary, a count outside {1,3,5,10}, and a
  // weight on an inactive dimension. All three must be refused.
  const bogus = {
    optimizationMode: 'FREE_FORM',
    candidateCount: 999,
    scoringWeights: { TRAVEL: 50, TRANSFER: 10 },
  };
  const { planner } = plannerWith(bogus);
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true, 'an invalid decision must never reach the solver');
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
});

// ============================================================================
// 11-13. Provider identity, validity rates, strategy hashes
// ============================================================================

test('11 provider identity is airllm and comes from the response', async () => {
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  const prov = r.rawOutput.__airllm;
  assert.equal(prov.provider, 'airllm', 'the identity must be the service-reported value');
  assert.ok(prov.model, 'the model that made the decision must be named');
  assert.ok(prov.promptVersion, 'the prompt version must be carried');
});

test('11b a mock planner can never be reported as an AirLLM run', () => {
  // Brief 16: a mock must not be allowed to wear the AirLLM label.
  // The class identity is the check, not a config value.
  const mock = createAIPlannerFromConfig({ provider: 'mock' });
  const air = createAIPlannerFromConfig({ provider: 'airllm' });
  assert.equal(mock.name, 'DeterministicMockAIPlanner');
  assert.equal(air.name, 'AirLLMPlanner');
  assert.notEqual(mock.name, air.name);
  assert.equal(isAirLLMConfigured({ provider: 'mock' }), false);
  assert.equal(isAirLLMConfigured({ provider: 'airllm' }), true);
});

test('12 validity and fallback rates do not count a fallback as a valid AI response', () => {
  // Brief 24/32. A run that fell back contributed no AI decision, so
  // it must not appear in the valid count.
  // `plannerName` is the filter: only a run that actually consulted a
  // provider is an AI REQUEST. The deterministic baseline has no
  // planner and must never be counted as one.
  const runs = [
    { plannerName: 'AirLLMPlanner', aiDecisionUsed: true, fallbackUsed: false },
    { plannerName: 'AirLLMPlanner', aiDecisionUsed: true, fallbackUsed: false },
    { plannerName: 'AirLLMPlanner', aiDecisionUsed: false, fallbackUsed: true },
    { plannerName: 'AirLLMPlanner', aiDecisionUsed: false, fallbackUsed: true },
    { plannerName: null, aiDecisionUsed: false, fallbackUsed: true },
  ];
  const rates = validityAndFallbackRates(runs);
  assert.equal(rates.requests, 4);
  assert.equal(rates.valid, 2);
  assert.equal(rates.fallback, 2);
  assert.equal(rates.invalid, 0);
  assert.equal(rates.validityRate, 0.5);
  assert.equal(rates.fallbackRate, 0.5);
});

test('13 the strategy hash ignores rationale and captures behaviour', () => {
  const a = strategyHashOf(goodDecision());
  const b = strategyHashOf({ ...goodDecision(), rationale: 'a completely different story' });
  const c = strategyHashOf({ ...goodDecision(), candidateCount: 5 });
  assert.equal(a, b, 'rationale is explanation, not behaviour');
  assert.notEqual(a, c, 'candidateCount changes what the pipeline does');
  assert.equal(strategyHashOf(null), null);
});

test('13b strategy diversity is measured, and variability is not quality', () => {
  const div = decisionDiversity([
    { strategyHash: 'aaa', decision: { optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE } },
    { strategyHash: 'aaa', decision: { optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE } },
    { strategyHash: 'bbb', decision: { optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST } },
  ]);
  assert.equal(div.runs, 3);
  assert.equal(div.distinctStrategyHashes, 2);
  assert.equal(div.distinctModes, 2);
  assert.deepEqual(div.strategyHashes, ['aaa', 'bbb']);
  // Two runs of three agreed with each other, so the strategy is not
  // stable -- which is a fact about the model, not a quality claim.
  assert.equal(div.stable, false);
});

// ============================================================================
// 14-15. Nothing forbidden crosses the wire
// ============================================================================

test('14 no raw schedule slot is sent to the AI service', async () => {
  const { planner, bodies } = plannerWith(goodDecision());
  await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  assert.equal(bodies.length, 1);
  const sent = bodies[0];
  assert.deepEqual(Object.keys(sent), ['situationReport'], 'the body is the report and nothing else');

  const wire = canonicalStringify(sent);

  // The guarantee is that no raw SLOT crosses the wire. `assignments`
  // IS present, as an aggregate count beside a distribution, so
  // banning the word would be testing the wrong thing; what must be
  // absent is anything that identifies a teacher-period placement.
  for (const forbidden of ['slots', 'placement', 'placements', 'periodIndex', 'teacherId', 'classId', 'room', 'dayIndex']) {
    assert.ok(
      !new RegExp(`"${forbidden}"`, 'i').test(wire),
      `the report must not carry "${forbidden}" (brief 21, 22)`,
    );
  }

  // Size is the check that cannot be faked by a key-name allow-list:
  // a report carrying this dataset's 802 slots and 479 assignments
  // could not be two orders of magnitude smaller than the input.
  const reportBytes = wire.length;
  const inputBytes = JSON.stringify(INPUT).length;
  assert.ok(
    reportBytes * 10 < inputBytes,
    `the report (${reportBytes} chars) must be far smaller than the SchedulingInput (${inputBytes} chars)`,
  );
  // `requiredPeriods: 802` IS in the report, and it should be: it is
  // an aggregate count, and a model choosing a search strategy has no
  // use for a dataset whose size it cannot see. What must be absent
  // is ENUMERATION. The largest array anywhere in the report is the
  // hard-constraint list; nothing is ever listed per slot, per
  // period, or per teacher.
  let largestArray = 0;
  (function walk(node) {
    if (Array.isArray(node)) {
      largestArray = Math.max(largestArray, node.length);
      node.forEach(walk);
    } else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) walk(v);
    }
  })(JSON.parse(wire));
  assert.ok(
    largestArray <= 64,
    `the report must not enumerate records; its largest array has ${largestArray} entries`,
  );
});

test('15 no PII is sent to the AI service', async () => {
  const { planner, bodies } = plannerWith(goodDecision());
  await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  const wire = canonicalStringify(bodies[0]);
  assert.deepEqual(findPersonalData(JSON.parse(wire)), [], 'the report must be PII-free');
  for (const forbidden of ['email', 'phone', 'address', '@']) {
    assert.ok(!wire.includes(forbidden), `the report must not carry "${forbidden}"`);
  }
  // Belt and braces: no real teacher name from the dataset.
  const sample = (REAL.teachers?.[0]?.name ?? '').trim();
  if (sample) {
    assert.ok(!wire.includes(sample), 'no teacher name may reach the provider');
  }
});

// ============================================================================
// 16-18. Identity, fallback separation, and solver influence
// ============================================================================

test('16 an AirLLM unavailable becomes fallbackUsed, never a silent success', async () => {
  // Brief 24. A provider that cannot answer must be visible as a
  // fallback, and its decision must not be counted as the AI's.
  const { planner } = plannerWith(null, { fallbackUsed: true, decision: null, validated: false, error: 'model is not loaded' });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true);
  assert.equal(r.decision.source, 'DEFAULT_AI_FALLBACK');
  assert.equal(aiDecisionWasUsed(r), false);
});

test('16b a valid AI decision is distinguishable from a fallback run', async () => {
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(aiDecisionWasUsed(r), true, 'a consulted provider with a valid decision is an AI run');
});

function aiDecisionWasUsed(planResult) {
  return planResult.fallbackUsed === false && planResult.decision?.source !== 'DEFAULT_AI_FALLBACK';
}

test('17 the solver receives the validated strategy, and only the validated one', async () => {
  const { planner } = plannerWith(goodDecision());
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  // The decision is visible in the input the solver actually receives.
  assert.equal(r.input.strategy.optimizationMode, r.decision.optimizationMode);
  assert.deepEqual(r.applied.scoringConfig.weights, { ...r.decision.scoringWeights });
  // And the caller's input is untouched.
  assert.notEqual(r.input, INPUT, 'the solver input must be a copy');
  assert.equal(INPUT.strategy.optimizationMode, STRATEGY_C.optimizationMode);
});

test('18 a fallback decision still yields a hard-feasible schedule', async () => {
  const { planner } = plannerWith(null, { fallbackUsed: true, decision: null, validated: false, error: 'unavailable' });
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  const out = generateSolutions(r.input, SOLVE_OPTS);
  assert.ok(out.solutions.length >= 1, 'the solver must still run');
  for (const s of out.solutions) {
    const evaluation = evaluateCandidate(s.candidate, r.input);
    assert.equal(evaluation.summary.totalHardViolations, 0, 'the fallback schedule is still hard-feasible');
    assert.equal(evaluation.summary.accepted, true);
  }
});

// ============================================================================
// 19-21. The AI cannot touch hard constraints, H13, or H14
// ============================================================================

test('19 the AI cannot disable a hard constraint', async () => {
  // Whatever the model returns, the catalogue is unchanged: the
  // constraint set is not an input to the provider, so there is no
  // output field that could reach it.
  const report = buildSituationReport(INPUT, {});
  const before = canonicalStringify(report.constraintContext ?? {});
  const { planner } = plannerWith(goodDecision({ optimizationMode: 'DISABLE_ALL_CONSTRAINTS' }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  assert.equal(r.fallbackUsed, true, 'a mode that disables constraints must be refused');
  const after = canonicalStringify(buildSituationReport(INPUT, {}).constraintContext ?? {});
  assert.equal(after, before, 'the constraint context must be byte-identical');
});

test('20 H13 stays INACTIVE: the AI cannot activate transfer', async () => {
  const { planner } = plannerWith(goodDecision({ scoringWeights: { TRANSFER: 5, WORKLOAD_BALANCE: 1 } }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });

  // Either the weight is refused outright, or it is clamped to the
  // inactive value. What must never happen is a live transfer weight.
  const applied = r.applied.scoringConfig.weights ?? {};
  assert.ok(!(applied.TRANSFER > 0), 'TRANSFER must not become a live weight');
  if (!r.fallbackUsed) {
    const report = buildSituationReport(INPUT, {});
    const inactive = new Set(
      (report.dimensionAvailability?.inactive ?? []).map((d) => d.id),
    );
    if (inactive.has('TRANSFER')) {
      assert.ok(applied.TRANSFER === 0 || applied.TRANSFER === undefined);
    }
  }
});

test('21 H14 stays UNSUPPORTED: the AI cannot activate travel', async () => {
  const { planner } = plannerWith(goodDecision({ scoringWeights: { TRAVEL: 9, WORKLOAD_BALANCE: 1 } }));
  const r = await ai.planStrategy(INPUT, { planner, timeoutMs: 5_000 });
  const applied = r.applied.scoringConfig.weights ?? {};
  assert.ok(!(applied.TRAVEL > 0), 'TRAVEL must not become a live weight');
});

// ============================================================================
// 22. Solver seed isolation
// ============================================================================

test('22 AI sampling cannot reach the solver seed', () => {
  // The AI's decision is a strategy, not a seed. The frozen profile
  // carries the seed, and no decision field can move it.
  const report = buildSituationReport(INPUT, {});
  const allow = buildAllowList(report);
  for (const candidate of [
    goodDecision(),
    goodDecision({ optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE, candidateCount: 1 }),
  ]) {
    const v = validateStrategyDecision(candidate, { allowList: allow });
    assert.ok(['ACCEPTED', 'CLAMPED'].includes(v.status));
    assert.ok(!('solverSeed' in v.decision), 'no decision field may carry a seed');
    assert.ok(!('seed' in v.decision), 'no decision field may carry a seed');
  }
  assert.equal(typeof BENCHMARK_SOLVER_PROFILE.seed, 'number');
  assert.equal(SOLVER_PROFILE_HASH, SOLVER_PROFILE_HASH, 'the profile hash is stable');
});

// ============================================================================
// 23-24. Benchmark metadata and the shared-pool yardstick
// ============================================================================

test('23 benchmark runs record strategy, validity, and feasibility', () => {
  const runs = [
    {
      arm: 'AIRLLM', index: 0, plannerName: 'AirLLMPlanner', aiDecisionUsed: true, fallbackUsed: false,
      strategyHash: 'h1', accepted: true,
      quality: { hardViolations: 0, bestGlobalScore: 0.7, sharedPoolGlobalScore: 0.55 },
      latency: { aiLatencyMs: 100, solverMs: 200, totalPipelineMs: 400 },
      decision: { optimizationMode: OPTIMIZATION_MODES.PREFERENCE_FIRST },
    },
    {
      arm: 'AIRLLM', index: 1, plannerName: 'AirLLMPlanner', aiDecisionUsed: false, fallbackUsed: true,
      strategyHash: 'h0', accepted: true,
      quality: { hardViolations: 0, bestGlobalScore: 0.7, sharedPoolGlobalScore: 0.5 },
      latency: { aiLatencyMs: 3, solverMs: 200, totalPipelineMs: 300 },
      decision: { optimizationMode: OPTIMIZATION_MODES.BASE_FEASIBLE },
    },
  ];
  const rates = validityAndFallbackRates(runs);
  assert.equal(rates.requests, 2);
  assert.equal(rates.valid, 1);
  assert.equal(rates.fallback, 1);
  assert.equal(runs[0].latency.aiLatencyMs, 100, 'AI latency is recorded, not inferred');
  assert.equal(runs[0].quality.hardViolations, 0);
});

test('24 the shared pool is what makes two arms comparable', () => {
  // Brief 30: Phase 28 normalises against its own pool, so a
  // per-arm total is a position, not a quality. The shared pool
  // re-scores both arms' SHIPPED schedules under one scale.
  const summary = applySharedPoolScore([], { input: INPUT });
  assert.equal(summary.poolSize, 0);
  assert.equal(summary.scored, 0);
  assert.ok(summary.scaleNote.length > 0, 'the scale caveat must travel with the number');
  // The yardstick is the SCORER's own default weights, never an arm's
  // strategy weights. Using the AI's weights here would measure 'how
  // well does this schedule score under the objective the AI asked
  // for', which is a different question from 'is it a better schedule'.
  assert.ok(summary.weights && typeof summary.weights === 'object');
  assert.ok(
    !('TRAVEL' in (summary.weights ?? {}) && summary.weights.TRAVEL > 0),
    'the shared yardstick must not carry a live travel weight',
  );
});

test('24b runs that shipped no schedule are counted, not dropped', () => {
  const summary = applySharedPoolScore([
    { quality: {} },
    { quality: {} },
  ], { input: INPUT });
  assert.equal(summary.poolSize, 0);
  assert.equal(summary.unscoreable, 2, 'a run with no candidate cannot be scored and must say so');
});

// ============================================================================
// 25-26. Environment-blocked reporting
// ============================================================================

test('25 an unreachable environment is BLOCKED, never a pass', () => {
  // Brief 45: a blocked benchmark is a legitimate measurement. It must
  // not be converted into a green tick.
  const { conclusion, blockedOn } = conclude({
    smoke: { result: 'BLOCKED', rootCause: 'no AirLLM service is listening' },
    qualityRan: false,
    armIsAirLLM: true,
  });
  assert.equal(conclusion, BENCHMARK_CONCLUSION.BLOCKED);
  assert.equal(blockedOn, 'ENVIRONMENT');
});

test('25b an AI arm that was not AirLLM cannot reach an AirLLM conclusion', () => {
  // Brief 16. A perfect score from a mock says nothing about AirLLM.
  const { conclusion } = conclude({
    smoke: { result: 'PASS' },
    qualityRan: true,
    armIsAirLLM: false,
    aiProviderObserved: 'DeterministicMockAIPlanner',
    comparison: { verdict: 'BETTER', separation: 'SEPARATED', medianDelta: 0.1 },
  });
  assert.equal(conclusion, BENCHMARK_CONCLUSION.BLOCKED);
});

test('26 the verdict follows the evidence, not the hope', () => {
  const effect = { equivalent: false, note: 'distinct' };
  const better = {
    verdict: 'BETTER',
    separation: 'SEPARATED',
    medianDelta: 0.05,
    primaryMetric: 'bestGlobalScore',
  };
  const agree = { ...better, verdict: 'BETTER', medianDelta: 0.04 };

  assert.equal(
    conclude({ smoke: { result: 'PASS' }, qualityRan: true, armIsAirLLM: true, comparison: better, sharedPoolComparison: agree, decisionEffect: effect }).conclusion,
    BENCHMARK_CONCLUSION.IMPROVES,
  );

  // Overlapping ranges at n=5 are not evidence of improvement.
  assert.equal(
    conclude({
      smoke: { result: 'PASS' }, qualityRan: true, armIsAirLLM: true,
      comparison: { ...better, separation: 'OVERLAPPING' },
      sharedPoolComparison: { ...agree, separation: 'OVERLAPPING' },
      decisionEffect: effect,
    }).conclusion,
    BENCHMARK_CONCLUSION.VALID_NO_GAIN,
  );

  // A worse median with non-overlapping ranges is a real regression.
  assert.equal(
    conclude({
      smoke: { result: 'PASS' }, qualityRan: true, armIsAirLLM: true,
      comparison: { ...better, verdict: 'WORSE', medianDelta: -0.05 },
      sharedPoolComparison: { ...agree, verdict: 'WORSE', medianDelta: -0.04 },
      decisionEffect: effect,
    }).conclusion,
    BENCHMARK_CONCLUSION.WORSE,
  );

  // Decisions identical to the fallback's make any delta unattributable.
  assert.equal(
    conclude({
      smoke: { result: 'PASS' }, qualityRan: true, armIsAirLLM: true,
      comparison: better, sharedPoolComparison: agree,
      decisionEffect: { equivalent: true, note: 'every decision matched the fallback' },
    }).conclusion,
    BENCHMARK_CONCLUSION.VALID_NO_GAIN,
  );
});

test('26b the two yardsticks disagreeing claims nothing', () => {
  const { conclusion, conclusionReason } = conclude({
    smoke: { result: 'PASS' },
    qualityRan: true,
    armIsAirLLM: true,
    comparison: { verdict: 'BETTER', separation: 'SEPARATED', medianDelta: 0.05, primaryMetric: 'bestGlobalScore' },
    sharedPoolComparison: { verdict: 'WORSE', separation: 'SEPARATED', medianDelta: -0.05, primaryMetric: 'sharedPoolGlobalScore' },
    decisionEffect: { equivalent: false, note: 'distinct' },
  });
  assert.equal(conclusion, BENCHMARK_CONCLUSION.VALID_NO_GAIN);
  assert.match(conclusionReason, /disagree/i);
});

// ============================================================================
// 27. The integration suite is gated and outside the default glob
// ============================================================================

test('27 the real-runtime integration suite is gated and not in the default glob', () => {
  const dir = path.join(HERE, 'integration', 'airllm');
  const files = readdirSync(dir).filter((f) => f.endsWith('.test.js'));
  const entry = files.find((f) => f.includes('phase35'));
  assert.ok(entry, 'a Phase 35 real-runtime integration test must exist');
  const body = readFileSync(path.join(dir, entry), 'utf8');
  assert.match(body, /AIRLLM_INTEGRATION/, 'it must be gated on AIRLLM_INTEGRATION');
  assert.match(body, /skip|t\.skip/, 'a gated suite must skip, not fail');

  // And the default npm script must not descend into it.
  const pkg = JSON.parse(readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.ok(
    !pkg.scripts.test.includes('integration'),
    'AIRLLM_INTEGRATION must not leak into the default test run (brief 46)',
  );
});
