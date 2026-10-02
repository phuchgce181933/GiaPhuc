'use strict';

const { z } = require('zod');
const { PERMISSION_LIST } = require('../../shared/permissions');

const createRoleSchema = z.object({
  body: z.object({
    key: z
      .string()
      .trim()
      .toLowerCase()
      .min(2, 'Key must be at least 2 chars')
      .max(50)
      .regex(/^[a-z0-9_-]+$/, 'Key may contain only a-z, 0-9, "-" and "_"'),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(500).optional().default(''),
    permissions: z.array(z.enum(PERMISSION_LIST)).default([]),
  }),
});

const updateRoleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).optional(),
    permissions: z.array(z.enum(PERMISSION_LIST)).optional(),
  }),
});

const idParamSchema = z.object({
  params: z.object({ id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid role id') }),
});

module.exports = { createRoleSchema, updateRoleSchema, idParamSchema };