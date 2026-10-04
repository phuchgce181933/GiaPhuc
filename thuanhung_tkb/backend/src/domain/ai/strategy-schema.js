// PHASE 29 — STRATEGY DECISION SCHEMA + VALIDATOR.
//
// This module is the security boundary of the AI Strategy Layer.
//
//   AI output  ->  validateStrategyDecision()  ->  approved StrategyDecision
//
// Nothing reaches the solver except what comes out of here. An AI
// provider is treated as an UNTRUSTED source of strings and numbers:
// it may propose, and this module disposes. There is no "best effort
// interpretation" — a value outside the allow-list is not rounded
// into range and guessed at, it is rejected (brief §33).
//
// What the AI MAY decide (brief §4, §5, §10, §11):
//   - optimizationMode   (one of four existing modes)
//   - candidateCount     (one of {1, 3, 5, 10})
//   - scoringWeights     (a weight per ACTIVE Phase 28 dimension)
//   - priorities         (LOW / MEDIUM / HIGH emphasis annotation)
//   - rationale          (free text, non-authoritative)
//   - confidence         (optional, [0, 1], non-authoritative)
//
// What the AI may NOT do, and how it is stopped:
//   - name a mode outside the enum        -> REJECT (§4)
//   - ask for a count outside the set     -> REJECT (§10)
//   - emit NaN / Infinity / negative      -> REJECT (§11)
//   - exceed a dimension's max weight     -> CLAMP + record (§11)
//   - invent a dimension id               -> REJECT (§3)
//   - weight an INACTIVE dimension        -> CLAMP TO 0 + record (§6, §7, §8)
//   - disable a hard constraint           -> REJECT (§13, §25)
//        There is no field for it. The schema has no constraint
//        field at all, and ANY unrecognized top-level field is
//        rejected rather than ignored, so a provider cannot smuggle
//        one through and have it silently dropped.
//
// Reject vs clamp
// --------------
// The split is deliberate, and it is about whether the value
// expresses a REQUEST the system cannot honor (reject, fall back to
// a known-good strategy) or an OVERSHOOT of a request it can honor
// (clamp, keep going, record the correction):
//
//   - A mode, a count, or a dimension id that does not exist is a
//     request for something outside the action space. Reject.
//   - A weight that is a real number but past the bound is the same
//     intent, overshot. Clamp, and record AI_OUTPUT_CLAMPED.
//   - A weight on a known-but-INACTIVE dimension is a request the
//     domain forbids. Clamp to 0 and record — never activate.
//
// Nothing is silently accepted: every clamp produces an event, and
// an all-zero weight vector is replaced by the deterministic defaults
// rather than left to make the global score 0/0 (brief §12).
//
// Weight bounds
// -------------
// The default bound is [0, 3] for every dimension, matching the
// bound `clampWeights` already applies to domain strategy weights
// in `strategies.js` — so the AI cannot request a weight magnitude
// the rest of the system already considers out of range. Bounds are
// per-dimension and part of the allow-list, which lives OUTSIDE
// the AI: `allowList` is built from the dimension catalog and the
// input, and no provider output can extend it (brief §31).
//
// Import hygiene
// --------------
// This module does NOT import the solver (brief §36). It reads
// vocabulary from `dimension-catalog.js` (leaf) and `strategies.js`
// (no imports at all). It never imports `global-scoring.js`,
// `multi-solution.js`, or `solver.js`.

import { DIMENSION_CATALOG, getDimension } from '../dimension-catalog.js';
import { OPTIMIZATION_MODES, ALLOWED_CANDIDATE_COUNTS } from '../strategies.js';

// ============================================================================
// Enumerations
// ============================================================================

/**
 * Failure kinds the caller must be able to distinguish for
 * observability (brief §22). All of them fall back; none of them
 * are allowed to fail the schedule.
 */
export const AI_FAILURE = Object.freeze({
  TIMEOUT: 'AI_TIMEOUT',
  INVALID_OUTPUT: 'AI_INVALID_OUTPUT',
  UNAVAILABLE: 'AI_UNAVAILABLE',
  PARSE_ERROR: 'AI_PARSE_ERROR',
  UNSUPPORTED_REQUEST: 'AI_UNSUPPORTED_REQUEST',
});

/** Outcome of validating one provider response. */
export const AI_VALIDATION = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  CLAMPED: 'CLAMPED',
  REJECTED: 'REJECTED',
});

/**
 * The complete set of top-level fields a provider may return.
 *
 * This list is the enforcement point for brief §13 and §25: since
 * there is no constraint, objective, or teacher-rule field, and
 * since unknown fields are REJECTED rather than ignored, an AI
 * cannot express "disable H01" even in an attempt to have it
 * ignored. If a new AI capability is ever wanted, it is added here
 * deliberately, by a human, after review — never by a model.
 */
export const ALLOWED_DECISION_FIELDS = Object.freeze([
  'optimizationMode',
  'candidateCount',
  'scoringWeights',
  'priorities',
  'rationale',
  'confidence',
  // Audit metadata: which provider produced this decision. Recorded
  // in the decision log; never read by the solver.
  'source',
]);

/** Emphasis levels for the optional `priorities` annotation. */
export const PRIORITY_LEVELS = Object.freeze(['LOW', 'MEDIUM', 'HIGH']);

/** Default per-dimension weight bounds (brief §11). */
export const DEFAULT_WEIGHT_BOUND = Object.freeze({ min: 0, max: 3 });

/**
 * The documented policy table. Exported so the tests assert against
 * the policy rather than against hard-coded expectations, and so a
 * reviewer can see the whole reject/clamp split in one place.
 */
export const VALIDATION_POLICY = Object.freeze({
  unknownField: 'REJECT',
  unknownMode: 'REJECT',
  unknownDimension: 'REJECT',
  invalidCandidateCount: 'REJECT',
  nonFiniteWeight: 'REJECT',
  negativeWeight: 'REJECT',
  outOfRangeWeight: 'CLAMP',
  inactiveDimensionWeight: 'CLAMP_TO_ZERO',
  unknownPriorityLevel: 'CLAMP_TO_MEDIUM',
  nonStringRationale: 'DROP',
  outOfRangeConfidence: 'DROP',
  zeroWeightSum: 'RESTORE_DEFAULTS',
  lowConfidence: 'FALLBACK',
});

// ============================================================================
// Deterministic fallback (brief §21)
// ============================================================================

/**
 * DEFAULT_AI_FALLBACK — used whenever the AI path fails for any
 * reason, including the AI being absent entirely.
 *
 * It depends on NO model and NO network. Its weights are derived
 * from the dimension catalog's own `defaultWeight`, which is the
 * same source `GLOBAL_SCORING_DEFAULTS.weights` is built from, so
 * the fallback cannot drift from the scorer's defaults (brief §21:
 * take values from existing config, do not duplicate magic values).
 *
 * `defaultWeight` is read once at module load — the catalog is
 * frozen, so this is stable.
 */
export const DEFAULT_AI_FALLBACK = Object.freeze({
  optimizationMode: OPTIMIZATION_MODES.GLOBAL_ASSIGNMENT_BALANCED,
  candidateCount: 3,
  source: 'DEFAULT_AI_FALLBACK',
  rationale: 'Deterministic fallback: no AI strategy was approved, so the default balanced strategy is used.',
});

/** The catalog-derived default weight for every dimension. */
export function defaultWeightsFor(input) {
  const out = {};
  for (const d of DIMENSION_CATALOG) {
    if (d.active(input)) out[d.id] = d.defaultWeight;
  }
  return out;
}

// ============================================================================
// Allow-list (brief §31)
// ============================================================================

/**
 * Build the allow-list for a given SchedulingInput. The allow-list
 * is derived from the catalog's `active(input)` predicate, so a
 * dataset with a travel matrix automatically unlocks TRAVEL without
 * any code change here — and, conversely, on today's dataset TRAVEL
 * cannot be weighted because it is not on the list at all.
 *
 * The result is deeply frozen. A provider receives it (via the
 * situation report's `actionSpace`) as information; it cannot
 * obtain a reference to it and mutate it.
 */
export function buildAllowList(input) {
  const modes = Object.freeze(Object.values(OPTIMIZATION_MODES));
  const counts = Object.freeze([...ALLOWED_CANDIDATE_COUNTS]);
  const weightBounds = Object.freeze(Object.fromEntries(
    DIMENSION_CATALOG.map((d) => [
      d.id,
      Object.freeze({ min: DEFAULT_WEIGHT_BOUND.min, max: DEFAULT_WEIGHT_BOUND.max }),
    ]),
  ));
  const allowedDimensions = Object.freeze(
    DIMENSION_CATALOG.filter((d) => d.active(input)).map((d) => d.id).sort(),
  );
  const blockedDimensions = Object.freeze(
    DIMENSION_CATALOG.filter((d) => !d.active(input)).map((d) => d.id).sort(),
  );
  return Object.freeze({
    modes,
    counts,
    weightBounds,
    allowedDimensions,
    blockedDimensions,
    decisionFields: ALLOWED_DECISION_FIELDS,
    priorityLevels: PRIORITY_LEVELS,
  });
}

// ============================================================================
// Validation
// ============================================================================

function reject(reason, code, extra = {}) {
  return {
    ok: false,
    status: AI_VALIDATION.REJECTED,
    decision: null,
    events: [],
    reason,
    failure: { kind: AI_FAILURE.INVALID_OUTPUT, code, detail: reason, ...extra },
  };
}

/**
 * validateStrategyDecision(output, context) -> ValidationResult
 *
 *   context = { input, allowList?, minConfidence? }
 *
 *   ValidationResult = {
 *     ok: boolean,          // true only when a usable decision exists
 *     status: 'ACCEPTED' | 'CLAMPED' | 'REJECTED',
 *     decision: {...} | null,
 *     events: [{ code, detail, field?, dimension?, from?, to? }],
 *     reason: string,
 *     failure: { kind, code, detail } | null,
 *   }
 *
 * The function is PURE: it does not mutate `output`, `context`, or
 * `context.input`, and it never throws for bad provider output —
 * a malformed response is a REJECT, not an exception.
 */
export function validateStrategyDecision(output, context = {}) {
  const input = context.input ?? null;
  const allowList = context.allowList ?? buildAllowList(input);

  // ---- 0. SHAPE -------------------------------------------------
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    return reject('AI output is not an object', 'NOT_AN_OBJECT');
  }

  const events = [];

  // ---- 1. UNKNOWN FIELDS (brief §13, §25) -----------------------
  // Rejected, not ignored: an ignored `disableConstraints: ['H01']`
  // would still be a lie in the audit log, and a rejected one is a
  // provider bug the operator can see.
  for (const key of Object.keys(output)) {
    if (!ALLOWED_DECISION_FIELDS.includes(key)) {
      return reject(
        `AI returned an unrecognized field "${key}". The decision schema has no such field, and unknown fields are rejected rather than ignored.`,
        'UNKNOWN_FIELD',
        { field: key },
      );
    }
  }

  // ---- 2. optimizationMode (brief §4) ---------------------------
  const mode = output.optimizationMode;
  if (typeof mode !== 'string' || !allowList.modes.includes(mode)) {
    return reject(
      `AI returned optimizationMode ${JSON.stringify(mode)}; allowed: ${allowList.modes.join(', ')}.`,
      'UNKNOWN_MODE',
      { field: 'optimizationMode', value: mode ?? null },
    );
  }

  // ---- 3. candidateCount (brief §10) ----------------------------
  const rawCount = output.candidateCount;
  const count = typeof rawCount === 'string' && rawCount.trim() !== '' ? Number(rawCount) : rawCount;
  if (!Number.isInteger(count) || !allowList.counts.includes(count)) {
    return reject(
      `AI returned candidateCount ${JSON.stringify(rawCount)}; allowed: ${allowList.counts.join(', ')}.`,
      'INVALID_CANDIDATE_COUNT',
      { field: 'candidateCount', value: rawCount ?? null },
    );
  }

  // ---- 4. scoringWeights (brief §5, §6, §7, §8, §11, §12) -------
  const rawWeights = output.scoringWeights;
  if (rawWeights === null || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
    return reject('AI returned no usable scoringWeights object.', 'MISSING_WEIGHTS', { field: 'scoringWeights' });
  }

  const weights = {};
  for (const [dimId, value] of Object.entries(rawWeights)) {
    const dim = getDimension(dimId);

    // 4a. A dimension that does not exist at all = the AI invented a
    //     new quality axis (brief §3). Reject; do not invent storage.
    if (!dim) {
      return reject(
        `AI referenced unknown scoring dimension "${dimId}". The AI may not create dimensions.`,
        'UNKNOWN_DIMENSION',
        { dimension: dimId },
      );
    }

    // 4b. Type / finiteness (brief §11). NaN, Infinity, -Infinity,
    //     strings, null and booleans are all rejected — none of them
    //     carry a usable intent, and coercing them would be guessing.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return reject(
        `AI returned a non-finite weight for ${dimId}: ${String(value)}.`,
        'NON_FINITE_WEIGHT',
        { dimension: dimId, value: String(value) },
      );
    }

    // 4c. Negative weights (brief §11). Rejected, not clamped: a
    //     negative weight is not "a bit too much", it inverts the
    //     meaning of the axis.
    if (value < 0) {
      return reject(
        `AI returned a negative weight for ${dimId}: ${value}.`,
        'NEGATIVE_WEIGHT',
        { dimension: dimId, value },
      );
    }

    // 4d. INACTIVE dimensions (TRAVEL / TRANSFER / CHANGED_ASSIGNMENTS).
    //     Clamp to 0 and record. The dimension's weight is 0 in the
    //     approved decision, so it cannot contribute to any score
    //     and cannot be "activated" (brief §6, §7, §8).
    if (!allowList.allowedDimensions.includes(dimId)) {
      events.push({
        code: 'AI_OUTPUT_CLAMPED',
        detail: `AI assigned weight ${value} to INACTIVE dimension ${dimId}; clamped to 0.`,
        dimension: dimId,
        from: value,
        to: 0,
      });
      weights[dimId] = 0;
      continue;
    }

    // 4e. In-range but overshooting the bound (brief §11). Clamp and
    //     record — the intent ("weight this axis") is honored.
    const bound = allowList.weightBounds[dimId] ?? DEFAULT_WEIGHT_BOUND;
    let w = value;
    if (w > bound.max) {
      events.push({
        code: 'AI_OUTPUT_CLAMPED',
        detail: `AI weight ${w} for ${dimId} exceeds max ${bound.max}; clamped to ${bound.max}.`,
        dimension: dimId,
        from: w,
        to: bound.max,
      });
      w = bound.max;
    } else if (w < bound.min) {
      events.push({
        code: 'AI_OUTPUT_CLAMPED',
        detail: `AI weight ${w} for ${dimId} is below min ${bound.min}; clamped to ${bound.min}.`,
        dimension: dimId,
        from: w,
        to: bound.min,
      });
      w = bound.min;
    }
    weights[dimId] = w;
  }

  // 4f. Dimensions the AI stayed silent about take the catalog
  //     default, so the global score never divides by an accidental
  //     zero on a dimension the provider simply forgot.
  for (const dimId of allowList.allowedDimensions) {
    if (!(dimId in weights)) {
      const dim = getDimension(dimId);
      weights[dimId] = dim ? dim.defaultWeight : 0;
      events.push({
        code: 'AI_OUTPUT_DEFAULTED',
        detail: `AI omitted ${dimId}; using the dimension default weight ${weights[dimId]}.`,
        dimension: dimId,
        to: weights[dimId],
      });
    }
  }

  // 4g. An all-zero weight vector would make the Phase 28 global
  //     score 0/0. Restore the deterministic defaults (brief §12).
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!(totalWeight > 0)) {
    const restored = defaultWeightsFor(input);
    for (const k of Object.keys(weights)) delete weights[k];
    Object.assign(weights, restored);
    events.push({
      code: 'AI_OUTPUT_ZERO_WEIGHT_SUM',
      detail: 'Every approved weight was 0; restored the catalog default weights so the global score stays defined.',
    });
  }

  // ---- 5. priorities (optional, annotation only) ----------------
  let priorities = null;
  if (output.priorities !== undefined && output.priorities !== null) {
    if (typeof output.priorities !== 'object' || Array.isArray(output.priorities)) {
      return reject('AI returned a non-object priorities field.', 'INVALID_PRIORITIES', { field: 'priorities' });
    }
    priorities = {};
    for (const [dimId, level] of Object.entries(output.priorities)) {
      if (!allowList.allowedDimensions.includes(dimId)) {
        return reject(
          `AI assigned a priority to INACTIVE dimension "${dimId}".`,
          'UNKNOWN_DIMENSION',
          { dimension: dimId, field: 'priorities' },
        );
      }
      if (typeof level !== 'string' || !PRIORITY_LEVELS.includes(level)) {
        const clamped = PRIORITY_LEVELS[1];
        events.push({
          code: 'AI_OUTPUT_CLAMPED',
          detail: `AI priority for ${dimId} was ${JSON.stringify(level)}; clamped to ${clamped}.`,
          dimension: dimId,
          from: level ?? null,
          to: clamped,
        });
        priorities[dimId] = clamped;
        continue;
      }
      priorities[dimId] = level;
    }
  }

  // ---- 6. rationale (non-authoritative, brief §23) --------------
  // Free text is never parsed back into behavior. A non-string
  // rationale is dropped rather than rejected: it carries no
  // authority, so refusing to schedule over it would be theatre.
  let rationale = null;
  if (output.rationale !== undefined && output.rationale !== null) {
    if (typeof output.rationale === 'string') {
      rationale = output.rationale;
    } else {
      events.push({
        code: 'AI_OUTPUT_DROPPED',
        detail: 'rationale was not a string and was dropped. Rationale is explanation only and is never parsed as logic.',
        field: 'rationale',
      });
    }
  }

  // ---- 7. confidence (non-authoritative, brief §24) --------------
  let confidence = null;
  if (output.confidence !== undefined && output.confidence !== null) {
    const c = output.confidence;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0 && c <= 1) {
      confidence = c;
    } else {
      events.push({
        code: 'AI_OUTPUT_DROPPED',
        detail: `confidence ${String(c)} was not a number in [0, 1] and was dropped.`,
        field: 'confidence',
      });
    }
  }

  // ---- 8. Confidence gate (brief §24) ---------------------------
  // Confidence can only make the system MORE conservative. It can
  // never relax a validation rule, and it never reaches the solver.
  const minConfidence = context.minConfidence;
  if (typeof minConfidence === 'number' && Number.isFinite(minConfidence) && minConfidence > 0) {
    if (confidence === null || confidence < minConfidence) {
      return {
        ok: false,
        status: AI_VALIDATION.REJECTED,
        decision: null,
        events,
        reason: `AI confidence ${confidence ?? 'ABSENT'} is below the required ${minConfidence}; using the conservative fallback.`,
        failure: {
          kind: AI_FAILURE.INVALID_OUTPUT,
          code: 'LOW_CONFIDENCE',
          detail: `confidence=${confidence ?? 'ABSENT'} < minConfidence=${minConfidence}`,
        },
      };
    }
  }

  const decision = {
    optimizationMode: mode,
    candidateCount: count,
    scoringWeights: Object.freeze(weights),
    priorities: priorities ? Object.freeze(priorities) : null,
    rationale: rationale ?? DEFAULT_AI_FALLBACK.rationale,
    confidence,
    source: output.source ?? 'AI',
  };

  return {
    ok: true,
    status: events.some((e) => e.code === 'AI_OUTPUT_CLAMPED') ? AI_VALIDATION.CLAMPED : AI_VALIDATION.ACCEPTED,
    decision,
    events,
    reason: events.length === 0
      ? 'AI decision accepted as returned.'
      : `AI decision accepted with ${events.length} correction(s).`,
    failure: null,
  };
}

// ============================================================================
// Applying an approved decision (brief §37)
// ============================================================================

/**
 * applyStrategyDecision(decision, baseStrategy) -> AppliedStrategy
 *
 * Turns an APPROVED decision into the two artifacts the rest of the
 * pipeline consumes:
 *
 *   strategy        — a NEW domain Strategy whose only changed field
 *                     is `optimizationMode`. Everything else
 *                     (objectives, solver budget, diversification,
 *                     Phase 17/24 weights) is carried over VERBATIM.
 *                     In particular `objectives` is copied, never
 *                     recomputed: this is the mechanical reason an
 *                     AI cannot turn off an objective even if a
 *                     future schema change tried to let it.
 *   scoringConfig   — `{ weights }` for the Phase 28 global scorer.
 *
 * The function is PURE. `baseStrategy` is never mutated; the caller
 * gets a fresh object tree.
 */
export function applyStrategyDecision(decision, baseStrategy) {
  if (!decision || typeof decision !== 'object') {
    throw new TypeError('applyStrategyDecision requires an approved decision');
  }
  const base = baseStrategy && typeof baseStrategy === 'object' ? baseStrategy : {};

  const strategy = {
    ...base,
    optimizationMode: decision.optimizationMode,
    // Deep-ish copy of the sub-objects we carry over, so a later
    // mutation by the caller cannot reach back into baseStrategy.
    weights: { ...(base.weights ?? {}) },
    objectives: { ...(base.objectives ?? {}) },
    solver: { ...(base.solver ?? {}) },
    diversification: { ...(base.diversification ?? {}) },
  };

  return {
    strategy,
    scoringConfig: { weights: { ...(decision.scoringWeights ?? defaultWeightsFor(null)) } },
    candidateCount: decision.candidateCount,
    decision,
    warnings: [],
  };
}

/**
 * Attach an approved strategy to a COPY of the SchedulingInput.
 *
 * Brief §34: the AI must not mutate the input. This returns a new
 * top-level object whose `strategy` is a new object. The heavy
 * collections (teachers, assignments, the indexes, the time-slot
 * maps) are shared BY REFERENCE — they are read-only to the solver
 * (Phase 23 / 25 guarantee) and copying them per call would be a
 * large, pointless allocation on a 479-assignment input.
 */
export function applyDecisionToInput(input, decision, baseStrategy) {
  const applied = applyStrategyDecision(decision, baseStrategy ?? input?.strategy);
  return { input: { ...input, strategy: applied.strategy }, applied };
}

// ============================================================================
// Fallback resolution (brief §21)
// ============================================================================

/**
 * Produce the deterministic fallback decision for a given input.
 * Always returns a decision that passes `validateStrategyDecision`
 * with no events, so callers can treat "fallback" and "approved"
 * identically downstream.
 */
export function fallbackDecision(input, overrides = {}) {
  return {
    optimizationMode: overrides.optimizationMode ?? DEFAULT_AI_FALLBACK.optimizationMode,
    candidateCount: overrides.candidateCount ?? DEFAULT_AI_FALLBACK.candidateCount,
    scoringWeights: overrides.scoringWeights ?? defaultWeightsFor(input),
    priorities: overrides.priorities ?? null,
    rationale: overrides.rationale ?? DEFAULT_AI_FALLBACK.rationale,
    confidence: null,
    source: DEFAULT_AI_FALLBACK.source,
  };
}
