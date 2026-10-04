// PHASE 29 — AI STRATEGY LAYER (public surface + orchestrator).
//
//   SchedulingInput
//         ↓
//   SituationReport          (situation-report.js — facts, no PII)
//         ↓
//   AIPlanner                (planner.js — untrusted provider seam)
//         ↓
//   StrategyValidator        (strategy-schema.js — the boundary)
//         ↓
//   StrategyDecision         (approved or deterministic fallback)
//         ↓
//   Solver → Candidates → Global Scorer → Final Solutions
//
// The AI NEVER DIRECTLY CREATES SCHEDULE SLOTS (brief §1). It picks
// a mode, a candidate count, and a weight per active scoring
// dimension. The deterministic solver does all placement; the
// independent evaluator still decides feasibility; the Phase 28
// scorer still ranks. Nothing here writes to a database (brief §2).
//
// Orchestration guarantees
// ------------------------
//  1. The solver is never reached with an unvalidated decision. The
//     only path to a Strategy is `validateStrategyDecision` → ok.
//  2. Every failure mode falls back to `DEFAULT_AI_FALLBACK`. An
//     absent, broken, slow, or adversarial AI cannot fail a schedule
//     that the deterministic path could have produced anyway.
//  3. The SchedulingInput is never mutated. `applyDecisionToInput`
//     returns a new object; the caller keeps the original (brief §34).
//  4. The decision is auditable: `audit` answers "why did the system
//     choose this strategy?" without storing the report or any
//     personal data (brief §26).
//
// Import hygiene: this module and everything under `domain/ai/`
// never import `solver.js`, `multi-solution.js`, or
// `global-scoring.js` (brief §36). The dimension vocabulary is read
// from the leaf module `domain/dimension-catalog.js`.
//
// PHASE 30 — the AirLLM provider is added under `domain/ai/providers/`
// and adds no import of this module. `index.js` stays the
// provider-agnostic public surface of the strategy layer: the word
// "airllm" appears nowhere in `domain/ai/*.js`, so the contract cannot
// be read as depending on any one implementation. Callers that want
// the provider import `domain/ai/providers/index.js` (brief §1, §3,
// §36).

import {
  SITUATION_REPORT_VERSION,
  buildSituationReport,
  hashSituationReport,
  canonicalStringify,
  findPersonalData,
  SIGNAL_THRESHOLDS,
} from './situation-report.js';

import {
  AI_FAILURE,
  AI_VALIDATION,
  ALLOWED_DECISION_FIELDS,
  DEFAULT_AI_FALLBACK,
  DEFAULT_WEIGHT_BOUND,
  PRIORITY_LEVELS,
  VALIDATION_POLICY,
  applyDecisionToInput,
  applyStrategyDecision,
  buildAllowList,
  defaultWeightsFor,
  fallbackDecision,
  validateStrategyDecision,
} from './strategy-schema.js';

import {
  AIPlanner,
  AIProviderError,
  DeterministicMockAIPlanner,
  assertPlannerShape,
  createHangingPlanner,
  createInvalidOutputPlanner,
  createParseErrorPlanner,
  createStaticPlanner,
  createUnavailablePlanner,
  createUnsupportedRequestPlanner,
} from './planner.js';

import { summarizeCandidates } from './candidate-summary.js';


// ============================================================================
// Orchestrator options
// ============================================================================

export const AI_STRATEGY_DEFAULTS = Object.freeze({
  /**
   * Wall-clock ceiling for ONE provider call (brief §42). The
   * orchestrator races the provider against this; a provider that
   * has not settled is abandoned and the fallback is used. The timer
   * is always cleared, and it is unref'd so a hung provider cannot
   * keep the process alive.
   */
  timeoutMs: 5_000,
  /**
   * Optional confidence gate (brief §24). null = disabled, which is
   * the default: the mock reports no confidence, and requiring one
   * would mean the mock always fell back. When enabled, a decision
   * below the threshold falls back to the conservative default.
   */
  minConfidence: null,
  /**
   * The caller's own candidate request, echoed to the AI so it can
   * respect it. Validated against the shared vocabulary before the
   * report is built.
   */
  requestedCandidateCount: null,
  /**
   * When true, the resolved decision is run through
   * `validateStrategyDecision` a second time. It is always valid by
   * construction, so this is off by default; it exists so callers
   * can assert the invariant in their own logs.
   */
  revalidate: false,
});

// ============================================================================
// Timeout wrapper
// ============================================================================

/**
 * Race a provider call against a timeout. Resolves to
 * `{ ok, value }` or `{ ok: false, failure }`. NEVER rejects: a
 * provider that throws is as ordinary an outcome as one that is
 * slow, and neither may propagate out of the orchestrator.
 */
async function callProvider(planner, report, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        failure: {
          kind: AI_FAILURE.TIMEOUT,
          code: 'AI_TIMEOUT',
          detail: `AI provider did not respond within ${timeoutMs} ms`,
        },
      });
    }, timeoutMs);
    // NOTE: deliberately NOT unref-ed. When the provider never
    // settles, this timer is the only pending handle, and
    // unref-ing it lets Node exit before the race resolves. It is
    // always cleared in the finally block below, so it cannot
    // outlive the call.
  });

  try {
    const call = (async () => {
      try {
        const value = await planner.plan(report);
        return { ok: true, value };
      } catch (e) {
        const kind = e instanceof AIProviderError || typeof e?.aiFailureKind === 'string'
          ? e.aiFailureKind
          : AI_FAILURE.INVALID_OUTPUT;
        return {
          ok: false,
          failure: {
            kind,
            code: `${kind}_THROWN`,
            detail: String(e?.message ?? e),
          },
        };
      }
    })();

    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ============================================================================
// planStrategy
// ============================================================================

/**
 * planStrategy(input, options) -> PlanResult
 *
 *   options = {
 *     planner,                 // AIPlanner; null/undefined => no AI at all
 *     timeoutMs, minConfidence, requestedCandidateCount, revalidate,
 *     baseStrategy,            // defaults to input.strategy
 *   }
 *
 *   PlanResult = {
 *     report,                  // SituationReport (includes .hash)
 *     allowList,               // frozen allow-list the AI was held to
 *     decision,                // the APPROVED decision (never the raw output)
 *     rawOutput,               // whatever the provider returned (audit only)
 *     validation,              // ValidationResult
 *     fallbackUsed,            // boolean
 *     failure,                 // failure kind or null
 *     audit,                   // brief §26 log
 *     applied,                 // { strategy, scoringConfig, candidateCount }
 *     input,                   // a NEW SchedulingInput carrying the strategy
 *     timing,                  // { reportMs, aiMs, totalMs } — non-deterministic
 *   }
 *
 * `result.input` is a new object; `input` itself is untouched. The
 * returned `input.strategy` is the only thing the AI influenced.
 */
export async function planStrategy(input, options = {}) {
  const start = Date.now();
  const cfg = { ...AI_STRATEGY_DEFAULTS, ...(options ?? {}) };
  const baseStrategy = cfg.baseStrategy ?? input?.strategy ?? {};

  if (!input || typeof input !== 'object') {
    throw new TypeError('planStrategy requires a SchedulingInput object');
  }

  // ---- 1. REPORT ------------------------------------------------
  const reportStart = Date.now();
  const report = buildSituationReport(input, {
    requestedCandidateCount: cfg.requestedCandidateCount,
    candidateSummary: options.candidateSummary ?? null,
  });
  const reportMs = Date.now() - reportStart;

  // ---- 2. ALLOW-LIST (built outside the AI; it cannot edit it) --
  const allowList = buildAllowList(input);

  // ---- 3. CALL THE PROVIDER (if any) ----------------------------
  const plannerShape = cfg.planner
    ? assertPlannerShape(cfg.planner)
    : { ok: false, reason: 'no planner supplied' };

  let call = { ok: false, value: null, failure: null, aiMs: 0 };

  if (!plannerShape.ok) {
    call.failure = {
      kind: AI_FAILURE.UNAVAILABLE,
      code: 'AI_UNAVAILABLE',
      detail: `AI provider is not usable: ${plannerShape.reason}`,
    };
  } else {
    const aiStart = Date.now();
    call = await callProvider(cfg.planner, report, cfg.timeoutMs);
    call.aiMs = Date.now() - aiStart;
  }

  // ---- 4. VALIDATE ----------------------------------------------
  // PHASE 31 measures the validator as its own stage. Previously the
  // only timings were reportMs and aiMs, which made validation cost
  // visible only as a residual — a regression in the boundary would
  // have had nowhere to show up. The field is additive; nothing in
  // Phase 29 or Phase 30 reads it.
  const validationStart = Date.now();
  const validation = call.ok
    ? validateStrategyDecision(call.value, {
      input,
      allowList,
      minConfidence: cfg.minConfidence,
    })
    : {
      ok: false,
      status: AI_VALIDATION.REJECTED,
      decision: null,
      events: [],
      reason: call.failure?.detail ?? 'AI provider produced no usable output.',
      failure: call.failure,
    };
  const validationMs = Date.now() - validationStart;

  // ---- 5. FALLBACK ----------------------------------------------
  const fallbackUsed = validation.ok !== true;
  const decision = validation.ok
    ? validation.decision
    : fallbackDecision(input);

  // Optional belt-and-braces: prove the resolved decision validates
  // cleanly even when it came from the AI.
  if (cfg.revalidate) {
    const check = validateStrategyDecision(decision, { input, allowList });
    if (!check.ok) {
      // Unreachable by construction; if it ever fires, that is a bug
      // in this module, so fall back rather than trust the decision.
      for (const k of Object.keys(decision)) delete decision[k];
      Object.assign(decision, fallbackDecision(input));
      validation.revalidation = { ok: false, reason: check.reason };
    } else {
      validation.revalidation = { ok: true, reason: null };
    }
  }

  // ---- 6. APPLY (to a COPY — brief §34) --------------------------
  const { input: nextInput, applied } = applyDecisionToInput(input, decision, baseStrategy);

  const totalMs = Date.now() - start;
  const audit = {
    provider: cfg.planner?.name ?? null,
    inputSummaryHash: report.hash,
    decision,
    validation: {
      status: validation.status,
      reason: validation.reason,
      events: validation.events,
    },
    fallbackUsed,
    rationale: decision.rationale,
    failure: validation.failure ?? null,
    // Deliberately NOT stored: the report itself, the raw provider
    // output, and any teacher data. `inputSummaryHash` is enough to
    // prove two runs saw the same situation (brief §26, §27).
  };

  return {
    report,
    allowList,
    decision,
    rawOutput: call.ok ? call.value : null,
    validation,
    fallbackUsed,
    failure: validation.failure ?? null,
    audit,
    applied,
    input: nextInput,
    // `validationMs` times `validateStrategyDecision` alone. The
    // optional revalidation pass below is outside that window on
    // purpose: it is a caller-requested assertion, not part of the
    // boundary every request pays for.
    timing: { reportMs, aiMs: call.aiMs ?? 0, validationMs, totalMs },
  };
}

// ============================================================================
// POST-SOLVE recommendation (brief §18, §35)
// ============================================================================

/**
 * recommendFromCandidates(candidates, options) -> Recommendation
 *
 * The POST-SOLVE timing mode, formalized but deliberately minimal
 * (brief §18: "Phase 29 chỉ cần formalize interfaces").
 *
 * It does NOT re-solve, does NOT rescore, and does NOT touch the
 * candidates: it returns a pointer to one candidate plus a short
 * rationale. The caller still runs the Phase 28 scorer; this is an
 * opinion about which surfaced solution to lead with, not a
 * re-ranking that could bypass the validator (brief §2, §35).
 *
 * Ranking is a pure function of candidate metrics, with the
 * original index as the final tiebreak so the order never depends
 * on anything but the input array.
 */
export function recommendFromCandidates(candidates, options = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {
      recommendedIndex: null,
      recommendedId: null,
      rationale: 'No candidates to recommend from.',
      alternatives: [],
      source: 'DETERMINISTIC',
    };
  }

  const ordered = candidates
    .map((candidate, index) => ({ candidate, index, id: candidate?.id ?? null }))
    .sort((a, b) => {
      const bySpread = spreadOf(a.candidate) - spreadOf(b.candidate);
      if (bySpread !== 0) return bySpread;
      const byLoad = loadOf(a.candidate) - loadOf(b.candidate);
      if (byLoad !== 0) return byLoad;
      // Total order: original index. Never input-iteration dependent.
      return a.index - b.index;
    });

  const best = ordered[0];
  const keep = options.limit ?? 3;
  return {
    recommendedIndex: best.index,
    recommendedId: best.id,
    rationale:
      `Recommended by the deterministic comparator (workloadSpread=${spreadOf(best.candidate)}, ` +
      `maxTeacherLoad=${loadOf(best.candidate)}). A later AI provider may suggest a different ` +
      'emphasis, but it may not alter the candidate itself.',
    alternatives: ordered.slice(1, 1 + keep).map((o) => ({ id: o.id, index: o.index })),
    source: options.source ?? 'DETERMINISTIC',
  };
}

function spreadOf(candidate) {
  const v = candidate?.metrics?.workloadSpread;
  return typeof v === 'number' && Number.isFinite(v) ? v : Infinity;
}

function loadOf(candidate) {
  const v = candidate?.metrics?.maxTeacherLoad;
  return typeof v === 'number' && Number.isFinite(v) ? v : Infinity;
}

// ============================================================================
// Public surface
// ============================================================================

export {
  // report
  SITUATION_REPORT_VERSION,
  buildSituationReport,
  hashSituationReport,
  canonicalStringify,
  findPersonalData,
  SIGNAL_THRESHOLDS,
  // schema / validation
  AI_FAILURE,
  AI_VALIDATION,
  ALLOWED_DECISION_FIELDS,
  DEFAULT_AI_FALLBACK,
  DEFAULT_WEIGHT_BOUND,
  PRIORITY_LEVELS,
  VALIDATION_POLICY,
  buildAllowList,
  defaultWeightsFor,
  validateStrategyDecision,
  applyStrategyDecision,
  applyDecisionToInput,
  fallbackDecision,
  // providers
  AIPlanner,
  AIProviderError,
  DeterministicMockAIPlanner,
  assertPlannerShape,
  createStaticPlanner,
  createUnavailablePlanner,
  createHangingPlanner,
  createParseErrorPlanner,
  createInvalidOutputPlanner,
  createUnsupportedRequestPlanner,

  // post-solve. (recommendFromCandidates is exported at its own
  // declaration above.)
  summarizeCandidates,
};
