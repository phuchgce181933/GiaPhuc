// Tests that lock the authoritative teacher fixture.
// The file is byte-identical to the source; any edit must update
// this test in the same commit and record the rationale in
// docs/REAL_DATA_READINESS.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');

test('fixture is byte-loadable and has 5 teachers', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(Array.isArray(raw), true);
  assert.equal(raw.length, 5);
});

test('teacher names preserve casing (kim, thư, trinh, trâm, nản)', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const names = raw.map((t) => t.hoTen);
  assert.deepEqual(names, ['kim', 'thư', 'trinh', 'trâm', 'nản']);
});

test('email and soDienThoai are empty strings (not undefined)', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const t of raw) {
    assert.equal(t.email, '');
    assert.equal(t.soDienThoai, '');
  }
});

test('every teacher has trangThai = "active"', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const t of raw) {
    assert.equal(t.trangThai, 'active');
  }
});

test('updatedAt quirk: nản has a string, others have a Date', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const nan = raw.find((t) => t.hoTen === 'nản');
  const others = raw.filter((t) => t.hoTen !== 'nản');
  assert.equal(typeof nan.updatedAt, 'string');
  for (const t of others) {
    assert.equal(typeof t.updatedAt, 'object');
    assert.ok(t.updatedAt.$date);
  }
});

test('thư / trâm / nản do NOT have a nguyenVong field (per second brief)', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  for (const name of ['thư', 'trâm', 'nản']) {
    const t = raw.find((x) => x.hoTen === name);
    assert.equal(Object.prototype.hasOwnProperty.call(t, 'nguyenVong'), false, `${name} should not have nguyenVong`);
  }
});

test('kim has nguyenVong (soBuoiToiDa=4, buoiUuTien=ca_hai, thuNghi=[])', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const kim = raw.find((t) => t.hoTen === 'kim');
  assert.deepEqual(kim.nguyenVong, { soBuoiToiDa: 4, buoiUuTien: 'ca_hai', thuNghi: [] });
});

test('trinh has buoiUuTien=chieu', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const trinh = raw.find((t) => t.hoTen === 'trinh');
  assert.equal(trinh.nguyenVong.buoiUuTien, 'chieu');
});

test('normalizeTeacher turns missing nguyenVong into null (not undefined, not an empty object)', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const teachers = raw.map(normalizeTeacher);
  for (const name of ['thư', 'trâm', 'nản']) {
    const t = teachers.find((x) => x.hoTen === name);
    assert.equal(t.nguyenVong, null, `${name} should normalize nguyenVong to null`);
  }
});
