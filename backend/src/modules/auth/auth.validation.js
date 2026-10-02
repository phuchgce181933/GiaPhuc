'use strict';

const { z } = require('zod');

const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(128),
  }),
});

const refreshSchema = z.object({
  body: z.object({
    refreshToken: z.string().min(10),
  }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().min(8).max(128),
  }),
});

module.exports = { loginSchema, refreshSchema, changePasswordSchema };