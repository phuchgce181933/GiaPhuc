// PHASE 33 â€” SCHEDULE COMMIT + PERSISTENCE TESTS.
//
// The twenty checks brief Â§35 names are numbered 1-20 in that order
// and named in their titles, so a reader can map this file to the
// brief without cross-referencing.
//
// THESE RUN AGAINST REAL HTTP AND THE REAL DATASET
// ------------------------------------------------
// The flow under test is the one a user performs: generate 3
// solutions, pick one, commit it. On the legacy-derived real
// SchedulingInput that is 40 teachers, 7 branches, 113 classes, 479
// assignments and 802 periods per solution, so check 5 and check 6
// assert a count that only this dataset produces â€” a fixture would
// make "802 slots persisted" a claim about the fixture.
//
// Each boot gets a fresh `ScheduleStore` in a temporary directory, so
// nothing here writes to the operator's `backend/data/schedules` and
// no test can pass because of a file another test left behind.
//
// WHERE THE HARD-FEASIBILITY FIXTURES COME FROM
// ---------------------------------------------
// Checks 14, 15 and 27 need candidates the solver will never produce:
// a double-booked class, an inactive teacher, a stale slot. They are
// injected straight into the `PreviewStore`, which is the only way to
// reach that path â€” the HTTP surface can only ever store what the
// solver emitted. That is deliberate: it means checks 14/15/27 test
// the COMMIT GATE rather than the solver's ability to avoid the
// problem.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApp } from '../src/app.js';
import { PreviewStore, commit as commitService } from '../src/api/generate.js';
import { COMMIT_STATUS } from '../src/api/commit.js';
import { ScheduleStore, scheduleIdFor } from '../src/persistence/schedule-store.js';
import { buildScheduleRows, compareRows, contentHash, normalizeReadback } from '../src/persistence/schedule-record.js';
import { loadBenchmarkDataset } from '../src/benchmark/dataset.js';
import { evaluateCandidate, isAccepted, CATALOG_BY_ID, listHard } from '../src/domain/constraints/index.js';
import { DeterministicMockAIPlanner } from '../src/domain/ai/index.js';
import { generateSolutions } from '../src/domain/multi-solution.js';

/** What the real dataset produces, asserted rather than assumed. */
const REAL = { teachers: 40, classes: 113, assignments: 479, periods: 802 };

// ============================================================================
// Dataset-derived fixtures
// ============================================================================
//
// The entity ids in this dataset are legacy ObjectId strings, so they
// are READ from the data rather than typed here. A hard-coded id is a
// test that breaks the next time the legacy dump is re-exported, and a
// fixture that silently stops matching is a fixture that stops testing.

let cachedFixture = null;
function fixture() {
  if (cachedFixture) return cachedFixture;
  const loaded = loadBenchmarkDataset();
  const { input } = loaded;

  // Two assignments that share a CLASS, so the same (day, period) is
  // an H01 double-booking rather than two unrelated slots.
  const byClass = new Map();
  for (const a of input.assignments) {
    if (!byClass.has(a.classId)) byClass.set(a.classId, []);
    byClass.get(a.classId).push(a);
  }
  const [, sameClass] = [...byClass.entries()].find(([, v]) => v.length >= 2);
  const branch = input.branches.find((b) => b.id === sameClass[0].branchId);
  // Keep injected rows on the new production calendar (avoid Monday M1).
  const day = branch.schoolDays.find((value) => value !== 1) ?? branch.schoolDays[0];
  const period = branch.periods.find((value) => !(day === 5 && value === 4)) ?? branch.periods[0];

  cachedFixture = {
    input,
    provenance: loaded.provenance,
    first: sameClass[0],
    second: sameClass[1],
    multiPeriod: input.assignments.find((a) => a.requiredPeriods > 1),
    branchId: branch.id,
    day,
    period,
    teacherId: input.teachers[0].id,
    // A teacher record the tests can mark inactive without touching
    // the real one.
    teacher: input.teachers[0],
  };
  return cachedFixture;
}

/**
 * A candidate the solver actually produced, from the real dataset.
 *
 * The first version of this file hand-built a "feasible" candidate by
 * putting every assignment on day 1. It was not feasible â€” a class
 * with three assignments overflowed the branch profile (H06) and a
 * teacher with two assignments was double-booked (H02) â€” and three
 * checks failed for that reason rather than for the reason they were
 * written to test.
 *
 * Using a real solver output removes the whole class of problem: the
 * baseline is genuinely accepted by the evaluator, so a check that
 * expects a rejection is rejecting a candidate that WAS valid, and a
 * check that expects acceptance is not accidentally passing on a
 * fixture that was never feasible.
 */
let cachedCandidate = null;
function realCandidate() {
  if (cachedCandidate) return copyCandidate(cachedCandidate);
  const { input } = fixture();
  const generated = generateSolutions(input, {
    perSolveTimeBudgetMs: 10_000,
    overallTimeBudgetMs: 60_000,
    maxSearchIterations: 12,
    respectStrategyMode: true,
    requireFeasibility: true,
    count: 1,
    seed: 0xC0FFEE,
  });
  const candidate = generated.solutions[0]?.candidate;
  assert.ok(candidate, 'the solver produced a candidate for the real dataset');
  // Assert the baseline really is feasible, so a later failure is
  // about the mutation and not about the fixture.
  assert.equal(isAccepted(evaluateCandidate(candidate, input)), true, 'the baseline candidate is feasible');
  cachedCandidate = candidate;
  return copyCandidate(candidate);
}

/** A deep-enough copy that a mutation cannot reach the cached original. */
function copyCandidate(src) {
  return {
    assignments: new Map([...src.assignments].map(([k, slots]) => [k, slots.map((s) => ({ ...s }))])),
    placements: new Map([...src.placements].map(([k, p]) => [k, { ...p }])),
  };
}

// ============================================================================
// Harness
// ============================================================================

async function withServer(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-'));
  const schedules = new ScheduleStore({ dir });
  const previews = new PreviewStore(6);
  const app = createApp({ previewStore: previews, scheduleStore: schedules });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (path, body) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  const get = async (path) => {
    const res = await fetch(base + path);
    return { status: res.status, json: JSON.parse(await res.text()) };
  };
  // A raw-body call, for the malformed-JSON case where `JSON.stringify`
  // would be doing the encoding for us.
  const raw = async (path, text) => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
    return { status: res.status, text: await res.text() };
  };
  const generate = async (body = { candidateCount: 3, useAI: false }) =>
    call('/api/schedules/generate?placements=all', body);

  try {
    return await fn({ call, get, raw, generate, schedules, previews, dir, base });
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The committed record files in a store directory. */
function storedFiles(dir) {
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
}

// ============================================================================
// 1-3. generate, select, commit
// ============================================================================

test('1. generate produces three accepted solutions from the real dataset', async () => {
  await withServer(async ({ generate }) => {
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
  await withServer(async ({ generate }) => {
    const r = await generate();
    const chosen = r.json.solutions[1];
    assert.equal(chosen.rank, 2);
    assert.match(chosen.id, /^ms-[0-9a-f]{8}$/);
    // Selection is an identity, not an array index: the chosen id is
    // the one the backend issued, and nothing about it is derived on
    // the client.
    assert.equal(r.json.solutions.filter((s) => s.id === chosen.id).length, 1);
  });
});

test('3. committing a valid solution returns 200 COMMITTED with a schedule id', async () => {
  await withServer(async ({ generate, call, schedules }) => {
    const g = await generate();
    const solutionId = g.json.solutions[1].id;
    const c = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId });

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
    // Exactly one record on disk.
    assert.equal(schedules.list().length, 1);
    assert.deepEqual(storedFiles(schedules.dir).length, 1);
  });
});

// ============================================================================
// 4. revalidation before commit
// ============================================================================

test('4. the backend re-validates with the independent evaluator before writing', async () => {
  await withServer(async ({ generate, call, schedules, previews }) => {
    const f = fixture();
    const g = await generate();
    const good = g.json.solutions[0].id;

    // Two assignments of the SAME class at the same (day, period):
    // the exact thing H01 exists to catch. Injected into the store so
    // the commit gate is reached with a schedule the solver would
    // never emit.
    const broken = {
      id: 'ms-deadbeef',
      solution: { id: 'ms-deadbeef', rank: 9 },
      candidate: {
        assignments: new Map([
          [f.first.id, [{ branchId: f.branchId, day: f.day, period: f.period }]],
          [f.second.id, [{ branchId: f.branchId, day: f.day, period: f.period }]],
        ]),
        placements: new Map([
          [f.first.id, { teacherId: f.first.teacherId, branchId: f.branchId }],
          [f.second.id, { teacherId: f.second.teacherId, branchId: f.branchId }],
        ]),
      },
    };
    previews.put('req-injected', [broken]);

    const bad = await call('/api/schedules/commit', { requestId: 'req-injected', solutionId: 'ms-deadbeef' });
    assert.equal(bad.status, 409);
    assert.equal(bad.json.status, COMMIT_STATUS.REJECTED);
    assert.equal(bad.json.error.code, 'HARD_VIOLATION');
    assert.equal(bad.json.persisted, false);
    assert.equal(bad.json.written, undefined, 'a rejected commit reports no write at all');
    assert.ok(bad.json.validation.hardViolations > 0);
    assert.ok(
      bad.json.validation.reasons.some((r) => r.includes('[H01]')),
      `expected an H01 reason, got ${JSON.stringify(bad.json.validation.reasons)}`,
    );

    // The store is untouched by the rejection, and the good solution
    // still commits afterwards â€” the failure was about the candidate,
    // not about the store.
    assert.deepEqual(schedules.list(), []);
    const ok = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: good });
    assert.equal(ok.status, 200);
    assert.equal(schedules.list().length, 1);
  });
});

// ============================================================================
// 5-7. persist, readback, semantic match
// ============================================================================

test('5. the commit persists exactly 802 slots â€” the full real dataset', async () => {
  await withServer(async ({ generate, call, schedules }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id,
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
  await withServer(async ({ generate, call, get, schedules }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[2].id,
    });
    const scheduleId = c.json.scheduleId;

    // A fresh store instance, so the read does not reuse anything the
    // committing process had in memory.
    const cold = new ScheduleStore({ dir: schedules.dir });
    const raw = cold.read(scheduleId);
    assert.equal(raw.slots.length, REAL.periods);

    const overHttp = await get(`/api/schedules/committed/${scheduleId}/full`);
    assert.equal(overHttp.status, 200);
    assert.equal(overHttp.json.schedule.slots.length, REAL.periods);
    assert.equal(overHttp.json.schedule.contentHash, c.json.contentHash);

    // The header endpoint does not carry the rows.
    const header = await get(`/api/schedules/committed/${scheduleId}`);
    assert.equal(header.status, 200);
    assert.equal(header.json.schedule.slots, undefined);
    assert.equal(header.json.schedule.slotCount, REAL.periods);
  });
});

test('7. the read-back schedule is semantically identical to the committed candidate', async () => {
  await withServer(async ({ generate, call, schedules }) => {
    const g = await generate();
    const chosen = g.json.solutions[1];

    // The candidate as the response described it...
    const expected = chosen.placements
      .map((p) => ({
        assignmentId: p.assignmentId,
        classId: p.classId,
        subjectId: p.subjectId,
        teacherId: p.teacherId,
        branchId: p.branchId,
        day: p.day,
        session: p.session,
        period: p.period,
      }));

    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: chosen.id,
    });
    // ...and the candidate as it came back off disk.
    const readBack = normalizeReadback(schedules.read(c.json.scheduleId));
    const diff = compareRows(expected, readBack);

    assert.equal(diff.equal, true, `read-back differs: ${JSON.stringify(diff)}`);
    assert.equal(diff.leftCount, REAL.periods);
    assert.equal(diff.rightCount, REAL.periods);
    assert.equal(diff.onlyInLeft.length, 0);
    assert.equal(diff.onlyInRight.length, 0);
    // The hash the response promised is the hash of the rows that are
    // actually there.
    assert.equal(contentHash(readBack), c.json.contentHash);
  });
});

// ============================================================================
// 8. invalid candidate rejected
// ============================================================================

test('8. an invalid candidate is rejected and the store is byte-identical', async () => {
  await withServer(async ({ generate, call, schedules, previews, dir }) => {
    const f = fixture();
    const g = await generate();
    await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: g.json.solutions[0].id });
    const before = storedFiles(dir).map((n) => `${n}:${schedules.read(n.slice(0, -5)).contentHash}`);

    previews.put('req-bad', [{
      id: 'ms-0000bad0',
      solution: { id: 'ms-0000bad0', rank: 1 },
      candidate: {
        // H05: an assignment that requires two periods but is given
        // one. Partial fulfilment is a hard violation by design.
        assignments: new Map([[f.multiPeriod.id, [{ branchId: f.multiPeriod.branchId, day: 1, period: 1 }]]]),
        placements: new Map([[f.multiPeriod.id, { teacherId: f.multiPeriod.teacherId, branchId: f.multiPeriod.branchId }]]),
      },
    }]);

    const c = await call('/api/schedules/commit', { requestId: 'req-bad', solutionId: 'ms-0000bad0' });
    assert.equal(c.status, 409);
    assert.equal(c.json.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.json.persisted, false);
    assert.ok(c.json.validation.reasons.some((r) => r.includes('[H05]')));

    const after = storedFiles(dir).map((n) => `${n}:${schedules.read(n.slice(0, -5)).contentHash}`);
    assert.deepEqual(after, before, 'a rejected commit changed nothing on disk');
  });
});

// ============================================================================
// 9-10. malformed request
// ============================================================================

test('9. a malformed commit request is refused with 4xx and writes nothing', async () => {
  await withServer(async ({ generate, call, raw, schedules, dir }) => {
    const g = await generate();
    const rid = g.json.requestId;
    const sid = g.json.solutions[0].id;

    const cases = [
      ['missing solutionId', { requestId: rid }],
      ['missing requestId', { solutionId: sid }],
      ['empty body', {}],
      ['solutionId is a number', { requestId: rid, solutionId: 3 }],
      ['solutionId is an object', { requestId: rid, solutionId: { id: sid } }],
      ['requestId is a number', { requestId: 1, solutionId: sid }],
      ['solutionId is null', { requestId: rid, solutionId: null }],
      ['unknown extra field', { requestId: rid, solutionId: sid, note: 'hello' }],
    ];
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
  await withServer(async ({ generate, call, schedules, dir }) => {
    const g = await generate();
    const unknownRequest = await call('/api/schedules/commit', { requestId: 'req-999999', solutionId: 'ms-00000000' });
    assert.equal(unknownRequest.status, 404);
    assert.equal(unknownRequest.json.error.code, 'UNKNOWN_REQUEST');

    const unknownSolution = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: 'ms-deadbeef',
    });
    assert.equal(unknownSolution.status, 404);
    assert.equal(unknownSolution.json.error.code, 'UNKNOWN_SOLUTION');
    assert.ok(Array.isArray(unknownSolution.json.error.available));

    assert.deepEqual(storedFiles(dir), []);
  });
});

// ============================================================================
// 11. altered client payload
// ============================================================================

test('11. a client cannot alter the candidate: a forged schedule is refused, not saved', async () => {
  await withServer(async ({ generate, call, schedules, dir }) => {
    const g = await generate();
    const sid = g.json.solutions[0].id;

    // The attack: name a solution AND post the timetable you want
    // saved, with a different teacher, day, period and branch.
    const forged = {
      requestId: g.json.requestId,
      solutionId: sid,
      teacherId: 'GV-9999',
      branchId: 'BR-07',
      day: 6,
      session: 'chieu',
      period: 7,
      placements: [{ assignmentId: 'a-000001', teacherId: 'GV-9999', day: 6, period: 7 }],
    };
    const refused = await call('/api/schedules/commit', forged);
    assert.equal(refused.status, 400, 'a body that carries a schedule is refused outright');
    assert.equal(refused.json.errors[0].code, 'FORBIDDEN_FIELD');
    assert.deepEqual(storedFiles(dir), [], 'nothing was written from a forged body');

    // The legitimate commit that follows stores the BACKEND's
    // candidate: the real teacher, the real day, the real period.
    const ok = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: sid });
    assert.equal(ok.status, 200);
    const rows = schedules.read(ok.json.scheduleId).slots;
    assert.equal(rows.length, REAL.periods);
    assert.equal(rows.some((r) => r.teacherId === 'GV-9999'), false, 'the forged teacher was not persisted');
    assert.equal(rows.some((r) => r.day === 6 && r.period === 7 && r.teacherId === 'GV-9999'), false, 'the forged slot was not persisted');
    assert.equal(rows.some((r) => r.branchId === 'BR-07'), false, 'the forged branch was not persisted');
  });
});

// ============================================================================
// 12. double commit
// ============================================================================

test('12. committing the same solution twice is safe and creates no duplicate', async () => {
  await withServer(async ({ generate, call, schedules, dir }) => {
    const g = await generate();
    const sid = g.json.solutions[0].id;
    const body = { requestId: g.json.requestId, solutionId: sid };

    const first = await call('/api/schedules/commit', body);
    const second = await call('/api/schedules/commit', body);
    // A third, in the same tick, which is what a double click looks
    // like on the wire.
    const [third] = await Promise.all([
      call('/api/schedules/commit', body),
      call('/api/schedules/commit', body),
    ]);

    for (const r of [first, second, third]) {
      assert.equal(r.status, 200);
      assert.equal(r.json.committed, true);
      assert.equal(r.json.scheduleId, first.json.scheduleId, 'every commit of one solution yields one id');
    }
    assert.equal(first.json.duplicate, false);
    assert.equal(second.json.duplicate, true);
    assert.equal(second.json.status, COMMIT_STATUS.COMMITTED_DUPLICATE);

    // One file. One record. The same content hash throughout.
    assert.deepEqual(storedFiles(dir).length, 1);
    assert.equal(schedules.list().length, 1);
    assert.equal(schedules.list()[0].version, first.json.version, 'a replay does not mint a new version');
    assert.equal(schedules.read(first.json.scheduleId).contentHash, third.json.contentHash);
  });
});

test('12b. two concurrent commits of DIFFERENT solutions both land, neither overwrites', async () => {
  await withServer(async ({ generate, call, schedules }) => {
    const g = await generate();
    const [a, b] = await Promise.all([
      call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: g.json.solutions[0].id }),
      call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: g.json.solutions[1].id }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.json.scheduleId, b.json.scheduleId);

    // Both exist, both are complete, and the versions differ â€” the
    // policy is append-only versioning, not last-write-wins.
    const listed = schedules.list();
    assert.equal(listed.length, 2);
    assert.equal(schedules.read(a.json.scheduleId).slots.length, REAL.periods);
    assert.equal(schedules.read(b.json.scheduleId).slots.length, REAL.periods);
    const versions = listed.map((r) => r.version).sort();
    assert.deepEqual(versions, [1, 2]);
    assert.equal(a.json.contentHash !== b.json.contentHash, true, 'two solutions are two timetables');
  });
});

// ============================================================================
// 13. no partial persistence
// ============================================================================

test('13. a commit is all-or-nothing: the record appears complete or not at all', async () => {
  await withServer(async ({ generate, call, schedules, dir }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id,
    });

    // Exactly one file, and it is whole. There is no intermediate
    // state a reader could catch, because the record becomes visible
    // under its real name only after every byte is on disk.
    const files = storedFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], `${c.json.scheduleId}.json`);
    assert.equal(files.some((n) => n.startsWith('.tmp-')), false, 'no temp file survives a successful commit');

    const record = schedules.read(c.json.scheduleId);
    assert.equal(record.slots.length, c.json.slotCount);
    assert.equal(record.slots.length, REAL.periods);

    // A store constructed over the directory â€” as a second process
    // would â€” sees the whole record, never a prefix.
    const reopened = new ScheduleStore({ dir });
    assert.equal(reopened.read(c.json.scheduleId).slots.length, REAL.periods);
    assert.equal(reopened.read(c.json.scheduleId).contentHash, c.json.contentHash);
  });
});

// ============================================================================
// 14. inactive entity
// ============================================================================

test('14. a schedule naming an inactive teacher is rejected and never committed', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-inactive-'));
  try {
    const schedules = new ScheduleStore({ dir });
    const previews = new PreviewStore(6);

    // The real dataset has no inactive teacher, so the condition is
    // created deliberately: the same SchedulingInput with ONE teacher
    // marked inactive. H08 is a catalog constraint and reads the
    // input, so this exercises the real gate rather than a
    // commit-specific one.
    const input = {
      ...f.input,
      teachers: f.input.teachers.map((t) => (t.id === f.teacherId ? { ...t, trangThai: 'inactive' } : t)),
    };
    previews.put('req-inactive', [{
      id: 'ms-inactive',
      solution: { id: 'ms-inactive', rank: 1 },
      candidate: realCandidate(),
    }]);

    const c = await commitService({
      requestId: 'req-inactive',
      solutionId: 'ms-inactive',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({ input, provenance: f.provenance }),
      },
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.status, COMMIT_STATUS.REJECTED);
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.written, undefined);
    assert.ok(
      c.payload.validation.reasons.some((r) => r.includes('[H08]')),
      `expected an H08 reason, got ${JSON.stringify(c.payload.validation.reasons)}`,
    );
    assert.deepEqual(schedules.list(), []);
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('14b. the placeholder teacher id is refused by the write path, not only by H08', async () => {
  const f = fixture();
  // `CN-TH` is the placeholder the legacy dump carries and which the
  // brief names explicitly. H08 reads the ASSIGNMENT's teacher, so a
  // candidate whose PLACEMENT points at `CN-TH` would pass the
  // catalog and reach the row builder â€” which is why the row builder
  // has its own gate. Both layers are asserted here: the catalog
  // verdict is ACCEPTED, and the commit still refuses.
  const candidate = realCandidate();
  candidate.placements.set(f.first.id, { teacherId: 'CN-TH', branchId: f.branchId });

  const evaluation = evaluateCandidate(candidate, f.input);
  assert.equal(isAccepted(evaluation), true, 'the catalog alone does not catch a forged placement teacher');

  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-placeholder-'));
  try {
    const schedules = new ScheduleStore({ dir });
    const previews = new PreviewStore(6);
    previews.put('req-placeholder', [{ id: 'ms-placeholder', solution: { id: 'ms-placeholder', rank: 1 }, candidate }]);
    const c = await commitService({
      requestId: 'req-placeholder',
      solutionId: 'ms-placeholder',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({ input: f.input, provenance: f.provenance }),
      },
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.error.code, 'UNRESOLVABLE_SLOTS');
    assert.ok(
      c.payload.validation.reasons.some((r) => r.includes('INACTIVE_TEACHER')),
      `expected the placeholder refusal, got ${JSON.stringify(c.payload.validation.reasons)}`,
    );
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 15-16. H14 / H13 unchanged
// ============================================================================

test('15. H14 is still UNSUPPORTED and commit does not claim travel was checked', async () => {
  await withServer(async ({ generate, call, get }) => {
    const g = await generate();
    const health = await get('/api/schedules/health');
    assert.equal(health.json.travel.h14, 'UNSUPPORTED');
    assert.equal(g.json.travel.h14, 'UNSUPPORTED');

    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id,
    });
    // A commit that asserted travel feasibility would be a claim the
    // data cannot support.
    assert.equal(c.json.travel.h14, 'UNSUPPORTED');
    assert.equal(c.json.validation.constraintStatuses.H14, 'UNSUPPORTED');
  });
});

test('16. H13 is still INACTIVE and commit reports it rather than passing it', async () => {
  await withServer(async ({ generate, call, get }) => {
    const g = await generate();
    const health = await get('/api/schedules/health');
    assert.equal(health.json.transfer.h13, 'INACTIVE');
    assert.equal(g.json.transfer.h13, 'INACTIVE');

    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id,
    });
    // INACTIVE is not PASS. The commit response must not collapse the
    // two, or a reader would conclude transfers were verified.
    assert.equal(c.json.transfer.h13, 'INACTIVE');
    assert.equal(c.json.validation.constraintStatuses.H13, 'INACTIVE');
    assert.equal(c.json.validation.hardViolations, 0);
  });
});

// ============================================================================
// 17. AI is not called during commit
// ============================================================================

test('17. commit never calls the AI layer', async () => {
  const { generateSchedules } = await import('../src/api/generate.js');
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-ai-'));
  try {
    const previews = new PreviewStore(6);
    const schedules = new ScheduleStore({ dir });
    // A counting wrapper around the real deterministic planner: the
    // counter proves the boundary, and the real planner proves the
    // generation path itself is unchanged.
    const inner = new DeterministicMockAIPlanner();
    const planner = { name: 'counting-planner', calls: 0, plan: (...a) => { planner.calls += 1; return inner.plan(...a); } };
    const deps = {
      loadDataset: () => loadBenchmarkDataset(),
      previewStore: previews,
      scheduleStore: schedules,
      aiProviderName: 'counting-planner',
      makePlanner: () => planner,
    };

    const g = await generateSchedules({ body: { candidateCount: 3, useAI: true }, deps });
    assert.equal(g.status, 200);
    const afterGenerate = planner.calls;
    assert.ok(afterGenerate > 0, 'the AI layer was consulted at generation time');

    const c = await commitService({
      requestId: g.payload.requestId,
      solutionId: g.payload.solutions[0].id,
      deps,
    });
    assert.equal(c.status, 200);
    assert.equal(planner.calls, afterGenerate, 'commit called the AI planner');

    // And the response says so, so the UI does not have to guess.
    assert.equal(c.payload.ai.used, false);
    assert.equal(c.payload.ai.reason, 'COMMIT_DOES_NOT_CALL_AI');

    // The record keeps WHICH strategy the candidate came from â€” a
    // fact about generation, recorded at commit time, with no prompt
    // or model response attached.
    const record = schedules.read(c.payload.scheduleId);
    assert.equal(record.audit.ai.provider, 'counting-planner');
    assert.equal(typeof record.audit.ai.used, 'boolean');
    assert.equal(typeof record.audit.inputHash, 'string');
    assert.equal(record.audit.rawPrompt, undefined);
    assert.equal(record.audit.modelResponse, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 18. preview remains non-persistent
// ============================================================================

test('18. generating stays preview-only: PREVIEW_ONLY survives as a generate-time fact', async () => {
  await withServer(async ({ generate, call, get, schedules }) => {
    const g = await generate();
    // Generate says nothing about persistence and writes nothing; the
    // commit endpoint is the only thing that writes, and it must be
    // called explicitly.
    assert.equal(g.json.persistence, undefined);
    assert.deepEqual(schedules.list(), []);
    const list = await get('/api/schedules/committed');
    assert.equal(list.json.count, 0);

    await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: g.json.solutions[0].id });
    const after = await get('/api/schedules/committed');
    assert.equal(after.json.count, 1);
    assert.equal(after.json.schedules[0].status, 'COMMITTED');
    assert.equal(after.json.schedules[0].slotCount, REAL.periods);
  });
});

// ============================================================================
// 19-20. identifiable, durable, source untouched
// ============================================================================

test('19. a committed schedule is identifiable by id, by solution, and by content hash', async () => {
  await withServer(async ({ generate, call, get, schedules }) => {
    const g = await generate();
    const chosen = g.json.solutions[1];
    const c = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: chosen.id });

    // The id is DERIVED from the pair, so it is stable across
    // processes and across restarts â€” not a random id that a second
    // commit could not reproduce.
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
  await withServer(async ({ generate, call, schedules, dir }) => {
    const before = loadBenchmarkDataset();
    const g = await generate();
    const c = await call('/api/schedules/commit', {
      requestId: g.json.requestId,
      solutionId: g.json.solutions[0].id,
    });
    const committedHash = c.json.contentHash;

    // Re-read the source. A commit that mutated the legacy raw data,
    // the normalized source, the SchedulingInput, the baseline or the
    // constraint catalog would change one of these stamps.
    const after = loadBenchmarkDataset();
    assert.equal(after.provenance.benchmarkInputHash, before.provenance.benchmarkInputHash);
    assert.equal(after.provenance.datasetShapeHash, before.provenance.datasetShapeHash);
    assert.equal(after.provenance.scoringDefaultsVersion, before.provenance.scoringDefaultsVersion);
    assert.equal(after.provenance.dimensionCatalogVersion, before.provenance.dimensionCatalogVersion);
    assert.equal(after.input.assignments.length, before.input.assignments.length);
    assert.equal(after.input.teachers.length, before.input.teachers.length);
    // And the catalog itself is unchanged: the hard list is still the
    // source of truth, not a hard-coded list in the commit path.
    assert.equal(listHard().length, 17);
    assert.equal(CATALOG_BY_ID.get('H01').code, 'H_CLASS_NO_DOUBLE_BOOK');

    // Durability: a store constructed over the directory from
    // scratch still returns the whole schedule with the same hash.
    const reopened = new ScheduleStore({ dir });
    const record = reopened.read(c.json.scheduleId);
    assert.equal(record.slots.length, REAL.periods);
    assert.equal(contentHash(normalizeReadback(record)), committedHash);
    assert.equal(record.schemaVersion, 1);
  });
});

// ============================================================================
// Guards on properties the phase depends on but does not enumerate
// ============================================================================

test('G1. a candidate carrying one unresolvable row is refused whole, not saved 802 of 803', async () => {
  const f = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-unresolvable-'));
  try {
    const schedules = new ScheduleStore({ dir });
    const previews = new PreviewStore(6);
    // A genuinely feasible candidate PLUS one assignment the backend's
    // data does not contain.
    //
    // The evaluator ACCEPTS this: every catalog constraint walks
    // `input.assignmentIndex`, and an id that is not in the index is
    // skipped by all of them. That is correct for the evaluator — it
    // has nothing to say about an entity it does not have — and it is
    // exactly why the write path needs its own gate. This is the
    // sharpest form of brief §16: 802 of 803 rows are perfectly
    // persistable, and the answer still has to be "not saved".
    const candidate = realCandidate();
    candidate.assignments.set('not-a-real-assignment-id', [
      { branchId: f.branchId, day: f.day, period: f.period },
    ]);
    candidate.placements.set('not-a-real-assignment-id', { teacherId: f.teacherId, branchId: f.branchId });
    // The historical candidate may now fail current calendar/adjacency
    // rules. The critical property here is that commit still independently
    // rejects the extra assignment id, which the catalogue cannot resolve.

    previews.put('req-unresolvable', [{
      id: 'ms-unresolvable',
      solution: { id: 'ms-unresolvable', rank: 1 },
      candidate,
    }]);
    const c = await commitService({
      requestId: 'req-unresolvable',
      solutionId: 'ms-unresolvable',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({ input: f.input, provenance: f.provenance }),
      },
    });
    assert.equal(c.status, 409);
    assert.equal(c.payload.error.code, 'UNRESOLVABLE_SLOTS');
    assert.equal(c.payload.persisted, false);
    assert.equal(c.payload.written, undefined);
    assert.ok(c.payload.validation.reasons.some((r) => r.includes('UNKNOWN_ASSIGNMENT')));
    // Not one row reached the store.
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2. the commit re-checks feasibility without searching or re-ranking', async () => {
  await withServer(async ({ generate, call }) => {
    const g = await generate();
    const chosen = g.json.solutions[0];
    const c = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: chosen.id });

    // The reported score is the score of the candidate the user was
    // SHOWN — commit must not restate a different number for the same
    // schedule, which is what a re-rank would do.
    assert.equal(c.json.score.globalScore, chosen.globalScore);
    assert.equal(c.json.score.qualityScore, chosen.qualityScore);
    // The re-check ran, searched nothing, and agreed.
    assert.equal(c.json.score.recheck.ran, true);
    assert.equal(c.json.score.recheck.searched, false);
    assert.equal(c.json.score.recheck.feasibility, 'FEASIBLE');
    assert.equal(c.json.score.recheck.hardViolations, 0);
    // And the persisted schedule is the one the response showed.
    assert.equal(c.json.slotCount, chosen.placements.length);
  });
});

test('G3. the store is the only thing that writes, and generate cannot reach it', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join: pjoin } = await import('node:path');
  const apiDir = pjoin(process.cwd(), 'src', 'api');

  // PHASE 34: this assertion was tightened, not relaxed.
  //
  // Phase 33 asserted "exactly two files under src/api import
  // ../persistence/ at all". Phase 34 gave `generate.js` the lifecycle
  // vocabulary, so a third file imports a persistence module -- and
  // the letter of the old assertion would have forced a choice between
  // a weaker test and duplicating two string constants.
  //
  // The property underneath is narrower and stronger: GENERATE MUST
  // NOT BE ABLE TO REACH A STORE. So the test now asks that directly,
  // per module, instead of counting files.
  const files = readdirSync(apiDir).filter((f) => f.endsWith('.js'));
  // The `\.js` matters: matching the bare path would also match a
  // directory import, and the first version of this helper dropped it
  // and matched nothing at all -- a test that passed by finding no
  // importers, which is the one way this assertion can be useless.
  const importersOf = (needle) => files
    .filter((file) => new RegExp(`from '\\.\\./persistence/${needle}\\.js'`).test(readFileSync(pjoin(apiDir, file), 'utf8')))
    .sort();

  // The schedule store is the write path. Only the commit service and
  // the route wiring may name it.
  assert.deepEqual(importersOf('schedule-store'), ['commit.js', 'routes.js'],
    'only the commit service and the route wiring may import the schedule store');

  // `generate` may name the preview RECORD -- constants and pure
  // functions, no filesystem access anywhere in the module -- but it
  // must never name a store. That is the actual Phase 34 guarantee,
  // and it is what the old count could not express.
  assert.deepEqual(importersOf('preview-record').includes('generate.js'), true,
    'generate may reuse the lifecycle vocabulary');
  for (const store of ['preview-store', 'schedule-store', 'atomic-file']) {
    assert.equal(importersOf(store).includes('generate.js'), false,
      `generate must not import ${store}`);
  }

  // And the belt-and-braces version: no module under src/api reaches
  // the filesystem directly, so there is no side door around the
  // stores at all.
  for (const file of files) {
    const source = readFileSync(pjoin(apiDir, file), 'utf8');
    assert.equal(/from 'node:fs/.test(source), false, `${file} must not import node:fs`);
  }
});

test('G4. committing survives a store restart: the directory is the source of truth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-restart-'));
  try {
    const { generateSchedules } = await import('../src/api/generate.js');
    const previews = new PreviewStore(6);
    const deps = {
      loadDataset: () => loadBenchmarkDataset(),
      scheduleStore: new ScheduleStore({ dir }),
      aiProviderName: 'mock',
      makePlanner: () => null,
      previewStore: previews,
    };
    const g = await generateSchedules({ body: { candidateCount: 1, useAI: false }, deps });
    const c = await commitService({
      requestId: g.payload.requestId,
      solutionId: g.payload.solutions[0].id,
      deps,
    });
    assert.equal(c.status, 200);

    // A brand-new store, as a restarted process would build, and a
    // brand-new preview store: the candidate is gone, the committed
    // schedule is not.
    const fresh = new ScheduleStore({ dir });
    assert.equal(fresh.list().length, 1);
    assert.equal(fresh.read(c.payload.scheduleId).slots.length, REAL.periods);
    assert.equal(fresh.latest().scheduleId, c.payload.scheduleId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G5. buildScheduleRows and compareRows behave as the round trip requires', () => {
  const f = fixture();
  // Empty candidate -> no rows, no warnings: a null candidate is not
  // a crash and not a phantom violation list.
  assert.deepEqual(buildScheduleRows(null, f.input), { rows: [], warnings: [] });

  // A candidate naming an assignment the input does not have is
  // reported, not silently written with nulls.
  const unknown = buildScheduleRows(
    { assignments: new Map([['not-a-real-assignment', [{ branchId: f.branchId, day: 1, period: 1 }]]]), placements: new Map() },
    f.input,
  );
  assert.equal(unknown.rows.length, 0);
  assert.equal(unknown.warnings[0].code, 'UNKNOWN_ASSIGNMENT');

  // A full candidate builds every period the dataset demands.
  const full = buildScheduleRows(realCandidate(), f.input);
  assert.deepEqual(full.warnings, []);
  assert.equal(full.rows.length, REAL.periods);
  for (const row of full.rows) {
    for (const field of ['assignmentId', 'classId', 'subjectId', 'teacherId', 'branchId', 'day', 'session', 'period']) {
      assert.notEqual(row[field], null, `${field} is present on every row`);
    }
  }

  // compareRows is multiset-aware: one duplicated and one missing row
  // is the same SET and a different schedule.
  const row = { assignmentId: 'a', classId: 'c', subjectId: 's', teacherId: 't', branchId: 'b', day: 1, session: 'sang', period: 1 };
  const other = { ...row, period: 2 };
  assert.equal(compareRows([row, row], [row, other]).equal, false, 'a duplicated row is not a match');
  assert.equal(compareRows([row, other], [row, other]).equal, true);
  assert.equal(compareRows([row], [row, other]).equal, false);

  // The hash is order-independent: the same slots in a different order
  // are the same timetable.
  assert.equal(contentHash([row, other]), contentHash([other, row]));
  assert.notEqual(contentHash([row, other]), contentHash([row, { ...other, day: 2 }]));
});

test('G6. a commit response carries no raw data and no personal fields', async () => {
  await withServer(async ({ generate, call, get }) => {
    const g = await generate();
    const c = await call('/api/schedules/commit', { requestId: g.json.requestId, solutionId: g.json.solutions[0].id });
    const text = JSON.stringify(c.json);
    const header = await get(`/api/schedules/committed/${c.json.scheduleId}`);
    const headerText = JSON.stringify(header.json);

    // The slot table lives behind the explicit read-back endpoint,
    // not in the commit response or the header.
    assert.equal(c.json.slots, undefined);
    assert.equal(header.json.schedule.slots, undefined);
    assert.ok(text.length < 8000, `the commit response is a header, not a payload (${text.length} bytes)`);
    for (const banned of ['hoTen', 'soDienThoai', 'email', 'ngaySinh', 'diaChi']) {
      assert.ok(!text.includes(banned), `no ${banned} in the commit response`);
      assert.ok(!headerText.includes(banned), `no ${banned} in the schedule header`);
    }
    // Audit metadata is identifiers and versions, not prompts.
    const audit = header.json.schedule.audit;
    assert.equal(audit.rawPrompt, undefined);
    assert.equal(audit.modelResponse, undefined);
    assert.equal(typeof audit.inputHash, 'string');
    assert.equal(typeof audit.sourceSolutionId, 'string');
  });
});

test('G7. the evaluator is the only definition of feasible â€” no hard-coded constraint list', async () => {
  const f = fixture();
  // The catalog is the source of truth, and the commit path reaches it
  // only through `evaluateCandidate`. Proof: a candidate that breaks
  // exactly ONE catalog constraint is rejected, and the response
  // names that constraint â€” without the commit code knowing any id.
  const candidate = realCandidate();
  const key = [...candidate.assignments.keys()][0];
  // Move a slot outside the branch profile: H06 only.
  candidate.assignments.set(key, [{ branchId: f.branchId, day: 9, period: 9 }]);

  const evaluation = evaluateCandidate(candidate, f.input);
  assert.equal(isAccepted(evaluation), false);
  const violated = new Set(evaluation.hard.violations.map((v) => v.constraintId));
  assert.ok(violated.has('H06'), `expected H06, got ${[...violated].join(',')}`);

  const dir = mkdtempSync(join(tmpdir(), 'tkb-phase33-catalog-'));
  try {
    const schedules = new ScheduleStore({ dir });
    const previews = new PreviewStore(6);
    previews.put('req-catalog', [{ id: 'ms-catalog', solution: { id: 'ms-catalog', rank: 1 }, candidate }]);
    const c = await commitService({
      requestId: 'req-catalog',
      solutionId: 'ms-catalog',
      deps: {
        previewStore: previews,
        scheduleStore: schedules,
        loadDataset: () => ({ input: f.input, provenance: f.provenance }),
      },
    });
    assert.equal(c.status, 409);
    assert.ok(
      c.payload.validation.reasons.some((r) => r.includes('[H06]')),
      `the commit response names the catalog's own id: ${JSON.stringify(c.payload.validation.reasons)}`,
    );
    assert.deepEqual(storedFiles(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

