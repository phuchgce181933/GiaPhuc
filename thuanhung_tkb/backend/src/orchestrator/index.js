// Orchestrator. Pure HTTP-free entry point. Caller wires it to
// Express in routes/scheduling.js.

import { buildSituation } from '../domain/situation.js';
import { solve } from '../domain/solver.js';
import { verify } from '../domain/validator.js';
import { score } from '../domain/scorer.js';
import { dedupe, diversity } from '../domain/diversity.js';
import { explainCandidate } from '../domain/explain.js';
import { PRESETS, clampWeights, withSeed } from '../domain/strategies.js';
import { validateInput } from '../domain/validate.js';

export class PreviewCache {
  constructor() { this.byId = new Map(); }
  put(sol) { this.byId.set(sol.id, sol); }
  get(id) { return this.byId.get(id); }
  clear() { this.byId.clear(); }
}

export function makeOrchestrator() {
  const cache = new PreviewCache();
  return {
    cache,
    preview: (model, options) => preview(model, options, cache),
    commit: (solutionId) => commit(solutionId, cache),
  };
}

export function preview(model, options = {}, cache = new PreviewCache()) {
  cache.clear();
  // Phase 14: pre-scheduler validation. `validateInput` separates
  // structural problems (`issues` → INVALID_INPUT) from legitimate
  // absences of optional data (`missing` → MISSING_DATA). Only the
  // former is a reason to refuse the solver outright.
  const { issues, missing } = validateInput(model);

  if (issues.length > 0) {
    return {
      status: 'INVALID_INPUT',
      situation: buildSituation(model),
      solutions: [],
      diagnostics: {
        strategiesAttempted: 0,
        totalSolveMs: 0,
        warnings: [],
        unresolvable: [],
      },
      warnings: dedupeStrings([
        ...model.warnings,
        ...issues.map((i) => `INVALID_INPUT: ${i.entity}${i.entityId ? `/${i.entityId}` : ''}/${i.field ?? ''} :: ${i.detail}`),
      ]),
      missingData: model.missingData,
      invalidInput: issues,
    };
  }

  // Even when structurally valid, the model may lack critical
  // entities. We classify those as MISSING_DATA rather than running
  // the solver (which would just emit INFEASIBLE_DEMAND warnings).
  const hasMissingCriticalData =
    missing.some((m) => ['Branch', 'Class', 'Curriculum', 'Assignment'].includes(m.entity));

  const situation = buildSituation(model);

  if (hasMissingCriticalData) {
    const missingDataReport = dedupeMissing([...missing, ...(model.missingData ?? [])]);
    return {
      status: 'MISSING_DATA',
      situation,
      solutions: [],
      diagnostics: {
        strategiesAttempted: 0,
        totalSolveMs: 0,
        warnings: [],
        unresolvable: situation.unresolvable,
      },
      warnings: dedupeStrings(model.warnings),
      missingData: missingDataReport,
    };
  }

  const requested = clampRequest(options.solutions ?? 3);
  const strategyIds = options.strategies ?? ['A_PREFERENCE_FIRST', 'B_WORKLOAD_TRAVEL', 'C_BALANCED'];
  const strategies = strategyIds
    .map((id) => PRESETS.find((p) => p.id === id))
    .filter(Boolean)
    .map((s) => clampWeights(withSeed(s, options.seed ?? 0xC0FFEE)));

  const allCandidates = [];
  const allWarnings = [];
  let strategiesAttempted = 0;
  const t0 = Date.now();

  for (const strategy of strategies) {
    if (allCandidates.length >= requested) break;
    if (Date.now() - t0 > 30_000) break;
    strategiesAttempted += 1;
    const input = { ...model, strategy };
    const out = solve(input);
    allWarnings.push(...out.diagnostics.warnings);
    for (const c of out.solutions) {
      c.validation = verify(c, input);
      allCandidates.push(c);
    }
  }

  // PHASE 16 pipeline:
  //   1. Sort candidates by validator acceptance, then by a quick
  //      placeholder score (we will re-score after diversity is
  //      resolved).
  //   2. Walk the list; for each candidate compute its diversity
  //      against already-kept candidates and a full score (which
  //      includes diversity). Keep it iff it passes the dedupe
  //      threshold.
  //   3. The full `score()` call is made WITH the prior-kept list
  //      so diversity is part of the final overallScore.
  const kept = [];
  for (const c of allCandidates) {
    if (kept.length >= requested) break;
    c.score = score(c, { ...model, strategy: findStrategy(c.strategyId, strategies) }, kept);
    if (kept.length === 0) {
      kept.push(c);
      continue;
    }
    let minDiv = 1;
    for (const k of kept) minDiv = Math.min(minDiv, diversity(k, c));
    if (minDiv >= (strategies[0]?.diversification?.minEditDistance ?? 0.15)) {
      kept.push(c);
    }
  }

  // After the kept set is final, the orchestrator does NOT recompute
  // scores — the score is already diversity-aware. The order of
  // `kept` reflects the discovery order; we sort by overallScore
  // for the response.
  kept.sort((a, b) => b.score.overallScore - a.score.overallScore);

  for (const c of kept) {
    c.explanation = explainCandidate(c, { ...model, strategy: findStrategy(c.strategyId, strategies) });
    cache.put(c);
  }

  // PHASE 16 status:
  //   - INVALID_INPUT: handled above.
  //   - MISSING_DATA:  handled above.
  //   - OK:            at least one kept candidate is accepted.
  //   - EMPTY:         solver ran, produced candidates, but none of
  //                    them survived validation.
  let status;
  if (kept.some((c) => c.validation?.accepted)) {
    status = 'OK';
  } else {
    status = 'EMPTY';
  }

  return {
    status,
    situation,
    solutions: kept,
    diagnostics: {
      strategiesAttempted,
      totalSolveMs: Date.now() - t0,
      warnings: dedupeStrings(allWarnings),
      unresolvable: situation.unresolvable,
    },
    warnings: dedupeStrings([
      ...allWarnings,
      ...model.warnings,
      ...kept.flatMap((c) => c.validation.warnings),
    ]),
    missingData: model.missingData ?? [],
  };
}

function findStrategy(id, strategies) {
  return strategies.find((s) => s.id === id) ?? strategies[0];
}

export function commit(solutionId, cache) {
  const sol = cache.get(solutionId);
  if (!sol) return { ok: false, error: 'UNKNOWN_SOLUTION', detail: `solution ${solutionId} not in preview cache` };
  if (!sol.validation?.accepted) {
    return { ok: false, error: 'HARD_VIOLATION', detail: 're-validation reported a hard violation', violations: sol.validation?.hardViolations ?? [] };
  }
  return { ok: true, written: false, reason: 'DB writer not implemented in this phase; cache returned for inspection', solution: sol };
}

function clampRequest(n) {
  const allowed = [1, 3, 5, 10];
  return allowed.includes(n) ? n : 3;
}

function dedupeStrings(arr) {
  return [...new Set(arr)];
}

function dedupeMissing(arr) {
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const k = `${m.entity}|${m.entityId ?? ''}|${m.field ?? ''}|${m.reason ?? ''}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}
