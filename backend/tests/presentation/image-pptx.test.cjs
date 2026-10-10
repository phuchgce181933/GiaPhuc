const test=require('node:test');
const assert=require('node:assert/strict');
const JSZip=require('jszip');
const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
test('image generation caches per owner/content, validates provider errors and embeds PNG in PPTX',async()=>{
 const db=require('../../src/config/db');const original=db.connectPresentationDB;const config=require('../../src/config').PRESENTATION;const old=config.IMAGE_API_KEY;config.IMAGE_API_KEY='QA-not-real';const cache=new Map();
 db.connectPresentationDB=async()=>({db:{collection:()=>({findOne:async({_id})=>cache.get(_id),updateOne:async({_id},op)=>cache.set(_id,op.$setOnInsert)})}});
 const modulePath=require.resolve('../../src/modules/presentation/presentation-image.service');delete require.cache[modulePath];
 const service=require(modulePath);const outline=[{title:'Toán',content:'Nội dung minh họa',notes:'Ghi chú'}];let calls=0;
 try{
  const options={fetcher:async(_url,request)=>{calls++;const body=JSON.parse(request.body);assert.equal(body.model,'gpt-image-2');for(const rule of ['5500K','4000-4500K','50mm','F1.8','minimalism','soft shadows','true-to-life','no yellow or blue cast','clean 2D flat vector'])assert.ok(body.prompt.includes(rule),rule);return {ok:true,json:async()=>({data:[{b64_json:PNG}]})};}};
  const images=await service.generateSlideImages('owner',{title:'QA',style:'Dark'},outline,options);
  await service.generateSlideImages('owner',{title:'QA',style:'Dark'},outline,options);assert.equal(calls,1);
  await service.generateSlideImages('owner',{title:'QA',style:'Dark'},outline,{...options,promptOverride:'Evening classroom scene'});assert.equal(calls,2);
  const {buildPptx}=require('../../src/modules/presentation/presentation-pptx.service');const zip=await JSZip.loadAsync(await buildPptx({title:'QA',outline},outline,images));assert.ok(Object.keys(zip.files).some(p=>/^ppt\/media\/.*\.png$/.test(p)));
  await assert.rejects(service.generateSlideImages('other',{title:'QA'},outline,{fetcher:async()=>({ok:false,status:403})}),e=>e.statusCode===502);
  assert.throws(()=>service.validateImage(Buffer.from('<html>bad</html>').toString('base64')),e=>e.statusCode===502);
  await assert.rejects(service.generateSlideImages('owner',{title:'QA'},Array(11).fill(outline[0]),options),e=>e.statusCode===400);
 }finally{db.connectPresentationDB=original;config.IMAGE_API_KEY=old;delete require.cache[modulePath];}
});
