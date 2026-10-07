import test from 'node:test';
import assert from 'node:assert/strict';
import planner from '../../src/modules/timetable/assistant/repair-planner.service.js';
import { slotsForBranch } from '../../src/modules/timetable/engine/domain/search-constraints.js';
const branch = { id: 'b', schoolDays: [1,2,3,4,5], periods: [1,2,3,4,5,6,7], sessions: { sang: [1,2,3,4], chieu: [5,6,7] } };
function fixture() {
  const teachers = [{ id: 't', hoTen: 'Kim', eligibleSubjectIds: ['s'], trangThai: 'active' }, { id: 'other', hoTen: 'Other', eligibleSubjectIds: ['s'], trangThai: 'active' }];
  const assignments = [{ id: 'a1', classId: 'c1', subjectId: 's', teacherId: 't', branchId:'b', requiredPeriods:1 }, { id:'a2',classId:'c2',subjectId:'s',teacherId:'t',branchId:'b',requiredPeriods:1 }, {id:'a3',classId:'c3',subjectId:'s',teacherId:'other',branchId:'b',requiredPeriods:1}];
  const input = { branches:[branch], teachers, teacherIndex:new Map(teachers.map(t=>[t.id,t])), assignments, assignmentIndex:new Map(assignments.map(a=>[a.id,a])), classes:assignments.map(a=>({id:a.classId,branchId:'b'})), subjects:[{id:'s',isActive:true}],timeSlotsByBranch:new Map([['b',slotsForBranch(branch)]]) };
  const slots = assignments.map((a,i)=>({assignmentId:a.id,classId:a.classId,subjectId:'s',teacherId:a.teacherId,branchId:'b',day:i<2?3:4,session:'sang',period:i===1?3:1}));
  return {input,original:{scheduleId:'source',version:1,slots,directory:{teachers:teachers.map(t=>({id:t.id,name:t.hoTen})),classes:assignments.map(a=>({id:a.classId,name:a.classId}))}}};
}
test('moves all teacher lessons on a day together, preserves other teachers and demand',async()=>{
 const {input,original}=fixture();const before=structuredClone(original);
 const plan=await planner.createPlan({original,input,intent:{kind:'day',teacher:'Kim',fromDay:4,toDay:5,fromSession:null,toSession:null}});
 assert.equal(plan.changes.length,2);assert.equal(plan.evaluation.summary.accepted,true);assert.ok(plan.rows.filter(r=>r.teacherId==='t').every(r=>r.day===4));assert.deepEqual(plan.rows[2],original.slots[2]);assert.equal(plan.rows.length,3);assert.deepEqual(original,before);
});
test('relocates all moved lessons on the target day when preferred periods conflict',async()=>{
 const {input,original}=fixture();original.slots[2].classId='c1';input.assignments[2].classId='c1';input.subjects.push({id:'s2',isActive:true});input.teachers[1].eligibleSubjectIds.push('s2');original.slots[2].subjectId='s2';input.assignments[2].subjectId='s2';
 const plan=await planner.createPlan({original,input,intent:{kind:'day',teacher:'Kim',fromDay:4,toDay:5,fromSession:null,toSession:null}});
 assert.equal(plan.evaluation.summary.accepted,true);assert.equal(plan.repaired,true);assert.equal(plan.rows[0].day,4);assert.notEqual(plan.rows[0].period,1);assert.deepEqual(plan.rows[2],original.slots[2]);
});
test('explicit moves can swap two lessons atomically without rejecting an intermediate conflict',async()=>{
 const {input,original}=fixture();
 const plan=await planner.createPlan({original,input,intent:{kind:'many',moves:[{teacher:'Kim',from:{day:4,session:'sang',period:1},to:{day:4,session:'sang',period:3}},{teacher:'Kim',from:{day:4,session:'sang',period:3},to:{day:4,session:'sang',period:1}}]}});
 assert.equal(plan.changes.length,2);assert.equal(plan.evaluation.summary.accepted,true);
});
test('missing day lessons and duplicate sources fail the whole request',async()=>{
 const {input,original}=fixture();
 await assert.rejects(planner.createPlan({original,input,intent:{kind:'day',teacher:'Kim',fromDay:6,toDay:5}}),e=>e.code==='SOURCE_SLOT_NOT_FOUND');
 const move={teacher:'Kim',from:{day:4,session:'sang',period:1},to:{day:5,session:'sang',period:1}};
 await assert.rejects(planner.createPlan({original,input,intent:{kind:'many',moves:[move,move]}}),/nhiều lần/);
});
test('impossible target day fails closed without changing the original',async()=>{
 const {input,original}=fixture();input.timeSlotsByBranch.set('b',slotsForBranch(branch).filter(s=>s.day!==4));const before=structuredClone(original);
 await assert.rejects(planner.createPlan({original,input,intent:{kind:'day',teacher:'Kim',fromDay:4,toDay:5,fromSession:null,toSession:null}}),e=>e.code==='BATCH_NO_SOLUTION');assert.deepEqual(original,before);
});
