'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const mongoose=require('mongoose');
const env=require('../../src/config');
const {runGenerate}=require('../../src/modules/timetable/timetable.worker');

test('MongoDB: isolated DB, atomic preferences, durable preview, version allocation and commit revalidation', async () => {
  const name='giaphuc_tkb_test_'+randomUUID().replaceAll('-','').slice(0,12);
  const connection=await mongoose.createConnection(env.TIMETABLE.MONGODB_URI,{dbName:name,serverSelectionTimeoutMS:10000}).asPromise();
  try {
    const {initializeMongoTimetable,loadMongoStores,MongoScheduleStore}=await import('../../src/modules/timetable/engine/persistence/mongo-store.js');
    const {loadBenchmarkDataset}=await import('../../src/modules/timetable/engine/loader/catalog-dataset.js');
    const {commit}=await import('../../src/modules/timetable/engine/api/commit.js');
    const {ScheduleStore,scheduleIdFor}=await import('../../src/modules/timetable/engine/persistence/schedule-store.js');
    const {contentHash}=await import('../../src/modules/timetable/engine/persistence/schedule-record.js');
    assert.notEqual(connection.name,env.MONGODB_DB);
    await assert.rejects(initializeMongoTimetable({db:{databaseName:env.MONGODB_DB}}),/must not use/);
    await initializeMongoTimetable(connection);
    const a=await loadMongoStores(connection),b=await loadMongoStores(connection);
    await Promise.all([a.preferenceStore.put('QA-A',{preferredSession:'morning'}),b.preferenceStore.put('QA-B',{preferredSession:'afternoon'})]);
    const fresh=await loadMongoStores(connection);assert.equal(fresh.preferenceStore.get('QA-A').preferredSession,'morning');assert.equal(fresh.preferenceStore.get('QA-B').preferredSession,'afternoon');
    await Promise.all([a.preferenceStore.update('QA-C',(old)=>({...old,preferredSession:'morning'})),b.preferenceStore.update('QA-C',(old)=>({...old,desiredTeachingSessionsPerWeek:3}))]);
    assert.deepEqual((await loadMongoStores(connection)).preferenceStore.get('QA-C'),{preferredSession:'morning',desiredTeachingSessionsPerWeek:3});
    await connection.db.collection('preferences').insertOne({_id:'QA-BAD',value:[],revision:1});
    await assert.rejects(loadMongoStores(connection),/Invalid teacher preference/);
    await connection.db.collection('preferences').deleteOne({_id:'QA-BAD'});
    const stores=await loadMongoStores(connection);
    const deps={...stores,actorId:'QA-ACTOR',loadDataset:async()=>loadBenchmarkDataset(await loadMongoStores(connection))};
    let heartbeats=0;const heartbeat=setInterval(()=>heartbeats++,10);
    const pending=runGenerate({body:{candidateCount:3},deps});
    const busy=await runGenerate({body:{candidateCount:1},deps});assert.equal(busy.status,429);
    const generated=await pending;clearInterval(heartbeat);
    assert.ok(heartbeats>2,'scheduling must leave the main event loop responsive');
    assert.equal(generated.payload.status,'OK');assert.equal(generated.payload.solutions.length,3);
    assert.equal(await connection.db.collection('schedules').countDocuments(),0);
    assert.equal(generated.payload.previewPersistence.driver,'mongodb');
    const reread=await loadMongoStores(connection);assert.equal((await reread.previewStore.get(generated.payload.requestId)).length,3);
    const body={requestId:generated.payload.requestId,solutionId:generated.payload.solutions[0].id};
    const [one,two]=await Promise.all([commit({body,deps}),commit({body,deps})]);
    assert.equal(one.payload.scheduleId,two.payload.scheduleId);assert.equal(await connection.db.collection('schedules').countDocuments(),1);
    const stored=await stores.scheduleStore.read(one.payload.scheduleId);
    assert.equal(stored.slots.length,802);assert.equal(stored.directory.teachers.length,40);assert.equal(stored.calendar.days.length,5);assert.equal(stored.audit.actorId,'QA-ACTOR');
    const target=generated.payload.solutions[1].placements[0].teacherId;
    const current=await loadMongoStores(connection);
    await current.catalogStore.update((state)=>{state.teachers[target]={...current.catalogStore.source.normalized.teachers.find(t=>t.id===target),capacityPeriodsPerWeek:0};});
    const refused=await commit({body:{requestId:body.requestId,solutionId:generated.payload.solutions[1].id},deps});
    assert.equal(refused.status,409);assert.equal(refused.payload.persisted,false);assert.equal(await connection.db.collection('schedules').countDocuments(),1);
    const row=stored.slots[0];
    const make=(requestId)=>{const id=scheduleIdFor(requestId,'ms-00000000');return new MongoScheduleStore(connection.db).create(id,(version)=>ScheduleStore.buildRecord({scheduleId:id,requestId,solutionId:'ms-00000000',version,rows:[row],contentHash:contentHash([row]),validated:true,clockValue:new Date().toISOString()}));};
    const versions=await Promise.all([make('req-999991-00000000'),make('req-999992-00000000')]);
    assert.notEqual(versions[0].record.version,versions[1].record.version);
    await connection.db.collection('schedules').updateOne({_id:stored.scheduleId},{$set:{slotCount:0}});
    await assert.rejects(stores.scheduleStore.read(stored.scheduleId),/integrity/);
    assert.equal((await stores.scheduleStore.health()).corruptRecordCount,1);
  } finally {
    if(!connection.name.startsWith('giaphuc_tkb_test_'))throw new Error('Refusing to drop a non-test database');
    try { await connection.dropDatabase(); } finally { await connection.close(); }
  }
});
