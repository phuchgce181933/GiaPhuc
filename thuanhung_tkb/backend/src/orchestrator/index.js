// Orchestrator. Pure HTTP-free entry point. Caller wires it to
// Express in routes/scheduling.js.
//
// PHASE 14: pre-scheduler validation. `validateInput` separates
// structural problems (`issues` → INVALID_INPUT) from legitimate
// absences of optional data (`missing` → MISSING_DATA). Only the
// former is a reason to refuse the solver outright.
//
// PHASE 16: pipeline order, status logic (OK/EMPTY/MISSING_DATA/INVALID_INPUT).
//
// PHASE 17: A/B/C comparison. The orchestrator now records, for
// each strategy attempted, the top candidate's score and a count
// of candidates produced. The response carries a `comparison`
// block so callers can audit which strategy "won" and what
// tradeoffs the others made. Each solution also carries the
// `strategyId` that produced it (PHASE 17 solver).

import { buildSituation } from '../domain/situation.js';
import { solve } from '../domain/solver.js';
import { verify } from '../domain/validator.js';
import { score } from '../domain/scorer.js';
import { dedupe, diversity, structuralDiversity } from '../domain/diversity.js';
import { explainCandidate } from '../domain/explain.js';
import { PRESETS, clampWeights, withSeed, ALLOWED_CANDIDATE_COUNTS } from '../domain/strategies.js';
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
      comparison: emptyComparison(),
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
      comparison: emptyComparison(),
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

  // PHASE 17 — A/B/C comparison state. The orchestrator tries EACH
  // strategy (not just until the kept set is full) so the comparison
  // block can compare them honestly. The kept set is still bounded by
  // `requested`, but the per-strategy work runs to completion.
  const allCandidates = [];
  const allWarnings = [];
  const perStrategy = strategies.map((s) => ({
    strategyId: s.id,
    candidatesProduced: 0,
    accepted: 0,
    topScore: null,
    topSolution: null,
  }));
  let strategiesAttempted = 0;
  const t0 = Date.now();

  for (let si = 0; si < strategies.length; si++) {
    if (Date.now() - t0 > 30_000) break;
    const strategy = strategies[si];
    strategiesAttempted += 1;
    const input = { ...model, strategy };
    const out = solve(input);
    allWarnings.push(...out.diagnostics.warnings);
    for (const c of out.solutions) {
      c.validation = verify(c, input);
      allCandidates.push(c);
      perStrategy[si].candidatesProduced += 1;
      if (c.validation?.accepted) perStrategy[si].accepted += 1;
    }
  }

  // PHASE 16 pipeline:
  //   1. Score each candidate with diversity against the
  //      already-kept set; keep iff it passes the dedupe threshold.
  //   2. After the kept set is final, the score is diversity-aware
  //      and used as the sort key.
  //   3. PHASE 17 — for the comparison report, we ALSO want a
  //      per-strategy top score. We compute it on the candidates
  //      that survived per strategy, using the kept set as the
  //      diversity prior. The per-strategy top score is taken from
  //      ALL candidates (not just kept ones), so a strategy whose
  //      best candidate was deduped-out of the final kept set
  //      still reports its true top score in the comparison block.
  const branchesById = new Map((model.branches ?? []).map((b) => [b.id, b]));
  // First pass: score every candidate against an empty prior, so
  // each candidate gets a "raw" score without diversity influence.
  // We use this raw score to identify each strategy's top candidate.
  for (const c of allCandidates) {
    c._rawScore = score(c, { ...model, strategy: findStrategy(c.strategyId, strategies) }, []);
    const ps = perStrategy.find((p) => p.strategyId === c.strategyId);
    if (ps) {
      if (ps.topScore == null || c._rawScore.overallScore > ps.topScore) {
        ps.topScore = c._rawScore.overallScore;
        ps.topSolution = c;
      }
    }
  }
  // Second pass: keep candidates into the bounded kept set, with
  // diversity-aware scoring.
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

  // PHASE 17 — for each kept candidate, attach the structural
  // diversity breakdown against the rest of the kept set. This is
  // a tie-breaker in the final sort: when two candidates have the
  // same `overallScore`, the one with the higher structural
  // diversity wins.
  for (const c of kept) {
    let bestStruct = { teacherDay: 0, sessionMix: 0, overall: 0 };
    for (const k of kept) {
      if (k === c) continue;
      const sd = structuralDiversity(c, k, branchesById);
      if (sd.overall > bestStruct.overall) bestStruct = sd;
    }
    c.structuralDiversity = bestStruct;
  }

  // Final sort: by overallScore DESC, then by structural diversity
  // overall DESC, then by strategyId for stability.
  kept.sort((a, b) => {
    if (b.score.overallScore !== a.score.overallScore) {
      return b.score.overallScore - a.score.overallScore;
    }
    if ((b.structuralDiversity?.overall ?? 0) !== (a.structuralDiversity?.overall ?? 0)) {
      return (b.structuralDiversity?.overall ?? 0) - (a.structuralDiversity?.overall ?? 0);
    }
    return String(a.strategyId).localeCompare(String(b.strategyId));
  });

  for (const c of kept) {
    c.explanation = explainCandidate(c, { ...model, strategy: findStrategy(c.strategyId, strategies) });
    cache.put(c);
  }

  // PHASE 17 — also put the per-strategy top solutions in the cache
  // (when they are not in `kept`), so the caller can fetch them by
  // id and inspect the winner strategy's top candidate.
  for (const p of perStrategy) {
    if (p.topSolution && !kept.some((k) => k.id === p.topSolution.id)) {
      p.topSolution.explanation = explainCandidate(p.topSolution, { ...model, strategy: findStrategy(p.topSolution.strategyId, strategies) });
      cache.put(p.topSolution);
    }
  }

  // Build the A/B/C comparison report. Each entry carries the
  // per-strategy audit and, when the strategy's top candidate is
  // NOT in the final kept set, the top candidate's id so the
  // caller can fetch it from the cache.
  const comparison = perStrategy.map((p) => ({
    strategyId: p.strategyId,
    candidatesProduced: p.candidatesProduced,
    accepted: p.accepted,
    topScore: p.topScore,
    topSolutionId: p.topSolution ? p.topSolution.id : null,
    topSolutionInKept: p.topSolution ? kept.some((k) => k.id === p.topSolution.id) : false,
  }));
  // Mark the winner: highest topScore. Tie-break by accepted count.
  let winner = null;
  for (const p of comparison) {
    if (p.topScore == null) continue;
    if (
      winner == null ||
      p.topScore > (comparison.find((x) => x.strategyId === winner).topScore) ||
      (p.topScore === (comparison.find((x) => x.strategyId === winner).topScore) &&
        p.accepted > (comparison.find((x) => x.strategyId === winner).accepted))
    ) {
      winner = p.strategyId;
    }
  }
  if (winner) {
    for (const p of comparison) {
      if (p.strategyId === winner) p.winner = true;
    }
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
    comparison,
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

function emptyComparison() {
  return [];
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
  return { ok: true, written: false, deprecated: true, successor: '/api/schedules/commit', reason: 'Deprecated inspection-only commit; no schedule is persisted. Use /api/schedules/commit.', solution: sol };
}

function clampRequest(n) {
  // PHASE 29 — the vocabulary is shared with the generation layer
  // and the AI Strategy Layer via strategies.js.
  return ALLOWED_CANDIDATE_COUNTS.includes(n) ? n : ALLOWED_CANDIDATE_COUNTS[2];
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
