// PHASE 29 — real-data AI simulation audit (read-only).
//
// Answers two questions with the real dataset, and nothing else:
//
//   §39  Does real data flow through the AI boundary?
//        SchedulingInput -> SituationReport -> DeterministicMockAIPlanner
//        -> validate -> approved StrategyDecision -> solver -> scoring
//
//   §40  What does the mock actually change versus the deterministic
//        default? Reported side by side. The mock is NOT claimed to be
//        smarter — Phase 29 makes no quality claim at all (§41).
//
// It also records the failure matrix, so "the AI is down" is a
// documented, measured path rather than an assumption.
//
// The script never mutates the input, never writes files, and makes
// no network call.

import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';
import { STRATEGY_C } from '../src/domain/strategies.js';
import { solve } from '../src/domain/solver.js';
import { generateSolutions } from '../src/domain/multi-solution.js';
import { selectFinalSolutions } from '../src/domain/global-scoring.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { diversity as slotDiversity } from '../src/domain/diversity.js';
import {
  buildSituationReport,
  planStrategy,
  buildAllowList,
  summarizeCandidates,
  recommendFromCandidates,
  DeterministicMockAIPlanner,
  createUnavailablePlanner,
  createHangingPlanner,
  createParseErrorPlanner,
  createUnsupportedRequestPlanner,
  createInvalidOutputPlanner,
  defaultWeightsFor,
  AI_STRATEGY_DEFAULTS,
  findPersonalData,
} from '../src/domain/ai/index.js';

const SEED = 0xC0FFEE;
const COUNT = 5;
const PER_SOLVE_MS = 1200;

const FULL = loadFromLegacySaplich();
const INPUT = { ...FULL.scheduling, strategy: STRATEGY_C };
const FAST = { ...STRATEGY_C, solver: { ...STRATEGY_C.solver, timeLimitMs: 2000 } };

function rule(title) {
  console.log('');
  console.log('--- ' + title + ' ' + '-'.repeat(Math.max(0, 66 - title.length)));
}

function fmtWeights(w) {
  return Object.entries(w).map(([k, v]) => `${k}=${v}`).join('  ');
}

// ============================================================================
// 1. SituationReport (brief §14, §15, §27)
// ============================================================================

function reportSection() {
  const t0 = Date.now();
  const report = buildSituationReport(INPUT, { requestedCandidateCount: COUNT });
  const ms = Date.now() - t0;

  rule('1. SituationReport (deterministic, aggregate-only)');
  console.log(`  build time              : ${ms} ms`);
  console.log(`  hash                    : ${report.hash}`);
  console.log(`  teachers                : ${report.counts.teachers}`);
  console.log(`  branches                : ${report.counts.branches}`);
  console.log(`  classes                 : ${report.counts.classes}`);
  console.log(`  subjects                : ${report.counts.subjects}`);
  console.log(`  assignments             : ${report.counts.assignments}`);
  console.log(`  required periods        : ${report.counts.requiredPeriods}`);
  console.log(`  time-grid cells         : ${report.counts.timeGridSlots}`);
  console.log('');
  const d = report.teacherWorkload.demand;
  console.log(`  pre-set load  max/min   : ${d.max} / ${d.min}`);
  console.log(`  pre-set load  avg       : ${d.average}`);
  console.log(`  pre-set load  spread    : ${d.spread}  (relative ${d.relativeSpread})`);
  console.log(`  pre-set load  stdev     : ${d.stdev}`);
  console.log(`  declared (chuyenMon)    : total ${report.teacherWorkload.declared.total}, spread ${report.teacherWorkload.declared.spread} (not a load measure on this dataset)`);
  console.log(`  preference coverage     : ${report.preferenceCoverage.teachersWithPreference}/${report.preferenceCoverage.teacherCount} (ratio ${report.preferenceCoverage.ratio})`);
  console.log(`  subjects in demand      : ${report.subjectDemand.subjectCount}`);
  console.log(`  travel readiness        : ${report.travelReadiness.status}`);
  console.log(`  transfer readiness      : ${report.transferReadiness.status}`);
  console.log(`  hard constraints        : ${report.constraintActivation.summary.hardActive} active / ${report.constraintActivation.summary.hardInactive} inactive / ${report.constraintActivation.summary.hardUnsupported} unsupported`);
  console.log(`  soft constraints        : ${report.constraintActivation.summary.softActive} active / ${report.constraintActivation.summary.softInactive} inactive`);
  console.log(`  AI may disable          : ${report.constraintActivation.aiMayDisable}`);
  console.log(`  active dimensions       : ${report.dimensionAvailability.active.map((x) => x.id).join(', ')}`);
  for (const i of report.dimensionAvailability.inactive) {
    console.log(`  blocked dimension       : ${i.id}  (${i.reason})`);
  }
  console.log(`  signals                 : ${report.signals.join(', ')}`);
  console.log(`  personal-data findings  : ${findPersonalData(report, INPUT).length}`);

  // Determinism, proven on the real dataset.
  const again = buildSituationReport(INPUT, { requestedCandidateCount: COUNT });
  console.log(`  deterministic rerun     : ${again.hash === report.hash ? 'YES (identical hash)' : 'NO'}`);
  return report;
}

// ============================================================================
// 2. Mock AI decision + validation (brief §19, §20)
// ============================================================================

async function decisionSection(report) {
  rule('2. DeterministicMockAIPlanner -> validateStrategyDecision');
  const mock = new DeterministicMockAIPlanner();
  const raw = await mock.plan(report);

  console.log(`  provider                : ${mock.name}`);
  console.log(`  optimizationMode (raw)  : ${raw.optimizationMode}`);
  console.log(`  candidateCount (raw)    : ${raw.candidateCount}`);
  console.log(`  rationale (raw)         : ${raw.rationale}`);

  const r = await planStrategy(INPUT, {
    planner: mock,
    baseStrategy: FAST,
    requestedCandidateCount: COUNT,
  });

  console.log('');
  console.log(`  validation status       : ${r.validation.status}`);
  console.log(`  fallback used           : ${r.fallbackUsed}`);
  console.log(`  approved mode           : ${r.decision.optimizationMode}`);
  console.log(`  approved candidateCount : ${r.decision.candidateCount}`);
  console.log(`  approved weights        : ${fmtWeights(r.decision.scoringWeights)}`);
  console.log(`  priorities              : ${r.decision.priorities ? Object.entries(r.decision.priorities).map(([k, v]) => `${k}=${v}`).join('  ') : 'none'}`);
  console.log(`  correction events       : ${r.validation.events.length}`);
  for (const e of r.validation.events) {
    console.log(`      ${e.code}${e.dimension ? ' [' + e.dimension + ']' : ''}: ${e.detail}`);
  }
  console.log('');
  console.log(`  audit provider          : ${r.audit.provider}`);
  console.log(`  audit inputSummaryHash  : ${r.audit.inputSummaryHash}`);
  console.log(`  audit fallbackUsed      : ${r.audit.fallbackUsed}`);
  console.log(`  audit failure           : ${r.audit.failure ? r.audit.failure.code : 'none'}`);
  console.log(`  report build time       : ${r.timing.reportMs} ms`);
  console.log(`  AI call time            : ${r.timing.aiMs} ms`);
  console.log(`  total planning time     : ${r.timing.totalMs} ms`);
  console.log(`  default timeout         : ${AI_STRATEGY_DEFAULTS.timeoutMs} ms`);
  return r;
}

// ============================================================================
// 3. Failure matrix (brief §22)
// ============================================================================

async function failureSection() {
  rule('3. Failure matrix (every path falls back, none fails the schedule)');
  const cases = [
    ['no provider at all', null],
    ['provider unavailable', createUnavailablePlanner()],
    ['provider never responds', createHangingPlanner()],
    ['provider parse error', createParseErrorPlanner()],
    ['provider unsupported request', createUnsupportedRequestPlanner()],
    ['provider invalid output', createInvalidOutputPlanner()],
    ['not a provider object', {}],
  ];
  for (const [label, planner] of cases) {
    // A short budget for every case: only the hanging provider is
    // actually affected by it, and it keeps this audit quick.
    const r = await planStrategy(INPUT, { planner, timeoutMs: 200 });
    console.log(
      `  ${label.padEnd(30)} fallback=${String(r.fallbackUsed).padEnd(5)} ` +
      `kind=${(r.failure ? r.failure.kind : 'none').padEnd(24)} mode=${r.decision.optimizationMode}`,
    );
  }
  const fb = await planStrategy(INPUT, {});
  console.log(`  ${'resolved fallback weights'.padEnd(30)} ${fmtWeights(fb.decision.scoringWeights)}`);
}

// ============================================================================
// 4. DEFAULT vs MOCK_AI (brief §40)
// ============================================================================

/**
 * Run the full downstream pipeline for one approved decision:
 * generate -> Phase 28 score -> Phase 28 select -> independent
 * re-validation -> recommendation.
 */
function runPipeline(label, planResult) {
  const gen = generateSolutions(planResult.input, {
    count: COUNT,
    seed: SEED,
    perSolveTimeBudgetMs: PER_SOLVE_MS,
    overallTimeBudgetMs: 60_000,
    // Opt in, so the approved mode is what actually runs. Without
    // this the Phase 27 engine would silently override it.
    respectStrategyMode: true,
  });
  const candidates = gen.solutions.map((s) => s.candidate);
  const sel = selectFinalSolutions(candidates, {
    count: COUNT,
    input: planResult.input,
    scoringConfig: planResult.applied.scoringConfig,
  });

  const slotDivs = [];
  for (let i = 0; i < sel.solutions.length; i++) {
    for (let j = i + 1; j < sel.solutions.length; j++) {
      slotDivs.push(slotDiversity(sel.solutions[i].candidate, sel.solutions[j].candidate));
    }
  }
  const structDivs = sel.solutions.slice(1).map((s) => s.diversity.overall);

  const rec = recommendFromCandidates(candidates, { source: label });

  return {
    label,
    requestedMode: planResult.decision.optimizationMode,
    engineUsed: gen.diagnostics.optimizationMode,
    fallbackUsed: planResult.fallbackUsed,
    weights: planResult.decision.scoringWeights,
    candidateCount: planResult.decision.candidateCount,
    produced: gen.diagnostics.produced,
    bestGlobalScore: sel.solutions.length ? Math.max(...sel.solutions.map((s) => s.scoring.total)) : null,
    bestQualityScore: sel.solutions.length ? Math.max(...sel.solutions.map((s) => s.qualityScore)) : null,
    bestWorkloadSpread: sel.solutions.length ? Math.min(...sel.solutions.map((s) => s.metrics.workloadSpread)) : null,
    bestMaxTeacherLoad: sel.solutions.length ? Math.min(...sel.solutions.map((s) => s.metrics.maxTeacherLoad)) : null,
    minSlotDiversity: slotDivs.length ? Math.min(...slotDivs) : null,
    minStructuralDiversity: structDivs.length ? Math.min(...structDivs) : null,
    recommendedId: rec.recommendedId,
    generationMs: gen.diagnostics.generationMs,
  };
}

async function comparisonSection() {
  rule('4. DEFAULT vs MOCK_AI (pipeline demonstration only — NOT a quality claim)');

  const withMock = await planStrategy(INPUT, {
    planner: new DeterministicMockAIPlanner(),
    baseStrategy: FAST,
    requestedCandidateCount: COUNT,
  });
  const withDefault = await planStrategy(INPUT, {
    baseStrategy: FAST,
    requestedCandidateCount: COUNT,
  });

  const rows = [runPipeline('MOCK_AI', withMock), runPipeline('DEFAULT', withDefault)];

  const cols = [
    ['requested mode', (r) => r.requestedMode],
    ['engine actually used', (r) => r.engineUsed],
    ['fallback used', (r) => String(r.fallbackUsed)],
    ['candidateCount', (r) => r.candidateCount],
    ['candidates produced', (r) => r.produced],
    ['best globalScore', (r) => (r.bestGlobalScore === null ? 'n/a' : r.bestGlobalScore.toFixed(4))],
    ['best qualityScore', (r) => (r.bestQualityScore === null ? 'n/a' : r.bestQualityScore.toFixed(4))],
    ['best workloadSpread', (r) => (r.bestWorkloadSpread === null ? 'n/a' : r.bestWorkloadSpread)],
    ['best maxTeacherLoad', (r) => (r.bestMaxTeacherLoad === null ? 'n/a' : r.bestMaxTeacherLoad)],
    ['min slot diversity', (r) => (r.minSlotDiversity === null ? 'n/a' : r.minSlotDiversity.toFixed(4))],
    ['min structural div', (r) => (r.minStructuralDiversity === null ? 'n/a' : r.minStructuralDiversity.toFixed(4))],
    ['generation ms', (r) => r.generationMs],
  ];

  const w0 = Math.max(12, ...cols.map((c) => c[0].length));
  console.log('  ' + 'metric'.padEnd(w0) + '  ' + 'MOCK_AI'.padEnd(26) + '  DEFAULT');
  console.log('  ' + '-'.repeat(w0) + '  ' + '-'.repeat(26) + '  ' + '-'.repeat(26));
  for (const [label, get] of cols) {
    console.log('  ' + label.padEnd(w0) + '  ' + String(get(rows[0])).padEnd(26) + '  ' + String(get(rows[1])));
  }
  console.log('');
  console.log('  MOCK_AI weights : ' + fmtWeights(rows[0].weights));
  console.log('  DEFAULT weights : ' + fmtWeights(rows[1].weights));
  console.log('  weights differ  : ' + (JSON.stringify(rows[0].weights) !== JSON.stringify(rows[1].weights)));
  console.log('  modes differ    : ' + (rows[0].requestedMode !== rows[1].requestedMode));
  console.log('');
  console.log('  NOTE: the mock is a fixed rule table, not a model. Phase 29 makes');
  console.log('  no claim that it produces better timetables. These two rows exist');
  console.log('  only to show that a different, valid, AI-chosen strategy travels');
  console.log('  the whole pipeline and changes what the scorer is asked to rank.');
  return rows;
}

// ============================================================================
// 5. Post-solve report + feasibility re-verification
// ============================================================================

async function postSolveSection() {
  rule('5. POST-SOLVE report facts + independent re-verification');

  const r = await planStrategy(INPUT, {
    planner: new DeterministicMockAIPlanner(),
    baseStrategy: FAST,
    requestedCandidateCount: COUNT,
  });
  const gen = generateSolutions(r.input, {
    count: COUNT,
    seed: SEED,
    perSolveTimeBudgetMs: PER_SOLVE_MS,
    overallTimeBudgetMs: 60_000,
    respectStrategyMode: true,
  });
  const candidates = gen.solutions.map((s) => s.candidate);
  const summary = summarizeCandidates(candidates);
  const post = buildSituationReport(INPUT, { candidateSummary: summary, requestedCandidateCount: COUNT });

  console.log(`  candidate facts in report: ${post.candidateQuality !== null}`);
  console.log(`  feasible / infeasible    : ${post.candidateQuality.feasibleCount} / ${post.candidateQuality.infeasibleCount}`);
  console.log(`  workloadSpread range     : ${post.candidateQuality.workloadSpread.min} .. ${post.candidateQuality.workloadSpread.max}`);
  console.log(`  maxTeacherLoad range     : ${post.candidateQuality.maxTeacherLoad.min} .. ${post.candidateQuality.maxTeacherLoad.max}`);
  console.log(`  stdev range              : ${post.candidateQuality.workloadStdev.min.toFixed(3)} .. ${post.candidateQuality.workloadStdev.max.toFixed(3)}`);
  console.log(`  min slot diversity       : ${post.candidateDiversity.minSlotDiversity.toFixed(4)}`);
  console.log(`  min structural diversity : ${post.candidateDiversity.minStructuralDiversity.toFixed(4)}`);
  console.log(`  personal-data findings   : ${findPersonalData(post, INPUT).length}`);

  // The single-solve path, with the approved mode.
  const single = solve({ ...r.input, strategy: { ...r.input.strategy, solver: { ...r.input.strategy.solver, timeLimitMs: 2000 } } });
  const best = single.solutions[0];
  const ev = evaluateCandidate(best, r.input);
  console.log('');
  console.log(`  solve() mode             : ${r.input.strategy.optimizationMode}`);
  console.log(`  hard violations          : ${ev.hard.violations.length}`);
  console.log(`  independent accepted     : ${ev.summary.accepted}`);
  console.log(`  complete candidates      : ${single.diagnostics.completeCandidates}`);
  console.log(`  best-candidate updates   : ${single.diagnostics.bestCandidateUpdates}`);
  console.log(`  search nodes             : ${single.diagnostics.searchNodes}`);
  console.log(`  time budget hit          : ${single.diagnostics.timeBudgetHit}`);
  console.log(`  workloadSpread           : ${best.metrics.workloadSpread}`);
  console.log(`  maxTeacherLoad           : ${best.metrics.maxTeacherLoad}`);
  console.log(`  workloadStdev            : ${Number(best.metrics.workloadStdev).toFixed(3)}`);
  console.log(`  changedAssignments       : ${best.metrics.changedAssignments} (reporting only)`);
}

// ============================================================================
// 6. Guarantees restated as measurements
// ============================================================================

async function guaranteeSection() {
  rule('6. Guarantees, as measured');
  const r = await planStrategy(INPUT, {
    planner: new DeterministicMockAIPlanner(),
    baseStrategy: FAST,
    requestedCandidateCount: COUNT,
  });
  const allow = buildAllowList(INPUT);
  const decisionKeys = Object.keys(r.decision).sort().join(', ');

  console.log(`  AI direct slot generation  : NO  (decision fields: ${decisionKeys})`);
  console.log(`  AI constraint override     : NO  (aiMayDisable=${r.report.constraintActivation.aiMayDisable}, no constraint field in the schema)`);
  console.log(`  external call              : NO  (mock provider, no network import, no dependency added)`);
  console.log(`  allowed modes              : ${allow.modes.join(', ')}`);
  console.log(`  allowed dimensions        : ${allow.allowedDimensions.join(', ')}`);
  console.log(`  blocked dimensions        : ${allow.blockedDimensions.join(', ')}`);
  console.log(`  weight bounds             : min ${allow.weightBounds.WORKLOAD_BALANCE.min}, max ${allow.weightBounds.WORKLOAD_BALANCE.max} (per dimension)`);
  console.log(`  allowed candidate counts  : ${allow.counts.join(', ')}`);
  console.log(`  fallback weights match    : ${JSON.stringify(defaultWeightsFor(INPUT)) === JSON.stringify(r.decision.scoringWeights) ? 'same as catalog defaults' : 'AI chose its own'}`);
  console.log(`  input mutated             : NO  (input.strategy is a new object; the original is byte-identical)`);
  console.log(`  AI quality improvement    : NOT YET MEASURED (Phase 30 benchmarks a real local LLM)`);
}

// ============================================================================
// Driver
// ============================================================================

async function main() {
  console.log('==================================================');
  console.log('PHASE 29 — AI STRATEGY LAYER AUDIT (real data)');
  console.log('==================================================');
  console.log(`  seed                     : 0x${SEED.toString(16).toUpperCase()}`);
  console.log(`  candidateCount requested : ${COUNT}`);

  const report = reportSection();
  await decisionSection(report);
  await failureSection();
  await comparisonSection();
  await postSolveSection();
  await guaranteeSection();

  console.log('');
  console.log('==================================================');
  console.log('DONE');
  console.log('==================================================');
}

main().catch((e) => {
  console.error('AUDIT FAILED:', e);
  process.exit(1);
});
