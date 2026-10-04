// PHASE 29 — AI PLANNER PROVIDER INTERFACE + MOCK PROVIDER.
//
// The provider seam
// -----------------
// An `AIPlanner` turns a SituationReport into a raw decision object.
// That is the entire contract:
//
//   plan(situationReport) -> Promise<rawDecision>
//
// The provider is an UNTRUSTED source. It is not given the
// SchedulingInput, the candidates, the solver, the constraint
// catalog's mutators, or any database handle — only the report. It
// cannot reach `solver.js` (brief §36) because it is not handed
// anything that references it.
//
// Whatever it returns is handed straight to
// `validateStrategyDecision`. A provider that returns nonsense, or
// throws, or never settles, produces a fallback — never a broken
// schedule (brief §22).
//
//   provider            verdict
//   ------------------  --------------------------------------------------
//   valid object        validated, clamped if needed, used
//   object out of range validated, corrections recorded, used
//   invalid object      AI_INVALID_OUTPUT -> fallback
//   throws              classified by error.aiFailureKind -> fallback
//   never settles       AI_TIMEOUT -> fallback
//
// Provider implementations in later phases: `LocalLLM`,
// `AirLLM` (Phase 30), and this mock. The DOMAIN does not know or
// care which one it is talking to (brief §28) — `AirLLM` appears
// nowhere in this file, and must not.
//
// The mock
// --------
// `DeterministicMockAIPlanner` exists so the pipeline can be
// exercised and tested with no model, no network, no GPU. It is a
// fixed rule table over the report's signals.
//
// It is NOT a language model and is not presented as one. It does
// not "reason", it does not improve scores, and Phase 29 makes no
// claim that it produces better timetables than the deterministic
// default (brief §41). What it proves is that the boundary works:
// report in, validated strategy out.

import { DIMENSION_CATALOG, getDimension } from '../dimension-catalog.js';
import { OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../strategies.js';
import { AI_FAILURE, PRIORITY_LEVELS } from './strategy-schema.js';

// ============================================================================
// Error type
// ============================================================================

/**
 * A provider failure with an explicit kind. Providers SHOULD throw
 * this rather than a bare Error so the orchestrator can log WHY it
 * fell back (unavailable vs parse error vs unsupported request are
 * operationally very different).
 */
export class AIProviderError extends Error {
  constructor(kind, message, detail = null) {
    super(message);
    this.name = 'AIProviderError';
    this.aiFailureKind = kind;
    this.detail = detail;
  }
}

// ============================================================================
// The interface
// ============================================================================

/**
 * Base class documenting the provider contract. Concrete providers
 * extend it and override `plan`. Using a base class (rather than
 * duck typing alone) means the contract is discoverable in the
 * codebase rather than implied by call sites.
 */
export class AIPlanner {
  /** Stable identifier used in the audit log (brief §26). */
  get name() {
    return this.constructor.name;
  }

  /**
   * @param {object} situationReport - from `buildSituationReport`.
   * @returns {Promise<object>} a raw decision object.
   */
  // eslint-disable-next-line no-unused-vars
  async plan(situationReport) {
    throw new AIProviderError(
      AI_FAILURE.UNAVAILABLE,
      'AIPlanner.plan must be implemented by a concrete provider',
    );
  }
}

/**
 * Shape check for anything passed as a provider. Returns
 * `{ ok, reason }` rather than throwing, so the orchestrator can
 * treat "you passed me nonsense instead of a planner" as an
 * AI_UNAVAILABLE condition (a caller bug) instead of a crash.
 */
export function assertPlannerShape(planner) {
  if (planner === null || typeof planner !== 'object') {
    return { ok: false, reason: 'planner must be an object' };
  }
  if (typeof planner.plan !== 'function') {
    return { ok: false, reason: 'planner.plan must be a function' };
  }
  return { ok: true, reason: null };
}

// ============================================================================
// Deterministic mock (brief §29)
// ============================================================================

/**
 * Rule table. Each rule is a named, inspectable mapping from
 * situation signals to a strategy shape — the whole "reasoning" of
 * the mock, written out in full.
 *
 * `weights` are the emphasis values; any dimension a rule does not
 * mention keeps its catalog default. Only ACTIVE dimensions are
 * emitted, so the mock structurally cannot weight TRAVEL today.
 */
const MOCK_RULES = Object.freeze([
  {
    id: 'NO_WORK_TO_DO',
    when: (s) => s.has('NO_ASSIGNMENTS') || s.has('NO_TEACHER_DATA'),
    mode: OPTIMIZATION_MODES.BASE_FEASIBLE,
    weights: {},
    rationale: 'There is no schedulable work, so no optimization is worth spending budget on.',
  },
  {
    id: 'WORKLOAD_IMBALANCE',
    when: (s) => s.has('WORKLOAD_IMBALANCE_HIGH'),
    mode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
    weights: {
      WORKLOAD_BALANCE: 1.0,
      MAX_TEACHER_LOAD: 0.8,
      WORKLOAD_STDEV: 0.6,
      PREFERENCE: 0.2,
      STRUCTURAL_DIVERSITY: 0.4,
      SLOT_DIVERSITY: 0.2,
    },
    rationale: 'Teacher workload spread is the strongest issue in this dataset, so workload axes are weighted highest.',
  },
  {
    id: 'PREFERENCE_COVERAGE',
    when: (s) => s.has('PREFERENCE_COVERAGE_STRONG') && !s.has('WORKLOAD_IMBALANCE_HIGH'),
    mode: OPTIMIZATION_MODES.ASSIGNMENT_BALANCED,
    weights: {
      WORKLOAD_BALANCE: 0.8,
      MAX_TEACHER_LOAD: 0.6,
      WORKLOAD_STDEV: 0.5,
      PREFERENCE: 0.9,
      STRUCTURAL_DIVERSITY: 0.5,
      SLOT_DIVERSITY: 0.3,
    },
    rationale: 'Workload is acceptable and most teachers state a session preference, so preference is weighted alongside balance.',
  },
]);

/** The rule used when none of the above matches. */
const MOCK_DEFAULT_RULE = Object.freeze({
  id: 'DEFAULT',
  mode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
  weights: {},
  rationale: 'No dominant signal in the situation report; using the balanced global strategy with catalog default weights.',
});

/**
 * Priority level for a weight, expressed RELATIVE TO THE HEAVIEST
 * WEIGHT IN THE SAME DECISION.
 *
 * Comparing against the absolute bound (3) would be useless: every
 * real weight sits in 0..1, so everything would read LOW. Comparing
 * within the decision answers the question a reader actually has -
 * "which axes did this strategy care about most?".
 */
function priorityFor(weight, heaviest) {
  if (!(heaviest > 0)) return PRIORITY_LEVELS[1];
  const ratio = weight / heaviest;
  if (ratio >= 0.8) return PRIORITY_LEVELS[2]; // HIGH
  if (ratio >= 0.5) return PRIORITY_LEVELS[1]; // MEDIUM
  return PRIORITY_LEVELS[0]; // LOW
}

export class DeterministicMockAIPlanner extends AIPlanner {
  /**
   * @param {object} [options]
   * @param {string} [options.profile] - 'auto' (default) runs the rule
   *   table. Any other value is ignored, so a caller cannot smuggle
   *   a different action space through this constructor.
   */
  constructor(options = {}) {
    super();
    this.profile = options.profile ?? 'auto';
  }

  get name() {
    return 'DeterministicMockAIPlanner';
  }

  /**
   * Pure function of the report. No clock, no randomness, no I/O,
   * no reference to the SchedulingInput. Two calls with equal
   * reports produce deeply equal decisions.
   */
  async plan(report) {
    if (!report || typeof report !== 'object') {
      throw new AIProviderError(AI_FAILURE.UNAVAILABLE, 'mock planner requires a situation report');
    }

    const signals = new Set(Array.isArray(report.signals) ? report.signals : []);
    const activeDimensions = new Set(
      (report?.dimensionAvailability?.active ?? []).map((d) => d.id),
    );

    const rule = MOCK_RULES.find((r) => r.when(signals)) ?? MOCK_DEFAULT_RULE;

    // Weights: catalog defaults for every ACTIVE dimension, then the
    // rule's emphasis on top. Iterating the catalog (not the rule)
    // guarantees the output only ever names active dimensions.
    const weights = {};
    for (const d of DIMENSION_CATALOG) {
      if (!activeDimensions.has(d.id)) continue;
      const override = rule.weights[d.id];
      weights[d.id] = typeof override === 'number' ? override : d.defaultWeight;
    }

    const heaviest = Math.max(0, ...Object.values(weights));
    const priorities = {};
    for (const [id, w] of Object.entries(weights)) {
      priorities[id] = priorityFor(w, heaviest);
    }

    // Echo the caller's own request when it is legal; otherwise use
    // the middle of the vocabulary. The mock cannot widen the set.
    const requested = Number(report.requestedCandidateCount);
    const candidateCount = ALLOWED_CANDIDATE_COUNTS.includes(requested)
      ? requested
      : ALLOWED_CANDIDATE_COUNTS[2];

    return {
      optimizationMode: rule.mode,
      candidateCount,
      scoringWeights: weights,
      priorities,
      rationale: `[mock:${rule.id}] ${rule.rationale}`,
      confidence: null,
      source: 'DeterministicMockAIPlanner',
    };
  }
}

// ============================================================================
// Failure providers (brief §22)
// ============================================================================
//
// These exist so the fallback paths are tested rather than assumed.
// Each one fails in exactly one way.

/** Always rejects as unavailable (no model configured, service down). */
export function createUnavailablePlanner(message = 'no AI provider configured') {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: 'UnavailablePlanner' });
  planner.plan = async () => {
    throw new AIProviderError(AI_FAILURE.UNAVAILABLE, message);
  };
  return planner;
}

/** Returns a promise that NEVER settles, to exercise the timeout. */
export function createHangingPlanner() {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: 'HangingPlanner' });
  planner.plan = () => new Promise(() => {});
  return planner;
}

/** Rejects with a parse error (the provider could not read its own output). */
export function createParseErrorPlanner(message = 'provider returned unparseable output') {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: 'ParseErrorPlanner' });
  planner.plan = async () => {
    throw new AIProviderError(AI_FAILURE.PARSE_ERROR, message);
  };
  return planner;
}

/** Rejects as an unsupported request (e.g. a mode the host will not serve). */
export function createUnsupportedRequestPlanner(message = 'provider cannot serve this request') {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: 'UnsupportedRequestPlanner' });
  planner.plan = async () => {
    throw new AIProviderError(AI_FAILURE.UNSUPPORTED_REQUEST, message);
  };
  return planner;
}

/** Resolves with a structurally invalid object (wrong mode, bad count, …). */
export function createInvalidOutputPlanner(output = null) {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: 'InvalidOutputPlanner' });
  planner.plan = async () => (output ?? {
    optimizationMode: 'FREE_FORM',
    candidateCount: 999,
    scoringWeights: { TRAVEL: 50 },
  });
  return planner;
}

/** Resolves with a fixed object. Useful for driving the validator directly. */
export function createStaticPlanner(output, name = 'StaticPlanner') {
  const planner = new AIPlanner();
  Object.defineProperty(planner, 'name', { value: name });
  planner.plan = async () => output;
  return planner;
}

export { getDimension };
