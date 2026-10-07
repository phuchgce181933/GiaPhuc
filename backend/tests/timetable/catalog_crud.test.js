import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './helpers/app.js';
import { CatalogStore } from '../../src/modules/timetable/engine/catalog/catalog.store.js';
import { loadCatalogData, saveCatalogRecord } from '../../src/modules/timetable/engine/catalog/catalog.service.js';
import { ScheduleStore } from '../../src/modules/timetable/engine/persistence/schedule-store.js';
import { TeacherPreferenceStore } from '../../src/modules/timetable/engine/persistence/teacher-preference-store.js';
import { PreviewStore } from '../../src/modules/timetable/engine/api/generate.js';
import { loadBenchmarkDataset } from '../../src/modules/timetable/engine/loader/catalog-dataset.js';
import { validateInput } from '../../src/modules/timetable/engine/domain/validate.js';
async function withCatalog(run) {
  const dir = mkdtempSync(join(tmpdir(), 'tkb-catalog-crud-'));
  const catalogStore = new CatalogStore(join(dir, 'catalog.json'));
  const preferenceStore = new TeacherPreferenceStore(join(dir, 'preferences.json'));
  const app = createApp({
    catalogStore,
    preferenceStore,
    scheduleStore: new ScheduleStore({
      dir
    }),
    previewStore: new PreviewStore()
  });
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method,
      ...(body ? {
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(body)
      } : {})
    });
    return {
      status: response.status,
      payload: await response.json()
    };
  };
  try {
    await run({
      request,
      catalogStore,
      preferenceStore,
      dir
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, {
      recursive: true,
      force: true
    });
  }
}
test('catalog CRUD: subjects survive reload, reject duplicates, update and delete', async () => withCatalog(async ({
  request,
  catalogStore
}) => {
  const created = await request('/subjects', 'POST', {
    name: 'Môn thử CRUD',
    code: 'CRUD',
    description: 'Môn mới',
    isActive: true
  });
  assert.equal(created.status, 201);
  const id = created.payload.subject.id;
  assert.equal((await request(`/subjects/${id}`)).payload.subject.name, 'Môn thử CRUD');
  assert.ok(loadCatalogData({
    store: new CatalogStore(catalogStore.file)
  }).normalized.subjects.some(row => row.id === id));
  assert.equal((await request('/subjects', 'POST', {
    name: 'Tên khác',
    code: 'CRUD'
  })).status, 409);
  assert.equal((await request(`/subjects/${id}`, 'PATCH', {
    name: 'Môn đã sửa',
    isActive: false
  })).status, 200);
  assert.equal((await request(`/subjects/${id}`)).payload.subject.isActive, false);
  assert.equal((await request(`/subjects/${id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/subjects/${id}`)).status, 404);
}));
test('catalog CRUD: teacher home branch is selected on creation and immutable on updates', async () => withCatalog(async ({
  request,
  catalogStore
}) => {
  const d = loadCatalogData({
    store: catalogStore
  }).normalized;
  const created = await request('/teachers', 'POST', {
    name: 'Giáo viên CRUD',
    code: 'GV-CRUD',
    email: 'crud@example.test',
    phone: '0900000000',
    homeBranchId: d.branches[0].id,
    specializationIds: [d.subjects[0].id],
    isActive: true
  });
  assert.equal(created.status, 201);
  const id = created.payload.teacher.id;
  const forbidden = await request(`/teachers/${id}`, 'PATCH', {
    homeBranchId: d.branches[1].id,
    name: 'Không được lưu'
  });
  assert.equal(forbidden.status, 400);
  assert.equal(forbidden.payload.errors[0].code, 'HOME_BRANCH_IMMUTABLE');
  const edited = await request(`/teachers/${id}`, 'PATCH', {
    name: 'Giáo viên đã sửa',
    phone: '0911111111'
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.payload.teacher.homeBranchId, d.branches[0].id);
  assert.equal((await request(`/teachers/${id}`)).payload.teacher.name, 'Giáo viên đã sửa');
  assert.equal((await request(`/teachers/${id}`, 'DELETE')).status, 200);
  assert.equal((await request(`/teachers/${id}`)).status, 404);
}));
test('catalog CRUD: a class inherits declared block demand with no fabricated teacher, and deletion removes that demand', async () => withCatalog(async ({
  request,
  catalogStore,
  preferenceStore
}) => {
  const d = loadCatalogData({
    store: catalogStore
  }).normalized;
  const branch = d.branches[0];
  const block = d.blocks[0];
  const created = await request('/classes', 'POST', {
    name: 'Lớp CRUD',
    code: 'LOP-CRUD',
    branchId: branch.id,
    blockId: block.id,
    isActive: true
  });
  assert.equal(created.status, 201);
  const id = created.payload.class.id;
  const details = (await request(`/classes/${id}`)).payload.class;
  assert.equal(details.block.id, block.id);
  assert.equal(details.branchId, branch.id);
  assert.ok(details.curriculum.length > 0);
  const loaded = loadBenchmarkDataset({
    catalogStore,
    preferenceStore
  });
  const demand = loaded.input.assignments.filter(row => row.classId === id);
  assert.ok(demand.length > 0);
  assert.ok(demand.every(row => row.teacherId === null && row.requiresTeacherAssignment === true));
  assert.equal(validateInput(loaded.input).issues.length, 0);
  const generated = await request('/schedules/generate', 'POST', {
    candidateCount: 1
  });
  assert.equal(generated.status, 200);
  assert.ok(['OK', 'EMPTY'].includes(generated.payload.status));
  assert.equal(generated.payload.diagnostics.data.provenance.catalogRevision, catalogStore.read().revision);
  const edited = await request(`/classes/${id}`, 'PATCH', {
    name: 'Lớp đã sửa',
    branchId: d.branches[1].id
  });
  assert.equal(edited.status, 200);
  assert.ok(loadBenchmarkDataset({
    catalogStore,
    preferenceStore
  }).input.assignments.filter(row => row.classId === id).every(row => row.branchId === d.branches[1].id));
  assert.equal((await request(`/classes/${id}`, 'DELETE')).status, 200);
  assert.ok(!loadBenchmarkDataset({
    catalogStore,
    preferenceStore
  }).input.assignments.some(row => row.classId === id));
}));
test('catalog CRUD: referenced records refuse deletion and support deactivation without breaking curriculum coverage', async () => withCatalog(async ({
  request,
  catalogStore,
  preferenceStore
}) => {
  const d = loadCatalogData({
    store: catalogStore
  }).normalized;
  const teacher = d.teachers.find(row => row.isActive && d.historicalAssignments.some(assignment => assignment.teacher === row.id));
  const removed = await request(`/teachers/${teacher.id}`, 'DELETE');
  assert.equal(removed.status, 409);
  assert.equal(removed.payload.errors[0].code, 'RECORD_IN_USE');
  assert.equal((await request(`/teachers/${teacher.id}`, 'PATCH', {
    isActive: false
  })).status, 200);
  const loaded = loadBenchmarkDataset({
    catalogStore,
    preferenceStore
  });
  assert.ok(!loaded.input.teacherIndex.has(teacher.id));
  assert.ok(loaded.input.assignments.some(row => row.requiresTeacherAssignment));
  assert.equal(validateInput(loaded.input).issues.length, 0);
  const subject = d.subjects.find(row => d.curriculum.some(curriculum => curriculum.subject === row.id));
  assert.equal((await request(`/subjects/${subject.id}`, 'DELETE')).status, 409);
}));
test('catalog CRUD: invalid payloads and references write nothing', async () => withCatalog(async ({
  request,
  catalogStore
}) => {
  for (const [path, body] of [['/subjects', {
    name: ''
  }], ['/subjects', {
    name: 'Bad',
    isActive: 'true'
  }], ['/subjects', {
    name: 'Bad',
    capacity: 10
  }], ['/classes', {
    name: 'Bad',
    branchId: 'missing',
    blockId: 'missing'
  }], ['/teachers', {
    name: 'Bad',
    homeBranchId: 'missing',
    specializationIds: []
  }], ['/teachers', {
    name: 'Bad',
    homeBranchId: 'missing',
    specializationIds: null
  }]]) assert.equal((await request(path, 'POST', body)).status, 400);
  assert.equal(catalogStore.read().revision, 0);
  assert.equal((await request('/subjects/missing', 'PATCH', {
    name: 'Bad'
  })).status, 404);
}));
test('catalog CRUD: concurrent updates through separate store instances preserve both writes', async () => withCatalog(async ({
  catalogStore
}) => {
  const other = new CatalogStore(catalogStore.file);
  const created = await Promise.all([saveCatalogRecord('subjects', null, {
    name: 'Concurrent A',
    code: 'CA'
  }, {
    store: catalogStore
  }), saveCatalogRecord('subjects', null, {
    name: 'Concurrent B',
    code: 'CB'
  }, {
    store: other
  })]);
  assert.ok(created.every(row => other.read().subjects[row.id]));
  assert.equal(other.read().revision, 2);
}));
test('catalog CRUD: corrupt persisted data fails closed and is not overwritten', async () => withCatalog(async ({
  request,
  catalogStore
}) => {
  writeFileSync(catalogStore.file, '{ broken catalog');
  assert.equal((await request('/subjects')).status, 500);
  assert.equal((await request('/subjects', 'POST', {
    name: 'Lost write'
  })).status, 500);
  assert.equal(readFileSync(catalogStore.file, 'utf8'), '{ broken catalog');
}));
