// Calls the real configured provider, without saving records or creating Canva designs.
const assert=require('node:assert/strict');
const {modelRequest}=require('../../src/modules/presentation/presentation.service');
(async()=>{
  const result=await modelRequest('Tạo đúng 2 slide bằng tiếng Việt cho học sinh: slide đầu giới thiệu an toàn mạng, slide sau hướng dẫn dùng mật khẩu mạnh. Chỉ trả JSON {slides:[{title,content,notes}]}. Không bịa số liệu.');
  assert.equal(result.slides.length,2);console.log(JSON.stringify({provider:'ModelAPI',slides:result.slides.length,valid:true,databaseWrites:0}));
})().catch(e=>{console.error(e.code,e.message);process.exitCode=1;});
