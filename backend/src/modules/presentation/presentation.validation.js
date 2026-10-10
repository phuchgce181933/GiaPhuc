'use strict';
const { z } = require('zod');
// Canva descriptions accept <=2000 characters; content and notes fit together.
const design=require('./presentation-design.service');
const slide = z.object({ title: z.string().trim().min(1).max(255), content: z.string().trim().min(1).max(1400), notes: z.string().trim().max(500), layout:z.enum(design.LAYOUTS).optional(),colorRole:z.enum(design.COLOR_ROLES).optional() }).strict();
const createSchema = z.object({ title: z.string().trim().min(1).max(255), sourceContent: z.string().trim().min(20),
  language: z.enum(['Tiếng Việt','English']), audience: z.string().trim().min(2).max(255), slideCount: z.number().int().min(1).max(100),
  style: z.enum(['Dark SaaS hiện đại','Tối giản chuyên nghiệp','Năng động thương hiệu']),
  visualStyle:z.enum(design.VISUAL_STYLES).default('Flat Design & Illustration'),presentationType:z.enum(design.PRESENTATION_TYPES).default('Education'),
}).strict();
const outlineSchema = z.object({ slides: z.array(slide).min(1).max(100) }).strict();
const updateSchema = z.object({ title:z.string().trim().min(1).max(255).optional(),outline: z.array(slide).min(1).max(100), revision: z.number().int().min(0).optional() }).strict();
const confirmSchema = z.object({ revision: z.number().int().min(0), confirmed: z.literal(true) }).strict();
const exportSchema = z.object({ format: z.enum(['pdf','pptx']) }).strict();
const idSchema = z.object({ id: z.string().regex(/^[a-f0-9]{24}$/i) });
const keySchema = z.string().uuid();
module.exports = { createSchema, outlineSchema, updateSchema, confirmSchema, exportSchema, idSchema, keySchema };
