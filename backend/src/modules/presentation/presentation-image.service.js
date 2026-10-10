'use strict';
const crypto = require('node:crypto');
const env = require('../../config');
const ApiError = require('../../shared/ApiError');
const { connectPresentationDB } = require('../../config/db');
const { outlineSchema } = require('./presentation.validation');
const inFlight = new Map();
const IMAGE_RULES_VERSION = 'natural-neutral-50mm-v1';
const IMAGE_RULES = `Mandatory image rendering rules; these override conflicting style or scene instructions:
- Default to balanced natural daylight with white balance around 5500K, no yellow cast or color shifts. If the scene explicitly takes place at night or in the evening, use neutral artificial lighting with white balance around 4000-4500K instead; no yellow or blue cast.
- Preserve faithful, true-to-life object colors; restrained saturation, never overly vivid grading.
- Simulate a 50mm lens at F1.8, with only gentle background blur. Keep the main subject and relevant educational details clear.
- Use refined minimalism for luxurious or elegant images. Remove unnecessary details and clutter while preserving the elements needed to explain the slide.
- Use natural, soft shadows and a clean, balanced composition.`;
function styleRules(presentation){
  const visual=presentation.visualStyle||'Flat Design & Illustration',type=presentation.presentationType||'Education';
  const rules={
    'Minimalism':'Use a restrained scene with one clear subject, generous negative space and no decorative clutter.',
    'Flat Design & Illustration':'Render as clean 2D flat vector illustration with simple geometry, controlled colors and no complex 3D effects or photorealistic texture. Treat lens guidance only as composition and focus hierarchy.',
    Glassmorphism:'Use a refined technology mood with translucent layered surfaces, subtle highlights and soft depth; avoid excessive glow.',
    Editorial:'Create a story-led editorial image with a strong crop, clear focal subject and intentional negative space suitable for large typography.',
    'Monochrome & Muted':'Use a restrained monochrome or closely related muted color family while preserving subject readability and tonal separation.',
    'Bold Geometric / Poster':'Use bold black, orange and warm cream contrast, oversized poster-like composition, strong geometric fields and dramatic negative space. Avoid copying logos or text from references.',
    'Tech Wireframe':'Use a deep indigo technology atmosphere with fine cyan or teal contour lines, restrained glow, minimal composition and ample empty space.',
  };
  const context=type==='Corporate & Business'?'Keep the visual credible and suitable for a professional business presentation.':type==='Minigame / Event'?'Use energetic visual rhythm without neon overload or visual clutter.':type==='Văn hóa & Truyền thống'?'Use only cultural details supported by the slide content; do not invent symbols, costumes or historical claims.':'Keep the visual age-appropriate, clear and useful for teaching.';
  return `${rules[visual]||rules['Flat Design & Illustration']} ${context}`;
}
function validateImage(base64) {
  if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/=\r\n]+$/.test(base64) || base64.length > 16 * 1024 * 1024) throw new ApiError(502, 'Dữ liệu ảnh AI không hợp lệ hoặc quá lớn.');
  const buffer = Buffer.from(base64, 'base64');
  const png = buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (!png && !jpeg) throw new ApiError(502, 'AI phải trả ảnh PNG hoặc JPEG.');
  return `data:image/${png ? 'png' : 'jpeg'};base64,${buffer.toString('base64')}`;
}
async function generateSlideImages(ownerId, presentation, outline, options = {}) {
  const slides = outlineSchema.parse({slides:outline}).slides;
  if (slides.length > 10) throw ApiError.badRequest('Tạo ảnh hỗ trợ tối đa 10 slide mỗi bản xuất. Bạn vẫn có thể tải bản không ảnh.');
  const settings = env.PRESENTATION;
  if (!settings.IMAGE_API_KEY) throw new ApiError(503, 'Chưa cấu hình MODEL_IMAGE_API_KEY ở backend.');
  const url = new URL(settings.IMAGE_API_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'modelapi.vn' || url.username || url.password) throw new ApiError(503, 'Endpoint ảnh phải thuộc https://modelapi.vn.');
  const connection = await connectPresentationDB(); const assets = connection.db.collection('slide_images');
  const images = [];
  for (const slide of slides) {
    const prompt = `Create a clean presentation illustration without text or lettering. Visual style: ${presentation.visualStyle||'Flat Design & Illustration'}. Presentation type: ${presentation.presentationType||'Education'}. Color direction: ${presentation.style}. Context: ${presentation.title}. Slide: ${slide.title}. Content: ${options.promptOverride || slide.content}. Illustrate the topic, do not invent statistical charts or numbers.\n\n${styleRules(presentation)}\n\n${IMAGE_RULES}`;
    const id = crypto.createHash('sha256').update(JSON.stringify([String(ownerId),settings.IMAGE_MODEL,prompt])).digest('hex');
    const cached = await assets.findOne({_id:id});
    if (cached) { images.push(validateImage(cached.base64)); continue; }
    if (!inFlight.has(id)) inFlight.set(id,(async()=>{
      try {
        const response = await (options.fetcher || fetch)(url.toString(), {method:'POST',headers:{Authorization:`Bearer ${settings.IMAGE_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:settings.IMAGE_MODEL,prompt,size:'1024x1024',n:1}),signal:AbortSignal.timeout(120000)});
        if (!response.ok) throw new ApiError(response.status === 429 ? 429 : 502, `Không tạo được ảnh cho slide “${slide.title}”. Kiểm tra quyền model ảnh và hạn mức ModelAPI.`);
        const data = await response.json(); const item = data.data?.[0];
        // Do not fetch arbitrary provider-returned URLs on the application server.
        if (!item?.b64_json) throw new ApiError(502,'ModelAPI chưa trả b64_json. Cần cấu hình nhà cung cấp trả ảnh base64 để nhúng vào PowerPoint.');
        const image = validateImage(item.b64_json);
        await assets.updateOne({_id:id},{$setOnInsert:{ownerId:String(ownerId),model:settings.IMAGE_MODEL,base64:item.b64_json,createdAt:new Date()}},{upsert:true});
        return image;
      } catch(error) {
        if(error instanceof ApiError) throw error;
        throw new ApiError(error.name === 'TimeoutError' ? 504 : 502, `Tạo ảnh cho slide “${slide.title}” bị gián đoạn. Hãy thử lại hoặc tắt ảnh minh họa.`);
      }
    })());
    try { images.push(await inFlight.get(id)); } finally { inFlight.delete(id); }
  }
  return images;
}
module.exports = {generateSlideImages,validateImage,IMAGE_RULES_VERSION};
