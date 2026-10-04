// PHASE 28 — real-data audit driver (read-only).
//
// Produces the numbers recorded in
// `docs/PHASE_28_GLOBAL_SCORING_SELECTION.md`:
//
//   1. Candidate pool at count = 3 / 5 / 10.
//   2. Per-candidate score vector for the count=10 pool.
//   3. Phase 27 ranking vs Phase 28 global ranking (diff).
//   4. Timing for the scoring + selection layer only.
//
// The script never mutates the input and never writes files.

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { STRATEGY_C } from '../src/domain/strategies.js';
import { generateSolutions } from '../src/domain/multi-solution.js';
import {
  selectFinalSolutions,
  scorePool,
  DIMENSION_CATALOG,
  listActiveDimensions,
  validateWeights,
  GLOBAL_SCORING_DEFAULTS,
} from '../src/domain/global-scoring.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { compareOptimizationCandidates } from '../src/domain/comparator.js';
import { diversity as slotDiversity, structuralDiversity } from '../src/domain/diversity.js';

const SEED = 0xC0FFEE;

function loadInput() {
  const full = loadFromLegacySaplich();
  return { ...full.scheduling, strategy: STRATEGY_C };
}

function generate(input, count, perSolveTimeBudgetMs) {
  return generateSolutions(input, {
    count,
    seed: SEED,
    perSolveTimeBudgetMs,
    overallTimeBudgetMs: 60_000,
  });
}

function minMax(values) {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { min: null, max: null };
  return { min: Math.min(...finite), max: Math.max(...finite) };
}

// ---------------------------------------------------------------------------
// 1. Candidate pool at count = 3 / 5 / 10
// ---------------------------------------------------------------------------

function poolSection() {
  const lines = [];
  for (const [count, budget] of [[3, 2000], [5, 1500], [10, 1000]]) {
    const input = loadInput();
    const gen = generate(input, count, budget);
    const candidates = gen.solutions.map((s) => s.candidate);
    const t0 = Date.now();
    const sel = selectFinalSolutions(candidates, { count, input });
    const selectMs = Date.now() - t0;

    const slotDivs = [];
    for (let i = 0; i < sel.solutions.length; i++) {
      for (let j = i + 1; j < sel.solutions.length; j++) {
        slotDivs.push(slotDiversity(sel.solutions[i].candidate, sel.solutions[j].candidate));
      }
    }
    const structDivs = sel.solutions.slice(1).map((s) => s.diversity.overall);

    lines.push({
      count,
      requested: gen.diagnostics.requested,
      produced: gen.diagnostics.produced,
      scored: candidates.length,
      selected: sel.solutions.length,
      generationMs: gen.diagnostics.generationMs,
      selectMs,
      minSlotDiversity: minMax(slotDivs).min,
      avgSlotDiversity: slotDivs.length > 0
        ? slotDivs.reduce((a, b) => a + b, 0) / slotDivs.length
        : null,
      minStructuralDiversity: minMax(structDivs).min,
      bestQualityScore: Math.max(...sel.solutions.map((s) => s.qualityScore)),
      worstSelectedQualityScore: Math.min(...sel.solutions.map((s) => s.qualityScore)),
      bestGlobalScore: Math.max(...sel.solutions.map((s) => s.scoring.total)),
      worstSelectedGlobalScore: Math.min(...sel.solutions.map((s) => s.scoring.total)),
    });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// 2. Per-candidate score vector (count = 10)
// ---------------------------------------------------------------------------

function scoreVectorSection() {
  const input = loadInput();
  const gen = generate(input, 10, 1000);
  const candidates = gen.solutions.map((s) => s.candidate);
  // Map candidate reference -> Phase 27 ms-* id. The selection
  // layer REORDERS the pool, so index alignment is not valid;
  // object identity is.
  const msIdByCandidate = new Map();
  for (const s of gen.solutions) msIdByCandidate.set(s.candidate, s.id);
  const sel = selectFinalSolutions(candidates, { count: 10, input });
  return sel.solutions.map((s) => ({
    rank: s.rank,
    solutionId: msIdByCandidate.get(s.candidate) ?? null,
    candidateId: s.candidate.id,
    qualityScore: s.qualityScore,
    globalScore: s.scoring.total,
    workloadSpread: s.metrics?.workloadSpread ?? null,
    maxTeacherLoad: s.metrics?.maxTeacherLoad ?? null,
    workloadStdev: s.metrics?.workloadStdev ?? null,
    preferencePenalty: s.metrics?.preferencePenalty ?? null,
    slotDiversityToBest: s.diversity.slotToBest,
    structuralDiversity: s.diversity.overall,
    selected: s.selected,
    hardViolations: s.scoring.hardViolations,
  }));
}

// ---------------------------------------------------------------------------
// 3. Phase 27 ranking vs Phase 28 ranking
// ---------------------------------------------------------------------------

/**
 * The Phase 27 `ms-*` id is the multi-solution-unique id that
 * lives on the Phase 27 WRAPPER, not on the candidate itself.
 * The underlying `candidate.id` stays the opaque solver id
 * (`sol-*`), and Phase 27 §5 notes that `sol-*` is NOT unique
 * across iterations. The audit therefore carries the `ms-*` id
 * alongside the raw `sol-*` id so every row is traceable.
 */
function rankingDiffSection(generateCount, selectCount) {
  const input = loadInput();
  const gen = generate(input, generateCount, 1000);

  // Phase 27 view: the order returned by generateSolutions.
  const phase27 = gen.solutions.map((s) => ({
    msId: s.id,
    candidateId: s.candidate.id,
    phase27Rank: s.rank,
    qualityScore: s.qualityScore,
    workloadSpread: s.candidate.metrics?.workloadSpread ?? null,
  }));

  // Phase 28 view: select `selectCount` from the pool of
  // `generateCount`. The selection layer REORDERS the pool, so
  // the `ms-*` id is resolved by candidate object identity, not
  // by position.
  const candidates = gen.solutions.map((s) => s.candidate);
  const msIdByCandidate = new Map();
  for (const s of gen.solutions) msIdByCandidate.set(s.candidate, s.id);
  const sel = selectFinalSolutions(candidates, { count: selectCount, input });

  const phase28 = sel.solutions.map((s) => ({
    msId: msIdByCandidate.get(s.candidate) ?? null,
    candidateId: s.candidate.id,
    phase28Rank: s.rank,
    qualityScore: s.qualityScore,
    globalScore: s.scoring.total,
    workloadSpread: s.metrics?.workloadSpread ?? null,
    slotDivToBest: s.diversity.slotToBest,
  }));

  // Which candidates did the global scorer REJECT?
  const selectedRefs = new Set(sel.solutions.map((s) => s.candidate));
  const notSelected = gen.solutions
    .filter((s) => !selectedRefs.has(s.candidate))
    .map((s, i) => ({
      msId: s.id,
      qualityScore: s.qualityScore,
      workloadSpread: s.candidate.metrics?.workloadSpread ?? null,
    }));

  return { generateCount, selectCount, phase27, phase28, notSelected };
}

// ---------------------------------------------------------------------------
// 4. Dimension catalog status
// ---------------------------------------------------------------------------

function dimensionSection() {
  const input = loadInput();
  const active = new Set(listActiveDimensions(input).map((d) => d.id));
  return DIMENSION_CATALOG.map((d) => ({
    id: d.id,
    direction: d.direction,
    defaultWeight: d.defaultWeight,
    active: active.has(d.id),
  }));
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function main() {
  console.log('==================================================');
  console.log('PHASE 28 — GLOBAL SCORING + FINAL SELECTION AUDIT');
  console.log('==================================================');
  console.log('');

  console.log('--- Weight validation ---');
  const wv = validateWeights(GLOBAL_SCORING_DEFAULTS.weights);
  console.log('default weights valid :', wv.ok);
  console.log('default weights       :', JSON.stringify(GLOBAL_SCORING_DEFAULTS.weights));
  console.log('');

  console.log('--- Dimension catalog status (real data) ---');
  for (const d of dimensionSection()) {
    console.log(
      `  ${d.id.padEnd(22)} ${d.direction.padEnd(9)} w=${String(d.defaultWeight).padEnd(5)} ${d.active ? 'ACTIVE' : 'INACTIVE'}`,
    );
  }
  console.log('');

  console.log('--- Candidate pool (count = 3 / 5 / 10) ---');
  const pools = poolSection();
  for (const p of pools) {
    console.log(
      `  count=${String(p.count).padEnd(3)} produced=${p.produced} scored=${p.scored} selected=${p.selected} ` +
      `genMs=${p.generationMs} selectMs=${p.selectMs}`,
    );
    console.log(
      `     minSlotDiv=${p.minSlotDiversity?.toFixed(4)} avgSlotDiv=${p.avgSlotDiversity?.toFixed(4)} ` +
      `minStruct=${p.minStructuralDiversity?.toFixed(4)}`,
    );
    console.log(
      `     bestQuality=${p.bestQualityScore?.toFixed(4)} worstQuality=${p.worstSelectedQualityScore?.toFixed(4)} ` +
      `bestGlobal=${p.bestGlobalScore?.toFixed(4)} worstGlobal=${p.worstSelectedGlobalScore?.toFixed(4)}`,
    );
  }
  console.log('');

  console.log('--- Top solutions (count = 10) ---');
  const vectors = scoreVectorSection();
  console.log('  rank solutionId        candId            qual    global  spread  max   stdev  pref   slotDiv  structDiv');
  for (const v of vectors) {
    console.log(
      `  ${String(v.rank).padEnd(4)} ${String(v.solutionId).padEnd(17)} ${String(v.candidateId).padEnd(17)} ` +
      `${v.qualityScore.toFixed(4)}  ${v.globalScore.toFixed(4)}  ` +
      `${String(v.workloadSpread).padEnd(6)}  ${String(v.maxTeacherLoad).padEnd(4)}  ` +
      `${Number(v.workloadStdev).toFixed(3)}  ${Number(v.preferencePenalty).toFixed(3)}  ` +
      `${v.slotDiversityToBest.toFixed(4)}  ${v.structuralDiversity.toFixed(4)}`,
    );
  }
  console.log('');

  // The ranking diff is only meaningful when the selection has
  // to actually CHOOSE (selectCount < generateCount). We use
  // generate 10 → select 3 so the global scorer has to drop
  // seven candidates and the ordering of the survivors can
  // differ from the Phase 27 comparator order.
  for (const [genCount, selCount] of [[10, 3], [10, 5]]) {
    console.log(`--- Phase 27 vs Phase 28 ranking (generate ${genCount} -> select ${selCount}) ---`);
    const diff = rankingDiffSection(genCount, selCount);
    console.log('  Phase 27 (comparator order, first 6):');
    for (const r of diff.phase27.slice(0, 6)) {
      console.log(`    #${r.phase27Rank} ${r.msId}  qual=${r.qualityScore.toFixed(4)} spread=${r.workloadSpread}`);
    }
    console.log(`  Phase 28 (global-score + diversity order, ${diff.phase28.length} selected):`);
    for (const r of diff.phase28) {
      console.log(`    #${r.phase28Rank} ${r.msId}  qual=${r.qualityScore.toFixed(4)} global=${r.globalScore.toFixed(4)} spread=${r.workloadSpread} slotDivToBest=${r.slotDivToBest.toFixed(4)}`);
    }
    console.log(`  Not selected (${diff.notSelected.length}):`);
    for (const r of diff.notSelected) {
      console.log(`    --    ${r.msId}  qual=${r.qualityScore.toFixed(4)} spread=${r.workloadSpread}`);
    }
    console.log('');
  }

  // Sanity: every selected solution is still evaluator-accepted.
  const input = loadInput();
  const gen = generate(input, 10, 1000);
  const sel = selectFinalSolutions(gen.solutions.map((s) => s.candidate), { count: 10, input });
  let allAccepted = true;
  for (const s of sel.solutions) {
    const ev = evaluateCandidate(s.candidate, input);
    if (!ev.summary.accepted) allAccepted = false;
  }
  console.log('--- Feasibility re-verification ---');
  console.log('  independent evaluator accepted for all selected :', allAccepted);
  console.log('  diagnostics.h13                                  :', sel.diagnostics.h13);
  console.log('  diagnostics.h14                                  :', sel.diagnostics.h14);
  console.log('  scoring time (ms)                                :', sel.diagnostics.scoringTimeMs);
  console.log('  total selection time (ms)                        :', sel.diagnostics.totalTimeMs);
  console.log('');
  console.log('==================================================');
  console.log('DONE');
  console.log('==================================================');
}

main();
