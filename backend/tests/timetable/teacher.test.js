import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeTeacher, teacherMissingFields } from '../../src/modules/timetable/engine/domain/teacher.js';
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'timetable', 'fixtures'), 'teachers.authoritative.json');
const teachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);
test('fixture is byte-loadable and has 5 teachers', () => {
  assert.equal(teachers.length, 5);
});
test('teacher names preserve casing (kim, thư, trinh, trâm, nản)', () => {
  const names = teachers.map(t => t.hoTen).sort();
  assert.deepEqual(names, ['kim', 'nản', 'thư', 'trinh', 'trâm']);
});
test('email and soDienThoai are empty strings (not undefined)', () => {
  for (const t of teachers) {
    assert.equal(t.email, '');
    assert.equal(t.soDienThoai, '');
  }
});
test('every teacher has trangThai = "active"', () => {
  for (const t of teachers) assert.equal(t.trangThai, 'active');
});
test('updatedAt quirk: nản has a string, others have a Date', () => {
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const nan = raw.find(t => t.hoTen === 'nản');
  assert.equal(typeof nan.updatedAt, 'string');
  const kim = raw.find(t => t.hoTen === 'kim');
  assert.equal(typeof kim.updatedAt, 'object');
});
test('missing data is reported for thư and trâm (no nguyenVong)', () => {
  const thu = teachers.find(t => t.hoTen === 'thư');
  const tram = teachers.find(t => t.hoTen === 'trâm');
  assert.equal(thu.nguyenVong, null);
  assert.equal(tram.nguyenVong, null);
  const md = teacherMissingFields(thu);
  assert.ok(md.some(m => m.field === 'nguyenVong'));
});
test('homeBranchId is null for all teachers (MISSING DATA)', () => {
  for (const t of teachers) assert.equal(t.homeBranchId, null);
});
