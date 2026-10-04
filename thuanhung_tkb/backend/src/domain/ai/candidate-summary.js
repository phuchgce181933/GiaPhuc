// PHASE 29 — CANDIDATE SUMMARIES FOR THE SITUATION REPORT.
//
// Brief §17: when the AI is consulted AFTER generation, the report
// may carry per-candidate facts (quality and diversity statistics).
// It must NOT carry the placements themselves — the AI has no use
// for 802 slot rows, and sending them would be both wasteful and a
// wider data surface than the decision needs.
//
// This module reduces a candidate pool to numbers. It is solver-free
// (imports only `diversity.js`), so it can be used from the AI
// layer without dragging the solver in (brief §36).
//
// Pure: no mutation of the candidates, no clock, no randomness.

import { diversity as slotDiversity, structuralDiversity } from '../diversity.js';

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function minOf(values) {
  const f = values.filter((v) => v !== null);
  return f.length > 0 ? Math.min(...f) : null;
}

function maxOf(values) {
  const f = values.filter((v) => v !== null);
  return f.length > 0 ? Math.max(...f) : null;
}

function avgOf(values) {
  const f = values.filter((v) => v !== null);
  if (f.length === 0) return null;
  return f.reduce((a, b) => a + b, 0) / f.length;
}

/**
 * summarizeCandidates(candidates) ->
 *   {
 *     count: number,
 *     quality: {
 *       feasibleCount, infeasibleCount,
 *       workloadSpread: { min, max, best },
 *       maxTeacherLoad: { min, max, best },
 *       workloadStdev: { min, max, best },
 *       preferencePenalty: { min, max, best },
 *       changedAssignments: { min, max, best },
 *     } | null,
 *     diversity: {
 *       pairCount, minSlotDiversity, avgSlotDiversity, minStructuralDiversity,
 *     } | null,
 *   }
 *
 * `best` is the value on the comparator-best candidate (lowest
 * workload spread), which is the candidate the Phase 28 scorer
 * anchors its diversity dimensions on.
 *
 * The input array and every candidate in it are read-only here.
 * Returns `{ count: 0, quality: null, diversity: null }` for an
 * empty or missing pool, so callers never have to special-case it.
 */
export function summarizeCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { count: 0, quality: null, diversity: null };
  }

  const spreads = [];
  const loads = [];
  const stdevs = [];
  const prefs = [];
  const changed = [];
  let feasible = 0;
  let infeasible = 0;

  for (const c of candidates) {
    const hv = finite(c?.metrics?.hardViolations);
    if (hv === null || hv === 0) feasible += 1;
    else infeasible += 1;
    spreads.push(finite(c?.metrics?.workloadSpread));
    loads.push(finite(c?.metrics?.maxTeacherLoad));
    stdevs.push(finite(c?.metrics?.workloadStdev));
    prefs.push(finite(c?.metrics?.preferencePenalty));
    changed.push(finite(c?.metrics?.changedAssignments));
  }

  // The comparator anchor: lowest workload spread, then lowest max
  // load, then lowest index. This mirrors the Phase 28 anchor choice
  // (which uses the full comparator); the summary only needs a
  // stable representative for the "best" column.
  let bestIndex = 0;
  for (let i = 1; i < candidates.length; i++) {
    const a = spreads[i];
    const b = spreads[bestIndex];
    const aSpread = a === null ? Infinity : a;
    const bSpread = b === null ? Infinity : b;
    if (aSpread < bSpread) { bestIndex = i; continue; }
    if (aSpread > bSpread) continue;
    const aLoad = loads[i] === null ? Infinity : loads[i];
    const bLoad = loads[bestIndex] === null ? Infinity : loads[bestIndex];
    if (aLoad < bLoad) bestIndex = i;
  }

  const span = (values) => ({ min: minOf(values), max: maxOf(values), best: values[bestIndex] });

  const quality = {
    feasibleCount: feasible,
    infeasibleCount: infeasible,
    workloadSpread: span(spreads),
    maxTeacherLoad: span(loads),
    workloadStdev: span(stdevs),
    preferencePenalty: span(prefs),
    changedAssignments: span(changed),
  };

  // Pairwise diversity over the pool. O(n^2) on a pool bounded at 10.
  const slotDivs = [];
  const structDivs = [];
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      slotDivs.push(slotDiversity(candidates[i], candidates[j]));
      structDivs.push(structuralDiversity(candidates[i], candidates[j]).overall);
    }
  }

  const diversity = slotDivs.length === 0
    ? { pairCount: 0, minSlotDiversity: null, avgSlotDiversity: null, minStructuralDiversity: null }
    : {
      pairCount: slotDivs.length,
      minSlotDiversity: Math.min(...slotDivs),
      avgSlotDiversity: avgOf(slotDivs),
      minStructuralDiversity: minOf(structDivs),
    };

  return { count: candidates.length, quality, diversity };
}
