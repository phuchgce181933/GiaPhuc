'use strict';
const crypto = require('node:crypto');
const env = require('../../config');
const ApiError = require('../../shared/ApiError');
const { getPresentationModel, getCanvaAccountModel } = require('./presentation.model');
const { outlineSchema } = require('./presentation.validation');
const { DESIGN_SYSTEM_PROMPT,ensureColorRhythm } = require('./presentation-design.service');
const memoryOauth = new Map();
const tokenLocks = new Map();
function tokenKey() { if (!env.PRESENTATION.TOKEN_ENCRYPTION_KEY) throw new ApiError(503, 'Chưa cấu hình mã hóa token Canva ở backend.'); return Buffer.from(env.PRESENTATION.TOKEN_ENCRYPTION_KEY, 'hex'); }
function encryptToken(value) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), iv); const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`; }
function decryptToken(value) { const [iv, tag, encrypted] = String(value).split('.').map((part) => Buffer.from(part, 'base64url')); const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'); }
function ownerFilter(id) { return { ownerId: id }; }
function authConfigured() { return !!(env.PRESENTATION.CANVA.CLIENT_ID && env.PRESENTATION.CANVA.CLIENT_SECRET && env.PRESENTATION.CANVA.REDIRECT_URI); }
async function connectionStatus(ownerId) {
  const configured = authConfigured() && !!env.PRESENTATION.TOKEN_ENCRYPTION_KEY;
  if (!configured) return { configured: false, connected: false };
  const account = await getCanvaAccountModel();
  const connected = !!await account.exists({ _id: String(ownerId) });
  if (connected) return { configured: true, connected: true };
  const model = await getPresentationModel();
  return { configured: true, connected: !!await model.exists({ ownerId: String(ownerId), canvaRefreshToken: { $type: 'string', $ne: '' } }) };
}
function canvaHeaders(token, json = false) { return { Authorization: `Bearer ${token}`, ...(json ? { 'Content-Type': 'application/json' } : {}) }; }
async function modelRequest(prompt, options = {}) {
  if (!env.PRESENTATION.MODEL_API_URL || !env.PRESENTATION.MODEL_API_KEY || !env.PRESENTATION.MODEL_API_MODEL) throw new ApiError(503, 'ModelAPI chưa được cấu hình.');
  const task = options.task || 'tạo cấu trúc slide';
  const deadline = Date.now() + env.PRESENTATION.MODEL_API_TIMEOUT_MS;
  const messages = [{ role:'system',content:options.system || DESIGN_SYSTEM_PROMPT }, {role:'user',content:prompt}];
  try {
    for(let attempt=0;attempt<2;attempt++) {
    if(Date.now()>=deadline) throw Object.assign(new Error('AI deadline'),{name:'TimeoutError'});
    const response = await fetch(env.PRESENTATION.MODEL_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${env.PRESENTATION.MODEL_API_KEY}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.max(1,deadline-Date.now())), body: JSON.stringify({ model: env.PRESENTATION.MODEL_API_MODEL, messages }) });
    if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, response.status === 429 ? 'ModelAPI đang giới hạn lượt gọi. Vui lòng thử lại sau.' : 'ModelAPI từ chối yêu cầu. Kiểm tra key, model và hạn mức của nhà cung cấp.');
    const data = await response.json(); const choice = data.choices?.[0]; const raw = choice?.message?.content;
    if (choice?.finish_reason !== 'stop' || typeof raw !== 'string') throw new ApiError(502, `AI ${task} chưa trả kết quả đầy đủ.`);
    let json, issues;
    try { json = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { issues=[{path:[],message:'Return one valid JSON object, no prose or Markdown.'}]; }
    if(!issues) {
      const normalized = options.normalize ? options.normalize(json) : normalizeOutlineOutput(json);
      const parsed = (options.schema || outlineSchema).safeParse(normalized);
      if(parsed.success && (!options.validate || options.validate(parsed.data))) return parsed.data;
      issues=parsed.success?[{path:['slides'],message:options.validationHint || 'Incorrect slide count or indices.'}]:parsed.error.issues.map(({path,message})=>({path,message}));
    }
    if(attempt===1) throw new ApiError(502,`AI ${task} trả dữ liệu chưa hợp lệ sau khi tự sửa. Vui lòng thử lại.`,{details:{issues}});
    messages.push({role:'assistant',content:raw},{role:'user',content:`Correct the previous JSON to match the required schema. Preserve the source facts. Return only the complete corrected JSON. Validation errors: ${JSON.stringify(issues)}`});
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === 'TimeoutError' || error.name === 'AbortError' ? 504 : 502, error.name === 'TimeoutError' || error.name === 'AbortError' ? `AI ${options.task || 'tạo cấu trúc slide'} chưa phản hồi sau ${Math.round(env.PRESENTATION.MODEL_API_TIMEOUT_MS / 1000)} giây. Vui lòng thử lại.` : 'Không kết nối được ModelAPI. Vui lòng thử lại.');
  }
}
async function outline(ownerId, input) {
  const model = await getPresentationModel(); const row = await model.create({ ...input, ...ownerFilter(ownerId), status: 'generating_outline' });
  try { const result = await modelRequest(`Tạo cấu trúc bài thuyết trình bằng ${input.language}. Chỉ trả JSON {slides:[{title,content,notes,layout,colorRole}]}, đúng ${input.slideCount} slide. Không bịa số liệu hoặc nguồn. Tiêu đề: ${input.title}\nĐối tượng: ${input.audience}\nLoại nội dung: ${input.presentationType}\nPhong cách thị giác: ${input.visualStyle}\nHệ màu: ${input.style}\nNguồn:\n${input.sourceContent}`); const slides = ensureColorRhythm(result.slides); if (!Array.isArray(slides) || slides.length !== input.slideCount) throw new ApiError(502, 'ModelAPI returned an incorrect slide count.'); row.outline = slides; row.status = 'ready'; await row.save(); return row.toObject(); } catch (error) { row.status = 'failed'; row.error = error.message; await row.save(); throw error; }
}
async function getOwned(ownerId, id) { const model = await getPresentationModel(); const row = await model.findOne({ _id: id, ...ownerFilter(ownerId) }); if (!row) throw ApiError.notFound('Không tìm thấy bài thuyết trình hoặc bạn không có quyền truy cập.'); return row; }
async function list(ownerId) { const model = await getPresentationModel(); return model.find(ownerFilter(ownerId)).sort({ createdAt: -1 }).select('-canvaRefreshToken').lean(); }
async function update(ownerId, id, values) { const row = await getOwned(ownerId, id); if (row.status === 'creating' || row.status === 'completed') throw ApiError.conflict('Bài thuyết trình đã được gửi tới Canva và không thể sửa cấu trúc.'); Object.assign(row, values, { status: 'ready', error: '' }); await row.save(); return row.toObject(); }
function oauthStart(userId) { if (!authConfigured()) throw new ApiError(503, 'Canva OAuth is not configured. Set Client ID, Client Secret and Redirect URI in backend.'); const verifier = crypto.randomBytes(64).toString('base64url'); const state = crypto.randomBytes(48).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); memoryOauth.set(state, { userId, verifier, expiresAt: Date.now() + 10 * 60 * 1000 }); const params = new URLSearchParams({ code_challenge: challenge, code_challenge_method: 'S256', scope: env.PRESENTATION.CANVA.SCOPES, response_type: 'code', client_id: env.PRESENTATION.CANVA.CLIENT_ID, state, redirect_uri: env.PRESENTATION.CANVA.REDIRECT_URI }); return `https://www.canva.com/api/oauth/authorize?${params}`; }
async function oauthCallback(code, state) {
  const saved = memoryOauth.get(state); memoryOauth.delete(state);
  if (!saved || saved.expiresAt < Date.now()) throw ApiError.badRequest('Canva authorization session expired. Please connect again.');
  const credentials = Buffer.from(env.PRESENTATION.CANVA.CLIENT_ID + ':' + env.PRESENTATION.CANVA.CLIENT_SECRET).toString('base64');
  const response = await fetch('https://api.canva.com/rest/v1/oauth/token', { method: 'POST', headers: { Authorization: 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000), body: new URLSearchParams({ grant_type: 'authorization_code', code_verifier: saved.verifier, code, redirect_uri: env.PRESENTATION.CANVA.REDIRECT_URI }) });
  if (!response.ok) throw new ApiError(502, 'Canva rejected authorization. Check credentials and the registered redirect URL.');
  const token = await response.json();
  if (!token.refresh_token) throw new ApiError(502, 'Canva did not return a refresh token.');
  const account = await getCanvaAccountModel();
  await account.updateOne({ _id: String(saved.userId) }, { $set: { refreshToken: encryptToken(token.refresh_token), expiresAt: new Date(Date.now() + (token.expires_in || 14400) * 1000) } }, { upsert: true });
  return saved.userId;
}
function normalizeOutlineOutput(json) {
  if(!json || !Array.isArray(json.slides)) return json;
  return {slides:json.slides.map(slide=>slide && typeof slide==='object' ? {title:slide.title,content:slide.content,notes:slide.notes ?? '',...(slide.layout!==undefined?{layout:typeof slide.layout==='string'?slide.layout.trim().toLowerCase():slide.layout}:{}),...(slide.colorRole!==undefined?{colorRole:typeof slide.colorRole==='string'?slide.colorRole.trim().toLowerCase():slide.colorRole}:{})}:slide)};
}
async function accessToken(row) {
  const ownerId = String(row.ownerId);
  const previous = tokenLocks.get(ownerId) || Promise.resolve();
  const action = previous.catch(() => {}).then(async () => {
    const accountModel = await getCanvaAccountModel();
    const account = await accountModel.findById(ownerId).select('+refreshToken').lean();
    let encrypted = account?.refreshToken;
    if (!encrypted) {
      const model = await getPresentationModel();
      const legacy = await model.findById(row._id).select('+canvaRefreshToken').lean();
      encrypted = legacy?.canvaRefreshToken;
    }
    if (!encrypted) throw new ApiError(503, 'Connect your Canva account before creating a design.');
    let refresh;
    try { refresh = decryptToken(encrypted); } catch { throw new ApiError(503, 'Canva token cannot be decrypted. Please connect the account again.'); }
    const credentials = Buffer.from(env.PRESENTATION.CANVA.CLIENT_ID + ':' + env.PRESENTATION.CANVA.CLIENT_SECRET).toString('base64');
    const response = await fetch('https://api.canva.com/rest/v1/oauth/token', { method: 'POST', headers: { Authorization: 'Basic ' + credentials, 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20000), body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }) });
    if (!response.ok) throw new ApiError(503, 'Canva connection expired or was revoked. Please connect the account again.');
    const token = await response.json();
    if (!token.access_token) throw new ApiError(502, 'Canva did not return an access token.');
    await accountModel.updateOne({ _id: ownerId }, { $set: { refreshToken: encryptToken(token.refresh_token || refresh), expiresAt: new Date(Date.now() + (token.expires_in || 14400) * 1000) } }, { upsert: true });
    return token.access_token;
  });
  tokenLocks.set(ownerId, action);
  try { return await action; } finally { if (tokenLocks.get(ownerId) === action) tokenLocks.delete(ownerId); }
}
async function createOnCanva(ownerId, id, idempotencyKey) { const row = await getOwned(ownerId, id); if (row.status === 'creating') return row.toObject(); if (row.status === 'completed') return row.toObject(); if (!['ready','failed'].includes(row.status)) throw ApiError.conflict('Bài thuyết trình chưa có cấu trúc hợp lệ.'); if (idempotencyKey && row.createIdempotencyKey === idempotencyKey && row.status === 'creating') return row.toObject(); row.status = 'creating'; row.error = ''; row.createIdempotencyKey = idempotencyKey || crypto.randomUUID(); await row.save(); try { const token = await accessToken(row); const response = await fetch('https://api.canva.com/rest/v1/generations', { method: 'POST', headers: canvaHeaders(token, true), body: JSON.stringify({ brief: `${row.title}. Ngôn ngữ: ${row.language}. Đối tượng: ${row.audience}. Loại: ${row.presentationType}. Phong cách thị giác: ${row.visualStyle}. Hệ màu: ${row.style}. Nội dung nguồn:\n${row.sourceContent}`, design_type: { type: 'preset', name: 'presentation' }, outline: { sections: row.outline.map((s) => ({ title: s.title, description: s.content, points: [s.notes].filter(Boolean) })) } }) }); if (!response.ok) throw new Error(`Canva generation HTTP ${response.status}`); const payload = await response.json(); const job = payload.job || payload; row.canvaJobId = job.id; await row.save(); return pollCanva(row); } catch (error) { row.status = 'failed'; row.error = error.message; await row.save(); throw error; } }
async function pollCanva(row) { const token = await accessToken(row); const deadline = Date.now() + 120000; while (Date.now() < deadline) { const response = await fetch(`https://api.canva.com/rest/v1/generations/${row.canvaJobId}`, { headers: canvaHeaders(token) }); if (!response.ok) throw new Error(`Canva generation status HTTP ${response.status}`); const { job } = await response.json(); if (job.status === 'success') { row.status = 'completed'; row.canvaDesignId = job.result.design.id; row.canvaViewUrl = job.result.design.urls?.view_url; row.canvaEditUrl = job.result.design.urls?.edit_url; await row.save(); return row.toObject(); } if (job.status === 'failed') throw new Error(job.error?.message || 'Canva không tạo được thiết kế.'); await new Promise((resolve) => setTimeout(resolve, 3000)); } throw new Error('Canva generation timeout.'); }
async function exportDesign(ownerId, id, format) { const row = await getOwned(ownerId, id); if (row.status !== 'completed' || !row.canvaDesignId) throw ApiError.conflict('Thiết kế Canva chưa sẵn sàng để xuất.'); const token = await accessToken(row); const formats = await fetch(`https://api.canva.com/rest/v1/designs/${row.canvaDesignId}/export-formats`, { headers: canvaHeaders(token) }); if (!formats.ok) throw new Error(`Canva export formats HTTP ${formats.status}`); const available = (await formats.json()).formats || {}; if (!available[format]) throw ApiError.badRequest(`Canva không hỗ trợ xuất ${format.toUpperCase()} cho thiết kế này.`); const start = await fetch('https://api.canva.com/rest/v1/exports', { method: 'POST', headers: canvaHeaders(token, true), body: JSON.stringify({ design_id: row.canvaDesignId, format: { type: format } }) }); if (!start.ok) throw new Error(`Canva export HTTP ${start.status}`); const job = (await start.json()).job; const response = await fetch(`https://api.canva.com/rest/v1/exports/${job.id}`, { headers: canvaHeaders(token) }); if (!response.ok) throw new Error(`Canva export status HTTP ${response.status}`); const done = await response.json(); if (done.job?.status === 'success') { if (!row.exportUrls) row.exportUrls = new Map(); row.exportUrls.set(format, done.job.urls?.[0]); await row.save(); return row.toObject(); } return { ...row.toObject(), exportPending: true, exportJobId: job.id };
}
module.exports = { outline, list, getOwned, update, oauthStart, oauthCallback, createOnCanva, exportDesign, modelRequest, accessToken, connectionStatus };
