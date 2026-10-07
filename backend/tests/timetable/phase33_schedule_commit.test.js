import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './helpers/app.js';
import { PreviewStore, commit as commitService } from '../../src/modules/timetable/engine/api/generate.js';
import { COMMIT_STATUS } from '../../src/modules/timetable/engine/api/commit.js';
import { ScheduleStore, scheduleIdFor } from '../../src/modules/timetable/engine/persistence/schedule-store.js';
import { buildScheduleRows, compareRows, contentHash, normalizeReadback } from '../../src/modules/timetable/engine/persistence/schedule-record.js';
import { loadSchedulingFixture } from './helpers/scheduling-fixture.js';
import { evaluateCandidate, isAccepted, CATALOG_BY_ID, listHard } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { generateSolutions } from '../../src/modules/timetable/engine/domain/multi-solution.js';
const REAL = {
  teachers: 40,
  classes: 113,
  assignments: 479,
  periods: 802
};
let cachedFixture = null;
function fixture() {
  if (cachedFixture) return cachedFixture;
  const loaded = loadSchedulingFixture();
  const {
    input
  } = loaded;
  const byClass = new Map();
  for (const a of input.assignments) {
    if (!byClass.has(a.classId)) byClass.set(a.classId, []);
    byClass.get(a.classId).push(a);
  }
  const [, sameClass] = [...byClass.entries()].find(([, v]) => v.length >= 2);
  const branch = input.branches.find(b => b.id === sameClass[0].branchId);
  const day = branch.schoolDays.find(value => value !== 1) ?? branch.schoolDays[0];
  const period = branch.periods.find(value => !(day === 5 && value === 4)) ?? branch.periods[0];
  cachedFixture = {
    input,
    provenance: loaded.provenance,
    first: sameClass[0],
    second: sameClass[1],
    multiPeriod: input.assignments.find(a => a.requiredPeriods > 1),
    branchId: branch.id,
    day,
    period,
    teacherId: input.teachers[0].id,
    teacher: input.teachers[0]
  };
  return cachedFixture;
}
let cachedCandidate = null;
function realCandidate() {
  if (cachedCandidate) return copyCandidate(cachedCandidate);
  const {
    input
  } = fixture();
  const generated = generateSolutions(input, {
    perSolveTimeBudgetMs: 10_000,
    overallTimeBudgetMs: 60_000,
    maxSearchIterations: 12,
    respectStrategyMode: true,
    requireFeasibility: true,
    count: 1,
    seed: 0xC0FFEE
  });
  const candidate = generated.solutions[0]?.candidate;
  assert.ok(candidate, 'the solver produced a candidate for the real dataset');
  assert.equal(isAccepted(evaluateCandidate(candidate, input)), true, 'the baseline candidate is feasible');
  cachedCandidate = candidate;
  return copyCandidate(candidate);
}
function copyCandidate(src) {
  return {
    assignments: new Map([...src.assignments].map(([k, slots]) => [k, slots.map(s => ({
      ...s
    }))])),
    placements: new Map([...src.placements].map(([k, p]) => [k, {
      ...p
    }]))
  };
}
async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-'));
  const schedules = new ScheduleStore({
    dir
  });
  const previews = new PreviewStore(6);
  const app = createApp({
    previewStore: previews,
    scheduleStore: schedules,
    loadDataset: loadSchedulingFixture
  });
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return {
      status: res.status,
      json: JSON.parse(await res.text())
    };
  };
  const get = async path => {
    const res = await fetch(base + path);
    return {
      status: res.status,
      json: JSON.parse(await res.text())
    };
  };
  const raw = async (path, text) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: text
    });
    return {
      status: res.status,
      text: await res.text()
    };
  };
  const generate = async (body = {
    candidateCount: 3
  }) => call('/api/schedules/generate?placements=all', body);
  try {
    return await fn({
      call,
      get,
      raw,
      generate,
      schedules,
      previews,
      dir,
      base
    });
  } finally {
    await new Promise(r => server.close(r));
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}
function storedFiles(dir) {
  return readdirSync(dir).filter(n => n.endsWith('.json')).sort();
}
test('1. generate produces three accepted solutions from the real dataset', async () => {
  await withServer(async ({
    generate
  }) => {
    const r = await generate();
    assert.equal(r.status, 200);
    assert.equal(r.json.solutions.length, 3);
    assert.equal(r.json.diagnostics.data.provenance.counts.teachers, REAL.teachers);
    assert.equal(r.json.diagnostics.data.provenance.counts.classes, REAL.classes);
    assert.equal(r.json.diagnostics.data.provenance.counts.assignments, REAL.assignments);
    for (const s of r.json.solutions) {
      assert.equal(s.validation.accepted, true);
      assert.equal(s.validation.hardViolations, 0);
      assert.equal(s.placements.length, REAL.periods);
    }
  });
});
test('2. a solution is selected by id, and the id is the one the response carried', async () => {
  await withServer(async ({
    generate
  }) => {
    const r = await generate();
    const chosen = r.json.solutions[1];
    assert.equal(chosen.rank, 2);
    assert.match(chosen.id, /^ms-[0-9a-f]{8}$/);
    assert.equal(r.json.solutions.filter(s => s.id === chosen.id).length, 1);
  });
});
test('3. committing a valid solution returns 200 COMMITTED with a schedule id', async () => {
  await withServer(async ({
    generate,
    call,
    schedules
  }) => {
    const g = await generate();
    const solutionId = g.json.solutions[1].id;
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId
    });
    assert.equal(c.status, 200);
    assert.equal(c.json.status, COMMIT_STATUS.COMMITTED);
    assert.equal(c.json.ok, true);
    assert.equal(c.json.committed, true);
    assert.equal(c.json.written, true);
    assert.equal(c.json.duplicate, false);
    assert.equal(c.json.solutionId, solutionId);
    assert.match(c.json.scheduleId, /^sch-[0-9a-f]{16}$/);
    assert.equal(typeof c.json.committedAt, 'string');
    assert.ok(Date.parse(c.json.committedAt) > 0, 'committedAt is a real timestamp');
    assert.equal(schedules.list().length, 1);
    assert.deepEqual(storedFiles(schedules.dir).length, 1);
  });
});
test('4. the backend re-validates with the independent evaluator before writing', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    previews
  }) => {
    const f = fixture();
    const g = await generate();
    const good = g.json.solutions[0].id;
    const broken = {
      id: 'ms-deadbeef',
      solution: {
        id: 'ms-deadbeef',
        rank: 9
      },
      candidate: {
        assignments: new Map([[f.first.id, [{
          branchId: f.branchId,
          day: f.day,
          period: f.period
        }]], [f.second.id, [{
          branchId: f.branchId,
          day: f.day,
          period: f.period
        }]]]),
        placements: new Map([[f.first.id, {
          teacherId: f.first.teacherId,
          branchId: f.branchId
        }], [f.second.id, {
          teacherId: f.second.teacherId,
          branchId: f.branchId
        }]])
      }
    };
    previews.put('req-injected', [broken]);
    const bad = await call('/api/schedules/commit', {
      requestId: 'req-injected',
      solutionId: 'ms-deadbeef'
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.status, COMMIT_STATUS.REJECTED);
    assert.equal(bad.json.error.code, 'HARD_VIOLATION');
    assert.equal(bad.json.persisted, false);
    assert.equal(bad.json.written, undefined, 'a rejected commit reports no write at all');
    assert.ok(bad.json.validation.hardViolations > 0);
    assert.ok(bad.json.validation.reasons.some(r => r.includes('[H01]')), `expected an H01 reason, got ${JSON.stringify(bad.json.validation.reasons)}`);
    assert.deepEqual(schedules.list(), []);
    const ok = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: good
    });
    assert.equal(ok.status, 200);
    assert.equal(schedules.list().length, 1);
  });
});
test('5. the commit persists exactly 802 slots â€” the full real dataset', async () => {
  await withServer(async ({
    generate,
    call,
    schedules
  }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    assert.equal(c.json.slotCount, REAL.periods);
    assert.equal(c.json.readback.slots, REAL.periods);
    const record = schedules.read(c.json.scheduleId);
    assert.equal(record.slotCount, REAL.periods);
    assert.equal(record.slots.length, REAL.periods);
    assert.equal(record.status, 'COMMITTED');
    assert.equal(record.validated, true);
  });
});
test('6. reading the persisted schedule back returns 802 slots', async () => {
  await withServer(async ({
    generate,
    call,
    get,
    schedules
  }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[2].id
    });
    const scheduleId = c.json.scheduleId;
    const cold = new ScheduleStore({
      dir: schedules.dir
    });
    const raw = cold.read(scheduleId);
    assert.equal(raw.slots.length, REAL.periods);
    const overHttp = await get(`/api/schedules/committed/${scheduleId}/full`);
    assert.equal(overHttp.status, 200);
    assert.equal(overHttp.json.schedule.slots.length, REAL.periods);
    assert.equal(overHttp.json.schedule.contentHash, c.json.contentHash);
    const header = await get(`/api/schedules/committed/${scheduleId}`);
    assert.equal(header.status, 200);
    assert.equal(header.json.schedule.slots, undefined);
    assert.equal(header.json.schedule.slotCount, REAL.periods);
  });
});
test('7. the read-back schedule is semantically identical to the committed candidate', async () => {
  await withServer(async ({
    generate,
    call,
    schedules
  }) => {
    const g = await generate();
    const chosen = g.json.solutions[1];
    const expected = chosen.placements.map(p => ({
      assignmentId: p.assignmentId,
      classId: p.classId,
      subjectId: p.subjectId,
      teacherId: p.teacherId,
      branchId: p.branchId,
      day: p.day,
      session: p.session,
      period: p.period
    }));
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: chosen.id
    });
    const readBack = normalizeReadback(schedules.read(c.json.scheduleId));
    const diff = compareRows(expected, readBack);
    assert.equal(diff.equal, true, `read-back differs: ${JSON.stringify(diff)}`);
    assert.equal(diff.leftCount, REAL.periods);
    assert.equal(diff.rightCount, REAL.periods);
    assert.equal(diff.onlyInLeft.length, 0);
    assert.equal(diff.onlyInRight.length, 0);
    assert.equal(contentHash(readBack), c.json.contentHash);
  });
});
test('8. an invalid candidate is rejected and the store is byte-identical', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    previews,
    dir
  }) => {
    const f = fixture();
    const g = await generate();
    await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    const before = storedFiles(dir).map(n => `${n}:${schedules.read(n.slice(0, -5)).contentHash}`);
    previews.put('req-bad', [{
      id: 'ms-0000bad0',
      solution: {
        id: 'ms-0000bad0',
        rank: 1
      },
      candidate: {
        assignments: new Map([[f.multiPeriod.id, [{
          branchId: f.multiPeriod.branchId,
          day: 1,
          period: 1
        }]]]),
        placements: new Map([[f.multiPeriod.id, {
          teacherId: f.multiPeriod.teacherId,
          branchId: f.multiPeriod.branchId
        }]])
      }
    }]);
    const c = await call('/api/schedules/commit', {
      requestId: 'req-bad',
      solutionId: 'ms-0000bad0'
    });
    assert.equal(c.status, 409);
    assert.equal(c.json.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.json.persisted, false);
    assert.ok(c.json.validation.reasons.some(r => r.includes('[H05]')));
    const after = storedFiles(dir).map(n => `${n}:${schedules.read(n.slice(0, -5)).contentHash}`);
    assert.deepEqual(after, before, 'a rejected commit changed nothing on disk');
  });
});
test('9. a malformed commit request is refused with 4xx and writes nothing', async () => {
  await withServer(async ({
    generate,
    call,
    raw,
    schedules,
    dir
  }) => {
    const g = await generate();
    const rid = g.json.requestId;
    const sid = g.json.solutions[0].id;
    const cases = [['missing solutionId', {
      requestId: rid
    }], ['missing requestId', {
      solutionId: sid
    }], ['empty body', {}], ['solutionId is a number', {
      requestId: rid,
      solutionId: 3
    }], ['solutionId is an object', {
      requestId: rid,
      solutionId: {
        id: sid
      }
    }], ['requestId is a number', {
      requestId: 1,
      solutionId: sid
    }], ['solutionId is null', {
      requestId: rid,
      solutionId: null
    }], ['unknown extra field', {
      requestId: rid,
      solutionId: sid,
      note: 'hello'
    }]];
    for (const [label, body] of cases) {
      const r = await call('/api/schedules/commit', body);
      assert.equal(r.status, 400, `${label} should be 400, got ${r.status}`);
      assert.equal(r.json.ok, false, label);
      assert.ok(Array.isArray(r.json.errors) && r.json.errors.length > 0, label);
    }
    const notJson = await raw('/api/schedules/commit', '{not json');
    assert.equal(notJson.status, 400);
    const notObject = await raw('/api/schedules/commit', '["requestId"]');
    assert.equal(notObject.status, 400);
    assert.deepEqual(schedules.list(), [], 'no malformed request reached the store');
    assert.deepEqual(storedFiles(dir), []);
  });
});
test('10. an unknown request or solution is a 404 and writes nothing', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    dir
  }) => {
    const g = await generate();
    const unknownRequest = await call('/api/schedules/commit', {
      requestId: 'req-999999',
      solutionId: 'ms-00000000'
    });
    assert.equal(unknownRequest.status, 404);
    assert.equal(unknownRequest.json.error.code, 'UNKNOWN_REQUEST');
    const unknownSolution = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: 'ms-deadbeef'
    });
    assert.equal(unknownSolution.status, 404);
    assert.equal(unknownSolution.json.error.code, 'UNKNOWN_SOLUTION');
    assert.ok(Array.isArray(unknownSolution.json.error.available));
    assert.deepEqual(storedFiles(dir), []);
  });
});
test('11. a client cannot alter the candidate: a forged schedule is refused, not saved', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    dir
  }) => {
    const g = await generate();
    const sid = g.json.solutions[0].id;
    const forged = {
      requestId: g.json.requestId,
      solutionId: sid,
      teacherId: 'GV-9999',
      branchId: 'BR-07',
      day: 6,
      session: 'chieu',
      period: 7,
      placements: [{
        assignmentId: 'a-000001',
        teacherId: 'GV-9999',
        day: 6,
        period: 7
      }]
    };
    const refused = await call('/api/schedules/commit', forged);
    assert.equal(refused.status, 400, 'a body that carries a schedule is refused outright');
    assert.equal(refused.json.errors[0].code, 'FORBIDDEN_FIELD');
    assert.deepEqual(storedFiles(dir), [], 'nothing was written from a forged body');
    const ok = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: sid
    });
    assert.equal(ok.status, 200);
    const rows = schedules.read(ok.json.scheduleId).slots;
    assert.equal(rows.length, REAL.periods);
    assert.equal(rows.some(r => r.teacherId === 'GV-9999'), false, 'the forged teacher was not persisted');
    assert.equal(rows.some(r => r.day === 6 && r.period === 7 && r.teacherId === 'GV-9999'), false, 'the forged slot was not persisted');
    assert.equal(rows.some(r => r.branchId === 'BR-07'), false, 'the forged branch was not persisted');
  });
});
test('12. committing the same solution twice is safe and creates no duplicate', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    dir
  }) => {
    const g = await generate();
    const sid = g.json.solutions[0].id;
    const body = {
      requestId: g.json.requestId,
      solutionId: sid
    };
    const first = await call('/api/schedules/commit', body);
    const second = await call('/api/schedules/commit', body);
    const [third] = await Promise.all([call('/api/schedules/commit', body), call('/api/schedules/commit', body)]);
    for (const r of [first, second, third]) {
      assert.equal(r.status, 200);
      assert.equal(r.json.committed, true);
      assert.equal(r.json.scheduleId, first.json.scheduleId, 'every commit of one solution yields one id');
    }
    assert.equal(first.json.duplicate, false);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.status, COMMIT_STATUS.COMMITTED_DUPLICATE);
    assert.deepEqual(storedFiles(dir).length, 1);
    assert.equal(schedules.list().length, 1);
    assert.equal(schedules.list()[0].version, first.json.version, 'a replay does not mint a new version');
    assert.equal(schedules.read(first.json.scheduleId).contentHash, third.json.contentHash);
  });
});
test('12b. two concurrent commits of DIFFERENT solutions both land, neither overwrites', async () => {
  await withServer(async ({
    generate,
    call,
    schedules
  }) => {
    const g = await generate();
    const [a, b] = await Promise.all([call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    }), call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[1].id
    })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.json.scheduleId, b.json.scheduleId);
    const listed = schedules.list();
    assert.equal(listed.length, 2);
    assert.equal(schedules.read(a.json.scheduleId).slots.length, REAL.periods);
    assert.equal(schedules.read(b.json.scheduleId).slots.length, REAL.periods);
    const versions = listed.map(r => r.version).sort();
    assert.deepEqual(versions, [1, 2]);
    assert.equal(a.json.contentHash !== b.json.contentHash, true, 'two solutions are two timetables');
  });
});
test('13. a commit is all-or-nothing: the record appears complete or not at all', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    dir
  }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    const files = storedFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], `${c.json.scheduleId}.json`);
    assert.equal(files.some(n => n.startsWith('.tmp-')), false, 'no temp file survives a successful commit');
    const record = schedules.read(c.json.scheduleId);
    assert.equal(record.slots.length, c.json.slotCount);
    assert.equal(record.slots.length, REAL.periods);
    const reopened = new ScheduleStore({
      dir
    });
    assert.equal(reopened.read(c.json.scheduleId).slots.length, REAL.periods);
    assert.equal(reopened.read(c.json.scheduleId).contentHash, c.json.contentHash);
  });
});
test('14. a schedule naming an inactive teacher is rejected and never committed', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-inactive-'));
  try {
    const schedules = new ScheduleStore({
      dir
    });
    const previews = new PreviewStore(6);
    const input = {
      ...f.input,
      teachers: f.input.teachers.map(t => t.id === f.teacherId ? {
        ...t,
        trangThai: 'inactive'
      } : t)
    };
    previews.put('req-inactive', [{
      id: 'ms-inactive',
      solution: {
        id: 'ms-inactive',
        rank: 1
      },
      candidate: realCandidate()
    }]);
    const c = await commitService({
      requestId: 'req-inactive',
      solutionId: 'ms-inactive',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({
          input,
          provenance: f.provenance
        })
      }
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.written, undefined);
    assert.ok(c.payload.validation.reasons.some(r => r.includes('[H08]')), `expected an H08 reason, got ${JSON.stringify(c.payload.validation.reasons)}`);
    assert.deepEqual(schedules.list(), []);
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('14b. the placeholder teacher id is refused by the write path, not only by H08', async () => {
  const f = fixture();
  const candidate = realCandidate();
  candidate.placements.set(f.first.id, {
    teacherId: 'CN-TH',
    branchId: f.branchId
  });
  const evaluation = evaluateCandidate(candidate, f.input);
  assert.equal(isAccepted(evaluation), false, 'the catalog now checks the effective placement teacher');
  assert.ok(buildScheduleRows(candidate, f.input).warnings.some(warning => warning.code === 'INACTIVE_TEACHER'), 'the independent writer guard remains in place');
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-placeholder-'));
  try {
    const schedules = new ScheduleStore({
      dir
    });
    const previews = new PreviewStore(6);
    previews.put('req-placeholder', [{
      id: 'ms-placeholder',
      solution: {
        id: 'ms-placeholder',
        rank: 1
      },
      candidate
    }]);
    const c = await commitService({
      requestId: 'req-placeholder',
      solutionId: 'ms-placeholder',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({
          input: f.input,
          provenance: f.provenance
        })
      }
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.error.code, 'HARD_VIOLATION');
    assert.ok(c.payload.validation.reasons.some(r => r.includes('CN-TH')), `expected the placeholder refusal, got ${JSON.stringify(c.payload.validation.reasons)}`);
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('15. H14 is still UNSUPPORTED and commit does not claim travel was checked', async () => {
  await withServer(async ({
    generate,
    call,
    get
  }) => {
    const g = await generate();
    const health = await get('/api/schedules/health');
    assert.equal(health.json.travel.h14, 'UNSUPPORTED');
    assert.equal(g.json.travel.h14, 'UNSUPPORTED');
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    assert.equal(c.json.travel.h14, 'UNSUPPORTED');
    assert.equal(c.json.validation.constraintStatuses.H14, 'UNSUPPORTED');
  });
});
test('16. H13 permission is ACTIVE and commit validates it before persistence', async () => {
  await withServer(async ({
    generate,
    call,
    get
  }) => {
    const g = await generate();
    const health = await get('/api/schedules/health');
    assert.equal(health.json.transfer.h13, 'ACTIVE');
    assert.equal(g.json.transfer.h13, 'ACTIVE');
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    assert.equal(c.json.transfer.h13, 'ACTIVE');
    assert.equal(c.json.validation.constraintStatuses.H13, 'ACTIVE');
    assert.equal(c.json.validation.hardViolations, 0);
  });
});
test('18. generating stays preview-only: PREVIEW_ONLY survives as a generate-time fact', async () => {
  await withServer(async ({
    generate,
    call,
    get,
    schedules
  }) => {
    const g = await generate();
    assert.equal(g.json.persistence, undefined);
    assert.deepEqual(schedules.list(), []);
    const list = await get('/api/schedules/committed');
    assert.equal(list.json.count, 0);
    await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    const after = await get('/api/schedules/committed');
    assert.equal(after.json.count, 1);
    assert.equal(after.json.schedules[0].status, 'COMMITTED');
    assert.equal(after.json.schedules[0].slotCount, REAL.periods);
  });
});
test('19. a committed schedule is identifiable by id, by solution, and by content hash', async () => {
  await withServer(async ({
    generate,
    call,
    get,
    schedules
  }) => {
    const g = await generate();
    const chosen = g.json.solutions[1];
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: chosen.id
    });
    assert.equal(c.json.scheduleId, scheduleIdFor(g.json.requestId, chosen.id));
    const header = await get(`/api/schedules/committed/${c.json.scheduleId}`);
    assert.equal(header.json.schedule.solutionId, chosen.id);
    assert.equal(header.json.schedule.requestId, g.json.requestId);
    assert.equal(header.json.schedule.contentHash, c.json.contentHash);
    assert.equal(header.json.schedule.audit.sourceRank, chosen.rank);
    assert.equal(header.json.schedule.audit.sourceSolutionId, chosen.id);
    const missing = await get('/api/schedules/committed/sch-0000000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'UNKNOWN_SCHEDULE');
    const list = await get('/api/schedules/committed');
    assert.equal(list.json.schedules.length, 1);
    assert.equal(list.json.schedules[0].scheduleId, c.json.scheduleId);
  });
});
test('20. a committed schedule survives a fresh store, and the source data is never mutated', async () => {
  await withServer(async ({
    generate,
    call,
    schedules,
    dir
  }) => {
    const before = loadSchedulingFixture();
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    const committedHash = c.json.contentHash;
    const after = loadSchedulingFixture();
    assert.equal(after.provenance.benchmarkInputHash, before.provenance.benchmarkInputHash);
    assert.equal(after.provenance.datasetShapeHash, before.provenance.datasetShapeHash);
    assert.equal(after.provenance.scoringDefaultsVersion, before.provenance.scoringDefaultsVersion);
    assert.equal(after.provenance.dimensionCatalogVersion, before.provenance.dimensionCatalogVersion);
    assert.equal(after.input.assignments.length, before.input.assignments.length);
    assert.equal(after.input.teachers.length, before.input.teachers.length);
    assert.equal(listHard().length, 17);
    assert.equal(CATALOG_BY_ID.get('H01').code, 'H_CLASS_NO_DOUBLE_BOOK');
    const reopened = new ScheduleStore({
      dir
    });
    const record = reopened.read(c.json.scheduleId);
    assert.equal(record.slots.length, REAL.periods);
    assert.equal(contentHash(normalizeReadback(record)), committedHash);
    assert.equal(record.schemaVersion, 1);
  });
});
test('G1. a candidate carrying one unresolvable row is refused whole, not saved 802 of 803', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-unresolvable-'));
  try {
    const schedules = new ScheduleStore({
      dir
    });
    const previews = new PreviewStore(6);
    const candidate = realCandidate();
    candidate.assignments.set('not-a-real-assignment-id', [{
      branchId: f.branchId,
      day: f.day,
      period: f.period
    }]);
    candidate.placements.set('not-a-real-assignment-id', {
      teacherId: f.teacherId,
      branchId: f.branchId
    });
    previews.put('req-unresolvable', [{
      id: 'ms-unresolvable',
      solution: {
        id: 'ms-unresolvable',
        rank: 1
      },
      candidate
    }]);
    const c = await commitService({
      requestId: 'req-unresolvable',
      solutionId: 'ms-unresolvable',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({
          input: f.input,
          provenance: f.provenance
        })
      }
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.error.code, 'HARD_VIOLATION');
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.written, undefined);
    assert.ok(c.payload.validation.reasons.some(r => r.includes('UNKNOWN_ASSIGNMENT')));
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('G2. the commit re-checks feasibility without searching or re-ranking', async () => {
  await withServer(async ({
    generate,
    call
  }) => {
    const g = await generate();
    const chosen = g.json.solutions[0];
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: chosen.id
    });
    assert.equal(c.json.score.globalScore, chosen.globalScore);
    assert.equal(c.json.score.qualityScore, chosen.qualityScore);
    assert.equal(c.json.score.recheck.ran, true);
    assert.equal(c.json.score.recheck.searched, false);
    assert.equal(c.json.score.recheck.feasibility, 'FEASIBLE');
    assert.equal(c.json.score.recheck.hardViolations, 0);
    assert.equal(c.json.slotCount, chosen.placements.length);
  });
});
test('G3. the store is the only thing that writes, and generate cannot reach it', async () => {
  const {
    readFileSync,
    readdirSync
  } = await import('node:fs');
  const {
    join: pjoin
  } = await import('node:path');
  const apiDir = pjoin(process.cwd(), 'src', 'modules', 'timetable', 'engine', 'api');
  const files = readdirSync(apiDir).filter(f => f.endsWith('.js'));
  const importersOf = needle => files.filter(file => new RegExp(`from '\\.\\./persistence/${needle}\\.js'`).test(readFileSync(pjoin(apiDir, file), 'utf8'))).sort();
  assert.deepEqual(importersOf('schedule-store'), ['commit.js'], 'only the commit service uses the immutable record factory; persistence is injected');
  assert.deepEqual(importersOf('preview-record').includes('generate.js'), true, 'generate may reuse the lifecycle vocabulary');
  for (const store of ['preview-store', 'schedule-store', 'atomic-file']) {
    assert.equal(importersOf(store).includes('generate.js'), false, `generate must not import ${store}`);
  }
  for (const file of files) {
    const source = readFileSync(pjoin(apiDir, file), 'utf8');
    assert.equal(/from 'node:fs/.test(source), false, `${file} must not import node:fs`);
  }
});
test('G4. committing survives a store restart: the directory is the source of truth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-restart-'));
  try {
    const {
      generateSchedules
    } = await import('../../src/modules/timetable/engine/api/generate.js');
    const previews = new PreviewStore(6);
    const deps = {
      loadDataset: () => loadSchedulingFixture(),
      scheduleStore: new ScheduleStore({
        dir
      }),
      previewStore: previews
    };
    const g = await generateSchedules({
      body: {
        candidateCount: 1
      },
      deps
    });
    const c = await commitService({
      requestId: g.payload.requestId,
      solutionId: g.payload.solutions[0].id,
      deps
    });
    assert.equal(c.status, 200);
    const fresh = new ScheduleStore({
      dir
    });
    assert.equal(fresh.list().length, 1);
    assert.equal(fresh.read(c.payload.scheduleId).slots.length, REAL.periods);
    assert.equal(fresh.latest().scheduleId, c.payload.scheduleId);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('G5. buildScheduleRows and compareRows behave as the round trip requires', () => {
  const f = fixture();
  assert.deepEqual(buildScheduleRows(null, f.input), {
    rows: [],
    warnings: []
  });
  const unknown = buildScheduleRows({
    assignments: new Map([['not-a-real-assignment', [{
      branchId: f.branchId,
      day: 1,
      period: 1
    }]]]),
    placements: new Map()
  }, f.input);
  assert.equal(unknown.rows.length, 0);
  assert.equal(unknown.warnings[0].code, 'UNKNOWN_ASSIGNMENT');
  const full = buildScheduleRows(realCandidate(), f.input);
  assert.deepEqual(full.warnings, []);
  assert.equal(full.rows.length, REAL.periods);
  for (const row of full.rows) {
    for (const field of ['assignmentId', 'classId', 'subjectId', 'teacherId', 'branchId', 'day', 'session', 'period']) {
      assert.notEqual(row[field], null, `${field} is present on every row`);
    }
  }
  const row = {
    assignmentId: 'a',
    classId: 'c',
    subjectId: 's',
    teacherId: 't',
    branchId: 'b',
    day: 1,
    session: 'sang',
    period: 1
  };
  const other = {
    ...row,
    period: 2
  };
  assert.equal(compareRows([row, row], [row, other]).equal, false, 'a duplicated row is not a match');
  assert.equal(compareRows([row, other], [row, other]).equal, true);
  assert.equal(compareRows([row], [row, other]).equal, false);
  assert.equal(contentHash([row, other]), contentHash([other, row]));
  assert.notEqual(contentHash([row, other]), contentHash([row, {
    ...other,
    day: 2
  }]));
});
test('G6. a commit response carries no raw data and no personal fields', async () => {
  await withServer(async ({
    generate,
    call,
    get
  }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id
    });
    const text = JSON.stringify(c.json);
    const header = await get(`/api/schedules/committed/${c.json.scheduleId}`);
    const headerText = JSON.stringify(header.json);
    assert.equal(c.json.slots, undefined);
    assert.equal(header.json.schedule.slots, undefined);
    assert.ok(text.length < 8000, `the commit response is a header, not a payload (${text.length} bytes)`);
    for (const banned of ['hoTen', 'soDienThoai', 'email', 'ngaySinh', 'diaChi']) {
      assert.ok(!text.includes(banned), `no ${banned} in the commit response`);
      assert.ok(!headerText.includes(banned), `no ${banned} in the schedule header`);
    }
    const audit = header.json.schedule.audit;
    assert.equal(audit.rawPrompt, undefined);
    assert.equal(audit.modelResponse, undefined);
    assert.equal(typeof audit.inputHash, 'string');
    assert.equal(typeof audit.sourceSolutionId, 'string');
  });
});
test('G7. the evaluator is the only definition of feasible â€” no hard-coded constraint list', async () => {
  const f = fixture();
  const candidate = realCandidate();
  const key = [...candidate.assignments.keys()][0];
  candidate.assignments.set(key, [{
    branchId: f.branchId,
    day: 9,
    period: 9
  }]);
  const evaluation = evaluateCandidate(candidate, f.input);
  assert.equal(isAccepted(evaluation), false);
  const violated = new Set(evaluation.hard.violations.map(v => v.constraintId));
  assert.ok(violated.has('H06'), `expected H06, got ${[...violated].join(',')}`);
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-catalog-'));
  try {
    const schedules = new ScheduleStore({
      dir
    });
    const previews = new PreviewStore(6);
    previews.put('req-catalog', [{
      id: 'ms-catalog',
      solution: {
        id: 'ms-catalog',
        rank: 1
      },
      candidate
    }]);
    const c = await commitService({
      requestId: 'req-catalog',
      solutionId: 'ms-catalog',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({
          input: f.input,
          provenance: f.provenance
        })
      }
    });
    assert.equal(c.status, 409);
    assert.ok(c.payload.validation.reasons.some(r => r.includes('[H06]')), `the commit response names the catalog's own id: ${JSON.stringify(c.payload.validation.reasons)}`);
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
