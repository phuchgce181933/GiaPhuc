'use strict';

const express = require('express');
const validate = require('../../middlewares/validate.middleware');
const authMiddleware = require('../../middlewares/auth.middleware');
const { requirePermission, requireAnyPermission } = require('../../middlewares/rbac.middleware');
const ctrl = require('./user.controller');
const v = require('./user.validation');

const router = express.Router();

// Read endpoints
router.get('/', authMiddleware, validate(v.listQuerySchema, 'query'), requirePermission('user:read'), ctrl.list);
router.get('/me', authMiddleware, ctrl.me);
router.get('/:id', authMiddleware, validate(v.userIdParamSchema, 'params'), ctrl.detail);

// Mutations — admins
router.post('/', authMiddleware, validate(v.createUserSchema), requirePermission('user:create'), ctrl.create);
router.patch(
  '/:id',
  authMiddleware,
  validate(v.userIdParamSchema, 'params'),
  requirePermission('user:update'),
  validate(v.updateUserSchema),
  ctrl.update
);

router.patch(
  '/:id/role',
  authMiddleware,
  validate(v.userIdParamSchema, 'params'),
  validate(v.updateRoleSchema),
  requirePermission('user:change-role'),
  ctrl.changeRole
);

router.patch(
  '/:id/status',
  authMiddleware,
  validate(v.userIdParamSchema, 'params'),
  validate(v.updateStatusSchema),
  requirePermission('user:change-status'),
  ctrl.changeStatus
);

router.delete(
  '/:id',
  authMiddleware,
  validate(v.userIdParamSchema, 'params'),
  requirePermission('user:delete'),
  ctrl.remove
);

// Profile updates — self only.
router.patch(
  '/:id/profile',
  authMiddleware,
  validate(v.userIdParamSchema, 'params'),
  requireAnyPermission('profile:update:self', 'profile:update:any'),
  (req, _res, next) => {
    const isSelf = String(req.params.id) === String(req.user.id);
    const canAny = req.user.role?.permissions?.includes('profile:update:any');
    if (!isSelf && !canAny) return next(require('../../shared/ApiError').forbidden('Cannot edit another user\'s profile'));
    next();
  },
  validate(v.updateProfileSchema),
  ctrl.updateProfile
);

module.exports = router;