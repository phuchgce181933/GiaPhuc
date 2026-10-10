const test=require('node:test');
const assert=require('node:assert/strict');

test('delete endpoint enforces permission and deletes owned presentation media first',async()=>{
  const route=require('../../src/modules/presentation/presentation.route').stack.find(layer=>layer.route?.path==='/:id'&&layer.route.methods.delete).route;
  const guard=route.stack[0].handle;
  let denied;guard({user:{role:{permissions:[]}}},{},error=>{denied=error;});assert.equal(denied.statusCode,403);
  let allowed;guard({user:{role:{permissions:['presentation:delete']}}},{},error=>{allowed=error;});assert.equal(allowed,undefined);
  const service=require('../../src/modules/presentation/presentation.service');const media=require('../../src/modules/presentation/presentation-media.service');
  const originalOwned=service.getOwned,originalRemove=media.removeAll;const calls=[];
  const row={_id:'a'.repeat(24),deleteOne:async()=>calls.push('presentation')};
  service.getOwned=async(owner,id)=>{assert.equal(owner,'owner');assert.equal(id,row._id);return row;};
  media.removeAll=async(owner,id)=>{assert.equal(owner,'owner');assert.equal(String(id),row._id);calls.push('media');return 2;};
  const express=require('express');const app=express();app.use((req,_res,next)=>{req.user={id:'owner'};next();});app.delete('/:id',require('../../src/modules/presentation/presentation.controller').remove);app.use(require('../../src/middlewares/error.middleware'));const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try {const response=await fetch(`http://127.0.0.1:${server.address().port}/${row._id}`,{method:'DELETE'});assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,data:{deleted:true}});assert.deepEqual(calls,['media','presentation']);}
  finally{service.getOwned=originalOwned;media.removeAll=originalRemove;await new Promise(resolve=>server.close(resolve));}
});
