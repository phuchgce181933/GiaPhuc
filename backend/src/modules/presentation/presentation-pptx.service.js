'use strict';
const PptxGenJS = require('pptxgenjs');
const ApiError = require('../../shared/ApiError');
const { outlineSchema } = require('./presentation.validation');
const { chooseLayout,contentBlocks,mediaFrame,resolvePlacement,fitImageFrame,coverImageFrame,slideColors } = require('./presentation-design.service');
async function buildPptx(presentation, outline = presentation.outline, images = [], media = []) {
  const result = outlineSchema.safeParse({ slides: outline });
  if (!result.success) throw ApiError.unprocessable('Cần có cấu trúc slide hợp lệ trước khi tải PowerPoint.');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'GiaPhuc'; pptx.subject = presentation.audience || ''; pptx.title = presentation.title; pptx.company = 'GiaPhuc'; pptx.lang = presentation.language === 'English' ? 'en-US' : 'vi-VN';
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: pptx.lang };
  result.data.slides.forEach((item, index) => {
    const slide = pptx.addSlide();
    const image = media[index]?.kind === 'image' ? media[index].data : images[index];
    const hasMedia=!!image || media[index]?.kind==='video';
    const layout=chooseLayout(item,index,result.data.slides.length,hasMedia);
    const placement=hasMedia?resolvePlacement(media[index]?.kind||'image',media[index]?.placement,layout,index):'auto';
    const backgroundMedia=!!image&&placement==='background';
    const framedMedia=hasMedia&&!backgroundMedia;
    const feature=framedMedia&&layout==='title-body'&&index%3===0&&item.content.length<650;
    const colors=slideColors(presentation.style,item,index,layout,backgroundMedia,presentation.visualStyle,presentation.presentationType);
    slide.background={color:colors.background};
    const text=(value,x,y,w,h,size=22,extra={})=>slide.addText(value,{x,y,w,h,fontSize:size,fontFace:'Arial',color:colors.text,margin:0,fit:'shrink',valign:'top',breakLine:false,paraSpaceAfterPt:10,...extra});
    const rect=(x,y,w,h,color,transparency=0)=>slide.addShape(pptx.ShapeType.roundRect,{x,y,w,h,rectRadius:.08,fill:{color,transparency},line:{color,transparency:100}});
    if(backgroundMedia){
      slide.addImage({data:image,...coverImageFrame(image,{x:0,y:0,w:13.333,h:7.5}),altText:`Ảnh nền AI: ${item.title}`});
      rect(0,0,13.333,7.5,'07101F',38);
      rect(0,0,layout==='cover'?7.25:13.333,7.5,'07101F',layout==='cover'?16:48);
    }
    if(colors.glass&&!backgroundMedia)slide.addShape(pptx.ShapeType.roundRect,{x:0.48,y:0.78,w:12.35,h:5.88,rectRadius:.08,fill:{color:'FFFFFF',transparency:88},line:{color:'FFFFFF',transparency:68,width:1}});
    if(colors.boldGeometric&&!backgroundMedia){
      if(layout==='cover')slide.addShape(pptx.ShapeType.roundRect,{x:-.35,y:1.18,w:13.9,h:4.85,rotate:-4,fill:{color:colors.accent},line:{color:colors.accent}});
      else if(layout==='section')slide.addShape(pptx.ShapeType.wave,{x:8.2,y:2.25,w:6.1,h:5.3,rotate:-10,fill:{color:'0A0A0B'},line:{color:'0A0A0B'}});
      else slide.addShape(pptx.ShapeType.roundRect,{x:10.25,y:2.75,w:4.9,h:5.1,rotate:13,fill:{color:colors.accent},line:{color:colors.accent},transparency:4});
    }
    if(colors.wireframe){
      for(let lineIndex=0;lineIndex<14;lineIndex++){
        slide.addShape(pptx.ShapeType.arc,{x:9.15+lineIndex*.11,y:-1.25+lineIndex*.07,w:4.2-lineIndex*.11,h:3.55-lineIndex*.07,rotate:8,adjustPoint:.35,fill:{color:colors.background,transparency:100},line:{color:lineIndex%2?colors.accent:colors.secondary,transparency:38,width:.55}});
        slide.addShape(pptx.ShapeType.arc,{x:-1.7+lineIndex*.07,y:4.55+lineIndex*.055,w:4.0-lineIndex*.09,h:3.45-lineIndex*.07,rotate:188,adjustPoint:.35,fill:{color:colors.background,transparency:100},line:{color:lineIndex%2?colors.accent:colors.secondary,transparency:45,width:.5}});
      }
      for(let lineIndex=0;lineIndex<12;lineIndex++){
        slide.addShape(pptx.ShapeType.line,{x:9.05+lineIndex*.34,y:0,w:4.28-lineIndex*.3,h:2.45-lineIndex*.08,line:{color:lineIndex%2?colors.accent:colors.secondary,transparency:34,width:.55}});
        slide.addShape(pptx.ShapeType.line,{x:0,y:5.05+lineIndex*.2,w:3.55-lineIndex*.12,h:2.45-lineIndex*.17,line:{color:lineIndex%2?colors.accent:colors.secondary,transparency:40,width:.5}});
      }
      for(let lineIndex=0;lineIndex<8;lineIndex++){
        slide.addShape(pptx.ShapeType.line,{x:9.45,y:.18+lineIndex*.23,w:3.88,h:1.92-lineIndex*.09,line:{color:colors.accent,transparency:48,width:.45}});
        slide.addShape(pptx.ShapeType.line,{x:.08,y:5.35+lineIndex*.22,w:2.95,h:.55+lineIndex*.08,line:{color:colors.secondary,transparency:52,width:.45}});
      }
    }
    text(presentation.title,0.75,0.35,11.75,0.3,10,{color:colors.muted,charSpacing:0.5});
    const blocks=contentBlocks(item.content);
    if(layout==='cover') {
      if(colors.wireframe){
        text(item.title,3.15,2.55,7.05,1.0,36,{bold:false,valign:'mid',align:'center'});
        text(item.content,3.45,3.68,6.45,1.5,17,{color:colors.muted,align:'center'});
      }else{
        rect(0,0,0.18,7.5,colors.accent);
        rect(0.75,1.2,0.65,0.08,colors.accent);
        const width=framedMedia?6.25:10.8;
        text(item.title,0.75,1.65,width,1.85,colors.boldGeometric?54:colors.editorial?48:44,{bold:true,valign:'mid',fontFace:colors.boldGeometric?'Arial Black':colors.editorial?'Georgia':'Arial'});
        text(item.content,0.8,3.8,width,2.3,22,{color:colors.muted});
        if(!hasMedia)rect(11.85,1.2,0.7,0.08,colors.accent);
      }
    } else if(layout==='section') {
      text(String(index+1).padStart(2,'0'),0.8,1.02,1.8,0.9,54,{bold:true,color:colors.muted});
      text(item.title,0.8,2.2,framedMedia?6.85:11.6,1.65,colors.boldGeometric?48:colors.editorial?44:40,{bold:true,valign:'mid',fontFace:colors.boldGeometric?'Arial Black':colors.editorial?'Georgia':'Arial'});
      rect(0.8,4.08,1.25,0.07,colors.accent);
      text(item.content,0.85,4.55,11.55,1.65,item.content.length>500?20:24);
    } else {
      text(item.title,0.75,1.02,feature?5.5:framedMedia&&layout==='columns'?7.2:11.8,feature?1.6:1.05,colors.boldGeometric?40:colors.editorial?36:32,{bold:true,valign:'mid',fontFace:colors.boldGeometric?'Arial Black':colors.editorial?'Georgia':'Arial'});
      rect(0.75,2.25,0.5,0.045,colors.accent);
      if(layout==='cards') {
        if(colors.editorial&&!framedMedia&&blocks.length>=3){
          const firstColor=colors.cardPalette[0];rect(.75,2.55,5.35,3.85,firstColor);rect(.75,2.55,.06,3.85,colors.accent);
          text('01',1.05,2.85,.6,.28,12,{color:colors.accent,bold:true});text(blocks[0],1.05,3.45,4.55,2.35,27,{bold:true});
          const rest=blocks.slice(1),cellH=(3.85-.18*(rest.length-1))/rest.length;
          rest.forEach((block,i)=>{const y=2.55+i*(cellH+.18),color=colors.cardPalette[(i+1)%colors.cardPalette.length];rect(6.42,y,6.16,cellH,color);rect(6.42,y,.05,cellH,colors.secondary);text(String(i+2).padStart(2,'0'),6.7,y+.16,.5,.24,11,{color:colors.accent,bold:true});text(block,7.42,y+.15,4.75,cellH-.3,20,{valign:'mid'});});
        } else {
          const cols=framedMedia?2:blocks.length===2?2:3;const rows=Math.ceil(blocks.length/cols);const gap=colors.minimal?.42:.2;const startX=framedMedia&&placement==='left'?6.15:0.75;const totalW=framedMedia?6.4:11.83;const cellW=(totalW-gap*(cols-1))/cols;const cellH=(3.85-gap*(rows-1))/rows;
          blocks.forEach((block,i)=>{
            const x=startX+(i%cols)*(cellW+gap),y=2.55+Math.floor(i/cols)*(cellH+gap);
            const cardColor=backgroundMedia||colors.glass?colors.panel:colors.cardPalette[i%colors.cardPalette.length];
            if(!colors.minimal)rect(x,y,cellW,cellH,cardColor,backgroundMedia?22:colors.glass?70:0);rect(x,y,0.045,cellH,colors.secondary);
            text(String(i+1).padStart(2,'0'),x+0.24,y+0.18,0.5,0.28,12,{color:backgroundMedia?colors.text:colors.accent,bold:true});
            text(block,x+0.24,y+0.53,cellW-0.48,cellH-0.66,rows>1?18:23);
          });
        }
      } else if(layout==='columns') {
        const mid=Math.ceil(blocks.length/2);
        const top=framedMedia?3.55:2.65;const height=framedMedia?2.7:3.75;
        rect(6.6,top,0.018,height,colors.panel);
        [blocks.slice(0,mid),blocks.slice(mid)].forEach((group,col)=>{
          const x=col?7.05:0.8;text(group.join('\n\n'),x,top+0.14,5.45,height-0.2,23);
          rect(x,top-0.12,0.45,0.045,colors.accent);
        });
      } else if(layout==='timeline') {
        if(framedMedia) {
          const stepH=3.95/blocks.length;
          slide.addShape(pptx.ShapeType.line,{x:1.0,y:2.65,w:0,h:3.25,line:{color:colors.muted,width:1}});
          blocks.forEach((block,i)=>{
            const y=2.5+i*stepH;
            slide.addShape(pptx.ShapeType.ellipse,{x:0.78,y,w:0.44,h:0.44,fill:{color:colors.accent},line:{color:colors.accent}});
            text(String(i+1),0.78,y+0.09,0.44,0.2,11,{color:colors.background,bold:true,align:'center'});
            text(block,1.5,y+0.02,5.3,stepH-0.14,blocks.length>4?18:21);
          });
        } else {
        const stepW=11.83/blocks.length;
        slide.addShape(pptx.ShapeType.line,{x:0.95,y:3.12,w:11.05,h:0,line:{color:colors.muted,width:1}});
        blocks.forEach((block,i)=>{
          const x=0.75+i*stepW;
          slide.addShape(pptx.ShapeType.ellipse,{x:x+0.1,y:2.83,w:0.58,h:0.58,fill:{color:colors.accent},line:{color:colors.accent}});
          text(String(i+1),x+0.1,2.98,0.58,0.24,13,{color:colors.background,bold:true,align:'center'});
          text(block,x+0.1,3.65,stepW-0.25,2.55,blocks.length>4?18:22);
        });
        }
      } else if(feature) {
        text(item.content,0.8,4.25,11.7,2.1,24);
      } else {
        const textX=framedMedia&&placement==='left'?6.55:0.8;
        text(item.content,textX,2.65,framedMedia?5.95:11.7,3.7,item.content.length>700?18:24);
      }
    }
    if(framedMedia) {
      const frame=mediaFrame(layout,index,item,placement);
      if(image)slide.addImage({data:image,...fitImageFrame(image,frame),altText:`Ảnh AI minh họa: ${item.title}`});
      if(media[index]?.kind==='video') {
        rect(frame.x,frame.y,frame.w,frame.h,colors.panel);
        const width=Math.min(frame.w,frame.h*16/9),height=width*9/16;
        slide.addMedia({type:'video',data:media[index].data,extn:'mp4',x:frame.x+(frame.w-width)/2,y:frame.y+(frame.h-height)/2,w:width,h:height});
      }
    }
    rect(.75,6.75,11.83,.018,colors.muted,75);
    text(`${index+1} / ${result.data.slides.length}`,11.3,6.98,1.25,0.22,10,{align:'right',color:colors.muted});
    text(presentation.audience || '',0.75,6.98,9.8,0.22,10,{color:colors.muted});
    if (item.notes) slide.addNotes(item.notes);
  });
  return pptx.write({ outputType: 'nodebuffer' });
}
module.exports = { buildPptx };
