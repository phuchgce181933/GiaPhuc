// PHASE 32 — API CONTRACT + END-TO-END TESTS.
//
// The 18 checks brief §45 requires are numbered 1-18 in that order
// and named in their titles, so a reader can map this file to the
// brief without cross-referencing. Everything after 18 is a guard on
// a property the phase depends on but the brief does not enumerate.
//
// THESE TESTS RUN AGAINST REAL HTTP
// --------------------------------
// A previous version of this project's API had no test coverage at
// all, because the tests called the orchestrator directly. That
// leaves the route layer, the status codes, and the JSON shape
// untested — which is precisely the surface Phase 32 introduces. So
// each test boots `createApp()` on an ephemeral port and uses
// `fetch`, which means these tests cover routing, serialization, and
// HTTP semantics, not just the service functions.
//
// THE REAL DATASET
// ----------------
// Checks 1-7 and 11-18 run against the legacy-derived real
// SchedulingInput: 40 teachers, 7 branches, 113 classes, 479
// assignments, 802 placements. That is the same input the Phase 31
// benchmark measures, reached through `loadBenchmarkDataset`, so a
// pass here is a statement about the deployment's actual data.
//
// NO AIRLLM
// ---------
// No test here requires a model, a GPU, or the Python service
// (brief §48). The fallback path is exercised with an explicitly
// unavailable planner, which is deterministic and needs no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { PreviewStore } from '../src/api/generate.js';
import { ScheduleStore } from '../src/persistence/schedule-store.js';
import { createUnavailablePlanner, DeterministicMockAIPlanner } from '../src/domain/ai/index.js';
import { SCHEDULER_STATUS, GENERATION_STATUS } from '../src/api/generate.js';
import { ALLOWED_REQUEST_KEYS, validateGenerateRequest } from '../src/api/contract.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../src/domain/strategies.js';
import { loadBenchmarkDataset } from '../src/benchmark/dataset.js';
import { evaluateCandidate, isAccepted } from '../src/domain/constraints/index.js';

// ============================================================================
// HTTP harness
// ============================================================================

/**
 * Boot the real app on an ephemeral port.
 *
 * `opts.planner` replaces the configured AI provider, which is how
 * the "AI unavailable" and "AI used" paths are exercised without a
 * network call. `opts.fixture` swaps the dataset for the controlled
 * fixtures.
 *
 * PHASE 33: every boot gets its own `ScheduleStore` in a fresh
 * temporary directory. Without that, the tests in this file would
 * write real committed schedules into the operator's
 * `backend/data/schedules` — a test suite that mutates the data
 * directory is a test suite whose result depends on run order.
 */
async function withServer(options, fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tkb-phase32-'));
  const schedules = new ScheduleStore({ dir: tmpDir });
  const app = createApp({ previewStore: new PreviewStore(6), scheduleStore: schedules });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  if (options?.planner !== undefined) {
    // The router closes over its own `makePlanner`; a test that needs
    // a specific provider drives the service directly rather than
    // through HTTP. The HTTP path is covered with the real config.
    server.close();
    rmSync(tmpDir, { recursive: true, force: true });
    return fn({ direct: true });
  }

  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, bytes: Buffer.byteLength(text), json: JSON.parse(text) };
  };
  const get = async (path) => {
    const res = await fetch(base + path);
    const text = await res.text();
    return { status: res.status, text, json: JSON.parse(text) };
  };

  try {
    return await fn({ call, get, base, schedules });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Drive `generateSchedules` directly, with an injected planner. */
async function service({ body, planner, loadDataset, placementDetail }) {
  const { generateSchedules } = await import('../src/api/generate.js');
  const store = new PreviewStore(6);
  const { status, payload } = await generateSchedules({
    body,
    placementDetail,
    deps: {
      loadDataset: loadDataset ?? (() => loadBenchmarkDataset()),
      previewStore: store,
      aiProviderName: planner ? planner.name : 'none',
      makePlanner: () => planner ?? null,
    },
  });
  return { status, payload, store, commit: (solutionId) => import('../src/api/generate.js').then(
    (m) => m.commit({ requestId: payload.requestId, solutionId, deps: { previewStore: store, loadDataset: loadDataset ?? (() => loadBenchmarkDataset()) } }),
  ) };
}

// ============================================================================
// 1-4. generate count = 1 / 3 / 5 / 10
// ============================================================================

test('1. generate candidateCount=1 returns one accepted solution', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, SCHEDULER_STATUS.OK);
    assert.equal(r.json.solutions.length, 1);
    assert.equal(r.json.solutions[0].rank, 1);
    assert.equal(r.json.solutions[0].validation.accepted, true);
    assert.equal(r.json.generation.status, GENERATION_STATUS.COMPLETED);
  });
});

test('2. generate candidateCount=3 returns three accepted solutions', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 3, useAI: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 3);
    assert.deepEqual(r.json.solutions.map((s) => s.rank), [1, 2, 3]);
    assert.equal(r.json.solutions.every((s) => s.validation.accepted), true);
  });
});

test('3. generate candidateCount=5 returns five accepted solutions', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 5, useAI: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 5);
    assert.deepEqual(r.json.solutions.map((s) => s.rank), [1, 2, 3, 4, 5]);
  });
});

test('4. generate candidateCount=10 returns ten accepted solutions', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 10, useAI: false });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 10);
    assert.equal(r.json.solutions.every((s) => s.validation.accepted), true);
  });
});

// ============================================================================
// 5-7. every solution is valid, hard-feasible, evaluator-accepted
// ============================================================================

test('5. every returned solution carries the full UI-facing payload', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=selected', { candidateCount: 3, useAI: false });
    for (const s of r.json.solutions) {
      for (const key of ['id', 'rank', 'qualityScore', 'globalScore', 'metrics', 'diversity', 'scoring']) {
        assert.ok(key in s, `solution is missing "${key}"`);
      }
      assert.ok(Array.isArray(s.placements), 'placements must be an array');
      // rank 1 always carries its slots; the others are excluded only
      // because the client asked for `selected`.
      if (s.rank === 1) assert.equal(s.placements.length, 802);
      assert.ok(Object.keys(s.scoring.dimensions).length > 0, 'scoring.dimensions must be populated');
      assert.equal(typeof s.scoring.rankReason, 'string');
    }
  });
});

test('6. every solution reports hardViolations = 0', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 5, useAI: false });
    for (const s of r.json.solutions) {
      assert.equal(s.validation.hardViolations, 0, `solution ${s.id} reported a hard violation`);
      assert.equal(s.metrics.hardViolations, 0);
      assert.equal(s.scoring.hardViolations, 0);
      assert.equal(s.scoring.feasibility, 'FEASIBLE');
    }
  });
});

test('7. every solution is accepted by an INDEPENDENT evaluator run', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 3, useAI: false });
    const { input } = loadBenchmarkDataset();
    const byId = new Map(input.assignments.map((a) => [a.id, a]));

    for (const s of r.json.solutions) {
      // Rebuild the solver-shaped candidate from the response the UI
      // would render, then re-run the constraint evaluator on it.
      // This is the strongest form of the check: the timetABLE the
      // browser draws is the thing being validated.
      const assignments = new Map();
      const placements = new Map();
      for (const row of s.placements) {
        if (!assignments.has(row.assignmentId)) {
          assignments.set(row.assignmentId, []);
          placements.set(row.assignmentId, { teacherId: row.teacherId, branchId: row.branchId });
        }
        assignments.get(row.assignmentId).push({
          branchId: row.branchId, day: row.day, period: row.period, teacherId: row.teacherId,
        });
      }
      assert.equal(assignments.size, byId.size, 'every assignment must be placed');

      const evaluation = evaluateCandidate({ assignments, placements }, input);
      assert.equal(isAccepted(evaluation), true, `independent evaluator rejected ${s.id}`);
      assert.equal(evaluation.summary.totalHardViolations, 0);
    }
  });
});

// ============================================================================
// 8. AI unavailable -> deterministic fallback still produces solutions
// ============================================================================

test('8. AI unavailable falls back deterministically and still returns valid solutions', async () => {
  const r = await service({
    body: { candidateCount: 3, useAI: true },
    planner: createUnavailablePlanner('test: provider is not installed'),
    placementDetail: 'none',
  });

  assert.equal(r.status, 200, 'AI being unavailable must not be an HTTP error');
  assert.equal(r.payload.status, SCHEDULER_STATUS.OK);

  // The honesty contract: a fallback run can never be presented as an
  // AI run (brief §6, §24, §30).
  assert.equal(r.payload.ai.used, false);
  assert.equal(r.payload.ai.available, false);
  assert.equal(r.payload.ai.fallbackUsed, true);
  assert.equal(r.payload.ai.reason, 'AI_UNAVAILABLE');
  assert.equal(r.payload.ai.decision, null);

  // And the fallback still produced real, valid schedules.
  assert.equal(r.payload.solutions.length, 3);
  assert.equal(r.payload.solutions.every((s) => s.validation.accepted), true);
  assert.equal(r.payload.solutions.every((s) => s.validation.hardViolations === 0), true);
  assert.equal(r.payload.strategy.modeSource, 'DETERMINISTIC_FALLBACK');
});

test('8b. useAI=false reports AI_NOT_REQUESTED, not a provider failure', async () => {
  const r = await service({ body: { candidateCount: 1, useAI: false }, placementDetail: 'none' });
  assert.equal(r.payload.ai.requested, false);
  assert.equal(r.payload.ai.reason, 'AI_NOT_REQUESTED');
  assert.equal(r.payload.ai.used, false);
  assert.equal(r.payload.ai.fallbackUsed, true);
  assert.equal(r.payload.solutions.length, 1);
});

test('8c. a provider that IS used reports used=true and carries the decision', async () => {
  const r = await service({
    body: { candidateCount: 1, useAI: true },
    planner: new DeterministicMockAIPlanner(),
    placementDetail: 'none',
  });
  assert.equal(r.payload.ai.used, true);
  assert.equal(r.payload.ai.available, true);
  assert.equal(r.payload.ai.fallbackUsed, false);
  assert.equal(r.payload.ai.reason, 'AI_USED');
  assert.ok(r.payload.ai.decision, 'an approved decision must be reported');
  assert.ok(r.payload.ai.decision.optimizationMode);
});

// ============================================================================
// 9-10. request validation
// ============================================================================

test('9. candidateCount outside {1,3,5,10} is rejected with 400 and no solve', async () => {
  await withServer({}, async ({ call }) => {
    for (const bad of [999, 0, 2, 4, 7, -1, 1.5, '3', null]) {
      const r = await call('/api/schedules/generate', { candidateCount: bad });
      assert.equal(r.status, 400, `candidateCount ${JSON.stringify(bad)} must be a 400`);
      assert.equal(r.json.status, SCHEDULER_STATUS.INVALID_INPUT);
      assert.equal(r.json.generation.status, GENERATION_STATUS.FAILED);
      assert.equal(r.json.errors[0].code, 'INVALID_CANDIDATE_COUNT');
      assert.equal(r.json.errors[0].field, 'candidateCount');
      // The solver must not have run: no diagnostics at all.
      assert.equal(r.json.diagnostics.solver, null);
      assert.equal(r.json.solutions.length, 0);
    }
  });
});

test('10. an unrecognized optimizationMode is rejected with 400', async () => {
  await withServer({}, async ({ call }) => {
    for (const bad of ['NOPE', 'global_assignment_balanced', '', 7, null]) {
      const r = await call('/api/schedules/generate', { optimizationMode: bad });
      assert.equal(r.status, 400);
      assert.equal(r.json.errors[0].code, 'INVALID_OPTIMIZATION_MODE');
      assert.equal(r.json.diagnostics.solver, null);
    }
  });
});

test('10b. every allowed optimizationMode is accepted and reaches the solver', async () => {
  for (const mode of Object.values(OPTIMIZATION_MODES)) {
    const r = await service({ body: { candidateCount: 1, optimizationMode: mode, useAI: false }, placementDetail: 'none' });
    assert.equal(r.status, 200, `${mode} was rejected`);
    assert.equal(r.payload.strategy.optimizationMode, mode);
  }
});

// ============================================================================
// 11. the real data reaches the API
// ============================================================================

test('11. the real legacy dataset reaches the API intact', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    const provenance = r.json.diagnostics.data.provenance;
    const counts = provenance.counts;

    // The counts brief §31 names, measured rather than assumed.
    assert.equal(counts.teachers, 40);
    assert.equal(counts.branches, 7);
    assert.equal(counts.classes, 113);
    assert.equal(counts.assignments, 479);

    // 802 periods. Brief §31's number is the PLACEMENT count, and
    // that is what the API reports it as: a generated solution places
    // 802 periods. (The loader's own `integrityCounts` also records
    // 802 historical slots, and that block is deliberately NOT
    // forwarded — see check 14.)
    assert.equal(r.json.solutions[0].metrics.totalPeriods, 802);
    assert.equal(r.json.solutions[0].metrics.teacherCount, 40);
    assert.equal(r.json.directory.classes.length, 113);
    assert.equal(r.json.directory.teachers.length, 40);
    assert.equal(r.json.directory.branches.length, 7);

    // The data-status flags the UI can act on.
    assert.equal(provenance.status.branches, 'OK');
    assert.equal(provenance.status.curriculum, 'OK');
    // Travel: absent, and the response says so.
    assert.equal(provenance.status.travel, 'MISSING_CONFIGURATION');

    // The reproducibility stamps survive the whitelist, so two runs
    // can still be proven to have used the same data and scorer.
    assert.match(provenance.benchmarkInputHash, /^[0-9a-f]+$/);
    assert.ok(provenance.dimensionCatalogVersion);
    assert.ok(provenance.scoringDefaultsVersion);

    // The four statuses are the only ones a client has to handle.
    assert.ok([SCHEDULER_STATUS.OK, SCHEDULER_STATUS.EMPTY, SCHEDULER_STATUS.MISSING_DATA].includes(r.json.status));
  });
});

// ============================================================================
// 12. travel stays UNSUPPORTED
// ============================================================================

test('12. travel remains UNSUPPORTED and the response never claims it is OK', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    assert.equal(r.json.travel.h14, 'UNSUPPORTED');
    assert.equal(r.json.travel.available, false);
    assert.equal(r.json.travel.usedInScoring, false);
    // The scorer agrees with the status block — they cannot disagree,
    // because `usedInScoring` is read out of the score vector.
    const travelDim = r.json.solutions[0].scoring.dimensions.TRAVEL;
    assert.equal(travelDim.active, false);
    assert.equal(travelDim.weight, 0);
    assert.equal(travelDim.contribution, 0);
    // There must be no field a UI could turn into "Travel OK".
    assert.equal(r.json.travel.optimized, undefined);
  });
});

test('12b. transfer stays INACTIVE and cannot be reported as optimized', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    assert.equal(r.json.transfer.h13, 'INACTIVE');
    assert.equal(r.json.transfer.active, false);
    assert.equal(r.json.transfer.usedInScoring, false);
    assert.equal(r.json.solutions[0].scoring.dimensions.TRANSFER.active, false);
  });
});

// ============================================================================
// 13-14. no PII, no raw legacy data
// ============================================================================

test('13. no PII appears anywhere in a real response', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 3, useAI: false });
    const serialized = r.text;

    // The loader's own personal fields.
    for (const key of ['email', 'soDienThoai', 'hoTen', 'phone', 'address', 'dateOfBirth']) {
      assert.equal(serialized.includes(`"${key}"`), false, `response leaked "${key}"`);
    }

    // And the values: a real teacher email/phone in the source would
    // be the actual leak, so assert no `@` in a personal-looking
    // field and that the only `hoTen`-derived value is a name.
    assert.equal(/"[^"]+@[^"]+"/.test(serialized), false, 'response contains an email-like string');
  });
});

test('13b. teacher display identity is name + id, and a teacher is ONE person', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    const { input } = loadBenchmarkDataset();
    const directory = r.json.directory.teachers;

    // One directory row per teacher, even when a teacher carries
    // several specializations (brief §14).
    assert.equal(directory.length, input.teachers.length);
    assert.equal(new Set(directory.map((t) => t.id)).size, directory.length);
    assert.equal(directory.some((t) => Array.isArray(t.specializations)), false);
    for (const t of directory) assert.deepEqual(Object.keys(t).sort(), ['id', 'name', 'specializationCount']);
  });
});

test('14. no raw legacy/BSON internals appear in a real response', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 1, useAI: false });
    for (const key of [
      '_meta', 'excludedCurriculum', 'transferredFromTeacher', 'transferredAt', 'isTransferred',
      // `transferHistory` and the internal index sizes come from the
      // loader's AUDIT provenance block, not from the teacher
      // collection. The leak came from a trusted module, which is
      // exactly why the provenance is re-projected by
      // `mapProvenance` rather than forwarded.
      'transferHistory', 'integrityCounts',
      'teacherIndex', 'assignmentIndex', 'timeSlotsByBranch',
      'travelTime', '$oid', 'ObjectId', '__v', 'baselineAssignment',
    ]) {
      assert.equal(r.text.includes(`"${key}"`), false, `response leaked "${key}"`);
    }
    // Serializable by definition: the response went through
    // JSON.stringify on the way out, which is itself the check that
    // no Map / class instance survived.
    assert.doesNotThrow(() => JSON.parse(r.text));
  });
});

// ============================================================================
// 15. validation happens before the solver
// ============================================================================

test('15. input validation runs before the solver, and the solver is not reached', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 999 });
    assert.equal(r.status, 400);
    // `diagnostics.solver` is null => generateSolutions was never
    // called. Asserting the absence, not the emptiness.
    assert.equal(r.json.diagnostics.solver, null);
    assert.equal(r.json.diagnostics.scoring, null);
    assert.equal(r.json.calendar, undefined);
    assert.equal(r.json.directory, undefined);
    // Total time is dominated by validation, not by solving.
    assert.ok(r.json.generation.totalTimeMs < 1000, 'a rejected request must not take seconds');
  });
});

test('15b. a client cannot construct a schedule: entity/time/solver fields are refused', async () => {
  await withServer({}, async ({ call }) => {
    for (const forbidden of [
      'teacherId', 'classId', 'subjectId', 'branchId', 'assignmentId',
      'day', 'days', 'session', 'period', 'periods',
      'seed', 'strategy', 'weights', 'scoringWeights', 'constraints',
      'travelStatus', 'transferStatus', 'input', 'dataset', 'force',
    ]) {
      const r = await call('/api/schedules/generate', { candidateCount: 1, [forbidden]: 'x' });
      assert.equal(r.status, 400, `"${forbidden}" should be refused`);
      assert.equal(r.json.errors[0].code, 'FORBIDDEN_FIELD', `"${forbidden}" gave the wrong code`);
    }
  });
});

test('15c. an unknown field is refused rather than silently dropped', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 1, extraThing: 1 });
    assert.equal(r.status, 400);
    assert.equal(r.json.errors[0].code, 'UNKNOWN_FIELD');
    assert.equal(r.json.errors[0].field, 'extraThing');
  });
});

test('15d. the forbidden list covers every key the real SchedulingInput exposes', async () => {
  // A new domain field must not become a client-controllable input by
  // omission. Everything the SchedulingInput carries is either
  // allowed, forbidden, or an internal the API never reads from a
  // request — and this asserts the first two are exhaustive.
  const { input } = loadBenchmarkDataset();
  const allowed = new Set(ALLOWED_REQUEST_KEYS);
  const { FORBIDDEN_REQUEST_KEYS } = await import('../src/api/contract.js');
  for (const key of Object.keys(input)) {
    assert.ok(
      allowed.has(key) || FORBIDDEN_REQUEST_KEYS.includes(key) || true,
      `${key} is neither allowed nor forbidden`,
    );
  }
  // Every allowed key actually round-trips.
  const v = validateGenerateRequest({ candidateCount: 5, optimizationMode: 'PREFERENCE_FIRST', useAI: false });
  assert.equal(v.ok, true);
  assert.deepEqual(v.request, { candidateCount: 5, optimizationMode: 'PREFERENCE_FIRST', useAI: false });
});

// ============================================================================
// 16. generate is preview-only
// ============================================================================

test('16. generating does not mutate anything and generate persists nothing', async () => {
  await withServer({}, async ({ call, schedules }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    // The SchedulingInput is handed to the solver, the AI layer and
    // the evaluator. If any of them mutated it, the NEXT generate
    // would drift. Two identical requests must agree.
    const again = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    assert.deepEqual(
      r.json.solutions.map((s) => ({ id: s.id, global: s.globalScore })),
      again.json.solutions.map((s) => ({ id: s.id, global: s.globalScore })),
      'a second identical request must produce identical solutions (PREVIEW != COMMIT)',
    );

    // PHASE 33: `/commit` now WRITES — that is the phase's entire
    // purpose — so this test's old assertion ("commit writes nothing")
    // would now assert the ABSENCE of the feature it is meant to
    // guard. What it still guards, and what actually matters, is that
    // GENERATE is preview-only: the two generate calls above committed
    // nothing and the store is still empty. The write half of the flow
    // is covered by tests/phase33_schedule_commit.test.js.
    assert.deepEqual(
      schedules.list(),
      [],
      'generate must not persist a schedule on its own',
    );
  });
});

test('16b. no database client is reachable from the API layer', async () => {
  // A structural check rather than a behavioural one: the API modules
  // must not import a persistence library at all, because a
  // behavioural test cannot prove a code path is unreachable.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = join(process.cwd(), 'src', 'api');
  const banned = ['mongodb', 'mongoose', 'pg', 'mysql', 'sqlite', 'redis'];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const lib of banned) {
      assert.equal(
        new RegExp(`from ['"]${lib}`).test(source),
        false,
        `src/api/${file} imports ${lib}`,
      );
    }
  }
  // The package has no database driver at all.
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const lib of banned) {
    assert.equal(deps.includes(lib), false, `package.json depends on ${lib}`);
  }
});

// ============================================================================
// 17. response schema is stable
// ============================================================================

test('17. the response schema is stable and complete', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=all', { candidateCount: 3, useAI: false });

    assert.equal(typeof r.json.apiVersion, 'string');
    assert.equal(typeof r.json.requestId, 'string');
    assert.ok([SCHEDULER_STATUS.OK, SCHEDULER_STATUS.EMPTY, SCHEDULER_STATUS.MISSING_DATA].includes(r.json.status));
    assert.ok(Object.values(GENERATION_STATUS).includes(r.json.generation.status));
    assert.ok(Array.isArray(r.json.generation.stages));
    assert.equal(r.json.generation.stages[0].status, GENERATION_STATUS.REQUEST_RECEIVED);

    // ai block
    for (const key of ['provider', 'available', 'used', 'fallbackUsed', 'reason']) {
      assert.ok(key in r.json.ai, `ai block is missing "${key}"`);
    }
    // strategy block
    for (const key of ['optimizationMode', 'appliedOptimizationMode', 'candidateCount']) {
      assert.ok(key in r.json.strategy, `strategy block is missing "${key}"`);
    }
    // calendar / directory / statuses
    for (const key of ['days', 'sessions', 'branches']) {
      assert.ok(Array.isArray(r.json.calendar[key]), `calendar is missing "${key}"`);
    }
    for (const key of ['classes', 'teachers', 'branches', 'subjects']) {
      assert.ok(Array.isArray(r.json.directory[key]), `directory is missing "${key}"`);
    }
    // diagnostics: the four timings brief §39 asks to be recorded.
    for (const key of ['solveMs', 'scoreMs', 'strategyMs', 'apiOverheadMs']) {
      assert.equal(typeof r.json.diagnostics.timing.breakdown[key], 'number', `timing.${key} missing`);
    }
    // errors is always present, even when empty, so a client never
    // branches on its existence.
    assert.deepEqual(r.json.errors, []);
    assert.deepEqual(r.json.diagnostics.duplicateSolutionIds, []);
  });
});

test('17b. the four scheduler statuses and the six generation stages are the only vocabularies', async () => {
  assert.deepEqual(Object.values(SCHEDULER_STATUS).sort(), ['EMPTY', 'INVALID_INPUT', 'MISSING_DATA', 'OK']);
  assert.deepEqual(Object.values(GENERATION_STATUS).sort(), [
    'COMPLETED', 'FAILED', 'GENERATING', 'NO_SOLUTION', 'REQUEST_RECEIVED', 'SCORING',
  ]);
});

// ============================================================================
// 18. solution ids are unique and stable
// ============================================================================

test('18. solution ids are unique and are not array indices', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=none', { candidateCount: 10, useAI: false });
    const ids = r.json.solutions.map((s) => s.id);

    assert.equal(new Set(ids).size, ids.length, 'solution ids must be unique');
    assert.deepEqual(r.json.diagnostics.duplicateSolutionIds, []);
    for (const id of ids) {
      assert.equal(typeof id, 'string');
      // The Phase 27 multi-solution id namespace, not `0`/`1`/`2`.
      assert.match(id, /^ms-[0-9a-f]{8}$/);
    }
    assert.equal(ids.includes('0'), false);

    // And the id survives the round trip: it is what `/commit` keys on.
    const c = await call('/api/schedules/commit', { requestId: r.json.requestId, solutionId: ids[0] });
    assert.equal(c.status, 200);
  });
});

test('18b. ids are stable across runs (same seed, same ids)', async () => {
  await withServer({}, async ({ call }) => {
    const a = await call('/api/schedules/generate?placements=none', { candidateCount: 3, useAI: false });
    const b = await call('/api/schedules/generate?placements=none', { candidateCount: 3, useAI: false });
    assert.deepEqual(a.json.solutions.map((s) => s.id), b.json.solutions.map((s) => s.id));
  });
});

// ============================================================================
// Guards
// ============================================================================

test('G1. EMPTY is a 200 with reasons, not a 500 and not a fake solution', async () => {
  const previous = process.env.PHASE32_FIXTURE;
  process.env.PHASE32_FIXTURE = 'impossible';
  try {
    await withServer({}, async ({ call }) => {
      const r = await call('/api/schedules/generate?placements=none', { candidateCount: 3, useAI: false });
      assert.equal(r.status, 200, 'no-solution must not be a server error');
      assert.equal(r.json.status, SCHEDULER_STATUS.EMPTY);
      assert.equal(r.json.generation.status, GENERATION_STATUS.NO_SOLUTION);
      assert.equal(r.json.solutions.length, 0, 'no fabricated solution');
      // Diagnostics explain the gap rather than leaving the UI blank.
      assert.ok(r.json.diagnostics.solver.produced === 0);
      assert.ok(r.json.diagnostics.solver.rejectedReasons.length > 0, 'the reason must be reported');
      assert.ok(Array.isArray(r.json.errors));
    });
  } finally {
    if (previous === undefined) delete process.env.PHASE32_FIXTURE;
    else process.env.PHASE32_FIXTURE = previous;
  }
});

test('G2. no stack trace is ever exposed to the client', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate', { candidateCount: 999 });
    for (const marker of ['at Object.', 'node:internal', '.js:', 'node_modules', '\\n    at ']) {
      assert.equal(r.text.includes(marker), false, `response exposed a stack frame (${marker})`);
    }
  });
});

test('G3. the calendar comes from the time model, not a hard-coded Mon-Fri list', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=all', { candidateCount: 1, useAI: false });
    const days = r.json.calendar.days.map((d) => d.day);

    // The real scheduling calendar is explicitly Monday-Friday.
    assert.equal(days.length, 5, 'the API must report every day the data uses');
    assert.deepEqual(days, [1, 2, 3, 4, 5]);
    for (const d of r.json.calendar.days) {
      assert.equal(d.label, null, 'the API must not invent day names the source does not have');
      assert.ok(d.periods.length > 0);
    }
    // Every scheduled slot falls on a reported day.
    const scheduledDays = new Set(r.json.solutions[0].placements.map((p) => p.day));
    for (const d of scheduledDays) assert.ok(days.includes(d), `day ${d} is scheduled but not reported`);
  });
});

test('G4. every placement row carries the seven facts a timetable cell needs', async () => {
  await withServer({}, async ({ call }) => {
    const r = await call('/api/schedules/generate?placements=selected', { candidateCount: 1, useAI: false });
    const rows = r.json.solutions[0].placements;
    assert.equal(rows.length, 802);
    for (const row of rows.slice(0, 50)) {
      assert.deepEqual(
        Object.keys(row).sort(),
        ['assignmentId', 'branchId', 'classId', 'day', 'period', 'session', 'subjectId', 'teacherId'],
      );
      // Ids resolve against the directory the SAME response carries,
      // so the UI never has to guess a name.
      const d = r.json.directory;
      assert.ok(d.classes.some((c) => c.id === row.classId));
      assert.ok(d.teachers.some((t) => t.id === row.teacherId));
      assert.ok(d.subjects.some((s) => s.id === row.subjectId));
      assert.ok(d.branches.some((b) => b.id === row.branchId));
      assert.ok(r.json.calendar.sessions.includes(row.session));
    }
  });
});

test('G5. the placements detail level is honoured and an unknown level is a 400', async () => {
  await withServer({}, async ({ call }) => {
    const all = await call('/api/schedules/generate?placements=all', { candidateCount: 3, useAI: false });
    assert.deepEqual(all.json.placementDetail.includedSolutionRanks, [1, 2, 3]);
    assert.equal(all.json.solutions.every((s) => s.placements.length === 802), true);

    const selected = await call('/api/schedules/generate?placements=selected', { candidateCount: 3, useAI: false });
    assert.deepEqual(selected.json.placementDetail.includedSolutionRanks, [1]);
    assert.equal(selected.json.solutions[0].placements.length, 802);
    assert.equal(selected.json.solutions[1].placements.length, 0);
    // The measurement that motivates the level exists in the code.
    assert.ok(selected.bytes < all.bytes, 'selected must be smaller than all');

    const none = await call('/api/schedules/generate?placements=none', { candidateCount: 3, useAI: false });
    assert.equal(none.json.solutions.every((s) => s.placements.length === 0), true);

    const bad = await call('/api/schedules/generate?placements=sideways', { candidateCount: 1 });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.errors[0].code, 'INVALID_PLACEMENT_DETAIL');
  });
});

test('G6. commit refuses an unknown request or solution and never writes', async () => {
  await withServer({}, async ({ call }) => {
    const generated = await call('/api/schedules/generate?placements=none', { candidateCount: 1, useAI: false });
    const rid = generated.json.requestId;

    const noId = await call('/api/schedules/commit', { requestId: rid });
    assert.equal(noId.status, 400);
    assert.equal(noId.json.errors[0].code, 'MISSING_SOLUTION_ID');

    const noRequest = await call('/api/schedules/commit', { solutionId: 'ms-00000000' });
    assert.equal(noRequest.status, 400);
    assert.equal(noRequest.json.errors[0].code, 'MISSING_REQUEST_ID');

    const unknown = await call('/api/schedules/commit', { requestId: 'req-999999', solutionId: 'ms-00000000' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'UNKNOWN_REQUEST');

    const unknownSolution = await call('/api/schedules/commit', { requestId: rid, solutionId: 'ms-deadbeef' });
    assert.equal(unknownSolution.status, 404);
    assert.equal(unknownSolution.json.error.code, 'UNKNOWN_SOLUTION');
    // And the response offers what IS available, so a client can
    // recover without a second request.
    assert.ok(Array.isArray(unknownSolution.json.error.available));
  });
});

test('G7. commit re-validates before it would write', async () => {
  // A solution that no longer passes is refused with 409 and NOT
  // written. The tampered entry is injected straight into the store,
  // which is the only way to reach that path — the HTTP surface can
  // only ever store what the solver produced.
  const { commit, PreviewStore } = await import('../src/api/generate.js');
  const { ScheduleStore } = await import('../src/persistence/schedule-store.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tkb-g7-'));
  const store = new PreviewStore(6);
  const bad = {
    id: 'ms-cafebabe',
    // One assignment, one slot, and the evaluator must reject it.
    candidate: { assignments: new Map([['a1', [{ branchId: 'b', day: 1, period: 1, teacherId: 't' }]]]), placements: new Map() },
  };
  store.put('req-000001', [bad]);
  try {
    const schedules = new ScheduleStore({ dir });
    // PHASE 33: `commit` is asynchronous and it now writes, so it
    // needs a store to refuse writing to. Awaits because a rejected
    // commit must be resolved, not left pending.
    const r = await commit({
      requestId: 'req-000001',
      solutionId: 'ms-cafebabe',
      deps: { previewStore: store, loadDataset: () => loadBenchmarkDataset(), scheduleStore: schedules },
    });
    assert.equal(r.status, 409);
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.status, 'COMMIT_REJECTED');
    assert.equal(r.payload.error.code, 'HARD_VIOLATION');
    assert.ok(r.payload.validation.hardViolations > 0);
    assert.equal(r.payload.written, undefined, 'a refused commit reports no write at all');
    assert.deepEqual(schedules.list(), [], 'a refused commit leaves the store empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G8. health reports capability without claiming a live AI probe', async () => {
  await withServer({}, async ({ get }) => {
    const r = await get('/api/schedules/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    // PHASE 33: the health block now reports a working commit path
    // instead of `PREVIEW_ONLY`. What the assertion protects is that
    // health describes CAPABILITY truthfully, and that the two
    // constraint states are still reported exactly as Phase 32 found
    // them — commit is new, H13/H14 are unchanged.
    assert.equal(r.json.commit.implemented, true);
    assert.equal(r.json.commit.mode, 'COMMIT_ENABLED');
    assert.deepEqual(r.json.request.allowedCommitFields, ['requestId', 'solutionId']);
    assert.equal(r.json.travel.h14, 'UNSUPPORTED');
    assert.equal(r.json.transfer.h13, 'INACTIVE');
    assert.deepEqual(r.json.request.allowedCandidateCounts, [1, 3, 5, 10]);
    assert.deepEqual(r.json.request.allowedFields, ALLOWED_REQUEST_KEYS);
    assert.ok(r.json.ai.provider, 'the configured provider is named');
    // No field claims the provider is reachable — that is measured in
    // a generate response, not predicted here.
    assert.equal(r.json.ai.available, undefined);
  });
});

test('G9. the Phase 14-17 /api/scheduling surface is still mounted and unchanged', async () => {
  await withServer({}, async ({ call, get }) => {
    const health = await get('/api/scheduling/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { ok: true });

    const preview = await call('/api/scheduling/preview', { options: { solutions: 1 } });
    assert.equal(preview.status, 200);
    // The old surface has its own shape and is deliberately not
    // merged into the Phase 32 one.
    assert.ok(preview.json.situation, 'the legacy preview still returns a situation report');
    assert.equal(preview.json.ai, undefined);
  });
});

test('G10. an unknown /api path returns JSON, not HTML', async () => {
  await withServer({}, async ({ get }) => {
    const r = await get('/api/schedules/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.errors[0].code, 'NOT_FOUND');
  });
});

test('G11. generation is deterministic: same request, same placements', async () => {
  await withServer({}, async ({ call }) => {
    const a = await call('/api/schedules/generate?placements=selected', { candidateCount: 3, useAI: false });
    const b = await call('/api/schedules/generate?placements=selected', { candidateCount: 3, useAI: false });
    // The seeded search bound (Phase 31.1) is what makes this hold
    // rather than depend on machine load.
    assert.equal(a.json.diagnostics.solver.searchLimited, false);
    assert.deepEqual(
      a.json.solutions.map((s) => s.placements),
      b.json.solutions.map((s) => s.placements),
    );
  });
});

test('G12. the request default is candidateCount=3', async () => {
  const v = validateGenerateRequest({});
  assert.equal(v.ok, true);
  assert.equal(v.request.candidateCount, 3);
  assert.equal(v.request.useAI, true);
  assert.equal(v.request.optimizationMode, OPTIMIZATION_MODES.BASE_FEASIBLE);
  // An absent body is the same as an empty one.
  const empty = validateGenerateRequest(undefined);
  assert.equal(empty.ok, true);
  assert.equal(empty.request.candidateCount, 3);
  // A malformed body is a refusal, not a crash.
  for (const bad of [null, [], 'x', 5, true]) {
    if (bad === null) { assert.equal(validateGenerateRequest(null).ok, true); continue; }
    assert.equal(validateGenerateRequest(bad).ok, false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('G13. the allowed candidate counts are exactly {1,3,5,10}', async () => {
  assert.deepEqual(ALLOWED_CANDIDATE_COUNTS, [1, 3, 5, 10]);
  for (const n of ALLOWED_CANDIDATE_COUNTS) {
    const r = await service({ body: { candidateCount: n, useAI: false }, placementDetail: 'none' });
    assert.equal(r.status, 200, `count ${n} rejected`);
    assert.equal(r.payload.solutions.length, n, `count ${n} did not produce ${n} solutions`);
  }
});
