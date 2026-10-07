import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './helpers/app.js';
import { loadSchedulingFixture } from './helpers/scheduling-fixture.js';

test('commit API carries trusted actor context into the stored audit',async()=>{
  const app=createApp({actorId:'TRUSTED-ACTOR',loadDataset:()=>loadSchedulingFixture()});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try {
    const base=`http://127.0.0.1:${server.address().port}/api/schedules`;
    const post=async(path,body)=>(await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).json();
    const generated=await post('/generate',{candidateCount:1});assert.equal(generated.status,'OK');
    const saved=await post('/commit',{requestId:generated.requestId,solutionId:generated.solutions[0].id});assert.equal(saved.committed,true);assert.equal(saved.written,true);
    const full=await (await fetch(base+'/committed/'+saved.scheduleId+'/full')).json();assert.equal(full.schedule.audit.actorId,'TRUSTED-ACTOR');
    assert.equal(full.schedule.directory.teachers.length,40);
  }finally{await new Promise(r=>server.close(r));}
});
