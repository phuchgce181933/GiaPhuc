'use strict';

const Role = require('./role.model');
const ApiError = require('../../shared/ApiError');

async function listRoles({ search, page = 1, limit = 20 }) {
  const filter = {};
  if (search) {
    const re = new RegExp(search.trim(), 'i');
    filter.$or = [{ name: re }, { key: re }];
  }
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    Role.find(filter).sort({ isSystem: -1, name: 1 }).skip(skip).limit(limit).lean(),
    Role.countDocuments(filter),
  ]);
  return { items, total, page, limit, pages: Math.ceil(total / limit) };
}

async function getRoleById(id) {
  const role = await Role.findById(id).lean();
  if (!role) throw ApiError.notFound('Role not found');
  return role;
}

async function getRoleByKey(key) {
  return Role.findOne({ key: key.toLowerCase() }).lean();
}

async function createRole(data) {
  const existing = await Role.findOne({ key: data.key }).lean();
  if (existing) throw ApiError.conflict(`Role key already exists: ${data.key}`);
  const role = await Role.create({ ...data, isSystem: false });
  return role.toObject();
}

async function updateRole(id, patch) {
  const role = await Role.findById(id);
  if (!role) throw ApiError.notFound('Role not found');
  if (role.isSystem && patch.permissions && !role.key) {
    // allow editing permissions
  }
  if (patch.name !== undefined) role.name = patch.name;
  if (patch.description !== undefined) role.description = patch.description;
  if (patch.permissions !== undefined) role.permissions = patch.permissions;
  await role.save();
  return role.toObject();
}

async function deleteRole(id) {
  const role = await Role.findById(id);
  if (!role) throw ApiError.notFound('Role not found');
  if (role.isSystem) throw ApiError.forbidden('System roles cannot be deleted');
  await role.deleteOne();
  return { id };
}

module.exports = { listRoles, getRoleById, getRoleByKey, createRole, updateRole, deleteRole };