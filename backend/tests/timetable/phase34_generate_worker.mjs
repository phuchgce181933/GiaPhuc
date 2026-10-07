// PHASE 34 TEST WORKER -- generate a real preview, in its own process.
//
// WHY A SEPARATE PROCESS AND NOT ANOTHER INSTANCE IN THIS ONE
// -----------------------------------------------------------
// Brief 16 asks for `process A generates -> process A stops ->
// process B commits`. Two store OBJECTS in one Node process share a
// heap, a module registry and a working directory, and the evidence
// they produce cannot distinguish "the preview survived" from "the
// preview never left memory". Spawning a child is the only way to
// make the claim honest.
//
// The child does a real `generateSchedules` against the real
// dataset and writes a real `DurablePreviewStore`. It prints the
// requestId and solution ids, and the parent -- a different process,
// with a different store instance, built from scratch -- commits from
// them. Nothing is shared but the directory on disk.
//
// Usage: node phase34_generate_worker.mjs <persistenceDir>

import { DurablePreviewStore } from '../../src/modules/timetable/engine/persistence/preview-store.js';
import { ScheduleStore } from '../../src/modules/timetable/engine/persistence/schedule-store.js';
import { generateSchedules } from '../../src/modules/timetable/engine/api/generate.js';
import { loadSchedulingFixture } from './helpers/scheduling-fixture.js';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: phase34_generate_worker.mjs <persistenceDir>\n');
  process.exit(2);
}

const previewStore = new DurablePreviewStore({ dir, limit: 8 });
const scheduleStore = new ScheduleStore({ dir });

const deps = {
  loadDataset: () => loadSchedulingFixture(),
  previewStore,
  scheduleStore,
  aiProviderName: 'mock',
  // No planner: the deterministic path keeps the worker free of any
  // dependency on a Python service, so the test measures persistence
  // and not an AI provider's availability.
  makePlanner: () => null,
};

const generated = await generateSchedules({ body: { candidateCount: 3,  }, deps });
const payload = generated.payload;

process.stdout.write(JSON.stringify({
  status: generated.status,
  requestId: payload.requestId,
  previewPersistence: payload.previewPersistence,
  solutions: payload.solutions.map((s) => ({
    id: s.id,
    rank: s.rank,
    globalScore: s.globalScore ?? null,
    qualityScore: s.qualityScore ?? null,
    slotCount: s.placements?.length ?? 0,
  })),
  counts: payload.diagnostics?.data?.provenance?.counts ?? null,
  pid: process.pid,
}));
