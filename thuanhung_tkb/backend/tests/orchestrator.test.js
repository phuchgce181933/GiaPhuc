// Tests for the orchestrator (preview + commit).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFromFixture } from '../src/loader/fixture.js';
import { preview, commit, PreviewCache } from '../src/orchestrator/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(here, '..', '..', 'data', 'fixtures');
const cfg = { fixtureDir };

test('preview with the empty-fixture model: returns 0 solutions, status = MISSING_DATA', () => {
  const model = loadFromFixture(cfg);
  const cache = new PreviewCache();
  const out = preview(model, { solutions: 3, strategies: ['C_BALANCED'] }, cache);
  assert.equal(out.status, 'MISSING_DATA');
  assert.equal(out.solutions.length, 0);
  assert.ok(out.missingData.length > 0);
  assert.ok(out.missingData.some((m) => m.entity === 'Branch'));
  assert.ok(out.missingData.some((m) => m.entity === 'Class'));
  assert.ok(out.missingData.some((m) => m.entity === 'Curriculum'));
  assert.ok(out.missingData.some((m) => m.entity === 'Assignment'));
  assert.ok(out.missingData.some((m) => m.entity === 'Travel'));
  assert.equal(out.situation.teachers.length, 5);
});

test('preview surfaces missing teacher fields: nguyenVong, homeBranchId', () => {
  const model = loadFromFixture(cfg);
  const out = preview(model, {}, new PreviewCache());
  const fields = new Set(out.missingData.map((m) => `${m.entity}:${m.entityId}:${m.field}`));
  assert.ok([...fields].some((f) => f.includes('nguyenVong')));
  assert.ok([...fields].some((f) => f.includes('homeBranchId')));
});

test('commit rejects unknown solution id', () => {
  const cache = new PreviewCache();
  const r = commit('does-not-exist', cache);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'UNKNOWN_SOLUTION');
});

test('preview cache stores zero solutions when input is empty', () => {
  const model = loadFromFixture(cfg);
  const cache = new PreviewCache();
  preview(model, {}, cache);
  assert.equal(cache.byId.size, 0);
});

test('preview on a structurally broken model returns INVALID_INPUT, never reaches the solver', () => {
  // Build a model where an assignment references an unknown class.
  // This must be classified as INVALID_INPUT, not MISSING_DATA and
  // not silently accepted.
  const model = loadFromFixture(cfg);
  model.branches = [{ id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  model.classes = [{ id: 'c1', branchId: 'b1', name: '1A', gradeLevel: 1 }];
  model.subjects = [{ id: 'Tin học', name: 'Tin học' }];
  model.curriculum = [{ classId: 'c1', subjectId: 'Tin học', requiredPeriods: 1 }];
  model.assignments = [{
    id: 'a1',
    classId: 'no-such-class', // broken reference
    subjectId: 'Tin học',
    teacherId: model.teachers[0].id,
    branchId: 'b1',
    requiredPeriods: 1,
  }];
  const cache = new PreviewCache();
  const out = preview(model, { solutions: 3, strategies: ['C_BALANCED'] }, cache);
  assert.equal(out.status, 'INVALID_INPUT');
  assert.equal(out.solutions.length, 0);
  assert.ok(out.invalidInput.length > 0);
  assert.ok(out.invalidInput.some((i) => i.code === 'invalid_reference' && i.field === 'classId'));
  assert.equal(cache.byId.size, 0);
});

test('preview on a model with an ineligible teacher returns INVALID_INPUT (unresolvable_demand)', () => {
  const model = loadFromFixture(cfg);
  model.branches = [{ id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] }];
  model.classes = [{ id: 'c1', branchId: 'b1', name: '1A', gradeLevel: 1 }];
  model.subjects = [{ id: 'Toán', name: 'Toán' }];
  model.curriculum = [{ classId: 'c1', subjectId: 'Toán', requiredPeriods: 1 }];
  // No fixture teacher has Toán in chuyenMon → unresolvable_demand.
  const teacher = model.teachers[0];
  model.assignments = [{
    id: 'a1',
    classId: 'c1',
    subjectId: 'Toán',
    teacherId: teacher.id,
    branchId: 'b1',
    requiredPeriods: 1,
  }];
  const out = preview(model, {}, new PreviewCache());
  assert.equal(out.status, 'INVALID_INPUT');
  assert.ok(out.invalidInput.some((i) => i.code === 'unresolvable_demand'));
});
