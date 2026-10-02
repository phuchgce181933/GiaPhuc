'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config');
const ApiError = require('../shared/ApiError');
const User = require('../modules/user/user.model');

/**
 * Verify an access token from the Authorization header and attach the user to req.user.
 * The shape is { id, email, roleKey, permissions: string[] }.
 */
async function authMiddleware(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw ApiError.unauthorized('Missing or malformed Authorization header');
    }

    let payload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET);
    } catch {
      throw ApiError.unauthorized('Invalid or expired token');
    }

    if (payload.type !== 'access') {
      throw ApiError.unauthorized('Wrong token type');
    }

    const user = await User.findById(payload.sub)
      .select('_id email status role profile')
      .populate({ path: 'role', select: 'key name permissions isSystem' })
      .lean();

    if (!user) throw ApiError.unauthorized('User no longer exists');
    if (user.status !== 'active') {
      throw ApiError.forbidden(`Account is ${user.status}`);
    }

    req.user = {
      id: String(user._id),
      email: user.email,
      status: user.status,
      profile: user.profile,
      role: user.role
        ? {
            id: String(user.role._id),
            key: user.role.key,
            name: user.role.name,
            permissions: user.role.permissions || [],
            isSystem: !!user.role.isSystem,
          }
        : null,
    };

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = authMiddleware;