import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TeacherPreferenceStore } from '../../src/modules/timetable/engine/persistence/teacher-preference-store.js';
test('preference persistence: simultaneous teachers are both retained', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-preference-test-'));
  try {
    const store = new TeacherPreferenceStore(join(dir, 'preferences.json'));
    await Promise.all([store.put('A', {
      preferredSession: 'morning'
    }), store.put('B', {
      preferredSession: 'afternoon'
    })]);
    assert.deepEqual(Object.keys(store.readAll()).sort(), ['A', 'B']);
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('preference persistence: corrupt JSON is not overwritten by a later save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-preference-test-')),
    file = join(dir, 'preferences.json');
  try {
    writeFileSync(file, '{"A":');
    const store = new TeacherPreferenceStore(file);
    assert.throws(() => store.readAll());
    await assert.rejects(store.put('B', {
      preferredSession: 'both'
    }));
    assert.equal(readFileSync(file, 'utf8'), '{"A":');
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
test('preference persistence: simultaneous patches on one teacher preserve both fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-preference-test-'));
  try {
    const store = new TeacherPreferenceStore(join(dir, 'preferences.json'));
    await Promise.all([store.update('A', old => ({
      ...old,
      preferredSession: 'morning'
    })), store.update('A', old => ({
      ...old,
      desiredTeachingSessionsPerWeek: 3
    }))]);
    assert.deepEqual(store.get('A'), {
      preferredSession: 'morning',
      desiredTeachingSessionsPerWeek: 3
    });
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
});
