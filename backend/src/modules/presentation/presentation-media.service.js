'use strict';
const crypto = require('node:crypto');
const { GridFSBucket } = require('mongoose').mongo;
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const env = require('../../config');
const ApiError = require('../../shared/ApiError');
const { connectPresentationDB } = require('../../config/db');
const { generateSlideImages, IMAGE_RULES_VERSION } = require('./presentation-image.service');
const MAX_BYTES = 50 * 1024 * 1024;
const VIDEO_RULES_VERSION='intrinsic-subject-motion-v1';
const VIDEO_MOTION_RULES=`Mandatory video motion rules:
- Generate a genuinely animated scene, not a panned, zoomed, parallaxed or cross-faded still image.
- The main subject must perform visible intrinsic motion throughout the shot. A character must move its head, eyes, limbs and body weight naturally; an object must show real state or mechanical change.
- For a turtle character, animate believable head, eye, foreleg and body motion plus the requested action (for example typing), while keeping the shell and anatomy temporally consistent.
- Camera movement is secondary and must not be the only motion.
- Use one coherent continuous 8-second shot with temporal consistency, no sudden morphing, duplicated limbs, text or slideshow transitions.`;
const locks = new Map();
function fingerprint(slide) { return crypto.createHash('sha256').update(JSON.stringify([slide.title, slide.content])).digest('hex'); }
function publicAsset(row) {
  const { _id, slideIndex, slideTitle, slideContent, kind, prompt, status, progress, error, createdAt } = row;
  return { id: _id, slideIndex, slideTitle, slideContent, kind, placement:row.placement||'auto', prompt, status, progress, error, createdAt, matchesImageRules:kind !== 'image' || row.imageRulesVersion === IMAGE_RULES_VERSION, position: 'Theo bố cục của slide khi xuất' };
}
async function store() {
  const connection = await connectPresentationDB();
  return { assets: connection.db.collection('slide_media'), bucket: new GridFSBucket(connection.db, { bucketName: 'slide_media_files' }) };
}
function videoEndpoint() {
  const url = new URL(env.PRESENTATION.VIDEO_API_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'modelapi.vn' || url.username || url.password || url.search || url.hash) throw new ApiError(503, 'Endpoint video phải thuộc https://modelapi.vn.');
  if (!env.PRESENTATION.VIDEO_API_KEY) throw new ApiError(503, 'Chưa cấu hình key tạo video ở backend.');
  return url.toString().replace(/\/$/, '');
}
async function videoRequest(path = '', body, fetcher = fetch) {
  try {
    const response = await fetcher(videoEndpoint() + path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${env.PRESENTATION.VIDEO_API_KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      let providerMessage='';
      try {
        const payload=await response.clone().json();
        providerMessage=String(payload.error?.message||payload.message||'').trim().slice(0,300);
      } catch {}
      throw new ApiError(response.status === 429 ? 429 : 502, `ModelAPI không xử lý được video (HTTP ${response.status})${providerMessage?`: ${providerMessage}`:'. Kiểm tra quyền model và hạn mức tài khoản.'}`);
    }
    return response;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'TimeoutError' ? 504 : 502, 'Kết nối tạo video bị gián đoạn. Hãy thử kiểm tra trạng thái lại.');
  }
}
async function boundedVideo(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new ApiError(502, 'Video vượt giới hạn 50 MB.');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BYTES) { await response.body.cancel?.().catch(() => {}); throw new ApiError(502, 'Video vượt giới hạn 50 MB.'); }
    chunks.push(Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') throw new ApiError(502, 'Nhà cung cấp chưa trả file MP4 hợp lệ.');
  return buffer;
}
async function ownedAsset(ownerId, presentationId, assetId) {
  const { assets } = await store();
  const row = await assets.findOne({ _id: assetId, ownerId: String(ownerId), presentationId: String(presentationId) });
  if (!row) throw ApiError.notFound('Không tìm thấy media hoặc bạn không có quyền.');
  return row;
}
async function create(ownerId, presentation, input) {
  const { assets } = await store(); const slide = input.outline[input.slideIndex];
  if (!slide) throw ApiError.badRequest('Slide được chọn không tồn tại.');
  const prompt = input.prompt?.trim() || `Minh họa ${slide.title}: ${slide.content}. Loại bài: ${presentation.presentationType||'Education'}. Phong cách thị giác: ${presentation.visualStyle||'Flat Design & Illustration'}. Hệ màu: ${presentation.style}. Không thêm chữ hoặc bịa số liệu.`;
  const snapshot = fingerprint(slide);
  const placement=input.kind==='video'&&input.placement==='background'?'right':input.placement||'auto';
  const providerPrompt=input.kind==='video'?`${prompt}\n\n${VIDEO_MOTION_RULES}`:prompt;
  const cacheParts=[String(ownerId), String(presentation._id), input.slideIndex, snapshot, input.kind, prompt, presentation.style,presentation.visualStyle,presentation.presentationType,input.kind === 'video' ? env.PRESENTATION.VIDEO_MODEL : env.PRESENTATION.IMAGE_MODEL,input.kind==='video'?VIDEO_RULES_VERSION:''];
  if(input.kind==='image')cacheParts.push(IMAGE_RULES_VERSION);
  const id = crypto.createHash('sha256').update(JSON.stringify(cacheParts)).digest('hex');
  const existing = await assets.findOne({ _id: id });
  if (existing && existing.status !== 'failed') {
    if((existing.placement||'auto')!==placement){await assets.updateOne({_id:id},{$set:{placement}});existing.placement=placement;}
    return publicAsset(existing);
  }
  const row = { _id: id, ownerId: String(ownerId), presentationId: String(presentation._id), slideIndex: input.slideIndex, slideTitle: slide.title, slideContent: slide.content, snapshot, kind: input.kind, placement, prompt, status: 'creating', error: '', createdAt: new Date() };
  if (existing) {
    const claimed = await assets.updateOne({ _id: id, status: 'failed' }, { $set: row });
    if (!claimed.modifiedCount) return publicAsset(await assets.findOne({ _id: id }));
  } else {
    try { await assets.insertOne(row); } catch (error) { if (error.code === 11000) return publicAsset(await assets.findOne({ _id: id })); throw error; }
  }
  try {
    if (input.kind === 'image') {
      const [data] = await generateSlideImages(ownerId, presentation, [slide], { promptOverride: prompt });
      row.imageData = data; row.imageRulesVersion = IMAGE_RULES_VERSION; row.status = 'completed';
    } else {
      const payload = await (await videoRequest('', { model: env.PRESENTATION.VIDEO_MODEL, prompt:providerPrompt, size: '1280x720', seconds: '8' })).json();
      const result=payload.data||payload;
      if(result.id&&result.task_id&&result.id!==result.task_id)throw new ApiError(502,'ModelAPI trả id và task_id không khớp.');
      const providerId=result.id||result.task_id;
      if (typeof providerId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(providerId)) throw new ApiError(502, 'ModelAPI chưa trả mã tác vụ video hợp lệ.');
      row.providerId = providerId; row.status = ['processing','in_progress','running'].includes(String(result.status).toLowerCase())?'processing':'queued';row.progress=Number.isFinite(Number(result.progress))?Number(result.progress):0;
    }
    const { _id, ...values } = row;
    await assets.updateOne({ _id: id }, { $set: values });
    return publicAsset(row);
  } catch (error) {
    await assets.updateOne({ _id: id }, { $set: { status: 'failed', error: error.message } });
    throw error;
  }
}
async function list(ownerId, presentationId) {
  const { assets } = await store();
  return (await assets.find({ ownerId: String(ownerId), presentationId: String(presentationId) }).sort({ createdAt: -1 }).toArray()).map(publicAsset);
}
async function refresh(ownerId, presentationId, assetId) {
  const row = await ownedAsset(ownerId, presentationId, assetId);
  if (row.status === 'creating' && Date.now() - new Date(row.createdAt).getTime() > 180000) {
    const { assets } = await store();
    row.status = 'failed'; row.error = 'Chưa nhận được phản hồi tạo media. Kiểm tra hạn mức trước khi thử tạo lại.';
    await assets.updateOne({_id:assetId,status:'creating'},{$set:{status:row.status,error:row.error}});
  }
  if (row.kind !== 'video' || ['completed', 'failed', 'creating'].includes(row.status)) return publicAsset(row);
  if (locks.has(assetId)) return locks.get(assetId);
  const action = (async () => {
    const { assets, bucket } = await store();
    const payload = await (await videoRequest('/' + encodeURIComponent(row.providerId))).json();
    const data=payload.data||payload;
    const status = String(data.status || '').toLowerCase();
    if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) {
      row.status = 'failed'; row.error = 'Nhà cung cấp không tạo được video. Bạn có thể tạo lại.';
    } else if (['completed', 'succeeded', 'ready'].includes(status)) {
      const buffer = await boundedVideo(await videoRequest('/' + encodeURIComponent(row.providerId) + '/content'));
      const upload = bucket.openUploadStream(`${assetId}.mp4`, { contentType: 'video/mp4' });
      try { await pipeline(Readable.from([buffer]), upload); } catch (error) { await bucket.delete(upload.id).catch(() => {}); throw error; }
      row.fileId = upload.id; row.status = 'completed'; row.error = '';
    } else if (['queued', 'pending', 'in_progress', 'processing', 'running'].includes(status)) row.status = status === 'queued' || status === 'pending' ? 'queued' : 'processing';
    else throw new ApiError(502, 'Trạng thái video từ nhà cung cấp chưa được hỗ trợ.');
    row.progress=Number.isFinite(Number(data.progress))?Number(data.progress):row.status==='completed'?100:row.progress;
    await assets.updateOne({ _id: assetId }, { $set: { status: row.status, progress:row.progress, error: row.error, ...(row.fileId ? { fileId: row.fileId } : {}) } });
    return publicAsset(row);
  })();
  locks.set(assetId, action);
  try { return await action; } finally { locks.delete(assetId); }
}
async function content(ownerId, presentationId, assetId) {
  const row = await ownedAsset(ownerId, presentationId, assetId);
  if (row.status !== 'completed') throw ApiError.conflict('Media chưa tạo xong.');
  if (row.kind === 'image') return { buffer: Buffer.from(row.imageData.split(',')[1], 'base64'), mime: row.imageData.startsWith('data:image/png') ? 'image/png' : 'image/jpeg' };
  const { bucket } = await store(); const chunks = [];
  for await (const chunk of bucket.openDownloadStream(row.fileId)) chunks.push(chunk);
  return { buffer: Buffer.concat(chunks), mime: 'video/mp4' };
}
async function resolve(ownerId, presentationId, outline, ids) {
  const media = []; let total = 0;
  for (const id of ids) {
    const row = await ownedAsset(ownerId, presentationId, id);
    if (!outline[row.slideIndex] || row.snapshot !== fingerprint(outline[row.slideIndex])) throw ApiError.conflict('Nội dung slide đã đổi. Hãy tạo lại minh họa để khớp nội dung.');
    if (media[row.slideIndex]) throw ApiError.badRequest('Mỗi slide chỉ đính kèm một ảnh hoặc video.');
    const asset = await content(ownerId, presentationId, id); total += asset.buffer.length;
    if (total > 150 * 1024 * 1024) throw ApiError.badRequest('Tổng media vượt 150 MB. Hãy giảm số video đính kèm.');
    media[row.slideIndex] = { kind: row.kind, placement:row.placement||'auto', data: `data:${asset.mime};base64,${asset.buffer.toString('base64')}` };
  }
  return media;
}
async function removeAll(ownerId,presentationId) {
  const {assets,bucket}=await store();
  const filter={ownerId:String(ownerId),presentationId:String(presentationId)};
  const rows=await assets.find(filter,{projection:{fileId:1}}).toArray();
  for(const row of rows)if(row.fileId)await bucket.delete(row.fileId).catch(error=>{if(error.code!=='ENOENT'&&error.code!=='FileNotFound')throw error;});
  await assets.deleteMany(filter);
  return rows.length;
}
module.exports = { create, list, refresh, content, resolve, removeAll, fingerprint, publicAsset, videoRequest, boundedVideo };
