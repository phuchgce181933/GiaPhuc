import test from 'node:test';
import assert from 'node:assert/strict';
import { slotsForBranch } from '../src/domain/constraints.js';
import { evaluateCandidate } from '../src/domain/constraints/index.js';
import { countTeachingSessions } from '../src/domain/time.js';
import { preferencePenaltyBreakdown } from '../src/domain/metrics.js';

const b1={id:'b1',schoolDays:[1,2,3,4,5],periods:[1,2,3,4,5,6,7],sessions:{sang:[1,2,3,4],chieu:[5,6,7]}};
const b2={...b1,id:'b2'};
function evaluate(rows, assignments, teachers=[]) {
  const input={branches:[b1,b2],teachers,teacherIndex:new Map(teachers.map(t=>[t.id,t])),classes:[],
    assignments:assignments.map(x=>({id:x.id,requiredPeriods:1})),
    assignmentIndex:new Map(assignments.map(x=>[x.id,x])),
    timeSlotsByBranch:new Map([['b1',slotsForBranch(b1)],['b2',slotsForBranch(b2)]])};
  const candidate={assignments:new Map(rows.map(x=>[x.id,[x.slot]])),placements:new Map(rows.map(x=>[x.id,{teacherId:x.teacherId,branchId:x.slot.branchId}]))};
  return evaluateCandidate(candidate,input);
}

test('weekday calendar has 33 available periods and blocks Monday M1 / Friday M4',()=>{
  const slots=slotsForBranch(b1);
  assert.equal(slots.length,33);
  assert.equal(slots.some(s=>s.day===1&&s.period===1),false);
  assert.equal(slots.some(s=>s.day===5&&s.period===4),false);
  assert.deepEqual([...new Set(slots.map(s=>s.day))],[1,2,3,4,5]);
});

test('teaching sessions count distinct day and session, not periods',()=>{
  const schedule=new Map([['a',[{teacherId:'t',day:1,session:'sang',period:2},{teacherId:'t',day:1,session:'sang',period:3},{teacherId:'t',day:1,session:'chieu',period:5},{teacherId:'t',day:2,session:'sang',period:2}]]]);
  assert.equal(countTeachingSessions(schedule,'t'),3);
});

test('independent evaluator rejects same class-subject in consecutive periods but allows gaps and session boundary',()=>{
  const assignments=[{id:'a',classId:'c',subjectId:'s',teacherId:'t',branchId:'b1'},{id:'b',classId:'c',subjectId:'s',teacherId:'t',branchId:'b1'}];
  const consecutive=evaluate([{id:'a',teacherId:'t',slot:{branchId:'b1',day:2,period:2}},{id:'b',teacherId:'t',slot:{branchId:'b1',day:2,period:3}}],assignments);
  assert.equal(consecutive.hard.violations.some(x=>x.constraintId==='H16'),true);
  for(const pair of [[2,4],[4,5]]) {
    const ok=evaluate([{id:'a',teacherId:'t',slot:{branchId:'b1',day:2,period:pair[0]}},{id:'b',teacherId:'t',slot:{branchId:'b1',day:2,period:pair[1]}}],assignments);
    assert.equal(ok.hard.violations.some(x=>x.constraintId==='H16'),false);
  }
});

test('independent evaluator rejects cross-branch adjacent teacher periods in either direction, but not across sessions',()=>{
  const assignments=[{id:'a',classId:'c1',subjectId:'s1',teacherId:'t',branchId:'b1'},{id:'b',classId:'c2',subjectId:'s2',teacherId:'t',branchId:'b2'}];
  for(const branches of [['b1','b2'],['b2','b1']]) {
    const bad=evaluate([{id:'a',teacherId:'t',slot:{branchId:branches[0],day:2,period:2}},{id:'b',teacherId:'t',slot:{branchId:branches[1],day:2,period:3}}],assignments);
    assert.equal(bad.hard.violations.some(x=>x.constraintId==='H17'),true);
  }
  const valid=evaluate([{id:'a',teacherId:'t',slot:{branchId:'b1',day:2,period:4}},{id:'b',teacherId:'t',slot:{branchId:'b2',day:2,period:5}}],assignments);
  assert.equal(valid.hard.violations.some(x=>x.constraintId==='H17'),false);
});

test('preference breakdown measures desired sessions, off-day, off-part and preferred transfer branch',()=>{
  const teacher={id:'t',homeBranchId:'b1',preferredTransferBranches:['b2'],nguyenVong:{buoiUuTien:'sang',desiredTeachingSessionsPerWeek:4,thuNghi:[3],preferredOffDay:'WEDNESDAY',preferredOffPart:'MORNING'}};
  const assignmentIndex=new Map([['a',{teacherId:'t'}]]);
  const input={branches:[b1,b2],teachers:[teacher],assignmentIndex};
  const candidate={assignments:new Map([['a',[{teacherId:'t',branchId:'b2',day:3,period:2},{teacherId:'t',branchId:'b2',day:3,period:3},{teacherId:'t',branchId:'b2',day:3,period:6}]]])};
  const parts=preferencePenaltyBreakdown(candidate,input);
  assert.equal(parts.desiredSessions,0.5);
  assert.equal(parts.offDay,1);
  assert.equal(parts.offPart,1);
  assert.equal(parts.transferBranch,0);
  assert.ok(parts.session>0);
});

test('blocked Monday M1 and Friday M4 are independently rejected by evaluator',()=>{
  const assignment=[{id:'a',classId:'c',subjectId:'s',teacherId:'t',branchId:'b1'}];
  for(const slot of [{branchId:'b1',day:1,period:1},{branchId:'b1',day:5,period:4}]) {
    const result=evaluate([{id:'a',teacherId:'t',slot}],assignment);
    assert.equal(result.hard.violations.some(x=>x.constraintId==='H15'),true);
  }
});
