const test = require('node:test');
const assert = require('node:assert/strict');
const { Writable, Readable } = require('node:stream');
const JSZip = require('jszip');
const MP4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

test('video jobs persist, deduplicate, poll, enforce ownership and attach to the correct slide', async () => {
  const db = require('../../src/config/db'); const originalDB = db.connectPresentationDB;
  const mongo = require('mongoose').mongo; const bucketDescriptor = Object.getOwnPropertyDescriptor(mongo,'GridFSBucket');
  const originalFetch = global.fetch; const settings = require('../../src/config').PRESENTATION; const originalKey = settings.VIDEO_API_KEY;
  const records = new Map(), files = new Map(); let posts = 0, checks = 0, downloads = 0;
  const matches = (row, filter) => Object.entries(filter).every(([key, value]) => row[key] === value);
  const collection = {
    findOne: async filter => [...records.values()].find(row => matches(row,filter)),
    insertOne: async row => { if(records.has(row._id))throw Object.assign(new Error('duplicate'),{code:11000});records.set(row._id,{...row}); },
    updateOne: async (filter, op) => { const row=[...records.values()].find(row=>matches(row,filter));if(!row)return {modifiedCount:0};Object.assign(row,op.$set);return {modifiedCount:1}; },
    find: filter => ({sort:()=>({toArray:async()=>[...records.values()].filter(row=>matches(row,filter))})}),
  };
  class Bucket {
    openUploadStream() { const parts=[];const id='file-'+files.size;const stream=new Writable({write(chunk,_encoding,done){parts.push(chunk);done();},final(done){files.set(id,Buffer.concat(parts));done();}});stream.id=id;return stream; }
    openDownloadStream(id) { return Readable.from([files.get(id)]); }
    async delete(id){files.delete(id);}
  }
  db.connectPresentationDB=async()=>({db:{collection:()=>collection}});Object.defineProperty(mongo,'GridFSBucket',{value:Bucket,configurable:true});settings.VIDEO_API_KEY='test-key';
  global.fetch=async(url,request)=>{
    assert.equal(new URL(url).hostname,'modelapi.vn');assert.equal(request.headers.Authorization,'Bearer test-key');
    assert.equal(request.headers['Content-Type'],'application/json');
    if(request.method==='POST'){posts++;const body=JSON.parse(request.body);assert.equal(body.model,'grok-imagine-video-1.5');assert.equal(body.seconds,'8');assert.ok(body.prompt.includes('not a panned, zoomed'));assert.ok(body.prompt.includes('turtle character'));assert.ok(body.prompt.includes('Camera movement is secondary'));return {ok:true,json:async()=>({id:'video_QA',task_id:'video_QA',status:'queued',progress:0})};}
    if(url.endsWith('/content')){downloads++;return new Response(MP4,{headers:{'Content-Type':'video/mp4'}});}
    checks++;return {ok:true,json:async()=>({status:checks===1?'in_progress':'completed'})};
  };
  const path=require.resolve('../../src/modules/presentation/presentation-media.service');delete require.cache[path];const media=require(path);
  const outline=[{title:'Giới thiệu',content:'Mở đầu',notes:''},{title:'Công nghệ',content:'Rùa xanh đang lập trình',notes:''}];const presentation={_id:'a'.repeat(24),title:'QA',style:'Dark SaaS hiện đại'};
  try {
    const input={kind:'video',placement:'right',slideIndex:1,outline,prompt:'Rùa xanh lập trình'};
    const asset=await media.create('owner',presentation,input);assert.equal(asset.status,'queued');assert.equal(asset.slideIndex,1);assert.equal(asset.providerId,undefined);
    await media.create('owner',presentation,input);assert.equal(posts,1);
    const moved=await media.create('owner',presentation,{...input,placement:'top'});assert.equal(posts,1);assert.equal(moved.placement,'top');
    await assert.rejects(media.refresh('other',presentation._id,asset.id),e=>e.statusCode===404);
    await assert.rejects(media.resolve('owner',presentation._id,outline,[asset.id]),e=>e.statusCode===409);
    assert.equal((await media.refresh('owner',presentation._id,asset.id)).status,'processing');
    assert.equal((await media.refresh('owner',presentation._id,asset.id)).status,'completed');
    await media.refresh('owner',presentation._id,asset.id);assert.equal(downloads,1);
    const attached=await media.resolve('owner',presentation._id,outline,[asset.id]);assert.equal(attached[0],undefined);assert.equal(attached[1].kind,'video');
    const changed=structuredClone(outline);changed[1].content='Nội dung đã đổi';await assert.rejects(media.resolve('owner',presentation._id,changed,[asset.id]),e=>e.statusCode===409);
    await assert.rejects(media.resolve('owner',presentation._id,outline,[asset.id,asset.id]),e=>e.statusCode===400);
    const {buildPptx}=require('../../src/modules/presentation/presentation-pptx.service');const zip=await JSZip.loadAsync(await buildPptx(presentation,outline,[],attached));
    const videoPath=Object.keys(zip.files).find(path=>/^ppt\/media\/.*\.mp4$/.test(path));assert.ok(videoPath);assert.deepEqual(await zip.file(videoPath).async('nodebuffer'),MP4);
    assert.ok((await zip.file('ppt/slides/slide2.xml').async('string')).includes('videoFile'));assert.ok(!(await zip.file('ppt/slides/slide1.xml').async('string')).includes('videoFile'));
    assert.equal((await media.list('owner',presentation._id)).length,1);assert.equal((await media.list('other',presentation._id)).length,0);
    global.fetch=async()=>({ok:true,json:async()=>({status:'failed'})});const stored=records.get(asset.id);stored.status='queued';assert.equal((await media.refresh('owner',presentation._id,asset.id)).status,'failed');
  } finally {db.connectPresentationDB=originalDB;Object.defineProperty(mongo,'GridFSBucket',bucketDescriptor);global.fetch=originalFetch;settings.VIDEO_API_KEY=originalKey;delete require.cache[path];}
});

test('video rejects errors, malformed MP4 and oversized responses', async()=>{
  const media=require('../../src/modules/presentation/presentation-media.service');const config=require('../../src/config').PRESENTATION;const old=config.VIDEO_API_KEY;config.VIDEO_API_KEY='test';
  try {
    await assert.rejects(media.videoRequest('',{},async()=>({ok:false,status:429})),e=>e.statusCode===429);
    await assert.rejects(media.boundedVideo(new Response('<html>not a video</html>')),e=>e.statusCode===502);
    await assert.rejects(media.boundedVideo(new Response(MP4,{headers:{'content-length':String(51*1024*1024)}})),e=>e.statusCode===502);
  }finally{config.VIDEO_API_KEY=old;}
});
