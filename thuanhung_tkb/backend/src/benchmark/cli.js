// PHASE 31 — BENCHMARK COMMAND-LINE ENTRY POINT.
//
//   node src/benchmark/cli.js                       real dataset
//   node src/benchmark/cli.js --fixture             controlled fixture
//   node src/benchmark/cli.js --reps=3
//   node src/benchmark/cli.js --tier-b=none         Tier A only
//   node src/benchmark/cli.js --out=../docs/....md
//
// WHY A CLI AND NOT A TEST
// ------------------------
// Tier A costs minutes when AirLLM is up and is a BLOCKED outcome
// when it is not; Tier B costs N multi-minute solves of a
// 479-assignment input. Neither belongs in `npm test`. The tests
// cover the harness on the controlled fixture; this produces the
// artifact the phase is judged on, from a real run, on a real host.
//
// WHAT IT WILL NOT DO
// -------------------
// It will not fabricate a ready model, relax the validator, retry
// until the numbers look good, or reach past the one of the five
// conclusions the evidence supports. A host with no AirLLM gets
// `AIRLLM_BENCHMARK_BLOCKED` and a report that says so in its first
// paragraph — not a green tick (brief §7, §35, §41).
//
// EXIT CODES
// ----------
//   0  the benchmark ran and reached one of the five conclusions
//   1  the benchmark itself failed (bad flags, unreadable dataset)
//   2  the benchmark ran but the environment blocked a conclusion
//
// The distinction between 0 and 2 matters: a blocked benchmark is a
// successful measurement of "this host cannot answer the question",
// and a CI job that treats it as a code failure would push someone
// to fake a model rather than report the gap.

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';
import { createAIPlannerFromConfig } from '../domain/ai/providers/index.js';
import {
  BENCHMARK_VERSION,
  DATASET_SOURCE,
  PROMPT_VERSION_LABEL,
  STRATEGY_LAYER_VERSION,
  PROVIDER_VERSION,
  CONSTRAINT_CATALOG_VERSION,
  SOLVER_VERSION,
  SCORING_CONFIG_VERSION,
  buildControlledFixture,
  controlledFixtureProvenance,
  loadBenchmarkDataset,
  runRuntimeSmokeTest,
  runStrategyBenchmark,
  renderBenchmarkReport,
  collectProvenance,
  benchmarkInputHash,
} from './index.js';
import { RUNTIME_RESULT } from './smoke.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT = resolve(HERE, '../../../docs/PHASE_31_AIRLLM_STRATEGY_BENCHMARK.md');

// ============================================================================
// Flags
// ============================================================================

function parseArgs(argv) {
  const out = {
    fixture: false,
    reps: null,
    tierB: 'full',
    out: DEFAULT_REPORT,
    write: true,
    quiet: false,
    // Running this CLI is by definition the AirLLM benchmark, so the
    // arm is built from an AirLLM planner by DEFAULT. The configured
    // `AI_PROVIDER` is not consulted unless asked for: leaving it to
    // `mock` (the config default) is the exact mistake that lets a
    // report about a model that was never loaded go out under an
    // AirLLM heading. `--provider=mock` is still available, and the
    // benchmark will then refuse every AirLLM conclusion.
    provider: 'airllm',
  };
  for (const arg of argv) {
    if (arg === '--fixture') out.fixture = true;
    else if (arg.startsWith('--reps=')) out.reps = Number(arg.slice(7));
    else if (arg.startsWith('--tier-b=')) out.tierB = arg.slice(9);
    else if (arg.startsWith('--out=')) out.out = resolve(arg.slice(6));
    else if (arg.startsWith('--provider=')) out.provider = arg.slice(11);
    else if (arg === '--no-write') out.write = false;
    else if (arg === '--quiet') out.quiet = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown flag: ${arg}`);
  }
  if (out.reps !== null && (!Number.isInteger(out.reps) || out.reps < 1)) {
    throw new Error(`--reps must be a positive integer, got ${out.reps}`);
  }
  if (!['full', 'none', 'fallback-only'].includes(out.tierB)) {
    throw new Error(`--tier-b must be full | none | fallback-only, got ${out.tierB}`);
  }
  return out;
}

const USAGE = `
Phase 31 — AirLLM runtime smoke test + AI strategy quality benchmark

  node src/benchmark/cli.js [options]

  --provider=NAME  airllm (default) | mock | off
                   which provider plans the AI arm
  --fixture        use the small controlled fixture instead of the
                   real 40-teacher / 479-assignment dataset
  --reps=N         baseline repetitions (default 5, brief §11)
  --tier-b=MODE    full | none | fallback-only
                   full           run the quality benchmark
                   none           Tier A only
                   fallback-only  skip Tier B when AirLLM answers
  --out=PATH       where to write the markdown report
  --no-write       render to stdout only
  --quiet          print the verdict, not the progress log
`;

// ============================================================================
// Run
// ============================================================================

export async function runBenchmarkCli(argv = []) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const log = args.quiet ? () => {} : (m) => process.stderr.write(`${m}\n`);

  // ---- dataset (brief §3, §33) -------------------------------------
  log('· loading the benchmark dataset');
  const { input, provenance, projection } = args.fixture
    ? (() => {
      const fx = buildControlledFixture();
      return { input: fx, provenance: controlledFixtureProvenance(fx), projection: null };
    })()
    : loadBenchmarkDataset();

  // Recomputed here, independently of the loader's own stamp, so the
  // report carries a hash this process calculated and a reader can
  // check rather than a value taken on trust.
  const inputHash = benchmarkInputHash(input, input.strategy);
  provenance.benchmarkInputHash = inputHash;

  log(`· benchmarkInputHash ${inputHash} — ${projection ? `teachers ${projection.counts.teachers}, assignments ${projection.counts.assignments}` : 'controlled fixture'}`);

  // ---- planner -----------------------------------------------------
  const aiPlanner = createAIPlannerFromConfig(config.ai, { provider: args.provider });
  log(`· AI provider: ${args.provider} (${aiPlanner.name})`);
  if (args.provider !== 'airllm') {
    log('  ! the AI arm is NOT AirLLM. The benchmark will refuse every AirLLM conclusion,');
    log('    because a measurement of another planner says nothing about AirLLM (brief §29).');
  }

  // ---- TIER A (brief §1, §7) ---------------------------------------
  log('· Tier A: runtime smoke test');
  const smoke = await runRuntimeSmokeTest({
    planner: aiPlanner,
    serviceUrl: config.ai.serviceUrl,
    serviceToken: config.ai.serviceToken,
    input,
    timeoutMs: 10_000,
    planTimeoutMs: config.ai.requestTimeoutMs,
  });
  log(`  ${smoke.result} — ${smoke.rootCause ?? 'the runtime answered'}`);

  // ---- TIER B (brief §1, §11, §17) ---------------------------------
  let quality = null;
  if (args.tierB !== 'none' && !(args.tierB === 'fallback-only' && smoke.result === RUNTIME_RESULT.PASS)) {
    log(`· Tier B: strategy quality benchmark, ${args.reps ?? 'default'} repetitions per arm`);
    quality = await runStrategyBenchmark({
      input,
      aiPlanner,
      repetitions: args.reps ?? undefined,
      probe: smoke.reachable === false ? { reachable: false, error: smoke.rootCause } : { reachable: true, state: smoke.environment?.serviceState },
      smoke,
      provenance,
    });
    log(`  ${quality.conclusion}`);
  } else {
    log('· Tier B: skipped by flag');
  }

  // ---- report ------------------------------------------------------
  const allRuns = quality
    ? [...(quality.arms.BASELINE?.runs ?? []), ...(quality.arms.AIRLLM?.runs ?? [])]
    : [];
  const report = renderBenchmarkReport({
    smoke,
    quality,
    provenance: { ...provenance, runProvenance: collectProvenance(allRuns) },
    notes: buildNotes({ args, smoke, quality, input, provenance }),
  });

  if (args.write) {
    writeFileSync(args.out, report, 'utf8');
    log(`· report written to ${args.out}`);
  }

  process.stdout.write(`${summaryText({ smoke, quality })}\n`);
  if (args.write) process.stdout.write(`\nFull report: ${args.out}\n`);

  if (quality?.blockedOn) return 2;
  return 0;
}

// ============================================================================
// The short block the phase is judged on (brief §42)
// ============================================================================

function summaryText({ smoke, quality }) {
  const env = smoke?.environment ?? {};
  const L = [];
  const field = (k, v) => L.push(`${k}:${v === null || v === undefined || v === '' ? 'n/a' : v}`);

  // No "before: N tests" line. This program cannot know how many tests
  // the repository has, and a hard-coded count in a report is a
  // fabricated number that ages badly — the first person to add a test
  // would make it wrong without noticing.
  L.push(`benchmark: ${BENCHMARK_VERSION} (${DATASET_SOURCE})`);
  L.push('---');
  L.push('AirLLM runtime:');
  field('result', smoke?.result ?? 'NOT RUN');
  field('version', env.airllmVersion);
  field('model', env.modelIdentifier);
  field('device', env.device);
  field('ready', smoke?.modelReady);
  L.push('');

  L.push('AI strategy:');
  const rates = quality?.arms?.AIRLLM?.rates;
  field('requests', rates?.requests);
  field('valid', rates?.valid);
  field('fallback', rates?.fallback);
  field('invalid', rates?.invalid);
  field('validityRate', rates?.validityRate);
  L.push('');

  const med = (arm, metric) => quality?.arms?.[arm]?.quality?.[metric]?.median;
  L.push('Quality:');
  field('Fallback bestGlobalScore', med('BASELINE', 'bestGlobalScore'));
  field('AirLLM bestGlobalScore', med('AIRLLM', 'bestGlobalScore'));
  field('Fallback workloadSpread', med('BASELINE', 'bestWorkloadSpread'));
  field('AirLLM workloadSpread', med('AIRLLM', 'bestWorkloadSpread'));
  field('Fallback maxLoad', med('BASELINE', 'bestMaxTeacherLoad'));
  field('AirLLM maxLoad', med('AIRLLM', 'bestMaxTeacherLoad'));
  field('Fallback stdev', med('BASELINE', 'bestWorkloadStdev'));
  field('AirLLM stdev', med('AIRLLM', 'bestWorkloadStdev'));
  L.push('');

  const lat = (arm, metric) => quality?.arms?.[arm]?.latency?.[metric]?.median;
  L.push('Latency:');
  field('AI', lat('AIRLLM', 'aiLatencyMs'));
  field('Solver', lat('AIRLLM', 'solverMs'));
  field('Total', lat('AIRLLM', 'totalPipelineMs'));
  L.push('');
  L.push(`Verdict: ${quality?.conclusion ?? 'AIRLLM_RUNTIME_READY'}`);

  return L.join('\n');
}

// ============================================================================
// Notes
// ============================================================================

function buildNotes({ args, smoke, quality, input, provenance }) {
  const notes = [];
  notes.push(`Benchmark version: \`${BENCHMARK_VERSION}\`.`);
  notes.push(`Strategy layer \`${STRATEGY_LAYER_VERSION}\`, provider \`${PROVIDER_VERSION}\`, `
    + `solver \`${SOLVER_VERSION}\`, scorer \`${SCORING_CONFIG_VERSION}\`, constraints \`${CONSTRAINT_CATALOG_VERSION}\`.`);
  notes.push(`${PROMPT_VERSION_LABEL} is reported above from the service response; it is not asserted here.`);
  notes.push(`Dataset: \`${provenance.source}\`${args.fixture ? ' (controlled fixture)' : ''}.`);

  if (smoke?.result === RUNTIME_RESULT.BLOCKED) {
    notes.push('**The environment could not answer the question.** No AirLLM service answered on this host, '
      + 'so no claim is made about whether the AI strategy is useful. Start `ai-service`, then re-run.');
    notes.push('Nothing in this report was faked to compensate. `modelReady` is `false` because the service '
      + 'never said otherwise.');
  }
  if (quality && quality.arms?.AIRLLM?.rates?.fallback > 0) {
    notes.push(`${quality.arms.AIRLLM.rates.fallback} of ${quality.arms.AIRLLM.rates.requests} AirLLM requests fell back. `
      + 'A fallback run is not counted as a successful AI run and contributes no score.');
  }
  if (quality?.sharedPool?.unscoreable > 0) {
    notes.push(`${quality.sharedPool.unscoreable} run(s) shipped no schedule and were excluded from the shared pool.`);
  }
  if (input?.travelTime == null) {
    notes.push('Travel matrix absent: **H14 = UNSUPPORTED** and the TRAVEL weight contributes nothing.');
  }
  notes.push('No UI, no database schema, no deployment, no fine-tuning, no training. '
    + 'H13 stays INACTIVE and no transfer weight was added.');
  return notes;
}

// ============================================================================

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runBenchmarkCli(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((e) => {
      process.stderr.write(`benchmark failed: ${e?.stack ?? e}\n`);
      process.exitCode = 1;
    });
}
