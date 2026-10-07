import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const jwt = require('jsonwebtoken');
const env = require('../../src/config');
const authenticate = require('../../src/middlewares/auth.middleware');
const access = require('../../src/middlewares/timetable-rbac.middleware');
const User = require('../../src/modules/user/user.model');
const { PERMISSIONS: P } = require('../../src/shared/permissions');

function check(path, method, permissions) {
  let outcome;
  access({ path, method, user: { role: { permissions } } }, {}, (error) => { outcome = error ?? null; });
  return outcome;
}
test('timetable access: a viewer may read but cannot write, generate or commit', () => {
  assert.equal(check('/teachers', 'GET', [P.TKB_VIEW]), null);
  for (const [path, method] of [['/teachers','POST'],['/teachers/x/preferences','PUT'],['/schedules/generate','POST'],['/schedules/commit','POST']]) {
    assert.equal(check(path, method, [P.TKB_VIEW]).statusCode, 403);
  }
});
test('timetable access: URL case and trailing slash cannot bypass generation or commit rights', () => {
  for (const path of ['/schedules/generate/','/SCHEDULES/GENERATE','/schedules/commit/','/SCHEDULES/COMMIT']) {
    assert.equal(check(path,'POST',[P.TKB_VIEW,P.TKB_CATALOG_MANAGE]).statusCode,403);
  }
});
test('timetable access: write permissions do not implicitly grant read access', () => {
  assert.equal(check('/schedules/commit','POST',[P.TKB_COMMIT]).statusCode,403);
  assert.equal(check('/schedules/commit','POST',[P.TKB_VIEW,P.TKB_COMMIT]),null);
  assert.equal(check('/teachers/x/preferences','PUT',[P.TKB_VIEW,P.TKB_PREFERENCE_UPDATE]),null);
});
test('JWT: missing, expired and refresh tokens do not authenticate a timetable user', async () => {
  for (const token of [null, jwt.sign({sub:'000000000000000000000001',type:'access'},env.JWT_SECRET,{expiresIn:-1}),
    jwt.sign({sub:'000000000000000000000001',type:'refresh'},env.JWT_SECRET)]) {
    let error;await authenticate({headers:token?{authorization:`Bearer ${token}`}:{ }},{},(e)=>{error=e;});
    assert.equal(error.statusCode,401);
  }
});
test('JWT: current account state and database permissions remain authoritative', async () => {
  const original=User.findById;
  let status='active';
  User.findById=()=>({select(){return this;},populate(){return this;},async lean(){return {_id:'000000000000000000000001',email:'qa@example.invalid',status,role:{_id:'r',key:'qa',name:'QA',permissions:[P.TKB_VIEW]}};}});
  try {
    const token=jwt.sign({sub:'000000000000000000000001',type:'access',permissions:[P.TKB_COMMIT]},env.JWT_SECRET);
    const req={headers:{authorization:`Bearer ${token}`}};let error;
    await authenticate(req,{},(e)=>{error=e;});assert.equal(error,undefined);
    assert.deepEqual(req.user.role.permissions,[P.TKB_VIEW]);
    status='locked';await authenticate({headers:req.headers},{},(e)=>{error=e;});assert.equal(error.statusCode,403);
  } finally {User.findById=original;}
});
