// Phase 22 — public surface of the constraint module.
//
// The new constraint catalog + independent evaluator live here.
// The existing `domain/constraints.js` (HARD/SOFT for the legacy
// validator path) is preserved for backward compatibility.
//
// Usage:
//
//   import { evaluateCandidate, evaluateBaseline, CATALOG } from './constraints/index.js';
//   const evaluation = evaluateCandidate(candidate, schedulingInput);
//
// See `docs/CONSTRAINT_SPECIFICATION.md` for the constraint
// catalogue and `docs/PHASE_22_CONSTRAINT_AUDIT.md` for the
// real-data audit.

export {
  CATALOG,
  CATALOG_BY_ID,
  HARD_CONSTRAINTS,
  SOFT_CONSTRAINTS,
  getConstraint,
  listHard,
  listSoft,
  normalizeCandidate,
} from './catalog.js';

export {
  evaluateCandidate,
  evaluateBaseline,
  isAccepted,
  totalCost,
  HARD_WEIGHT,
} from './evaluator.js';