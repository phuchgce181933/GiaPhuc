'use strict';

const { z } = require('zod');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

// Treat empty strings from query strings as undefined so `?status=` doesn't fail enum/objectId checks.
const emptyToUndef = (schema) =>
  z.preprocess((v) => (v === '' || v == null ? undefined : v), schema.optional());

const profileSchema = z.object({
  fullName: z.string().trim().max(120).optional().default(''),
  phone: z.string().trim().max(32).optional().default(''),
  dob: z
    .union([z.string().datetime({ offset: true }), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])
    .optional()
    .nullable(),
  gender: z.enum(['male', 'female', 'other', '']).optional().default(''),
  address: z.string().trim().max(500).optional().default(''),
  avatarUrl: z.string().trim().max(1000).optional().default(''),
});

const createUserSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(128),
    username: z.string().trim().toLowerCase().max(64).optional().default(''),
    roleId: objectId,
    status: z.enum(['active', 'inactive', 'locked']).optional().default('active'),
    profile: profileSchema.optional().default({}),
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    username: z.string().trim().toLowerCase().max(64).optional(),
    roleId: objectId.optional(),
    status: z.enum(['active', 'inactive', 'locked']).optional(),
    profile: profileSchema.optional(),
  }),
});

const updateProfileSchema = z.object({
  body: profileSchema,
});

const updateRoleSchema = z.object({
  body: z.object({ roleId: objectId }),
});

const updateStatusSchema = z.object({
  body: z.object({
    status: z.enum(['active', 'inactive', 'locked']),
    reason: z.string().trim().max(200).optional(),
  }),
});

const userIdParamSchema = z.object({
  params: z.object({ id: objectId }),
});

const listQuerySchema = z.object({
  query: z.object({
    q: emptyToUndef(z.string().trim()),
    roleId: emptyToUndef(objectId),
    status: emptyToUndef(z.enum(['active', 'inactive', 'locked'])),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
});

module.exports = {
  createUserSchema,
  updateUserSchema,
  updateProfileSchema,
  updateRoleSchema,
  updateStatusSchema,
  userIdParamSchema,
  listQuerySchema,
};