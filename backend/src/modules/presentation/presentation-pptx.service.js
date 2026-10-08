'use strict';
const PptxGenJS = require('pptxgenjs');
const ApiError = require('../../shared/ApiError');
const { outlineSchema } = require('./presentation.validation');

function theme(style) {
  if (style === 'Tối giản chuyên nghiệp') return { background: 'FFFFFF', panel: 'F1F5F9', text: '172033', muted: '536178', accent: '2563EB' };
  if (style === 'Năng động thương hiệu') return { background: 'FFF9F2', panel: 'FCE7D7', text: '30203F', muted: '68576F', accent: '9333EA' };
  return { background: '0F172A', panel: '19243B', text: 'F1F5F9', muted: 'A8B8D0', accent: 'A5B4FC' };
}
async function buildPptx(presentation, outline = presentation.outline) {
  const result = outlineSchema.safeParse({ slides: outline });
  if (!result.success) throw ApiError.unprocessable('Cần có cấu trúc slide hợp lệ trước khi tải PowerPoint.');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'GiaPhuc'; pptx.subject = presentation.audience || ''; pptx.title = presentation.title; pptx.company = 'GiaPhuc'; pptx.lang = presentation.language === 'English' ? 'en-US' : 'vi-VN';
  pptx.theme = { headFontFace: 'Arial', bodyFontFace: 'Arial', lang: pptx.lang };
  const colors = theme(presentation.style);
  result.data.slides.forEach((item, index) => {
    const slide = pptx.addSlide(); slide.background = { color: colors.background };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.14, h: 7.5, fill: { color: colors.accent }, line: { color: colors.accent } });
    slide.addText(presentation.title, { x: 0.65, y: 0.28, w: 11.8, h: 0.4, fontSize: 11, color: colors.muted, margin: 0, breakLine: false, fit: 'shrink' });
    slide.addText(item.title, { x: 0.65, y: 0.95, w: 11.85, h: 1.15, fontSize: 32, bold: true, color: colors.text, margin: 0, fit: 'shrink', valign: 'mid' });
    slide.addShape(pptx.ShapeType.line, { x: 0.65, y: 2.22, w: 12, h: 0, line: { color: colors.accent, width: 1, transparency: 65 } });
    slide.addText(item.content, { x: 0.95, y: 2.6, w: 11.35, h: 3.55, fontSize: item.content.length > 700 ? 18 : 23, color: colors.text, margin: 0, valign: 'top', fit: 'shrink', paraSpaceAfterPt: 10, breakLine: false });
    slide.addText(`${index + 1} / ${result.data.slides.length}`, { x: 11.3, y: 6.9, w: 1.3, h: 0.25, fontSize: 10, align: 'right', color: colors.muted, margin: 0 });
    slide.addText(presentation.audience || '', { x: 0.65, y: 6.9, w: 9.8, h: 0.25, fontSize: 10, color: colors.muted, margin: 0, fit: 'shrink' });
    if (item.notes) slide.addNotes(item.notes);
  });
  return pptx.write({ outputType: 'nodebuffer' });
}
module.exports = { buildPptx };
