import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './helpers/app.js';
import { PreviewStore, generateSchedules } from '../../src/modules/timetable/engine/api/generate.js';
import { commit as commitService, COMMIT_STATUS } from '../../src/modules/timetable/engine/api/commit.js';
import { ScheduleStore, scheduleIdFor, ScheduleStoreError } from '../../src/modules/timetable/engine/persistence/schedule-store.js';
import { DurablePreviewStore } from '../../src/modules/timetable/engine/persistence/preview-store.js';
import { buildPreviewRecord, verifyPreviewRecord, candidateIntegrityHash, serializeCandidate, deserializeCandidate, isPreviewId, PREVIEW_LIFECYCLE, PREVIEW_INTEGRITY } from '../../src/modules/timetable/engine/persistence/preview-record.js';
import { contentHash, normalizeReadback } from '../../src/modules/timetable/engine/persistence/schedule-record.js';
import { TEMP_PREFIX } from '../../src/modules/timetable/engine/persistence/atomic-file.js';
import { loadSchedulingFixture } from './helpers/scheduling-fixture.js';
import { evaluateCandidate, isAccepted } from '../../src/modules/timetable/engine/domain/constraints/index.js';
import { generateSolutions } from '../../src/modules/timetable/engine/domain/multi-solution.js';
const run = promisify(execFile);
const REAL = {
  teachers: 40,
  classes: 113,
  assignments: 479,
  periods: 802
};
const WORKER = name => fileURLToPath(new URL(`./${name}`, import.meta.url));
let seedPromise = null;
function seed() {
  if (!seedPromise) {
    seedPromise = (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tkb-p34-seed-'));
      const {
        stdout
      } = await run(process.execPath, [WORKER('phase34_generate_worker.mjs'), dir], {
        maxBuffer: 8 * 1024 * 1024
      });
      const generated = JSON.parse(stdout);
      return {
        dir,
        ...generated
      };
    })();
  }
  return seedPromise;
}
async function seededDir() {
  const s = await seed();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-p34-'));
  cpSync(s.dir, dir, {
    recursive: true
  });
  return {
    dir,
    requestId: s.requestId,
    solutions: s.solutions,
    counts: s.counts,
    previewPersistence: s.previewPersistence,
    cleanup: () => rmSync(dir, {
      recursive: true,
      force: true
    })
  };
}
function emptyDir(tag = 'p34') {
  const dir = mkdtempSync(join(tmpdir(), `tkb-${tag}-`));
  return {
    dir,
    cleanup: () => rmSync(dir, {
      recursive: true,
      force: true
    })
  };
}
async function withServer(dir, fn, options = {}) {
  const previewStore = options.previewStore ?? new DurablePreviewStore({
    dir,
    limit: options.limit ?? 8,
    ttlSeconds: options.ttlSeconds ?? null,
    clock: options.clock
  });
  const scheduleStore = options.scheduleStore ?? new ScheduleStore({
    dir,
    staleTempMs: options.staleTempMs
  });
  const app = createApp({
    previewStore,
    scheduleStore,
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
  const generate = async (body = {
    candidateCount: 1
  }) => call('/api/schedules/generate?placements=all', body);
  try {
    return await fn({
      call,
      get,
      generate,
      previewStore,
      scheduleStore,
      dir,
      base
    });
  } finally {
    await new Promise(r => server.close(r));
  }
}
function scheduleFiles(dir) {
  return readdirSync(dir).filter(n => /^sch-[0-9a-f]{16}\.json$/.test(n));
}
function claimFiles(dir) {
  return readdirSync(dir).filter(n => n.startsWith('.version-'));
}
let cached = null;
function fx() {
  if (cached) return cached;
  const {
    input
  } = loadSchedulingFixture();
  const byClass = new Map();
  for (const a of input.assignments) {
    if (!byClass.has(a.classId)) byClass.set(a.classId, []);
    byClass.get(a.classId).push(a);
  }
  const [, sameClass] = [...byClass.entries()].find(([, v]) => v.length >= 2);
  const branch = input.branches.find(b => b.id === sameClass[0].branchId);
  cached = {
    input,
    first: sameClass[0],
    second: sameClass[1],
    branchId: branch.id,
    day: branch.schoolDays[0],
    period: branch.periods[0]
  };
  return cached;
}
let cachedCandidate = null;
function realCandidate() {
  if (cachedCandidate) return copyCandidate(cachedCandidate);
  const {
    input
  } = fx();
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
    assignments: new Map([...src.assignments].map(([k, v]) => [k, v.map(s => ({
      ...s
    }))])),
    placements: new Map([...src.placements].map(([k, v]) => [k, {
      ...v
    }]))
  };
}
test('1. a preview generated by a child process is committable after that process exits', async () => {
  const s = await seededDir();
  try {
    const before = s.solutions.length;
    assert.equal(before, 3, 'the seed generation produced three solutions');
    await withServer(s.dir, async ({
      call,
      previewStore,
      scheduleStore
    }) => {
      const described = previewStore.describe(s.requestId);
      assert.equal(described.lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
      assert.equal(described.integrity, PREVIEW_INTEGRITY.VERIFIED);
      assert.deepEqual(described.solutionIds, s.solutions.map(x => x.id));
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[1].id
      });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.equal(c.json.status, COMMIT_STATUS.COMMITTED);
      assert.equal(c.json.committed, true);
      assert.equal(scheduleStore.list().length, 1);
    });
  } finally {
    s.cleanup();
  }
});
test('2. a second store instance sees the first one\'s preview, as solver Maps', async () => {
  const s = await seededDir();
  try {
    const reader = new DurablePreviewStore({
      dir: s.dir,
      limit: 8
    });
    const described = reader.describe(s.requestId);
    assert.equal(described.lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    assert.equal(described.integrity, PREVIEW_INTEGRITY.VERIFIED);
    const solutions = reader.get(s.requestId);
    assert.equal(solutions.length, 3);
    for (const entry of solutions) {
      assert.ok(entry.candidate.assignments instanceof Map, 'assignments is a Map');
      assert.ok(entry.candidate.placements instanceof Map, 'placements is a Map');
      assert.equal(entry.candidate.assignments.size, REAL.assignments);
      assert.equal(typeof entry.solution.rank, 'number');
      assert.equal(typeof entry.solution.globalScore, 'number');
      assert.ok(entry.strategy, 'the generation strategy survived');
    }
  } finally {
    s.cleanup();
  }
});
test('3. the stored candidate hashes to the integrity hash written beside it', async () => {
  const s = await seededDir();
  try {
    const reader = new DurablePreviewStore({
      dir: s.dir,
      limit: 8
    });
    const record = reader.readRaw(s.requestId);
    assert.equal(verifyPreviewRecord(record).ok, true);
    for (const entry of record.solutions) {
      assert.equal(candidateIntegrityHash(deserializeCandidate(entry.candidate)), entry.integrityHash, `solution ${entry.id} hash matches`);
      assert.match(entry.integrityHash, /^[0-9a-f]{64}$/);
    }
    const live = realCandidate();
    const round = deserializeCandidate(serializeCandidate(live));
    assert.equal(candidateIntegrityHash(round), candidateIntegrityHash(live));
  } finally {
    s.cleanup();
  }
});
test('4. a candidate edited on disk is refused, and nothing is written', async () => {
  const s = await seededDir();
  try {
    const path = join(s.dir, 'previews', `${s.requestId}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const target = record.solutions[0];
    const originalDay = target.candidate.assignments[0][1][0].day;
    target.candidate.assignments[0][1][0].day = originalDay === 5 ? 4 : 5;
    assert.notEqual(target.candidate.assignments[0][1][0].day, originalDay);
    assert.notEqual(candidateIntegrityHash(deserializeCandidate(target.candidate)), target.integrityHash, 'the corruption fixture must actually alter the candidate bytes');
    writeFileSync(path, JSON.stringify(record));
    await withServer(s.dir, async ({
      call,
      previewStore,
      scheduleStore
    }) => {
      assert.equal(previewStore.describe(s.requestId).lifecycle, PREVIEW_LIFECYCLE.INVALID);
      assert.equal(previewStore.describe(s.requestId).integrity, PREVIEW_INTEGRITY.FAILED);
      assert.equal(previewStore.get(s.requestId), null, 'a tampered record hands out nothing');
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: target.id
      });
      assert.equal(c.status, 409);
      assert.equal(c.json.status, COMMIT_STATUS.REJECTED);
      assert.equal(c.json.ok, false);
      assert.equal(c.json.persisted, false);
      assert.equal(c.json.error.code, 'PREVIEW_INTEGRITY');
      assert.deepEqual(c.json.error.mismatched, [target.id]);
      assert.equal(scheduleStore.list().length, 0);
      assert.equal(scheduleFiles(s.dir).length, 0);
    });
  } finally {
    s.cleanup();
  }
});
test('5. ten concurrent commits of the same solution produce exactly one record', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      scheduleStore
    }) => {
      const body = {
        requestId: s.requestId,
        solutionId: s.solutions[1].id
      };
      const results = await Promise.all(Array.from({
        length: 10
      }, () => call('/api/schedules/commit', body)));
      for (const r of results) {
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.committed, true);
        assert.equal(typeof r.json.duplicate, 'boolean', 'duplicate is reported, not inferred');
      }
      const ids = new Set(results.map(r => r.json.scheduleId));
      assert.equal(ids.size, 1, `all ten got the same scheduleId, got ${[...ids]}`);
      const versions = new Set(results.map(r => r.json.version));
      assert.equal(versions.size, 1, 'all ten report the same version');
      assert.equal(scheduleStore.list().length, 1);
      assert.equal(scheduleFiles(s.dir).length, 1);
      assert.equal(results.filter(r => r.json.duplicate === false).length, 1, 'exactly one of the ten was the writer');
      assert.equal(results.filter(r => r.json.duplicate === true).length, 9, 'the other nine were replays of the same record');
    });
  } finally {
    s.cleanup();
  }
});
test('6. the same generation committed concurrently three ways yields three records', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      scheduleStore
    }) => {
      const results = await Promise.all(s.solutions.map(x => call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: x.id
      })));
      for (const r of results) {
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.equal(r.json.committed, true);
      }
      assert.equal(new Set(results.map(r => r.json.scheduleId)).size, 3, 'three distinct schedule ids');
      assert.equal(new Set(results.map(r => r.json.version)).size, 3, 'three distinct versions');
      assert.equal(scheduleStore.list().length, 3);
      assert.equal(scheduleFiles(s.dir).length, 3);
      assert.equal(new Set(results.map(r => r.json.contentHash)).size, 3);
    });
  } finally {
    s.cleanup();
  }
});
test('7. four OS processes claiming versions concurrently collide on none', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-xproc');
  try {
    const tags = ['aaaa', 'bbbb', 'cccc', 'dddd'];
    const outs = await Promise.all(tags.map(t => run(process.execPath, [WORKER('phase34_store_worker.mjs'), dir, t, '5'])));
    const all = outs.flatMap(o => JSON.parse(o.stdout).results);
    assert.equal(all.length, 20);
    assert.equal(new Set(all.map(r => r.scheduleId)).size, 20, '20 distinct schedules');
    assert.equal(new Set(all.map(r => r.version)).size, 20, '20 distinct versions');
    assert.equal(new Set(outs.map(o => JSON.parse(o.stdout).pid)).size, 4);
    const store = new ScheduleStore({
      dir
    });
    assert.equal(store.list().length, 20);
    assert.equal(claimFiles(dir).length, 20);
    assert.equal(store.health().versionHighWaterMark, 20);
  } finally {
    cleanup();
  }
});
test('7b. a store under construction does not delete another process\'s in-flight write', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-sweep');
  try {
    const ours = `${TEMP_PREFIX}${process.pid}-sch-ours-abcdef`;
    const young = `${TEMP_PREFIX}999999-sch-young-abcdef`;
    const stale = `${TEMP_PREFIX}999998-sch-stale-abcdef`;
    const foreign = `${TEMP_PREFIX}not-a-pid-file`;
    for (const name of [ours, young, stale, foreign]) writeFileSync(join(dir, name), 'x');
    const anHourAgo = new Date(Date.now() - 3_600_000);
    utimesSync(join(dir, stale), anHourAgo, anHourAgo);
    utimesSync(join(dir, foreign), anHourAgo, anHourAgo);
    new ScheduleStore({
      dir,
      staleTempMs: 1000
    });
    const left = readdirSync(dir);
    assert.ok(left.includes(ours), 'a temp file from this process is never swept -- it may be our own in-flight write');
    assert.ok(left.includes(young), 'a young file from another pid is left alone -- it may be a live write');
    assert.equal(left.includes(stale), false, 'an old file from another pid is collected');
    assert.ok(left.includes(foreign), 'a file attributable to no writer is not ours to delete');
    assert.equal(left.some(n => /^sch-/.test(n)), false, 'no temp file became a schedule');
    assert.equal(new ScheduleStore({
      dir
    }).list().length, 0);
  } finally {
    cleanup();
  }
});
test('8. every record on disk after a concurrent burst is complete and parseable', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call
    }) => {
      await Promise.all(s.solutions.flatMap(x => [1, 2].map(() => call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: x.id
      }))));
      const names = scheduleFiles(s.dir);
      assert.equal(names.length, 3);
      for (const name of names) {
        const text = readFileSync(join(s.dir, name), 'utf8');
        const record = JSON.parse(text);
        assert.equal(record.scheduleId, name.slice(0, -5));
        assert.equal(record.status, 'COMMITTED');
        assert.equal(Array.isArray(record.slots), true);
        assert.equal(record.slots.length, REAL.periods, `${name} has every slot`);
        assert.equal(record.slotCount, REAL.periods);
        assert.equal(record.contentHash, contentHash(normalizeReadback(record)), `${name} hashes to its own contents`);
        assert.equal(text.endsWith('\n'), true, 'the file is terminated, not cut off');
      }
    });
  } finally {
    s.cleanup();
  }
});
test('9. temp files are invisible to list, health and the committed endpoints', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get,
      scheduleStore
    }) => {
      await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      });
      assert.equal(scheduleStore.list().length, 1);
      const stale = join(s.dir, `${TEMP_PREFIX}${process.pid}-sch-interrupted-abcdef`);
      writeFileSync(stale, '{"schemaVersion":1,"scheduleId":"sch-interrupted","slots":[');
      writeFileSync(join(s.dir, 'sch-not-a-real-id.json'), '{"slots":[]}');
      writeFileSync(join(s.dir, 'notes.txt'), 'unrelated');
      const store2 = new ScheduleStore({
        dir: s.dir,
        staleTempMs: 0
      });
      assert.equal(store2.list().length, 1, 'the interrupted write is not a schedule');
      assert.equal(store2.list().some(h => h.scheduleId === 'sch-interrupted'), false);
      assert.equal(store2.read('sch-interrupted'), null);
      assert.equal(store2.read('sch-0000000000000000'), null);
      const listed = await get('/api/schedules/committed');
      assert.equal(listed.json.count, 1);
      assert.equal(listed.json.schedules.length, 1);
    });
  } finally {
    s.cleanup();
  }
});
test('10. a corrupted record is contained: the store stays usable and says so', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get,
      scheduleStore
    }) => {
      await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      });
      const good = scheduleFiles(s.dir)[0];
      const goodBytes = readFileSync(join(s.dir, good), 'utf8');
      const otherId = scheduleIdFor(s.requestId, s.solutions[1].id);
      writeFileSync(join(s.dir, `${otherId}.json`), '{"schemaVersion":1,"slots":[{"assignm');
      const store2 = new ScheduleStore({
        dir: s.dir
      });
      assert.equal(store2.list().length, 1, 'the good record is still listed');
      assert.equal(store2.read(otherId), null, 'the corrupt one is not a schedule');
      const health = store2.health();
      assert.equal(health.corruptRecordCount, 1, 'and the condition is reported, not hidden');
      assert.equal(health.recordCount, 1);
      const listed = await get('/api/schedules/committed');
      assert.equal(listed.status, 200);
      assert.equal(listed.json.count, 1);
      const missing = await get(`/api/schedules/committed/${otherId}`);
      assert.equal(missing.status, 404);
      assert.equal(missing.json.error.code, 'UNKNOWN_SCHEDULE');
      assert.equal(readFileSync(join(s.dir, good), 'utf8'), goodBytes);
    });
  } finally {
    s.cleanup();
  }
});
test('10b. a commit onto a name that is already corrupt is refused, not silently overwritten', async () => {
  const s = await seededDir();
  try {
    const scheduleId = scheduleIdFor(s.requestId, s.solutions[0].id);
    writeFileSync(join(s.dir, 'previews', '.keep'), '');
    writeFileSync(join(s.dir, `${scheduleId}.json`), 'not json at all');
    await withServer(s.dir, async ({
      call,
      scheduleStore
    }) => {
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      });
      assert.equal(c.status, 500);
      assert.equal(c.json.ok, false);
      assert.equal(c.json.persisted, false, 'reported as not persisted');
      assert.equal(c.json.error.code, 'RECORD_CORRUPT');
      assert.equal(readFileSync(join(s.dir, `${scheduleId}.json`), 'utf8'), 'not json at all');
      assert.equal(scheduleStore.list().length, 0);
    });
  } finally {
    s.cleanup();
  }
});
test('11. an unknown schedule, generation or solution is a 404 with a code, never a 500', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get
    }) => {
      const unknownSchedule = await get('/api/schedules/committed/sch-0000000000000000');
      assert.equal(unknownSchedule.status, 404);
      assert.equal(unknownSchedule.json.error.code, 'UNKNOWN_SCHEDULE');
      const unknownFull = await get('/api/schedules/committed/sch-0000000000000000/full');
      assert.equal(unknownFull.status, 404);
      assert.equal(unknownFull.json.error.code, 'UNKNOWN_SCHEDULE');
      const unknownGeneration = await call('/api/schedules/commit', {
        requestId: 'req-999999-deadbeef',
        solutionId: 'ms-00000000'
      });
      assert.equal(unknownGeneration.status, 404);
      assert.equal(unknownGeneration.json.error.code, 'UNKNOWN_REQUEST');
      assert.equal(unknownGeneration.json.preview.lifecycle, PREVIEW_LIFECYCLE.MISSING);
      const unknownSolution = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: 'ms-deadbeef'
      });
      assert.equal(unknownSolution.status, 404);
      assert.equal(unknownSolution.json.error.code, 'UNKNOWN_SOLUTION');
      assert.deepEqual(unknownSolution.json.error.available, s.solutions.map(x => x.id));
      assert.equal((await get('/api/schedules/committed')).json.count, 0);
    });
  } finally {
    s.cleanup();
  }
});
test('12. a client-supplied id cannot become a path outside the persistence directory', async () => {
  const s = await seededDir();
  try {
    const store = new ScheduleStore({
      dir: s.dir
    });
    const previews = new DurablePreviewStore({
      dir: s.dir,
      limit: 8
    });
    for (const attack of ['../../package.json', '../schedules', '..\\..\\package.json', '/etc/passwd', 'C:\\Windows\\System32\\config\\SAM', 'sch-../../etc', 'sch-ABCDEF0123456789', 'sch-short', '.tmp-anything', '', null, undefined, 42, {
      toString: () => '../x'
    }]) {
      assert.equal(store.pathFor(attack), null, `schedule pathFor refuses ${String(attack)}`);
      assert.equal(store.read(attack), null, `schedule read refuses ${String(attack)}`);
      assert.equal(previews.pathFor(attack), null, `preview pathFor refuses ${String(attack)}`);
      assert.equal(previews.readRaw(attack), null, `preview readRaw refuses ${String(attack)}`);
    }
    assert.equal(store.pathFor('sch-8afa59b87c3282bb') !== null, true);
    assert.equal(isPreviewId('req-000001-abcd1234'), true);
    assert.equal(isPreviewId('req-000001'), true);
    assert.equal(isPreviewId('../x'), false);
    await withServer(s.dir, async ({
      get
    }) => {
      for (const attack of ['..%2F..%2Fpackage.json', '....//package.json', '%2e%2e%2f%2e%2e%2fpackage.json', 'sch-8afa59b87c3282bb%00.json']) {
        const r = await get(`/api/schedules/committed/${attack}`);
        assert.equal(r.status, 404, `HTTP refuses ${attack}`);
        assert.equal(r.json.ok, false);
        const text = JSON.stringify(r.json);
        assert.equal(text.includes('"name":'), false, `${attack} did not return a file`);
        assert.equal(text.includes('devDependencies'), false, `${attack} did not return package.json`);
        assert.equal(text.includes('"scripts"'), false, `${attack} did not return package.json`);
      }
    });
  } finally {
    s.cleanup();
  }
});
test('13. a record name only ever appears complete, and a duplicate never rewrites it', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      scheduleStore,
      dir
    }) => {
      const body = {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      };
      const first = await call('/api/schedules/commit', body);
      assert.equal(first.status, 200);
      const path = join(dir, `${first.json.scheduleId}.json`);
      const bytes = readFileSync(path, 'utf8');
      const mtime = statSync(path).mtimeMs;
      const observed = [];
      let stop = false;
      const polling = (async () => {
        const deadline = Date.now() + 60_000;
        while (!stop && Date.now() < deadline) {
          for (const name of readdirSync(dir)) {
            if (!/^sch-[0-9a-f]{16}\.json$/.test(name)) continue;
            if (observed.includes(name)) continue;
            const raw = readFileSync(join(dir, name), 'utf8');
            let parsed = null;
            try {
              parsed = JSON.parse(raw);
            } catch {}
            observed.push(name);
            if (!parsed) continue;
            assert.equal(parsed.slots.length, REAL.periods, `${name} was never observed half-written`);
            assert.equal(parsed.status, 'COMMITTED');
            assert.equal(parsed.scheduleId, name.slice(0, -5));
          }
          await new Promise(r => setTimeout(r, 5));
        }
      })();
      await Promise.all(s.solutions.slice(1).map(x => call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: x.id
      })));
      const replay = await call('/api/schedules/commit', body);
      assert.equal(replay.status, 200);
      assert.equal(replay.json.duplicate, true);
      stop = true;
      await polling;
      assert.ok(observed.length >= 3, `polled and saw ${observed.length} records`);
      assert.equal(readFileSync(path, 'utf8'), bytes, 'a duplicate did not rewrite the record');
      assert.equal(statSync(path).mtimeMs, mtime, 'a duplicate did not touch the record');
      assert.equal(scheduleStore.list().length, 3);
    });
  } finally {
    s.cleanup();
  }
});
test('14. list() never returns a malformed entry while writes are in flight', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      scheduleStore,
      dir
    }) => {
      const writes = Promise.all(s.solutions.map(x => call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: x.id
      })));
      const reading = (async () => {
        for (let i = 0; i < 60; i += 1) {
          for (const header of scheduleStore.list()) {
            assert.match(header.scheduleId, /^sch-[0-9a-f]{16}$/);
            assert.equal(Number.isInteger(header.version), true, 'every listed version is an integer');
            assert.equal(typeof header.slotCount, 'number', 'every listed slot count is a number');
            assert.equal(header.status, 'COMMITTED');
            const record = scheduleStore.read(header.scheduleId);
            assert.ok(record, `${header.scheduleId} listed and readable`);
            assert.equal(record.slots.length, REAL.periods);
            assert.equal(record.version, header.version);
          }
          await new Promise(r => setTimeout(r, 5));
        }
      })();
      await Promise.all([writes, reading]);
      assert.equal(scheduleStore.list().length, 3);
      assert.equal(scheduleFiles(dir).length, 3);
    });
  } finally {
    s.cleanup();
  }
});
test('15. generating again leaves the earlier generation committable', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-regen');
  try {
    const previewStore = new DurablePreviewStore({
      dir,
      limit: 8
    });
    const scheduleStore = new ScheduleStore({
      dir
    });
    const deps = {
      loadDataset: () => loadSchedulingFixture(),
      previewStore,
      scheduleStore
    };
    const first = await generateSchedules({
      body: {
        candidateCount: 1
      },
      deps
    });
    const second = await generateSchedules({
      body: {
        candidateCount: 1
      },
      deps
    });
    assert.equal(first.payload.status, 'OK');
    assert.equal(second.payload.status, 'OK');
    assert.notEqual(first.payload.requestId, second.payload.requestId, 'a new generation is a new request');
    assert.equal(previewStore.describe(first.payload.requestId).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    assert.equal(previewStore.describe(second.payload.requestId).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    const c = await commitService({
      requestId: first.payload.requestId,
      solutionId: first.payload.solutions[0].id,
      deps
    });
    assert.equal(c.status, 200, JSON.stringify(c.payload));
    assert.equal(c.payload.committed, true);
    assert.equal(c.payload.requestId, first.payload.requestId);
    const c2 = await commitService({
      requestId: second.payload.requestId,
      solutionId: second.payload.solutions[0].id,
      deps
    });
    assert.equal(c2.status, 200);
    assert.notEqual(c2.payload.scheduleId, c.payload.scheduleId);
    assert.equal(scheduleStore.list().length, 2);
  } finally {
    cleanup();
  }
});
test('16. the evaluator still refuses a candidate, even one whose integrity hash is honest', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-reval');
  try {
    const f = fx();
    const broken = {
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
    };
    const requestId = 'req-000001-aabbccdd';
    const solutionId = 'ms-deadbeef';
    const record = buildPreviewRecord({
      requestId,
      solutions: [{
        id: solutionId,
        solution: {
          rank: 1,
          globalScore: 1,
          qualityScore: 0
        },
        candidate: broken,
        strategy: null
      }],
      createdAt: new Date().toISOString(),
      ttlSeconds: null
    });
    assert.equal(verifyPreviewRecord(record).ok, true, 'the hash is honest');
    mkdirSync(join(dir, 'previews'), {
      recursive: true
    });
    writeFileSync(join(dir, 'previews', `${requestId}.json`), JSON.stringify(record));
    const scheduleStore = new ScheduleStore({
      dir
    });
    const deps = {
      loadDataset: () => loadSchedulingFixture(),
      previewStore: new DurablePreviewStore({
        dir,
        limit: 8
      }),
      scheduleStore
    };
    const c = await commitService({
      requestId,
      solutionId,
      deps
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.error.code, 'HARD_VIOLATION');
    assert.ok(c.payload.error.hardViolations > 0, 'the evaluator reported the violation');
    assert.ok(c.payload.error.reasons.some(r => r.includes('H01')), JSON.stringify(c.payload.error.reasons));
    assert.equal(c.payload.preview.integrity, PREVIEW_INTEGRITY.VERIFIED);
    assert.equal(scheduleStore.list().length, 0);
  } finally {
    cleanup();
  }
});
test('17. the reported globalScore is the one from generation, not a one-candidate re-rank', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call
    }) => {
      const target = s.solutions[1];
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: target.id
      });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.equal(c.json.score.globalScore, target.globalScore, 'the score is the one the user saw, not 0.5');
      assert.notEqual(c.json.score.globalScore, 0.5);
      assert.equal(c.json.score.qualityScore, target.qualityScore);
      assert.equal(c.json.score.recheck.ran, true);
      assert.equal(c.json.score.recheck.searched, false, 'no search was run at commit');
      assert.equal(c.json.score.recheck.hardViolations, 0);
      assert.equal(c.json.score.feasibility, 'FEASIBLE');
      const audit = (await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: target.id
      })).json;
      assert.equal(audit.score.globalScore, target.globalScore);
    });
  } finally {
    s.cleanup();
  }
});
test('18. the committed record reads back as the same 802-slot schedule', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get
    }) => {
      const target = s.solutions[1];
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: target.id
      });
      assert.equal(c.status, 200);
      assert.equal(c.json.slotCount, REAL.periods);
      assert.equal(c.json.readback.slots, REAL.periods);
      assert.equal(c.json.readback.matchesCandidate, true);
      const full = await get(`/api/schedules/committed/${c.json.scheduleId}/full`);
      assert.equal(full.status, 200);
      const record = full.json.schedule;
      const slots = record.slots;
      assert.equal(slots.length, REAL.periods);
      assert.equal(new Set(slots.map(x => x.classId)).size, REAL.classes);
      assert.deepEqual([...new Set(slots.map(x => x.day))].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
      assert.equal(record.contentHash, contentHash(normalizeReadback({
        slots
      })));
      assert.equal(record.contentHash, c.json.contentHash);
      for (const row of slots.slice(0, 50)) {
        for (const f of ['assignmentId', 'classId', 'subjectId', 'teacherId', 'branchId', 'day', 'session', 'period']) {
          assert.notEqual(row[f], undefined, `row has ${f}`);
        }
      }
      const header = await get(`/api/schedules/committed/${c.json.scheduleId}`);
      assert.equal(header.json.schedule.slots, undefined, 'a header carries no slot table');
    });
  } finally {
    s.cleanup();
  }
});
test('19. every Phase 32/33 endpoint answers, unchanged, on a durable store', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get,
      generate,
      previewStore
    }) => {
      const g = await generate({
        candidateCount: 1
      });
      assert.equal(g.status, 200);
      assert.equal(g.json.solutions.length, 1);
      assert.equal(g.json.previewPersistence.stored, true);
      assert.equal(g.json.previewPersistence.driver, 'file');
      assert.ok(g.json.previewPersistence.reason === null);
      const health = await get('/api/schedules/health');
      assert.equal(health.json.ok, true);
      assert.equal(health.json.commit.mode, 'COMMIT_ENABLED');
      assert.equal(health.json.commit.atomic, true);
      assert.equal(health.json.commit.idempotency, 'requestId+solutionId');
      assert.equal(health.json.commit.corruptRecordCount, 0);
      assert.equal(health.json.preview.durable, true, 'the default preview store is durable');
      assert.equal(health.json.preview.crossProcess, true);
      assert.equal(health.json.preview.expiration, 'NONE', 'no TTL is configured by default');
      assert.equal(health.json.preview.ttlSeconds, null);
      assert.equal(health.json.travel.h14, 'UNSUPPORTED');
      assert.equal(health.json.transfer.h13, 'ACTIVE');
      assert.deepEqual(health.json.request.allowedCommitFields, ['requestId', 'solutionId']);
      const forbidden = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id,
        teacherId: 'x'
      });
      assert.equal(forbidden.status, 400);
      assert.equal(forbidden.json.errors[0].code, 'FORBIDDEN_FIELD');
      assert.equal(forbidden.json.errors[0].field, 'teacherId');
      assert.equal(scheduleCount(s.dir), 0, 'a refused commit writes nothing');
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      });
      assert.equal(c.status, 200);
      const listed = await get('/api/schedules/committed');
      assert.equal(listed.json.count, 1);
      assert.equal(previewStore.stats().stored, 2, 'both generations are on disk');
    });
  } finally {
    s.cleanup();
  }
});
function scheduleCount(dir) {
  return readdirSync(dir).filter(n => /^sch-[0-9a-f]{16}\.json$/.test(n)).length;
}
test('20. every field the React commit state reads is present and correctly typed', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call
    }) => {
      const uiPath = join(process.cwd(), '..', 'frontend', 'src', 'features', 'scheduling', 'useCommitState.js');
      let required = [];
      try {
        const source = readFileSync(uiPath, 'utf8');
        const projection = source.slice(source.indexOf('function toRecord('));
        const projected = [...new Set([...projection.matchAll(/payload\?\.(\w+)/g)].map(m => m[1]))];
        const guards = [...new Set([...source.matchAll(/result\?\.(\w+) !== true/g)].map(m => m[1]))];
        required = [...projected, ...guards];
      } catch {
        required = ['scheduleId', 'version', 'status', 'solutionId', 'requestId', 'slotCount', 'contentHash', 'committedAt', 'duplicate', 'validated', 'committed'];
      }
      assert.ok(required.length >= 10, `the list has to be a real list, got ${required.length}`);
      assert.ok(required.includes('committed'), 'the list includes the success guard');
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[1].id
      });
      assert.equal(c.status, 200);
      for (const field of required) {
        assert.notEqual(c.json[field], undefined, `commit response carries ${field}`);
      }
      assert.equal(c.json.committed, true);
      assert.equal(c.json.written, true, 'the Phase 32 name is still there too');
      const refused = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: 'ms-nope1234'
      });
      assert.equal(refused.status, 404);
      assert.equal(typeof refused.json.error.message, 'string');
      assert.ok(Array.isArray(refused.json.error.available));
    });
  } finally {
    s.cleanup();
  }
});
test('21. generate in a child, kill it, commit here, read the record back', async () => {
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      call,
      get,
      scheduleStore
    }) => {
      const c = await call('/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[1].id
      });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.equal(c.json.validation.accepted, true);
      assert.equal(c.json.validation.hardViolations, 0);
      assert.equal(c.json.preview.lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
      const store2 = new ScheduleStore({
        dir: s.dir
      });
      assert.equal(store2.list().length, 1);
      const record = store2.read(c.json.scheduleId);
      assert.equal(record.slots.length, REAL.periods);
      assert.equal(record.slotCount, REAL.periods);
      assert.equal(record.contentHash, c.json.contentHash);
      assert.equal(record.audit.sourceRequestId, s.requestId);
      assert.equal(record.audit.sourceSolutionId, s.solutions[1].id);
      assert.equal(record.version, c.json.version);
      const full = await get(`/api/schedules/committed/${c.json.scheduleId}/full`);
      assert.equal(full.status, 200);
      assert.equal(full.json.schedule.slots.length, REAL.periods);
      assert.equal(scheduleStore.read(c.json.scheduleId).slots.length, REAL.periods);
    });
  } finally {
    s.cleanup();
  }
});
test('22. a second client on the same directory can commit what the first generated', async () => {
  const s = await seededDir();
  try {
    const storeA = {
      previewStore: new DurablePreviewStore({
        dir: s.dir,
        limit: 8
      }),
      scheduleStore: new ScheduleStore({
        dir: s.dir
      })
    };
    const storeB = {
      previewStore: new DurablePreviewStore({
        dir: s.dir,
        limit: 8
      }),
      scheduleStore: new ScheduleStore({
        dir: s.dir
      })
    };
    const serverA = createApp({
      ...storeA,
      loadDataset: loadSchedulingFixture
    }).listen(0);
    const serverB = createApp({
      ...storeB,
      loadDataset: loadSchedulingFixture
    }).listen(0);
    await Promise.all([new Promise(r => serverA.once('listening', r)), new Promise(r => serverB.once('listening', r))]);
    const a = `http://127.0.0.1:${serverA.address().port}`;
    const b = `http://127.0.0.1:${serverB.address().port}`;
    const post = async (base, path, body) => {
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
    try {
      assert.equal(storeB.previewStore.byId, undefined, 'B holds no in-memory previews');
      assert.equal(storeB.previewStore.describe(s.requestId).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
      const c = await post(b, '/api/schedules/commit', {
        requestId: s.requestId,
        solutionId: s.solutions[0].id
      });
      assert.equal(c.status, 200, JSON.stringify(c.json));
      const seen = await (await fetch(`${a}/api/schedules/committed`)).json();
      assert.equal(seen.count, 1);
      assert.equal(seen.schedules[0].scheduleId, c.json.scheduleId);
      const storeC = new ScheduleStore({
        dir: s.dir
      });
      assert.equal(storeC.list().length, 1);
      assert.equal(storeC.read(c.json.scheduleId).slots.length, REAL.periods);
    } finally {
      await Promise.all([new Promise(r => serverA.close(r)), new Promise(r => serverB.close(r))]);
    }
  } finally {
    s.cleanup();
  }
});
test('X1. expiration is opt-in: off by default, and it fires when configured', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-ttl');
  try {
    const never = new DurablePreviewStore({
      dir,
      limit: 8,
      clock: () => '2026-01-01T00:00:00.000Z'
    });
    await never.put('req-000001-0a1b2c3d', [{
      id: 'ms-aaaaaaaa',
      solution: {
        rank: 1
      },
      candidate: realCandidate(),
      strategy: null
    }]);
    const record = JSON.parse(readFileSync(join(dir, 'previews', 'req-000001-0a1b2c3d.json'), 'utf8'));
    assert.equal(record.expiresAt, null, 'no TTL means no expiry field, not an expiry of zero');
    const muchLater = new DurablePreviewStore({
      dir,
      limit: 8,
      clock: () => '2028-01-01T00:00:00.000Z'
    });
    assert.equal(muchLater.describe('req-000001-0a1b2c3d').lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    const expiring = new DurablePreviewStore({
      dir,
      limit: 8,
      ttlSeconds: 60,
      clock: () => '2028-01-01T00:00:00.000Z'
    });
    await expiring.put('req-000002-4e5f6a7b', [{
      id: 'ms-bbbbbbbb',
      solution: {
        rank: 1
      },
      candidate: realCandidate(),
      strategy: null
    }]);
    const expiringRecord = JSON.parse(readFileSync(join(dir, 'previews', 'req-000002-4e5f6a7b.json'), 'utf8'));
    assert.equal(expiringRecord.expiresAt, '2028-01-01T00:01:00.000Z', 'the applied expiry is in the record');
    const before = new DurablePreviewStore({
      dir,
      limit: 8,
      ttlSeconds: 60,
      clock: () => '2028-01-01T00:00:59.000Z'
    });
    assert.equal(before.describe('req-000002-4e5f6a7b').lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    const after = new DurablePreviewStore({
      dir,
      limit: 8,
      ttlSeconds: 60,
      clock: () => '2028-01-01T00:01:00.000Z'
    });
    assert.equal(after.describe('req-000002-4e5f6a7b').lifecycle, PREVIEW_LIFECYCLE.EXPIRED);
    assert.equal(after.get('req-000002-4e5f6a7b'), null, 'an expired preview hands out nothing');
  } finally {
    cleanup();
  }
});
test('X2. an expired preview is a 410, and it writes nothing', async () => {
  const s = await seededDir();
  try {
    let now = '2028-01-01T00:00:00.000Z';
    const scheduleStore = new ScheduleStore({
      dir: s.dir
    });
    const previewStore = new DurablePreviewStore({
      dir: s.dir,
      limit: 8,
      ttlSeconds: 60,
      clock: () => now
    });
    const path = join(s.dir, 'previews', `${s.requestId}.json`);
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.expiresAt = '2027-01-01T00:00:00.000Z';
    writeFileSync(path, JSON.stringify(record));
    const c = await commitService({
      requestId: s.requestId,
      solutionId: s.solutions[0].id,
      deps: {
        loadDataset: () => loadSchedulingFixture(),
        previewStore,
        scheduleStore
      }
    });
    assert.equal(c.status, 410);
    assert.equal(c.payload.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.error.code, 'PREVIEW_EXPIRED');
    assert.equal(c.payload.preview.lifecycle, PREVIEW_LIFECYCLE.EXPIRED);
    assert.equal(c.payload.preview.reason, 'TTL_PASSED');
    assert.equal(scheduleStore.list().length, 0);
  } finally {
    s.cleanup();
  }
});
test('X3. the preview lifecycle is a complete, enumerable set', async () => {
  assert.deepEqual(Object.values(PREVIEW_LIFECYCLE).sort(), ['AVAILABLE', 'COMMITTED', 'EXPIRED', 'GENERATED', 'INVALID', 'MISSING']);
  const s = await seededDir();
  try {
    await withServer(s.dir, async ({
      get
    }) => {
      const health = await get('/api/schedules/health');
      assert.deepEqual(health.json.preview.lifecycles, Object.values(PREVIEW_LIFECYCLE));
    });
  } finally {
    s.cleanup();
  }
});
test('X5. scheduleId derivation is byte-for-byte what Phase 33 committed', async () => {
  assert.equal(scheduleIdFor('req-000001', 'ms-dab6b0d3'), 'sch-8afa59b87c3282bb');
  const storeSource = readFileSync(join(process.cwd(), 'src', 'modules', 'timetable', 'engine', 'persistence', 'schedule-store.js'), 'utf8');
  const line = storeSource.split('\n').find(l => l.includes('.update(String(requestId))') === false && l.includes(".update('") && l.includes("')"));
  assert.ok(line, 'the separator line is present');
  assert.equal(line.includes(String.fromCharCode(0)), true, 'the separator is a NUL byte');
  assert.notEqual(scheduleIdFor('a', 'bc'), scheduleIdFor('ab', 'c'));
});
test('X6. pruning respects the limit and never deletes a preview that has been committed', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-prune');
  try {
    const store = new DurablePreviewStore({
      dir,
      limit: 3,
      clock: (() => {
        let t = 0;
        return () => new Date(Date.UTC(2026, 0, 1, 0, 0, t++)).toISOString();
      })()
    });
    const scheduleStore = new ScheduleStore({
      dir
    });
    const deps = {
      loadDataset: () => loadSchedulingFixture(),
      previewStore: store,
      scheduleStore
    };
    const ids = [];
    for (let i = 0; i < 5; i += 1) {
      const g = await generateSchedules({
        body: {
          candidateCount: 1
        },
        deps
      });
      ids.push(g.payload.requestId);
    }
    assert.equal(store.entries().length, 3);
    assert.equal(store.describe(ids[0]).lifecycle, PREVIEW_LIFECYCLE.MISSING);
    assert.equal(store.describe(ids[4]).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
    const oldestSurvivor = ids[2];
    const c = await commitService({
      requestId: oldestSurvivor,
      solutionId: store.get(oldestSurvivor)[0].id,
      deps
    });
    assert.equal(c.status, 200, JSON.stringify(c.payload));
    for (let i = 0; i < 2; i += 1) await generateSchedules({
      body: {
        candidateCount: 1
      },
      deps
    });
    assert.equal(store.describe(oldestSurvivor).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE, 'a preview that produced a committed schedule is not shed');
    assert.equal(store.entries().length, 4, 'three shedable plus one protected');
    assert.equal(store.describe(ids[3]).lifecycle, PREVIEW_LIFECYCLE.MISSING, 'uncommitted previews are still shed');
    assert.equal(store.describe(ids[2]).lifecycle, PREVIEW_LIFECYCLE.AVAILABLE);
  } finally {
    cleanup();
  }
});
test('X7. a commit against a store with no describe() still works, and says NOT_TRACKED', async () => {
  const s = await seededDir();
  try {
    const scheduleStore = new ScheduleStore({
      dir: s.dir
    });
    const previews = new PreviewStore(6);
    await previews.put(s.requestId, [{
      id: s.solutions[0].id,
      solution: {
        rank: 1,
        globalScore: 0.5,
        qualityScore: 0.1
      },
      candidate: realCandidate(),
      strategy: null
    }]);
    const c = await commitService({
      requestId: s.requestId,
      solutionId: s.solutions[0].id,
      deps: {
        loadDataset: () => loadSchedulingFixture(),
        previewStore: previews,
        scheduleStore
      }
    });
    assert.equal(c.status, 200, JSON.stringify(c.payload));
    assert.equal(c.payload.committed, true);
    assert.equal(c.payload.preview.integrity, PREVIEW_INTEGRITY.NOT_TRACKED);
    assert.equal(scheduleStore.list().length, 1);
  } finally {
    s.cleanup();
  }
});
test('X8. the store refuses a record factory that is not a factory', async () => {
  const {
    dir,
    cleanup
  } = emptyDir('p34-badrec');
  try {
    const store = new ScheduleStore({
      dir
    });
    const id = scheduleIdFor('req-x', 'ms-y');
    await assert.rejects(() => store.create(id, {
      scheduleId: id,
      version: 1
    }), e => {
      assert.equal(e instanceof ScheduleStoreError, true);
      assert.equal(e.code, 'MALFORMED_RECORD');
      return true;
    });
    await assert.rejects(() => store.create(id, () => ScheduleStore.buildRecord({
      scheduleId: 'sch-0000000000000000',
      requestId: 'r',
      solutionId: 's',
      version: 1,
      rows: [],
      contentHash: 'h',
      audit: null,
      clockValue: 'now',
      validated: true
    })), e => {
      assert.equal(e.code, 'MALFORMED_RECORD');
      return true;
    });
    assert.equal(store.list().length, 0);
  } finally {
    cleanup();
  }
});
