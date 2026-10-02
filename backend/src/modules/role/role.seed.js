'use strict';

const Role = require('./role.model');
const ApiError = require('../../shared/ApiError');

const ROLES = {
  ADMIN: 'admin',
  USER: 'user',
};

const ROLE_DEFINITIONS = [
  {
    key: ROLES.ADMIN,
    name: 'Administrator',
    description: 'Full system access. Granted to seeded staff members only.',
    permissions: [], // assigned programmatically below
    isSystem: true,
  },
  {
    key: ROLES.USER,
    name: 'User',
    description: 'Default role for self-registered users. Can view and edit own profile.',
    permissions: [
      'auth:login',
      'profile:read:self',
      'profile:update:self',
    ],
    isSystem: true,
  },
];

const { PERMISSION_LIST } = require('../../shared/permissions');

async function ensureSystemRoles() {
  const adminDef = { ...ROLE_DEFINITIONS[0], permissions: PERMISSION_LIST };
  await Role.findOneAndUpdate(
    { key: adminDef.key },
    { $set: adminDef },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await Role.findOneAndUpdate(
    { key: ROLE_DEFINITIONS[1].key },
    { $set: ROLE_DEFINITIONS[1] },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function ensureRoleByKey(key, fallback = {}) {
  const existing = await Role.findOne({ key }).lean();
  if (existing) return existing;
  const created = await Role.create({
    key,
    name: fallback.name || key,
    description: fallback.description || '',
    permissions: fallback.permissions || [],
    isSystem: !!fallback.isSystem,
  });
  return created.toObject();
}

module.exports = { ROLES, ROLE_DEFINITIONS, ensureSystemRoles, ensureRoleByKey };