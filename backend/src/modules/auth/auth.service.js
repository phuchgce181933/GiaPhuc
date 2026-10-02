'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const env = require('../../config');
const ApiError = require('../../shared/ApiError');
const userService = require('../user/user.service');

function signAccess(payload) {
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  });
}

function signRefresh(payload) {
  return jwt.sign({ ...payload, type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  });
}

function verifyRefresh(token) {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET);
    if (decoded.type !== 'refresh') throw new Error('wrong type');
    return decoded;
  } catch {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }
}

async function login({ email, password }) {
  const user = await userService.findByEmailWithSecrets(email);
  if (!user) throw ApiError.unauthorized('Invalid credentials');

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid credentials');

  if (user.status !== 'active') {
    throw ApiError.forbidden(`Account is ${user.status}`);
  }

  const base = { sub: String(user._id), email: user.email, roleKey: user.role?.key };
  const accessToken = signAccess(base);
  const refreshToken = signRefresh(base);

  user.lastLoginAt = new Date();
  await user.save();

  // Strip passwordHash before returning
  const safe = user.toObject ? user.toObject() : { ...user };
  delete safe.passwordHash;

  return {
    user: safe,
    tokens: { accessToken, refreshToken },
  };
}

async function refresh(refreshToken) {
  const decoded = verifyRefresh(refreshToken);
  const user = await userService.findByEmailWithSecrets(decoded.email);
  if (!user) throw ApiError.unauthorized('User no longer exists');
  if (user.status !== 'active') throw ApiError.forbidden(`Account is ${user.status}`);

  const base = { sub: String(user._id), email: user.email, roleKey: user.role?.key };
  return {
    accessToken: signAccess(base),
    refreshToken: signRefresh(base),
  };
}

async function changePassword(userId, currentPassword, newPassword) {
  const User = require('../user/user.model');
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw ApiError.notFound('User not found');

  const ok = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Current password is incorrect');

  user.passwordHash = await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS);
  user.passwordChangedAt = new Date();
  await user.save();

  return { id: String(user._id) };
}

module.exports = { login, refresh, changePassword, verifyRefresh };