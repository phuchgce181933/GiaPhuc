const test = require('node:test');
const assert = require('node:assert/strict');
const JSZip = require('jszip');
const { buildPptx } = require('../../src/modules/presentation/presentation-pptx.service');
test('PPTX route requires both read and export permissions', () => {
 const route=require('../../src/modules/presentation/presentation.route').stack.find(layer=>layer.route?.path==='/:id/pptx').route;
 const guard=route.stack[0].handle;
 for(const permissions of [[],['presentation:read'],['presentation:export']]) { let error;guard({user:{role:{permissions}}},{},e=>{error=e;});assert.equal(error.statusCode,403); }
 let error;guard({user:{role:{permissions:['presentation:read','presentation:export']}}},{},e=>{error=e;});assert.equal(error,undefined);
});
test('direct PowerPoint preserves editable Vietnamese text, notes and widescreen layout', async () => {
  const source = { title: 'Bài kiểm tra Toán', audience: 'Học sinh', language: 'Tiếng Việt', style: 'Dark SaaS hiện đại', outline: [{ title: 'Giới thiệu', content: 'Nội dung tiếng Việt: x², √, π.', notes: 'Ghi chú giáo viên' }, { title: 'Kết luận', content: 'Cảm ơn các bạn', notes: '' }] };
  const before = structuredClone(source);
  const buffer = await buildPptx(source);
  assert.ok(Buffer.isBuffer(buffer));assert.equal(buffer.subarray(0,2).toString(),'PK');
  const zip = await JSZip.loadAsync(buffer);
  assert.equal(Object.keys(zip.files).filter(p=>/^ppt\/slides\/slide\d+\.xml$/.test(p)).length,2);
  const slide=await zip.file('ppt/slides/slide1.xml').async('string');
  assert.ok(slide.includes('Giới thiệu'));assert.ok(slide.includes('Nội dung tiếng Việt'));assert.ok(slide.includes('<a:t>'));
  const notes=await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');assert.ok(notes.includes('Ghi chú giáo viên'));
  const presentation=await zip.file('ppt/presentation.xml').async('string');assert.ok(presentation.includes('12192000'));
  assert.deepEqual(source,before);
});
test('invalid outline cannot produce an empty or malformed deck', async () => {
  await assert.rejects(buildPptx({title:'Title',outline:[]}),e=>e.statusCode===422);
});
test('download endpoint enforces ownership and returns real PPTX, not Canva JSON', async () => {
  const service=require('../../src/modules/presentation/presentation.service');const original=service.getOwned;
  const row={title:'Test',outline:[{title:'Title',content:'Content',notes:'Notes'}]};
  service.getOwned=async(owner,id)=>{assert.equal(owner,'QA');if(id==='b'.repeat(24))throw require('../../src/shared/ApiError').notFound('Not owned');return row;};
  const express=require('express');const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:'QA'};next();});app.post('/:id/pptx',require('../../src/modules/presentation/presentation.controller').downloadPptx);app.use(require('../../src/middlewares/error.middleware'));const server=app.listen(0);await new Promise(r=>server.once('listening',r));
  try {const base=`http://127.0.0.1:${server.address().port}`;const response=await fetch(base+'/'+ 'a'.repeat(24)+'/pptx',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,200);assert.ok(response.headers.get('content-type').includes('presentationml'));assert.equal(Buffer.from(await response.arrayBuffer()).subarray(0,2).toString(),'PK');assert.equal((await fetch(base+'/'+ 'b'.repeat(24)+'/pptx',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404);}finally{service.getOwned=original;await new Promise(r=>server.close(r));}
});
