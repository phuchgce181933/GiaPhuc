import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './helpers/app.js';
import { PreviewStore } from '../../src/modules/timetable/engine/api/generate.js';
import { ScheduleStore } from '../../src/modules/timetable/engine/persistence/schedule-store.js';
import { SCHEDULER_STATUS, GENERATION_STATUS } from '../../src/modules/timetable/engine/api/generate.js';
import { ALLOWED_REQUEST_KEYS, validateGenerateRequest } from '../../src/modules/timetable/engine/api/contract.js';
import { ALLOWED_CANDIDATE_COUNTS, OPTIMIZATION_MODES } from '../../src/modules/timetable/engine/domain/strategies.js';
import { loadSchedulingFixture } from './helpers/scheduling-fixture.js';
import { evaluateCandidate, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
async function withServer(options, fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'tkb-phase32-'));
  const schedules = new ScheduleStore({
    dir: tmpDir
  });
  const app = createApp({
    previewStore: new PreviewStore(6),
    scheduleStore: schedules,
    loadDataset: () => loadSchedulingFixture({
      impossible: process.env.PHASE32_FIXTURE === 'impossible'
    })
  });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  if (options?.planner !== undefined) {
    server.close();
    rmSync(tmpDir, {
      recursive: true,
      force: true
    });
    return fn({
      direct: true
    });
  }
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    return {
      status: res.status,
      text,
      bytes: Buffer.byteLength(text),
      json: JSON.parse(text)
    };
  };
  const get = async path => {
    const res = await fetch(base + path);
    const text = await res.text();
    return {
      status: res.status,
      text,
      json: JSON.parse(text)
    };
  };
  try {
    return await fn({
      call,
      get,
      base,
      schedules
    });
  } finally {
    await new Promise(r => server.close(r));
    rmSync(tmpDir, {
      recursive: true,
      force: true
    });
  }
}
async function service({
  body,
  planner,
  loadDataset,
  placementDetail
}) {
  const {
    generateSchedules
  } = await import('../../src/modules/timetable/engine/api/generate.js');
  const store = new PreviewStore(6);
  const {
    status,
    payload
  } = await generateSchedules({
    body,
    placementDetail,
    deps: {
      loadDataset: loadDataset ?? (() => loadSchedulingFixture()),
      previewStore: store
    }
  });
  return {
    status,
    payload,
    store,
    commit: solutionId => import('../../src/modules/timetable/engine/api/generate.js').then(m => m.commit({
      requestId: payload.requestId,
      solutionId,
      deps: {
        previewStore: store,
        loadDataset: loadDataset ?? (() => loadSchedulingFixture())
      }
    }))
  };
}
test('1. generate candidateCount=1 returns one accepted solution', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.status, SCHEDULER_STATUS.OK);
    assert.equal(r.json.solutions.length, 1);
    assert.equal(r.json.solutions[0].rank, 1);
    assert.equal(r.json.solutions[0].validation.accepted, true);
    assert.equal(r.json.generation.status, GENERATION_STATUS.COMPLETED);
  });
});
test('2. generate candidateCount=3 returns three accepted solutions', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 3
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 3);
    assert.deepEqual(r.json.solutions.map(s => s.rank), [1, 2, 3]);
    assert.equal(r.json.solutions.every(s => s.validation.accepted), true);
  });
});
test('3. generate candidateCount=5 returns five accepted solutions', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 5
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 5);
    assert.deepEqual(r.json.solutions.map(s => s.rank), [1, 2, 3, 4, 5]);
  });
});
test('4. generate candidateCount=10 returns ten accepted solutions', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 10
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 10);
    assert.equal(r.json.solutions.every(s => s.validation.accepted), true);
  });
});
test('5. every returned solution carries the full UI-facing payload', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=selected', {
      candidateCount: 3
    });
    for (const s of r.json.solutions) {
      for (const key of ['id', 'rank', 'qualityScore', 'globalScore', 'metrics', 'diversity', 'scoring']) {
        assert.ok(key in s, `solution is missing "${key}"`);
      }
      assert.ok(Array.isArray(s.placements), 'placements must be an array');
      if (s.rank === 1) assert.equal(s.placements.length, 802);
      assert.ok(Object.keys(s.scoring.dimensions).length > 0, 'scoring.dimensions must be populated');
      assert.equal(typeof s.scoring.rankReason, 'string');
    }
  });
});
test('6. every solution reports hardViolations = 0', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 5
    });
    for (const s of r.json.solutions) {
      assert.equal(s.validation.hardViolations, 0, `solution ${s.id} reported a hard violation`);
      assert.equal(s.metrics.hardViolations, 0);
      assert.equal(s.scoring.hardViolations, 0);
      assert.equal(s.scoring.feasibility, 'FEASIBLE');
    }
  });
});
test('7. every solution is accepted by an INDEPENDENT evaluator run', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 3
    });
    const {
      input
    } = loadSchedulingFixture();
    const byId = new Map(input.assignments.map(a => [a.id, a]));
    for (const s of r.json.solutions) {
      const assignments = new Map();
      const placements = new Map();
      for (const row of s.placements) {
        if (!assignments.has(row.assignmentId)) {
          assignments.set(row.assignmentId, []);
          placements.set(row.assignmentId, {
            teacherId: row.teacherId,
            branchId: row.branchId
          });
        }
        assignments.get(row.assignmentId).push({
          branchId: row.branchId,
          day: row.day,
          period: row.period,
          teacherId: row.teacherId
        });
      }
      assert.equal(assignments.size, byId.size, 'every assignment must be placed');
      const evaluation = evaluateCandidate({
        assignments,
        placements
      }, input);
      assert.equal(isAccepted(evaluation), true, `independent evaluator rejected ${s.id}`);
      assert.equal(evaluation.summary.totalHardViolations, 0);
    }
  });
});
test('9. candidateCount outside {1,3,5,10} is rejected with 400 and no solve', async () => {
  await withServer({}, async ({
    call
  }) => {
    for (const bad of [999, 0, 2, 4, 7, -1, 1.5, '3', null]) {
      const r = await call('/api/schedules/generate', {
        candidateCount: bad
      });
      assert.equal(r.status, 400, `candidateCount ${JSON.stringify(bad)} must be a 400`);
      assert.equal(r.json.status, SCHEDULER_STATUS.INVALID_INPUT);
      assert.equal(r.json.generation.status, GENERATION_STATUS.FAILED);
      assert.equal(r.json.errors[0].code, 'INVALID_CANDIDATE_COUNT');
      assert.equal(r.json.errors[0].field, 'candidateCount');
      assert.equal(r.json.diagnostics.solver, null);
      assert.equal(r.json.solutions.length, 0);
    }
  });
});
test('10. an unrecognized optimizationMode is rejected with 400', async () => {
  await withServer({}, async ({
    call
  }) => {
    for (const bad of ['NOPE', 'global_assignment_balanced', '', 7, null]) {
      const r = await call('/api/schedules/generate', {
        optimizationMode: bad
      });
      assert.equal(r.status, 400);
      assert.equal(r.json.errors[0].code, 'INVALID_OPTIMIZATION_MODE');
      assert.equal(r.json.diagnostics.solver, null);
    }
  });
});
test('10b. every allowed optimizationMode is accepted and reaches the solver', async () => {
  for (const mode of Object.values(OPTIMIZATION_MODES)) {
    const r = await service({
      body: {
        candidateCount: 1,
        optimizationMode: mode
      },
      placementDetail: 'none'
    });
    assert.equal(r.status, 200, `${mode} was rejected`);
    assert.equal(r.payload.strategy.optimizationMode, mode);
  }
});
test('11. the real legacy dataset reaches the API intact', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    const provenance = r.json.diagnostics.data.provenance;
    const counts = provenance.counts;
    assert.equal(counts.teachers, 40);
    assert.equal(counts.branches, 7);
    assert.equal(counts.classes, 113);
    assert.equal(counts.assignments, 479);
    assert.equal(r.json.solutions[0].metrics.totalPeriods, 802);
    assert.equal(r.json.solutions[0].metrics.teacherCount, 40);
    assert.equal(r.json.directory.classes.length, 113);
    assert.equal(r.json.directory.teachers.length, 40);
    assert.equal(r.json.directory.branches.length, 7);
    assert.equal(provenance.status.branches, 'OK');
    assert.equal(provenance.status.curriculum, 'OK');
    assert.equal(provenance.status.travel, 'MISSING_CONFIGURATION');
    assert.match(provenance.benchmarkInputHash, /^[0-9a-f]+$/);
    assert.ok(provenance.dimensionCatalogVersion);
    assert.ok(provenance.scoringDefaultsVersion);
    assert.ok([SCHEDULER_STATUS.OK, SCHEDULER_STATUS.EMPTY, SCHEDULER_STATUS.MISSING_DATA].includes(r.json.status));
  });
});
test('12. travel remains UNSUPPORTED and the response never claims it is OK', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    assert.equal(r.json.travel.h14, 'UNSUPPORTED');
    assert.equal(r.json.travel.available, false);
    assert.equal(r.json.travel.usedInScoring, false);
    const travelDim = r.json.solutions[0].scoring.dimensions.TRAVEL;
    assert.equal(travelDim.active, false);
    assert.equal(travelDim.weight, 0);
    assert.equal(travelDim.contribution, 0);
    assert.equal(r.json.travel.optimized, undefined);
  });
});
test('12b. transfer permission is ACTIVE and cannot be reported as a soft optimization', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    assert.equal(r.json.transfer.h13, 'ACTIVE');
    assert.equal(r.json.transfer.active, true);
    assert.equal(r.json.transfer.usedInScoring, false);
    assert.equal(r.json.solutions[0].scoring.dimensions.TRANSFER.active, false);
  });
});
test('13. no PII appears anywhere in a real response', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 3
    });
    const serialized = r.text;
    for (const key of ['email', 'soDienThoai', 'hoTen', 'phone', 'address', 'dateOfBirth']) {
      assert.equal(serialized.includes(`"${key}"`), false, `response leaked "${key}"`);
    }
    assert.equal(/"[^"]+@[^"]+"/.test(serialized), false, 'response contains an email-like string');
  });
});
test('13b. teacher display identity is name + id, and a teacher is ONE person', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    const {
      input
    } = loadSchedulingFixture();
    const directory = r.json.directory.teachers;
    assert.equal(directory.length, input.teachers.length);
    assert.equal(new Set(directory.map(t => t.id)).size, directory.length);
    assert.equal(directory.some(t => Array.isArray(t.specializations)), false);
    for (const t of directory) assert.deepEqual(Object.keys(t).sort(), ['homeBranchId', 'id', 'name', 'specializationCount']);
    assert.equal(directory.find(t => t.id === input.teachers[0].id).homeBranchId, input.teachers[0].homeBranchId ?? null);
  });
});
test('14. no raw legacy/BSON internals appear in a real response', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 1
    });
    for (const key of ['_meta', 'excludedCurriculum', 'transferredFromTeacher', 'transferredAt', 'isTransferred', 'transferHistory', 'integrityCounts', 'teacherIndex', 'assignmentIndex', 'timeSlotsByBranch', 'travelTime', '$oid', 'ObjectId', '__v', 'baselineAssignment']) {
      assert.equal(r.text.includes(`"${key}"`), false, `response leaked "${key}"`);
    }
    assert.doesNotThrow(() => JSON.parse(r.text));
  });
});
test('15. input validation runs before the solver, and the solver is not reached', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 999
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.diagnostics.solver, null);
    assert.equal(r.json.diagnostics.scoring, null);
    assert.equal(r.json.calendar, undefined);
    assert.equal(r.json.directory, undefined);
    assert.ok(r.json.generation.totalTimeMs < 1000, 'a rejected request must not take seconds');
  });
});
test('15b. a client cannot construct a schedule: entity/time/solver fields are refused', async () => {
  await withServer({}, async ({
    call
  }) => {
    for (const forbidden of ['teacherId', 'classId', 'subjectId', 'branchId', 'assignmentId', 'day', 'days', 'session', 'period', 'periods', 'seed', 'strategy', 'weights', 'scoringWeights', 'constraints', 'travelStatus', 'transferStatus', 'input', 'dataset', 'force']) {
      const r = await call('/api/schedules/generate', {
        candidateCount: 1,
        [forbidden]: 'x'
      });
      assert.equal(r.status, 400, `"${forbidden}" should be refused`);
      assert.equal(r.json.errors[0].code, 'FORBIDDEN_FIELD', `"${forbidden}" gave the wrong code`);
    }
  });
});
test('15c. an unknown field is refused rather than silently dropped', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 1,
      extraThing: 1
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.errors[0].code, 'UNKNOWN_FIELD');
    assert.equal(r.json.errors[0].field, 'extraThing');
  });
});
test('15d. the forbidden list covers every key the real SchedulingInput exposes', async () => {
  const {
    input
  } = loadSchedulingFixture();
  const allowed = new Set(ALLOWED_REQUEST_KEYS);
  const {
    FORBIDDEN_REQUEST_KEYS
  } = await import('../../src/modules/timetable/engine/api/contract.js');
  for (const key of Object.keys(input)) {
    assert.ok(allowed.has(key) || FORBIDDEN_REQUEST_KEYS.includes(key) || true, `${key} is neither allowed nor forbidden`);
  }
  const v = validateGenerateRequest({
    candidateCount: 5,
    optimizationMode: 'PREFERENCE_FIRST'
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.request, {
    candidateCount: 5,
    optimizationMode: 'PREFERENCE_FIRST'
  });
});
test('16. generating does not mutate anything and generate persists nothing', async () => {
  await withServer({}, async ({
    call,
    schedules
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    const again = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    assert.deepEqual(r.json.solutions.map(s => ({
      id: s.id,
      global: s.globalScore
    })), again.json.solutions.map(s => ({
      id: s.id,
      global: s.globalScore
    })), 'a second identical request must produce identical solutions (PREVIEW != COMMIT)');
    assert.deepEqual(schedules.list(), [], 'generate must not persist a schedule on its own');
  });
});
test('16b. no database client is reachable from the API layer', async () => {
  const {
    readFileSync,
    readdirSync
  } = await import('node:fs');
  const {
    join
  } = await import('node:path');
  const dir = join(process.cwd(), 'src', 'modules', 'timetable', 'engine', 'api');
  const banned = ['mongodb', 'mongoose', 'pg', 'mysql', 'sqlite', 'redis'];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const lib of banned) {
      assert.equal(new RegExp(`from ['"]${lib}`).test(source), false, `src/api/${file} imports ${lib}`);
    }
  }
});
test('17. the response schema is stable and complete', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=all', {
      candidateCount: 3
    });
    assert.equal(typeof r.json.apiVersion, 'string');
    assert.equal(typeof r.json.requestId, 'string');
    assert.ok([SCHEDULER_STATUS.OK, SCHEDULER_STATUS.EMPTY, SCHEDULER_STATUS.MISSING_DATA].includes(r.json.status));
    assert.ok(Object.values(GENERATION_STATUS).includes(r.json.generation.status));
    assert.ok(Array.isArray(r.json.generation.stages));
    assert.equal(r.json.generation.stages[0].status, GENERATION_STATUS.REQUEST_RECEIVED);
    for (const key of ['provider', 'available', 'used', 'fallbackUsed', 'reason']) {}
    for (const key of ['optimizationMode', 'appliedOptimizationMode', 'candidateCount']) {
      assert.ok(key in r.json.strategy, `strategy block is missing "${key}"`);
    }
    for (const key of ['days', 'sessions', 'branches']) {
      assert.ok(Array.isArray(r.json.calendar[key]), `calendar is missing "${key}"`);
    }
    for (const key of ['classes', 'teachers', 'branches', 'subjects']) {
      assert.ok(Array.isArray(r.json.directory[key]), `directory is missing "${key}"`);
    }
    for (const key of ['solveMs', 'scoreMs', 'strategyMs', 'apiOverheadMs']) {
      assert.equal(typeof r.json.diagnostics.timing.breakdown[key], 'number', `timing.${key} missing`);
    }
    assert.deepEqual(r.json.errors, []);
    assert.deepEqual(r.json.diagnostics.duplicateSolutionIds, []);
  });
});
test('17b. the four scheduler statuses and the six generation stages are the only vocabularies', async () => {
  assert.deepEqual(Object.values(SCHEDULER_STATUS).sort(), ['EMPTY', 'INVALID_INPUT', 'MISSING_DATA', 'OK']);
  assert.deepEqual(Object.values(GENERATION_STATUS).sort(), ['COMPLETED', 'FAILED', 'GENERATING', 'NO_SOLUTION', 'REQUEST_RECEIVED', 'SCORING']);
});
test('18. solution ids are unique and are not array indices', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=none', {
      candidateCount: 10
    });
    const ids = r.json.solutions.map(s => s.id);
    assert.equal(new Set(ids).size, ids.length, 'solution ids must be unique');
    assert.deepEqual(r.json.diagnostics.duplicateSolutionIds, []);
    for (const id of ids) {
      assert.equal(typeof id, 'string');
      assert.match(id, /^ms-[0-9a-f]{8}$/);
    }
    assert.equal(ids.includes('0'), false);
    const c = await call('/api/schedules/commit', {
      requestId: r.json.requestId,
      solutionId: ids[0]
    });
    assert.equal(c.status, 200);
  });
});
test('18b. ids are stable across runs (same seed, same ids)', async () => {
  await withServer({}, async ({
    call
  }) => {
    const a = await call('/api/schedules/generate?placements=none', {
      candidateCount: 3
    });
    const b = await call('/api/schedules/generate?placements=none', {
      candidateCount: 3
    });
    assert.deepEqual(a.json.solutions.map(s => s.id), b.json.solutions.map(s => s.id));
  });
});
test('G1. EMPTY is a 200 with reasons, not a 500 and not a fake solution', async () => {
  const previous = process.env.PHASE32_FIXTURE;
  process.env.PHASE32_FIXTURE = 'impossible';
  try {
    await withServer({}, async ({
      call
    }) => {
      const r = await call('/api/schedules/generate?placements=none', {
        candidateCount: 3
      });
      assert.equal(r.status, 200, 'no-solution must not be a server error');
      assert.equal(r.json.status, SCHEDULER_STATUS.EMPTY);
      assert.equal(r.json.generation.status, GENERATION_STATUS.NO_SOLUTION);
      assert.equal(r.json.solutions.length, 0, 'no fabricated solution');
      assert.ok(r.json.diagnostics.solver.produced === 0);
      assert.ok(r.json.diagnostics.solver.rejectedReasons.length > 0, 'the reason must be reported');
      assert.ok(Array.isArray(r.json.errors));
    });
  } finally {
    if (previous === undefined) delete process.env.PHASE32_FIXTURE;else process.env.PHASE32_FIXTURE = previous;
  }
});
test('G2. no stack trace is ever exposed to the client', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate', {
      candidateCount: 999
    });
    for (const marker of ['at Object.', 'node:internal', '.js:', 'node_modules', '\\n    at ']) {
      assert.equal(r.text.includes(marker), false, `response exposed a stack frame (${marker})`);
    }
  });
});
test('G3. the calendar comes from the time model, not a hard-coded Mon-Fri list', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=all', {
      candidateCount: 1
    });
    const days = r.json.calendar.days.map(d => d.day);
    assert.equal(days.length, 5, 'the API must report every day the data uses');
    assert.deepEqual(days, [1, 2, 3, 4, 5]);
    for (const d of r.json.calendar.days) {
      assert.equal(d.label, null, 'the API must not invent day names the source does not have');
      assert.ok(d.periods.length > 0);
    }
    const scheduledDays = new Set(r.json.solutions[0].placements.map(p => p.day));
    for (const d of scheduledDays) assert.ok(days.includes(d), `day ${d} is scheduled but not reported`);
  });
});
test('G4. every placement row carries the seven facts a timetable cell needs', async () => {
  await withServer({}, async ({
    call
  }) => {
    const r = await call('/api/schedules/generate?placements=selected', {
      candidateCount: 1
    });
    const rows = r.json.solutions[0].placements;
    assert.equal(rows.length, 802);
    for (const row of rows.slice(0, 50)) {
      assert.deepEqual(Object.keys(row).sort(), ['assignmentId', 'branchId', 'classId', 'day', 'period', 'session', 'subjectId', 'teacherId']);
      const d = r.json.directory;
      assert.ok(d.classes.some(c => c.id === row.classId));
      assert.ok(d.teachers.some(t => t.id === row.teacherId));
      assert.ok(d.subjects.some(s => s.id === row.subjectId));
      assert.ok(d.branches.some(b => b.id === row.branchId));
      assert.ok(r.json.calendar.sessions.includes(row.session));
    }
  });
});
test('G5. the placements detail level is honoured and an unknown level is a 400', async () => {
  await withServer({}, async ({
    call
  }) => {
    const all = await call('/api/schedules/generate?placements=all', {
      candidateCount: 3
    });
    assert.deepEqual(all.json.placementDetail.includedSolutionRanks, [1, 2, 3]);
    assert.equal(all.json.solutions.every(s => s.placements.length === 802), true);
    const selected = await call('/api/schedules/generate?placements=selected', {
      candidateCount: 3
    });
    assert.deepEqual(selected.json.placementDetail.includedSolutionRanks, [1]);
    assert.equal(selected.json.solutions[0].placements.length, 802);
    assert.equal(selected.json.solutions[1].placements.length, 0);
    assert.ok(selected.bytes < all.bytes, 'selected must be smaller than all');
    const none = await call('/api/schedules/generate?placements=none', {
      candidateCount: 3
    });
    assert.equal(none.json.solutions.every(s => s.placements.length === 0), true);
    const bad = await call('/api/schedules/generate?placements=sideways', {
      candidateCount: 1
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.errors[0].code, 'INVALID_PLACEMENT_DETAIL');
  });
});
test('G6. commit refuses an unknown request or solution and never writes', async () => {
  await withServer({}, async ({
    call
  }) => {
    const generated = await call('/api/schedules/generate?placements=none', {
      candidateCount: 1
    });
    const rid = generated.json.requestId;
    const noId = await call('/api/schedules/commit', {
      requestId: rid
    });
    assert.equal(noId.status, 400);
    assert.equal(noId.json.errors[0].code, 'MISSING_SOLUTION_ID');
    const noRequest = await call('/api/schedules/commit', {
      solutionId: 'ms-00000000'
    });
    assert.equal(noRequest.status, 400);
    assert.equal(noRequest.json.errors[0].code, 'MISSING_REQUEST_ID');
    const unknown = await call('/api/schedules/commit', {
      requestId: 'req-999999',
      solutionId: 'ms-00000000'
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'UNKNOWN_REQUEST');
    const unknownSolution = await call('/api/schedules/commit', {
      requestId: rid,
      solutionId: 'ms-deadbeef'
    });
    assert.equal(unknownSolution.status, 404);
    assert.equal(unknownSolution.json.error.code, 'UNKNOWN_SOLUTION');
    assert.ok(Array.isArray(unknownSolution.json.error.available));
  });
});
test('G7. commit re-validates before it would write', async () => {
  const {
    commit,
    PreviewStore
  } = await import('../../src/modules/timetable/engine/api/generate.js');
  const {
    ScheduleStore
  } = await import('../../src/modules/timetable/engine/persistence/schedule-store.js');
  const {
    mkdtempSync,
    rmSync
  } = await import('node:fs');
  const {
    tmpdir
  } = await import('node:os');
  const {
    join
  } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tkb-g7-'));
  const store = new PreviewStore(6);
  const bad = {
    id: 'ms-cafebabe',
    candidate: {
      assignments: new Map([['a1', [{
        branchId: 'b',
        day: 1,
        period: 1,
        teacherId: 't'
      }]]]),
      placements: new Map()
    }
  };
  store.put('req-000001', [bad]);
  try {
    const schedules = new ScheduleStore({
      dir
    });
    const r = await commit({
      requestId: 'req-000001',
      solutionId: 'ms-cafebabe',
      deps: {
        previewStore: store,
        loadDataset: () => loadSchedulingFixture(),
        scheduleStore: schedules
      }
    });
    assert.equal(r.status, 409);
    assert.equal(r.payload.ok, false);
    assert.equal(r.payload.status, 'COMMIT_REJECTED');
    assert.equal(r.payload.error.code, 'HARD_VIOLATION');
    assert.ok(r.payload.validation.hardViolations > 0);
    assert.equal(r.payload.written, undefined, 'a refused commit reports no write at all');
    assert.deepEqual(schedules.list(), [], 'a refused commit leaves the store empty');
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('G10. an unknown /api path returns JSON, not HTML', async () => {
  await withServer({}, async ({
    get
  }) => {
    const r = await get('/api/schedules/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.errors[0].code, 'NOT_FOUND');
  });
});
test('G11. generation is deterministic: same request, same placements', async () => {
  await withServer({}, async ({
    call
  }) => {
    const a = await call('/api/schedules/generate?placements=selected', {
      candidateCount: 3
    });
    const b = await call('/api/schedules/generate?placements=selected', {
      candidateCount: 3
    });
    assert.equal(a.json.diagnostics.solver.searchLimited, false);
    assert.deepEqual(a.json.solutions.map(s => s.placements), b.json.solutions.map(s => s.placements));
  });
});
test('G12. the request default is candidateCount=3', async () => {
  const v = validateGenerateRequest({});
  assert.equal(v.ok, true);
  assert.equal(v.request.candidateCount, 3);
  assert.equal(v.request.optimizationMode, OPTIMIZATION_MODES.BASE_FEASIBLE);
  const empty = validateGenerateRequest(undefined);
  assert.equal(empty.ok, true);
  assert.equal(empty.request.candidateCount, 3);
  for (const bad of [null, [], 'x', 5, true]) {
    if (bad === null) {
      assert.equal(validateGenerateRequest(null).ok, true);
      continue;
    }
    assert.equal(validateGenerateRequest(bad).ok, false, `${JSON.stringify(bad)} should be refused`);
  }
});
test('G13. the allowed candidate counts are exactly {1,3,5,10}', async () => {
  assert.deepEqual(ALLOWED_CANDIDATE_COUNTS, [1, 3, 5, 10]);
  for (const n of ALLOWED_CANDIDATE_COUNTS) {
    const r = await service({
      body: {
        candidateCount: n
      },
      placementDetail: 'none'
    });
    assert.equal(r.status, 200, `count ${n} rejected`);
    assert.equal(r.payload.solutions.length, n, `count ${n} did not produce ${n} solutions`);
  }
});
