const test=require('node:test');
const assert=require('node:assert/strict');
test('AI media recommendations preserve indices and reject duplicate or missing slide plans',async()=>{
  const ai=require('../../src/modules/presentation/presentation.service');const old=ai.modelRequest;
  const {suggest}=require('../../src/modules/presentation/presentation-media-plan.service');
  const outline=[{title:'Mở đầu',content:'Giới thiệu',notes:''},{title:'Quy trình',content:'Hướng dẫn thao tác',notes:''}];
  try {
    ai.modelRequest=async(_prompt,options)=>{assert.ok(options.system.includes('full-bleed background'));return {slides:[{slideIndex:1,kind:'video',placement:'right',prompt:'Thao tác trong 8 giây',reason:'Có chuyển động'},{slideIndex:0,kind:'image',placement:'background',prompt:'Không gian mở đầu',reason:'Tạo không khí'}]};};
    const result=await suggest({title:'QA'},outline);assert.deepEqual(result.slides.map(s=>s.slideIndex),[0,1]);assert.equal(result.slides[0].placement,'background');
    ai.modelRequest=async()=>({slides:[{slideIndex:0,kind:'none',placement:'auto',prompt:'',reason:'Text'},{slideIndex:0,kind:'image',placement:'left',prompt:'Scene',reason:'Image'}]});
    await assert.rejects(suggest({title:'QA'},outline),e=>e.statusCode===502);
    ai.modelRequest=async()=>({slides:[{slideIndex:0,kind:'image',placement:'left',prompt:'',reason:'Image'},{slideIndex:1,kind:'none',placement:'auto',prompt:'',reason:'Text'}]});
    await assert.rejects(suggest({title:'QA'},outline),e=>e.statusCode===502);
    ai.modelRequest=async()=>({slides:[{slideIndex:0,kind:'video',placement:'background',prompt:'Move',reason:'Video'},{slideIndex:1,kind:'none',placement:'auto',prompt:'',reason:'Text'}]});
    await assert.rejects(suggest({title:'QA'},outline),e=>e.statusCode===502);
  }finally{ai.modelRequest=old;}
});
