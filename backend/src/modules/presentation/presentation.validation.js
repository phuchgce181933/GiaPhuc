'use strict';
const { z } = require('zod');
// Canva descriptions accept <=2000 characters; content and notes fit together.
const slide = z.object({ title: z.string().trim().min(1).max(255), content: z.string().trim().min(1).max(1400), notes: z.string().trim().max(500) }).strict();
const createSchema = z.object({ title: z.string().trim().min(1).max(255), sourceContent: z.string().trim().min(20).max(50000),
  language: z.enum(['Tiếng Việt','English']), audience: z.string().trim().min(2).max(255), slideCount: z.number().int().min(1).max(100),
  style: z.enum(['Dark SaaS hiện đại','Tối giản chuyên nghiệp','Năng động thương hiệu']),
}).strict();
const outlineSchema = z.object({ slides: z.array(slide).min(1).max(100) }).strict();
const updateSchema = z.object({ outline: z.array(slide).min(1).max(100), revision: z.number().int().min(0) }).strict();
const confirmSchema = z.object({ revision: z.number().int().min(0), confirmed: z.literal(true) }).strict();
const exportSchema = z.object({ format: z.enum(['pdf','pptx']) }).strict();
const idSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
const keySchema = z.string().uuid();
module.exports = { createSchema, outlineSchema, updateSchema, confirmSchema, exportSchema, idSchema, keySchema };
