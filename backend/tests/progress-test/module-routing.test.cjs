const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
test('merged app mounts all protected modules and retains matching permission catalogs', async () => {
 const app = require('../../src/app');
 const server = app.listen(0);
 await new Promise(resolve => server.once('listening',resolve));
 try {
  const base = 'http://127.0.0.1:' + server.address().port;
  for(const route of ['/api/progress-test/catalog','/api/timetable/schedules/committed','/api/presentations']) {
   const response = await fetch(base + route);
   assert.equal(response.status,401,route + ' must be mounted and protected, not missing');
  }
  const {PERMISSION_LIST} = require('../../src/shared/permissions');
  const frontend = fs.readFileSync(path.resolve(__dirname,'../../../frontend/src/lib/env.js'),'utf8');
  for(const prefix of ['progress-test:','presentation:','tkb:']) {
   const permissions = PERMISSION_LIST.filter(key=>key.startsWith(prefix));
   assert.ok(permissions.length>0,prefix);
   for(const key of permissions) assert.ok(frontend.includes(key),key);
  }
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
