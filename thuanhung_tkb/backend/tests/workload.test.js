// Regression tests for the workload invariant.
// Phase 14: this locks in the per-teacher workload computed from
// the authoritative fixture. The fixture must not change; if a
// future change alters any specialization, this test must be
// updated in the same commit and the rationale recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { workloadOf, workloadSummary } from '../src/domain/workload.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');
const teachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);

test('workload: kim = 2 (Công nghệ=1 + Tin học=1)', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  assert.equal(workloadOf(kim), 2);
});

test('workload: thư = 4 (Tiếng Anh=4)', () => {
  const thu = teachers.find((t) => t.hoTen === 'thư');
  assert.equal(workloadOf(thu), 4);
});

test('workload: trinh = 1 (Mỹ thuật=1)', () => {
  const trinh = teachers.find((t) => t.hoTen === 'trinh');
  assert.equal(workloadOf(trinh), 1);
});

test('workload: trâm = 1 (Âm nhạc=1)', () => {
  const tram = teachers.find((t) => t.hoTen === 'trâm');
  assert.equal(workloadOf(tram), 1);
});

test('workload: nản = 2 (Giáo dục thể chất=2)', () => {
  const nan = teachers.find((t) => t.hoTen === 'nản');
  assert.equal(workloadOf(nan), 2);
});

test('workload summary: total across all 5 teachers = 10', () => {
  const summary = workloadSummary(teachers);
  const total = summary.reduce((s, e) => s + e.workload, 0);
  assert.equal(total, 10);
});

test('workload: each teacher has at least 1 specialization (the fixture invariant)', () => {
  for (const t of teachers) {
    assert.ok(t.chuyenMon.length >= 1, `${t.hoTen} has no specializations`);
  }
});

test('workload: each specialization soTietTuan is a non-negative integer', () => {
  for (const t of teachers) {
    for (const s of t.chuyenMon) {
      assert.ok(Number.isInteger(s.soTietTuan), `${t.hoTen}/${s.tenChuyenMon} has non-integer soTietTuan`);
      assert.ok(s.soTietTuan >= 0, `${t.hoTen}/${s.tenChuyenMon} has negative soTietTuan`);
    }
  }
});
