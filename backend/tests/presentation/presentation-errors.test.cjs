const test = require('node:test');
const assert = require('node:assert/strict');
const env = require('../../src/config');
const ApiError = require('../../src/shared/ApiError');
const service = require('../../src/modules/presentation/presentation.service');
test('async presentation failures reach error middleware and leave server alive', async () => {
  const original = service.outline;
  service.outline = async () => { throw new ApiError(503, 'ModelAPI unavailable'); };
  const app = require('express')(); app.use(require('express').json()); app.use((req, _res, next) => { req.user = { id: 'QA' }; next(); });
  app.post('/presentations', require('../../src/modules/presentation/presentation.controller').create);
  app.get('/health', (_req,res) => res.json({ok:true})); app.use(require('../../src/middlewares/error.middleware'));
  const server = app.listen(0); await new Promise(r => server.once('listening',r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base+'/presentations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'QA',sourceContent:'Sample content for a presentation.',language:'English',audience:'Students',slideCount:2,style:'Dark SaaS hiện đại'})});
    assert.equal(response.status,503); assert.equal((await response.json()).message,'ModelAPI unavailable'); assert.equal((await fetch(base+'/health')).status,200);
  } finally { service.outline=original; await new Promise(r=>server.close(r)); }
});
test('ModelAPI missing key, failures, malformed output and valid fenced JSON have controlled outcomes', async () => {
  const settings={...env.PRESENTATION};const originalFetch=global.fetch;
  try {
    env.PRESENTATION.MODEL_API_KEY=''; await assert.rejects(service.modelRequest('test'),e=>e.statusCode===503);
    env.PRESENTATION.MODEL_API_KEY='QA-NOT-A-REAL-KEY';
    global.fetch=async()=>({ok:false,status:429});await assert.rejects(service.modelRequest('test'),e=>e.statusCode===429);
    global.fetch=async()=>({ok:false,status:401});await assert.rejects(service.modelRequest('test'),e=>e.statusCode===502);
    global.fetch=async()=>{throw Object.assign(new Error('secret'),{name:'TimeoutError'});};await assert.rejects(service.modelRequest('test'),e=>e.statusCode===504&&!e.message.includes('secret'));
    global.fetch=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]})});await assert.rejects(service.modelRequest('test'),e=>e.statusCode===502);
    const output={slides:[{title:'Title',content:'Content',notes:'Notes'}]};
    global.fetch=async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'```json\n'+JSON.stringify(output)+'\n```'}}]})});assert.deepEqual(await service.modelRequest('test'),output);
  } finally { Object.assign(env.PRESENTATION,settings);global.fetch=originalFetch; }
});
test('missing Canva OAuth reports unavailable rather than a generic crash', () => {
  const settings={...env.PRESENTATION.CANVA};
  try { env.PRESENTATION.CANVA.CLIENT_ID='';assert.throws(()=>service.oauthStart('QA'),e=>e.statusCode===503); }
  finally { Object.assign(env.PRESENTATION.CANVA,settings); }
});
