// Regression tests for the eligibility invariant on the
// authoritative fixture. Phase 14.
//
// `kim` is one teacher with two specializations (Công nghệ=1,
// Tin học=1). This test prevents the "split kim into two records"
// refactor that would silently break workload totals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeTeacher } from '../src/domain/teacher.js';
import { isEligibleFor, eligibleTeachers } from '../src/domain/eligibility.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'fixtures'), 'teachers.authoritative.json');
const teachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);

test('kim is exactly ONE teacher record in the fixture', () => {
  const matches = teachers.filter((t) => t.hoTen === 'kim');
  assert.equal(matches.length, 1);
});

test('kim has TWO specializations, not one', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  assert.equal(kim.chuyenMon.length, 2);
});

test('kim specializations: Công nghệ=1, Tin học=1', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  const byName = Object.fromEntries(kim.chuyenMon.map((s) => [s.tenChuyenMon, s.soTietTuan]));
  assert.equal(byName['Công nghệ'], 1);
  assert.equal(byName['Tin học'], 1);
});

test('kim workload = 2 (Σ specialization.soTietTuan)', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  const total = kim.chuyenMon.reduce((s, x) => s + x.soTietTuan, 0);
  assert.equal(total, 2);
});

test('kim → Công nghệ is eligible', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  assert.equal(isEligibleFor(kim, 'Công nghệ'), true);
});

test('kim → Tin học is eligible', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  assert.equal(isEligibleFor(kim, 'Tin học'), true);
});

test('kim → Toán is NOT eligible', () => {
  const kim = teachers.find((t) => t.hoTen === 'kim');
  assert.equal(isEligibleFor(kim, 'Toán'), false);
});

test('eligibleTeachers("Tin học") includes kim and only kim', () => {
  const got = eligibleTeachers(teachers, 'Tin học').map((t) => t.hoTen).sort();
  assert.deepEqual(got, ['kim']);
});

test('eligibleTeachers("Công nghệ") includes kim and only kim', () => {
  const got = eligibleTeachers(teachers, 'Công nghệ').map((t) => t.hoTen).sort();
  assert.deepEqual(got, ['kim']);
});

test('eligibleTeachers("Toán") returns the empty set (no fixture teacher specializes in Toán)', () => {
  const got = eligibleTeachers(teachers, 'Toán');
  assert.equal(got.length, 0);
});

test('eligibleTeachers is case-sensitive (lowercase "công nghệ" ≠ "Công nghệ")', () => {
  const got = eligibleTeachers(teachers, 'công nghệ');
  assert.equal(got.length, 0);
});

test('thư is eligible for Tiếng Anh only', () => {
  const got = eligibleTeachers(teachers, 'Tiếng Anh').map((t) => t.hoTen).sort();
  assert.deepEqual(got, ['thư']);
});
