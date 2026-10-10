'use strict';
const service = require('./presentation.service');
const { createSchema, updateSchema, exportSchema } = require('./presentation.validation');
const ApiError = require('../../shared/ApiError');
const catchAsync = require('../../shared/catchAsync');
function parse(schema, value) { const r = schema.safeParse(value); if (!r.success) throw ApiError.unprocessable('Dữ liệu không hợp lệ.', { issues: r.error.issues }); return r.data; }
async function list(req,res) { res.json({ success:true, data: await service.list(req.user.id) }); }
async function create(req,res) { const input=parse(createSchema, req.body); res.status(202).json({ success:true, data: await service.outline(req.user.id,input) }); }
async function update(req,res) { res.json({ success:true, data: await service.update(req.user.id, req.params.id, parse(updateSchema, req.body)) }); }
async function connect(req,res) { res.json({ success:true, data:{ authorizationUrl: service.oauthStart(req.user.id) } }); }
async function connectionStatus(req,res) { res.json({ success:true, data: await service.connectionStatus(req.user.id) }); }
async function callback(req,res) { await service.oauthCallback(req.query.code, req.query.state); res.redirect(`${require('../../config').FRONTEND_URL}/presentations?canva=connected`); }
async function createCanva(req,res) { res.status(202).json({ success:true, data: await service.createOnCanva(req.user.id, req.params.id, req.get('Idempotency-Key')) }); }
async function exportFile(req,res) { res.json({ success:true, data: await service.exportDesign(req.user.id, req.params.id, parse(exportSchema, req.body).format) }); }
async function detail(req,res) { res.json({ success:true, data: await service.getOwned(req.user.id, req.params.id) }); }
async function remove(req,res) {
  const {idSchema}=require('./presentation.validation');parse(idSchema,req.params);
  const row=await service.getOwned(req.user.id,req.params.id);
  await require('./presentation-media.service').removeAll(req.user.id,row._id);
  await row.deleteOne();
  res.json({success:true,data:{deleted:true}});
}
async function mediaContext(req) {
  parse(require('./presentation.validation').idSchema, req.params);
  return service.getOwned(req.user.id, req.params.id);
}
async function listMedia(req,res) {
  await mediaContext(req);
  res.json({ success:true, data:await require('./presentation-media.service').list(req.user.id,req.params.id) });
}
async function suggestMedia(req,res) {
  const input=parse(require('./presentation.validation').outlineSchema,{slides:req.body?.outline});
  const row=await mediaContext(req);
  res.json({success:true,data:await require('./presentation-media-plan.service').suggest(row,input.slides)});
}
async function createMedia(req,res) {
  const { z } = require('zod'); const { outlineSchema } = require('./presentation.validation');
  const input = parse(z.object({outline:outlineSchema.shape.slides,slideIndex:z.number().int().min(0).max(99),kind:z.enum(['image','video']),placement:z.enum(require('./presentation-design.service').MEDIA_PLACEMENTS).default('auto'),prompt:z.string().trim().min(1).max(4500).optional()}).strict(),req.body);
  const row = await mediaContext(req);
  res.status(202).json({ success:true,data:await require('./presentation-media.service').create(req.user.id,row,input) });
}
async function refreshMedia(req,res) {
  await mediaContext(req);
  res.json({success:true,data:await require('./presentation-media.service').refresh(req.user.id,req.params.id,req.params.assetId)});
}
async function mediaContent(req,res) {
  await mediaContext(req);
  const {buffer,mime} = await require('./presentation-media.service').content(req.user.id,req.params.id,req.params.assetId);
  res.set({'Content-Type':mime,'Cache-Control':'private, no-store','Accept-Ranges':'bytes'});
  const range=req.get('Range');
  if(range){
    const match=/^bytes=(\d+)-(\d*)$/.exec(range);const start=match?Number(match[1]):NaN;const end=match&&match[2]?Math.min(Number(match[2]),buffer.length-1):buffer.length-1;
    if(!Number.isSafeInteger(start)||start<0||start>=buffer.length||end<start){res.set('Content-Range',`bytes */${buffer.length}`);return res.status(416).end();}
    res.set('Content-Range',`bytes ${start}-${end}/${buffer.length}`);return res.status(206).send(buffer.subarray(start,end+1));
  }
  res.send(buffer);
}
async function downloadPptx(req,res) {
  const { z } = require('zod');
  const { outlineSchema, idSchema } = require('./presentation.validation');
  parse(idSchema, req.params);
  const input = parse(z.object({ outline: outlineSchema.shape.slides.optional(), includeImages: z.boolean().default(false), mediaIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20).default([]) }).strict(), req.body || {});
  const row = await service.getOwned(req.user.id, req.params.id);
  const { buildPptx } = require('./presentation-pptx.service');
  const outline = input.outline || row.outline;
  if(input.includeImages && input.mediaIds.length) throw ApiError.badRequest('Hãy chọn một cách đính kèm minh họa.');
  const images = input.includeImages ? await require('./presentation-image.service').generateSlideImages(req.user.id,row,outline) : [];
  const media = await require('./presentation-media.service').resolve(req.user.id,req.params.id,outline,input.mediaIds);
  const buffer = await buildPptx(row, outline, images, media);
  res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': `attachment; filename="presentation.pptx"; filename*=UTF-8''${encodeURIComponent(row.title + '.pptx')}`, 'Cache-Control': 'no-store' });
  res.send(buffer);
}
module.exports = Object.fromEntries(Object.entries({ list, create, update, connect, connectionStatus, callback, createCanva, exportFile, detail, remove, suggestMedia,listMedia,createMedia,refreshMedia,mediaContent,downloadPptx }).map(([name, handler]) => [name, catchAsync(handler)]));
