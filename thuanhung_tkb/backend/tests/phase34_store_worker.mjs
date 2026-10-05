// PHASE 34 TEST WORKER -- claim schedule versions, in its own process.
//
// Brief 5/6 asks for version allocation that two processes cannot
// collide on. That cannot be proven with two objects in one process:
// they share a module registry, and an in-process mutex would hide a
// missing cross-process guarantee rather than expose it. So several
// of these run at once, each writing to the same directory with its
// own `ScheduleStore` built from scratch.
//
// Each record is a genuine store write -- the same
// `writeTemp -> fsync -> link` path a commit takes -- so the test is
// measuring the allocation, not a mock of it.
//
// Usage: node phase34_store_worker.mjs <dir> <tag> <count>

import { ScheduleStore, scheduleIdFor } from '../src/persistence/schedule-store.js';

const [dir, tag, countRaw] = process.argv.slice(2);
if (!dir || !tag) {
  process.stderr.write('usage: phase34_store_worker.mjs <dir> <tag> <count>\n');
  process.exit(2);
}
const count = Number(countRaw ?? 1);

const store = new ScheduleStore({ dir });
const results = [];

for (let i = 0; i < count; i += 1) {
  const requestId = `req-${tag}`;
  const solutionId = `ms-${tag}-${i}`;
  const scheduleId = scheduleIdFor(requestId, solutionId);
  const rows = [{
    assignmentId: `a-${tag}-${i}`,
    classId: 'c-1',
    subjectId: 's-1',
    teacherId: 't-1',
    branchId: 'b-1',
    day: 1,
    session: 'sang',
    period: 1,
  }];
  // The factory, not a record: the store allocates the version, which
  // is the whole property under test.
  const outcome = await store.create(scheduleId, (version) => ScheduleStore.buildRecord({
    scheduleId,
    requestId,
    solutionId,
    version,
    rows,
    contentHash: `hash-${tag}-${i}`,
    audit: null,
    clockValue: new Date().toISOString(),
    validated: true,
  }));
  results.push({
    scheduleId,
    version: outcome.record.version,
    created: outcome.created,
  });
}

process.stdout.write(JSON.stringify({ pid: process.pid, results }));
