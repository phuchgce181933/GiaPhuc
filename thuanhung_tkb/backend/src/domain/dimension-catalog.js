// DIMENSION CATALOG — Phase 28 vocabulary, extracted as a leaf module.
//
// WHY THIS FILE EXISTS
// --------------------
// The dimension catalog is DOMAIN VOCABULARY: the list of quality
// axes the system knows about, which way each axis points, where
// its raw value comes from, and whether it is currently ACTIVE.
//
// Phase 28 defined it inside `global-scoring.js`. That module also
// re-exports the Phase 27 `qualityScore` and imports the Phase 25
// comparator, which transitively pulls in `multi-solution.js` →
// `solver.js`.
//
// That import chain is fine for the scorer, but it is WRONG for the
// Phase 29 AI Strategy Layer. Brief §36 requires the AI layer to
// not import the solver: an AI layer that can reach `solver.js` can
// reach search internals, and the boundary stops being meaningful.
//
// So the catalog is extracted here into a LEAF module. Its only
// import is `diversity.js` (slot/structural diversity), which is
// itself solver-free (`diversity.js` → `time.js` only).
//
//   situation-report.js ──┐
//   strategy-schema.js  ──┼──> dimension-catalog.js ──> diversity.js ──> time.js
//   global-scoring.js   ──┘
//
// `global-scoring.js` RE-EXPORTS everything below, so its public
// API is byte-for-byte unchanged and no existing test is affected.
//
// A dimension is a single quality axis. Each dimension has:
//
//   id            - unique string used as a key everywhere
//   name          - human-readable label
//   description   - one-line explanation
//   source        - (candidate, context) -> raw value
//                   the raw value is a Number or null (when
//                   the dimension is INACTIVE)
//   direction     - 'MINIMIZE' (lower raw is better) or
//                   'MAXIMIZE' (higher raw is better)
//   defaultWeight - default weight (overridable via options)
//   active        - (input) -> boolean
//                   false = dimension is INACTIVE, raw = null,
//                   contribution = 0. Used for travel, transfer,
//                   and any future data-dependent dimension.
//
// The dimension catalog is the SINGLE source of truth for
// "which dimensions exist, which way they point, where the
// raw value comes from". A new dimension is added by
// registering it here. Consumers should NOT duplicate the
// definitions — in particular, the Phase 29 AI layer reads this
// catalog to build its allow-list rather than restating the
// dimension ids.

import { diversity as slotDiversity, structuralDiversity } from './diversity.js';

const DIRECTION = Object.freeze({ MINIMIZE: 'MINIMIZE', MAXIMIZE: 'MAXIMIZE' });

export const DIMENSION_CATALOG = Object.freeze([
  {
    id: 'WORKLOAD_BALANCE',
    name: 'Workload Balance',
    description: '(max - min) of per-teacher periods. Lower is better.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 1.0,
    source: (candidate) => Number(candidate?.metrics?.workloadSpread ?? 0),
    active: () => true,
  },
  {
    id: 'MAX_TEACHER_LOAD',
    name: 'Max Teacher Load',
    description: 'Maximum per-teacher period count. Lower is better.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.5,
    source: (candidate) => Number(candidate?.metrics?.maxTeacherLoad ?? 0),
    active: () => true,
  },
  {
    id: 'WORKLOAD_STDEV',
    name: 'Workload Standard Deviation',
    description: 'Population stdev of per-teacher load. Lower is better.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.3,
    source: (candidate) => Number(candidate?.metrics?.workloadStdev ?? 0),
    active: () => true,
  },
  {
    id: 'PREFERENCE',
    name: 'Session Preference Penalty',
    description: 'Mean S01 mismatch (0 = perfect, 1 = all miss). Lower is better.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.3,
    source: (candidate) => Number(candidate?.metrics?.preferencePenalty ?? 0),
    active: () => true,
  },
  {
    id: 'STRUCTURAL_DIVERSITY',
    name: 'Structural Diversity (to best)',
    description: 'Per-teacher day + session distribution difference vs the best-quality candidate. Higher is better.',
    direction: DIRECTION.MAXIMIZE,
    defaultWeight: 0.4,
    source: (candidate, context) => {
      // Pairwise vs the best-quality candidate in the pool.
      // If the candidate IS the best, the raw value is 0
      // (no diversity to itself). The metric is bounded in
      // [0, 1].
      const best = context?.bestCandidate;
      if (!best || best === candidate) return 0;
      return structuralDiversity(best, candidate).overall;
    },
    active: () => true,
  },
  {
    id: 'SLOT_DIVERSITY',
    name: 'Slot Identity Diversity (to best)',
    description: 'Symmetric-difference of slot identity sets vs the best candidate. Higher is better.',
    direction: DIRECTION.MAXIMIZE,
    defaultWeight: 0.2,
    source: (candidate, context) => {
      const best = context?.bestCandidate;
      if (!best || best === candidate) return 0;
      return slotDiversity(best, candidate);
    },
    active: () => true,
  },
  // ---- Always-inactive dimensions (Phase 28) -------------------------
  {
    id: 'TRAVEL',
    name: 'Travel Feasibility (UNSUPPORTED)',
    description: 'H14 = UNSUPPORTED. No travel matrix in input. Dimension is INACTIVE.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.0,
    source: () => null,
    active: (input) => Boolean(input?.travelTime && typeof input.travelTime === 'object'),
  },
  {
    id: 'TRANSFER',
    name: 'Transfer Permission (INACTIVE)',
    description: 'H13 = INACTIVE. No teacher carries allowedTransferBranches. Dimension is INACTIVE.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.0,
    source: () => null,
    active: (input) => Array.isArray(input?.teachers)
      && input.teachers.some((t) => Array.isArray(t?.allowedTransferBranches) && t.allowedTransferBranches.length > 0),
  },
  {
    id: 'CHANGED_ASSIGNMENTS',
    name: 'Changed Assignments (reporting only)',
    description: 'Number of assignments whose teacher differs from the legacy baseline. Reporting only — never used as a primary score.',
    direction: DIRECTION.MINIMIZE,
    defaultWeight: 0.0,
    source: (candidate) => Number(candidate?.metrics?.changedAssignments ?? 0),
    active: () => false, // §21 — reporting only unless explicitly configured
  },
]);

const DIMENSION_BY_ID = new Map(DIMENSION_CATALOG.map((d) => [d.id, d]));

export function getDimension(id) {
  return DIMENSION_BY_ID.get(id) ?? null;
}

export function listActiveDimensions(input) {
  return DIMENSION_CATALOG.filter((d) => d.active(input));
}

/**
 * Human-readable reason why a dimension is not contributing.
 * The AI layer surfaces this verbatim so a strategy decision can
 * explain "why is TRAVEL not weighted?" without the AI having to
 * know the activation rules.
 */
export function inactiveReason(id, input) {
  if (id === 'TRAVEL') return 'H14 = UNSUPPORTED (no travel matrix)';
  if (id === 'TRANSFER') return 'H13 = INACTIVE (no allowedTransferBranches)';
  if (id === 'CHANGED_ASSIGNMENTS') return 'REPORTING_ONLY';
  const dim = getDimension(id);
  if (dim && typeof dim.active === 'function' && !dim.active(input)) {
    return 'INACTIVE (activation predicate returned false)';
  }
  return 'INACTIVE';
}

export { DIRECTION, slotDiversity, structuralDiversity };
