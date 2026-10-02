// Tests for the JSON dataset loader.
//
// The dataset is supplied by the operator; this loader must not
// invent any data. The fixtures used in these tests are written
// inline and labeled as TEST MOCK DATA. They are not added to
// data/fixtures/ and they are not loaded as production input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadFromDataset } from '../src/loader/dataset.js';

function withDataset(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ds-'));
  const p = join(dir, 'dataset.json');
  writeFileSync(p, JSON.stringify(content), 'utf8');
  try {
    return fn(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('dataset loader: empty file → all entities missing, no teachers loaded', () => {
  withDataset({}, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.teachers.length, 0);
    assert.equal(m.branches.length, 0);
    assert.equal(m.classes.length, 0);
    assert.equal(m.curriculum.length, 0);
    assert.equal(m.assignments.length, 0);
    assert.equal(m.travelTime, null);
    assert.ok(m.missingData.some((x) => x.entity === 'Teacher'));
    assert.ok(m.missingData.some((x) => x.entity === 'Branch'));
    assert.ok(m.missingData.some((x) => x.entity === 'Class'));
    assert.ok(m.missingData.some((x) => x.entity === 'Curriculum'));
    assert.ok(m.missingData.some((x) => x.entity === 'Assignment'));
    assert.ok(m.missingData.some((x) => x.entity === 'Travel'));
  });
});

test('dataset loader: only teachers supplied → other entities still missing', () => {
  withDataset({
    teachers: [
      { _id: { $oid: 'a1' }, hoTen: 'A', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    ],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.teachers.length, 1);
    assert.equal(m.branches.length, 0);
    assert.equal(m.classes.length, 0);
    assert.equal(m.curriculum.length, 0);
    assert.equal(m.assignments.length, 0);
    assert.ok(m.missingData.some((x) => x.entity === 'Branch'));
    assert.ok(m.missingData.some((x) => x.entity === 'Class'));
    assert.ok(m.missingData.some((x) => x.entity === 'Curriculum'));
    assert.ok(m.missingData.some((x) => x.entity === 'Assignment'));
  });
});

test('dataset loader: branches produce a timeSlotsByBranch entry per branch', () => {
  withDataset({
    branches: [
      { id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
    ],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.branchesStatus, 'OK');
    const slots = m.timeSlotsByBranch.get('b1');
    assert.ok(slots);
    assert.equal(slots.length, 25); // 5 days * 5 periods
  });
});

test('dataset loader: travel matrix produces a working TravelProvider', () => {
  withDataset({
    travel: { matrix: { b1: { b2: 5 } } },
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.travelStatus, 'OK');
    assert.equal(m.travelTime.travelTime('b1', 'b2', 1), 5);
    assert.equal(m.travelTime.travelTime('b1', 'b1', 1), 0);
    assert.equal(m.travelTime.travelTime('b1', 'b3', 1), null);
  });
});

test('dataset loader: missing travel matrix → MISSING_CONFIGURATION', () => {
  withDataset({}, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.travelTime, null);
    assert.equal(m.travelStatus, 'MISSING_CONFIGURATION');
    assert.ok(m.missingData.some((x) => x.entity === 'Travel'));
  });
});

test('dataset loader: missing assignment list is auto-derived from curriculum + first eligible teacher', () => {
  withDataset({
    teachers: [
      { _id: { $oid: 'a1' }, hoTen: 'A', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    ],
    branches: [
      { id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
    ],
    classes: [{ id: 'c1', branchId: 'b1', name: '1A', gradeLevel: 1 }],
    curriculum: [{ classId: 'c1', subjectId: 'Toán', requiredPeriods: 2 }],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.assignments.length, 1);
    const a = m.assignments[0];
    assert.equal(a.classId, 'c1');
    assert.equal(a.subjectId, 'Toán');
    assert.equal(a.teacherId, 'a1');
    assert.equal(a.branchId, 'b1');
    assert.equal(a.requiredPeriods, 2);
  });
});

test('dataset loader: explicit assignment list is preserved verbatim', () => {
  withDataset({
    teachers: [
      { _id: { $oid: 'a1' }, hoTen: 'A', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    ],
    branches: [
      { id: 'b1', name: 'B1', schoolDays: [1, 2, 3, 4, 5], periods: [1, 2, 3, 4, 5] },
    ],
    classes: [{ id: 'c1', branchId: 'b1', name: '1A', gradeLevel: 1 }],
    curriculum: [{ classId: 'c1', subjectId: 'Toán', requiredPeriods: 1 }],
    assignments: [{
      id: 'manual-1', classId: 'c1', subjectId: 'Toán',
      teacherId: 'a1', branchId: 'b1', requiredPeriods: 1,
    }],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.assignments.length, 1);
    assert.equal(m.assignments[0].id, 'manual-1');
  });
});

test('dataset loader: subjects are union of teacher specializations and explicit subjects', () => {
  withDataset({
    teachers: [
      { _id: { $oid: 'a1' }, hoTen: 'A', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    ],
    subjects: [{ id: 'Lý', name: 'Lý' }],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    const names = m.subjects.map((s) => s.name).sort();
    assert.deepEqual(names, ['Lý', 'Toán']);
  });
});

test('dataset loader: transitionMinutes defaults to 10 and is overridable', () => {
  withDataset({}, (p) => {
    assert.equal(loadFromDataset({ path: p }).transitionMinutes, 10);
  });
  withDataset({ transitionMinutes: 7 }, (p) => {
    assert.equal(loadFromDataset({ path: p }).transitionMinutes, 7);
  });
});

test('dataset loader: missing cfg.path throws', () => {
  assert.throws(() => loadFromDataset({}), /cfg\.path is required/);
  assert.throws(() => loadFromDataset(), /cfg\.path is required/);
});

test('dataset loader: a teacher with empty chuyenMon is skipped, not invented', () => {
  withDataset({
    teachers: [
      { _id: { $oid: 'a1' }, hoTen: 'A', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [] },
      { _id: { $oid: 'a2' }, hoTen: 'B', email: '', soDienThoai: '', trangThai: 'active',
        chuyenMon: [{ tenChuyenMon: 'Toán', soTietTuan: 1 }] },
    ],
  }, (p) => {
    const m = loadFromDataset({ path: p });
    assert.equal(m.teachers.length, 1);
    assert.equal(m.teachers[0].hoTen, 'B');
    assert.ok(m.warnings.some((w) => w.startsWith('Skipped teacher:')));
  });
});
