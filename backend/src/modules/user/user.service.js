'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('./user.model');
const Role = require('../role/role.model');
const ApiError = require('../../shared/ApiError');
const env = require('../../config');
const { sendMail } = require('../../shared/mailer');

function ensureRoleDoc(roleId) {
  if (!mongoose.isValidObjectId(roleId)) {
    throw ApiError.badRequest('Invalid roleId');
  }
}

function pickUserPublic(userDoc) {
  if (!userDoc) return null;
  const obj = userDoc.toObject ? userDoc.toObject() : { ...userDoc };
  delete obj.passwordHash;
  return obj;
}

async function listUsers({ q, roleId, status, page = 1, limit = 20 }) {
  const filter = {};
  if (q) {
    const re = new RegExp(q.trim(), 'i');
    filter.$or = [
      { email: re },
      { username: re },
      { 'profile.fullName': re },
      { 'profile.phone': re },
    ];
  }
  if (roleId) filter.role = roleId;
  if (status) filter.status = status;
  const skip = (page - 1) * limit;
  const [items, total] = await Promise.all([
    User.find(filter)
      .populate({ path: 'role', select: 'key name permissions isSystem' })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);
  return {
    items: items.map(pickUserPublic),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

async function getUserById(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid user id');
  const user = await User.findById(id).populate({
    path: 'role',
    select: 'key name permissions isSystem',
  });
  if (!user) throw ApiError.notFound('User not found');
  return pickUserPublic(user);
}

async function createUser(payload) {
  ensureRoleDoc(payload.roleId);
  const role = await Role.findById(payload.roleId).lean();
  if (!role) throw ApiError.notFound('Role not found');

  const existing = await User.findOne({ email: payload.email.toLowerCase() }).lean();
  if (existing) throw ApiError.conflict('Email already in use');

  const passwordHash = await bcrypt.hash(payload.password, env.BCRYPT_ROUNDS);
  const user = await User.create({
    email: payload.email.toLowerCase(),
    username: payload.username || '',
    passwordHash,
    role: payload.roleId,
    status: payload.status || 'active',
    profile: payload.profile || {},
  });

  // Fire-and-forget welcome email. We do not fail user creation on email errors.
  sendMail({
    to: user.email,
    subject: 'Your Gia Phuc account has been created',
    html: welcomeEmailHtml({ name: user.profile?.fullName, email: user.email, loginUrl: env.FRONTEND_URL }),
    text: `Hello ${user.profile?.fullName || ''},\n\nAn account was created for ${user.email}. Sign in at ${env.FRONTEND_URL}.`,
  }).catch(() => {});

  const full = await User.findById(user._id).populate({
    path: 'role',
    select: 'key name permissions isSystem',
  });
  return pickUserPublic(full);
}

function welcomeEmailHtml({ name, email, loginUrl }) {
  return `
  <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;line-height:1.6;color:#0f172a">
    <h2 style="margin:0 0 12px">Welcome to Gia Phuc</h2>
    <p>Hi${name ? ` ${name}` : ''},</p>
    <p>An administrator has created an account for you.</p>
    <p><strong>Email:</strong> ${email}</p>
    <p>You can sign in using the temporary password provided to you separately. For your security, change it after the first login.</p>
    <p><a href="${loginUrl}" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Open Gia Phuc</a></p>
    <p style="color:#64748b;font-size:12px;margin-top:24px">If you did not expect this email, please ignore it.</p>
  </div>`;
}

async function updateUser(id, patch) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid user id');
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');

  if (patch.roleId) {
    const role = await Role.findById(patch.roleId).lean();
    if (!role) throw ApiError.notFound('Role not found');
    user.role = patch.roleId;
  }
  if (patch.username !== undefined) user.username = patch.username;
  if (patch.status !== undefined) user.status = patch.status;
  if (patch.profile !== undefined) {
    user.profile = { ...user.profile.toObject?.() || user.profile, ...patch.profile };
  }
  await user.save();

  const full = await User.findById(user._id).populate({
    path: 'role',
    select: 'key name permissions isSystem',
  });
  return pickUserPublic(full);
}

async function updateOwnProfile(userId, patch) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');
  user.profile = { ...user.profile.toObject?.() || user.profile, ...patch };
  await user.save();
  return pickUserPublic(user);
}

async function changeRole(id, roleId, { actor } = {}) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid user id');
  if (!mongoose.isValidObjectId(roleId)) throw ApiError.badRequest('Invalid roleId');
  const role = await Role.findById(roleId).lean();
  if (!role) throw ApiError.notFound('Role not found');
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  if (actor && String(user._id) === String(actor.id) && role.key !== 'admin') {
    // No-op: admins can demote themselves; non-admins cannot escalate. The route layer enforces permissions.
  }
  user.role = roleId;
  await user.save();
  return pickUserPublic(user);
}

async function changeStatus(id, status) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid user id');
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  user.status = status;
  await user.save();
  return pickUserPublic(user);
}

async function deleteUser(id) {
  if (!mongoose.isValidObjectId(id)) throw ApiError.badRequest('Invalid user id');
  const user = await User.findById(id);
  if (!user) throw ApiError.notFound('User not found');
  await user.deleteOne();
  return { id: String(user._id) };
}

async function findByEmailWithSecrets(email) {
  return User.findOne({ email: email.toLowerCase() })
    .select('+passwordHash')
    .populate({ path: 'role', select: 'key name permissions' });
}

module.exports = {
  listUsers,
  getUserById,
  createUser,
  updateUser,
  updateOwnProfile,
  changeRole,
  changeStatus,
  deleteUser,
  findByEmailWithSecrets,
};