const test=require('node:test');
const assert=require('node:assert/strict');
const {createSchema}=require('../../src/modules/presentation/presentation.validation');
const {presentationSchema}=require('../../src/modules/presentation/presentation.model');

test('presentation source content is not capped at 50,000 characters',()=>{
  const sourceContent='Nội dung dài. '.repeat(100000);
  const parsed=createSchema.parse({title:'Tài liệu dài',sourceContent,language:'Tiếng Việt',audience:'Giáo viên',slideCount:10,style:'Tối giản chuyên nghiệp'});
  assert.equal(parsed.sourceContent,sourceContent.trim());
  assert.ok(parsed.sourceContent.length>50000);
  assert.equal(presentationSchema.path('sourceContent').options.maxlength,undefined);
  assert.equal(parsed.visualStyle,'Flat Design & Illustration');assert.equal(parsed.presentationType,'Education');
});

test('presentation route accepts JSON larger than the global 1 MB parser limit',async()=>{
  const app=require('../../src/app');const server=app.listen(0);await new Promise(resolve=>server.once('listening',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/presentations`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sourceContent:'x'.repeat(1100000)})});
    assert.notEqual(response.status,413);
    assert.equal(response.status,401);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
