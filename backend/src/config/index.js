'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load .env from backend root regardless of where node is invoked from.
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

function required(name) {
  const v = process.env[name];
  if (v === undefined || v === null || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Environment variable ${name} must be an integer (got "${raw}")`);
  }
  return n;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: int('PORT', 5001),

  MONGODB_URI: required('MONGODB_URI'),
  MONGODB_DB: process.env.MONGODB_DB || 'giaphuc',
  PROGRESS_TEST: {
    MONGODB_URI: process.env.PROGRESS_TEST_MONGODB_URI || required('MONGODB_URI'),
    MONGODB_DB: process.env.PROGRESS_TEST_MONGODB_DB || 'progress_test',
  },
  TIMETABLE: {
    MONGODB_URI: process.env.TKB_MONGODB_URI || required('MONGODB_URI'),
    MONGODB_DB: process.env.TKB_MONGODB_DB || 'thuanhung_tkb',
    TRANSFER_POLICY: (process.env.TKB_TRANSFER_POLICY || 'AUTO_SHORTAGE').toUpperCase(),
    PREVIEW_LIMIT: int('TKB_PREVIEW_LIMIT', 6),
    PREVIEW_TTL_SECONDS: int('TKB_PREVIEW_TTL_SECONDS', 0) || null,
    ASSISTANT: {
      API_KEY: process.env.TKB_AI_API_KEY || '',
      MODEL: process.env.TKB_AI_MODEL || 'codex-auto-review',
      BASE_URL: process.env.TKB_AI_BASE_URL || 'https://modelapi.vn/v1',
      TIMEOUT_MS: int('TKB_AI_TIMEOUT_MS', 60000),
      PREVIEW_TTL_SECONDS: int('TKB_ASSISTANT_TTL_SECONDS', 900),
    },
  },

  JWT_SECRET: required('JWT_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '1h',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  MAIL: {
    HOST: process.env.MAIL_HOST || 'smtp.gmail.com',
    PORT: int('MAIL_PORT', 465),
    SECURE: String(process.env.MAIL_SECURE ?? 'true').toLowerCase() === 'true',
    USER: required('MAIL_USER'),
    PASS: required('MAIL_PASS'),
    FROM_NAME: process.env.MAIL_FROM_NAME || 'Gia Phuc System',
    FROM_EMAIL: process.env.MAIL_FROM_EMAIL || process.env.MAIL_USER,
  },

  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:5173',
  BACKEND_URL: process.env.BACKEND_URL || 'http://localhost:5001',

  PRESENTATION: {
    MONGODB_URI: process.env.PRESENTATION_MONGODB_URI || process.env.MONGODB_URI,
    MONGODB_DB: process.env.PRESENTATION_MONGODB_DB || 'presentations',
    TOKEN_ENCRYPTION_KEY: process.env.PRESENTATION_TOKEN_ENCRYPTION_KEY || '',
    MODEL_API_URL: process.env.MODEL_API_URL || `${(process.env.TKB_AI_BASE_URL || 'https://modelapi.vn/v1').replace(/\/$/, '')}/chat/completions`,
    MODEL_API_KEY: process.env.MODEL_API_KEY || process.env.TKB_AI_API_KEY || '',
    MODEL_API_MODEL: process.env.MODEL_API_MODEL || process.env.TKB_AI_MODEL || 'codex-auto-review',
    MODEL_API_TIMEOUT_MS: int('MODEL_API_TIMEOUT_MS', 180000),
    IMAGE_API_URL: process.env.MODEL_IMAGE_API_URL || 'https://modelapi.vn/v1/images/generations',
    IMAGE_API_KEY: process.env.MODEL_IMAGE_API_KEY || '',
    IMAGE_MODEL: process.env.MODEL_IMAGE_MODEL || 'gpt-image-2',
    VIDEO_API_URL: process.env.MODEL_VIDEO_API_URL || 'https://modelapi.vn/v1/videos',
    VIDEO_API_KEY: process.env.MODEL_VIDEO_API_KEY || process.env.MODEL_IMAGE_API_KEY || '',
    VIDEO_MODEL: process.env.MODEL_VIDEO_MODEL || 'grok-imagine-video-1.5',
    CANVA: {
      CLIENT_ID: process.env.CANVA_CLIENT_ID || '',
      CLIENT_SECRET: process.env.CANVA_CLIENT_SECRET || '',
      REDIRECT_URI: process.env.CANVA_REDIRECT_URI || '',
      SCOPES: process.env.CANVA_SCOPES || 'design:content:write design:content:read',
    },
  },

  SEED_ADMIN: {
    EMAIL: process.env.SEED_ADMIN_EMAIL || 'admin@giaphuc.local',
    PASSWORD: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe@12345',
    NAME: process.env.SEED_ADMIN_NAME || 'Administrator',
    PHONE: process.env.SEED_ADMIN_PHONE || '',
    USERNAME: process.env.SEED_ADMIN_USERNAME || 'admin',
  },

  BCRYPT_ROUNDS: int('BCRYPT_ROUNDS', 10),
};

if (env.TIMETABLE.MONGODB_DB.toLowerCase() === env.MONGODB_DB.toLowerCase()) {
  throw new Error('TKB_MONGODB_DB must be different from MONGODB_DB.');
}
if ([env.MONGODB_DB, env.TIMETABLE.MONGODB_DB, env.PRESENTATION.MONGODB_DB].some(name => name.toLowerCase() === env.PROGRESS_TEST.MONGODB_DB.toLowerCase()) || /[\s/\\.\"$]/.test(env.PROGRESS_TEST.MONGODB_DB)) {
  throw new Error('PROGRESS_TEST_MONGODB_DB must be a valid independent database name.');
}
if (env.PRESENTATION.MONGODB_DB !== 'presentations' || [env.MONGODB_DB, env.TIMETABLE.MONGODB_DB, env.PROGRESS_TEST.MONGODB_DB].some(name => name.toLowerCase() === 'presentations')) {
  throw new Error('Presentation database must be presentations and independent of other applications.');
}
if (env.PRESENTATION.TOKEN_ENCRYPTION_KEY && !/^[a-fA-F0-9]{64}$/.test(env.PRESENTATION.TOKEN_ENCRYPTION_KEY)) {
  throw new Error('PRESENTATION_TOKEN_ENCRYPTION_KEY must be a 32-byte hex key.');
}
if (env.PRESENTATION.MODEL_API_TIMEOUT_MS < 1000 || env.PRESENTATION.MODEL_API_TIMEOUT_MS > 300000) {
  throw new Error('MODEL_API_TIMEOUT_MS must be between 1000 and 300000.');
}
if (!['AUTO_SHORTAGE', 'EXPLICIT'].includes(env.TIMETABLE.TRANSFER_POLICY)) {
  throw new Error('TKB_TRANSFER_POLICY must be AUTO_SHORTAGE or EXPLICIT.');
}
if (env.TIMETABLE.PREVIEW_LIMIT < 1 || (env.TIMETABLE.PREVIEW_TTL_SECONDS !== null && env.TIMETABLE.PREVIEW_TTL_SECONDS < 1)) {
  throw new Error('TKB_PREVIEW_LIMIT must be positive; preview TTL must be zero/unset or positive.');
}
module.exports = env;
