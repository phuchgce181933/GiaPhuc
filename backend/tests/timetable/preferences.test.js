import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTeacher } from '../../src/modules/timetable/engine/domain/teacher.js';
import { SOFT } from '../../src/modules/timetable/engine/domain/search-constraints.js';
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(resolve(here, '..', '..', 'data', 'timetable', 'fixtures'), 'teachers.authoritative.json');
const teachers = JSON.parse(readFileSync(fixturePath, 'utf8')).map(normalizeTeacher);
test('kim has soBuoiToiDa=4, buoiUuTien=ca_hai, thuNghi=[]', () => {
  const kim = teachers.find(t => t.hoTen === 'kim');
  assert.deepEqual(kim.nguyenVong, {
    soBuoiToiDa: 4,
    buoiUuTien: 'ca_hai',
    thuNghi: []
  });
});
test('trinh has buoiUuTien=chieu', () => {
  const trinh = teachers.find(t => t.hoTen === 'trinh');
  assert.equal(trinh.nguyenVong.buoiUuTien, 'chieu');
});
test('nản has NO nguyenVong in the authoritative fixture (per second brief)', () => {
  const nan = teachers.find(t => t.hoTen === 'nản');
  assert.equal(nan.nguyenVong, null);
});
test('thư and trâm have NO nguyenVong (treated as null, not auto-filled)', () => {
  const thu = teachers.find(t => t.hoTen === 'thư');
  const tram = teachers.find(t => t.hoTen === 'trâm');
  assert.equal(thu.nguyenVong, null);
  assert.equal(tram.nguyenVong, null);
});
test('S_PREFERRED_SESSION is active when at least one teacher has a non-ca_hai preference', () => {
  const input = {
    teachers
  };
  assert.equal(SOFT.S_PREFERRED_SESSION.active(input), true);
});
test('S_PREFERRED_SESSION score: chieu-pref teacher with chieu slots → 1', () => {
  const t = {
    nguyenVong: {
      buoiUuTien: 'chieu'
    }
  };
  const slots = [{
    period: 6
  }, {
    period: 7
  }, {
    period: 8
  }];
  assert.equal(SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, slots), 1);
});
test('S_PREFERRED_SESSION score: chieu-pref teacher with sang slots → 0', () => {
  const t = {
    nguyenVong: {
      buoiUuTien: 'chieu'
    }
  };
  const slots = [{
    period: 1
  }, {
    period: 2
  }];
  assert.equal(SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, slots), 0);
});
test('S_PREFERRED_SESSION score: ca_hai is always 1', () => {
  const t = {
    nguyenVong: {
      buoiUuTien: 'ca_hai'
    }
  };
  const slots = [{
    period: 1
  }, {
    period: 9
  }];
  assert.equal(SOFT.S_PREFERRED_SESSION.scorePerTeacher(t, slots), 1);
});
test('S_MAX_SESSIONS_PER_WEEK: under cap → 1, over cap → < 1', () => {
  const t = {
    nguyenVong: {
      soBuoiToiDa: 2
    }
  };
  const under = [{
    day: 1
  }, {
    day: 2
  }];
  const over = [{
    day: 1
  }, {
    day: 2
  }, {
    day: 3
  }, {
    day: 4
  }];
  assert.equal(SOFT.S_MAX_SESSIONS_PER_WEEK.scorePerTeacher(t, under), 1);
  assert.ok(SOFT.S_MAX_SESSIONS_PER_WEEK.scorePerTeacher(t, over) < 1);
});
