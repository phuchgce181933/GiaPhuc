const test=require('node:test');const assert=require('node:assert/strict');const JSZip=require('jszip');
const {chooseLayout}=require('../../src/modules/presentation/presentation-design.service');
const {buildPptx}=require('../../src/modules/presentation/presentation-pptx.service');
test('PPT Master compositions preserve every source block as editable text within slide bounds',async()=>{
  const layouts=['cover','section','title-body','columns','cards','timeline'];
  const outline=layouts.map((layout,index)=>({title:`Bố cục ${layout}`,content:index<3?'Nội dung tiếng Việt, x².':'Ý một: Hướng dẫn đầu tiên\nÝ hai: Tiếp theo\nÝ ba: Tổng kết',notes:'Ghi chú',layout}));
  const zip=await JSZip.loadAsync(await buildPptx({title:'QA thiết kế',style:'Dark SaaS hiện đại'},outline));
  for(let i=0;i<outline.length;i++) {
    const xml=await zip.file(`ppt/slides/slide${i+1}.xml`).async('string');assert.ok(xml.includes(outline[i].title));
    for(const line of outline[i].content.split('\n'))assert.ok(xml.includes(line));
    for(const match of xml.matchAll(/<a:xfrm[^>]*>\s*<a:off x="(\d+)" y="(\d+)"\/>\s*<a:ext cx="(\d+)" cy="(\d+)"\/>/g)) {
      const [x,y,w,h]=match.slice(1).map(Number);assert.ok(x+w<=12192001,'horizontal canvas overflow');assert.ok(y+h<=6858001,'vertical canvas overflow');
    }
  }
  assert.equal(chooseLayout({content:'x'.repeat(1000),layout:'cards'},2,5,false),'title-body');
  assert.equal(chooseLayout({content:'Text',layout:'timeline'},2,5,true),'title-body');
  assert.equal(chooseLayout({content:'Một\nHai\nBa',layout:'timeline'},2,5,true),'timeline');
});
test('media preserves distinct compositions and palette rhythm instead of forcing every slide to the same template',async()=>{
 const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
 const layouts=['cover','title-body','cards','columns','timeline','section'];
 const roles=['anchor','cool','warm','fresh','neutral','warm'];
 const placements=['background','left','right','top','accent','background'];
 const outline=layouts.map((layout,index)=>({title:`Slide ${layout}`,layout,colorRole:roles[index],content:'Một: Nội dung thứ nhất\nHai: Nội dung thứ hai\nBa: Nội dung thứ ba',notes:''}));
 const media=placements.map(placement=>({kind:'image',placement,data:png}));
 const zip=await JSZip.loadAsync(await buildPptx({title:'Media QA'},outline,[],media));
 const frames=new Set(),backgrounds=new Set();
 for(let i=0;i<outline.length;i++) {
  const xml=await zip.file(`ppt/slides/slide${i+1}.xml`).async('string');
  backgrounds.add(xml.match(/<p:bg>[\s\S]*?<a:srgbClr val="([A-Fa-f0-9]+)"/)?.[1]);
  const picture=xml.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0];assert.ok(picture);frames.add(picture.match(/<a:xfrm>[\s\S]*?<\/a:xfrm>/)?.[0]);
  for(const block of outline[i].content.split('\n'))assert.ok(xml.includes(block));
 }
 assert.ok(frames.size>=5,'Media frame geometry must vary by page role');assert.ok(backgrounds.size>=4,'Deck needs a coordinated multi-hue rhythm');
});
test('landscape images keep their actual aspect ratio in portrait and wide frames',()=>{
 const {fitImageFrame}=require('../../src/modules/presentation/presentation-design.service');
 const data='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP8//8/AwMDAA7/Av+4xZ6ZAAAAAElFTkSuQmCC';
 for(const frame of [{x:7,y:1,w:5,h:6},{x:1,y:4,w:10,h:2}]){
   const fitted=fitImageFrame(data,frame);assert.equal(fitted.w/fitted.h,2);assert.ok(fitted.x>=frame.x&&fitted.y>=frame.y);assert.ok(fitted.x+fitted.w<=frame.x+frame.w);assert.ok(fitted.y+fitted.h<=frame.y+frame.h);
 }
});
test('weak AI color plans are normalized into a varied semantic rhythm',()=>{
 const {ensureColorRhythm}=require('../../src/modules/presentation/presentation-design.service');
 const slides=Array.from({length:7},(_,index)=>({title:String(index),content:'Content',notes:'',layout:index===0?'cover':index===6?'section':'title-body',colorRole:'cool'}));
 const result=ensureColorRhythm(slides);assert.ok(new Set(result.map(slide=>slide.colorRole)).size>=4);assert.equal(result[0].colorRole,'anchor');
 const intentional=[{colorRole:'anchor'},{colorRole:'cool'},{colorRole:'warm'},{colorRole:'fresh'}];assert.equal(ensureColorRhythm(intentional),intentional);
});
test('visual styles produce distinct executable color and typography behavior',async()=>{
 const {slideColors}=require('../../src/modules/presentation/presentation-design.service');
 const item={colorRole:'warm',content:'Một\nHai\nBa',layout:'cards'};
 const minimal=slideColors('Năng động thương hiệu',item,1,'cards',false,'Minimalism','Corporate & Business');
 const flat=slideColors('Năng động thương hiệu',item,1,'cards',false,'Flat Design & Illustration','Education');
 const glass=slideColors('Năng động thương hiệu',item,1,'cards',false,'Glassmorphism','Corporate & Business');
 const editorial=slideColors('Năng động thương hiệu',item,1,'cards',false,'Editorial','Văn hóa & Truyền thống');
 const mono=slideColors('Năng động thương hiệu',item,1,'cards',false,'Monochrome & Muted','Corporate & Business');
 const bold=slideColors('Năng động thương hiệu',item,1,'cards',false,'Bold Geometric / Poster','Minigame / Event');
 const wire=slideColors('Năng động thương hiệu',item,1,'cards',false,'Tech Wireframe','Corporate & Business');
 assert.equal(minimal.minimal,true);assert.equal(minimal.background,'FFF9F2');assert.equal(flat.flat,true);assert.ok(new Set(flat.cardPalette).size>=5);
 assert.equal(glass.glass,true);assert.equal(glass.dark,true);assert.equal(editorial.editorial,true);assert.equal(mono.accent,'7B3FE4');assert.equal(new Set(mono.cardPalette).size,5);
 assert.equal(bold.boldGeometric,true);assert.equal(bold.accent,'FF641E');assert.equal(wire.wireframe,true);assert.equal(wire.accent,'21C4D6');
 const outline=[{title:'Kính mờ',content:'Một\nHai\nBa',notes:'',layout:'cards',colorRole:'cool'}];
 const zip=await JSZip.loadAsync(await buildPptx({title:'Glass',visualStyle:'Glassmorphism',presentationType:'Corporate & Business',style:'Năng động thương hiệu'},outline));
 const xml=await zip.file('ppt/slides/slide1.xml').async('string');assert.ok(xml.includes('prst="roundRect"'));assert.ok(xml.includes('<a:alpha'));
 const boldZip=await JSZip.loadAsync(await buildPptx({title:'Poster',visualStyle:'Bold Geometric / Poster',presentationType:'Minigame / Event'},[{title:'Ưu đãi tháng 10',content:'Khám phá ngay',notes:'',layout:'cover',colorRole:'anchor'}]));
 const boldXml=await boldZip.file('ppt/slides/slide1.xml').async('string');assert.ok(boldXml.includes('Arial Black'));assert.ok(boldXml.includes('FF641E'));
 const wireZip=await JSZip.loadAsync(await buildPptx({title:'Wire',visualStyle:'Tech Wireframe',presentationType:'Corporate & Business'},[{title:'Meridian',content:'Technology briefing',notes:'',layout:'cover',colorRole:'cool'}]));
 const wireXml=await wireZip.file('ppt/slides/slide1.xml').async('string');assert.ok(wireXml.includes('prst="arc"'));assert.ok(wireXml.includes('21C4D6'));
});
