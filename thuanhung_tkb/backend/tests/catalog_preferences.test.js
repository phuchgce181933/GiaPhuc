import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { PreviewStore } from '../src/api/generate.js';
import { ScheduleStore } from '../src/persistence/schedule-store.js';
import { TeacherPreferenceStore } from '../src/persistence/teacher-preference-store.js';
import { loadBenchmarkDataset } from '../src/benchmark/dataset.js';
import { loadFromLegacySaplich } from '../src/loader/legacy-saplich/index.js';

test('teacher preference API persists values through reload into accepted schedule generation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-preferences-'));
  const preferenceStore = new TeacherPreferenceStore(join(dir, 'teacher-preferences.json'));
  const model = loadFromLegacySaplich().normalized;
  const teacher = model.teachers[0];
  const app = createApp({
    preferenceStore,
    previewStore: new PreviewStore(2),
    scheduleStore: new ScheduleStore({ dir: join(dir, 'schedules') }),
    loadDataset: () => loadBenchmarkDataset({ preferenceStore }),
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const initialPreference = await fetch(`${base}/api/teachers/${teacher.id}/preferences`).then((r) => r.json());
    assert.ok(['morning', 'afternoon', 'both'].includes(initialPreference.preference.preferredSession));
    const legacySession = await fetch(`${base}/api/teachers/${teacher.id}/preferences`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferredSession: 'ca_hai' }),
    });
    assert.equal(legacySession.status, 200);
    assert.equal((await legacySession.json()).preference.preferredSession, 'both');
    const saved = await fetch(`${base}/api/teachers/${teacher.id}/preferences`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferredSession: 'afternoon', desiredTeachingSessionsPerWeek: 4 }),
    });
    assert.equal(saved.status, 200);
    const reloaded = await fetch(`${base}/api/teachers/${teacher.id}/preferences`).then((r) => r.json());
    assert.equal(reloaded.preference.preferredSession, 'afternoon');
    assert.equal(reloaded.preference.desiredTeachingSessionsPerWeek, 4);

    const staleBranches = await fetch(`${base}/api/teachers/${teacher.id}/preferences`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferredTransferBranchIds: ['removed-branch-id'] }),
    });
    assert.equal(staleBranches.status, 200);
    assert.deepEqual((await staleBranches.json()).preference.preferredTransferBranchIds, []);
    const invalidSessions = await fetch(`${base}/api/teachers/${teacher.id}/preferences`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ desiredTeachingSessionsPerWeek: 2.5 }),
    });
    assert.equal(invalidSessions.status, 400);
    assert.equal((await invalidSessions.json()).errors[0].field, 'desiredTeachingSessionsPerWeek');

    const generated = await fetch(`${base}/api/schedules/generate?placements=all`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateCount: 1, useAI: false }),
    }).then((r) => r.json());
    assert.equal(generated.solutions.length, 1);
    const loaded = loadBenchmarkDataset({ preferenceStore });
    assert.equal(loaded.input.teacherIndex.get(teacher.id).nguyenVong.buoiUuTien, 'chieu');
    assert.equal(loaded.input.teacherIndex.get(teacher.id).nguyenVong.desiredTeachingSessionsPerWeek, 4);
    const solution = generated.solutions[0];
    assert.equal(solution.metrics.accepted, true);
    assert.equal(solution.metrics.hardViolations, 0);
    assert.ok(solution.metrics.preferenceBreakdown);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
