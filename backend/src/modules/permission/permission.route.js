'use strict';

const { Router } = require('express');
const catchAsync = require('../../shared/catchAsync');
const sendResponse = require('../../shared/sendResponse');
const { PERMISSION_LIST, PERMISSION_GROUPS } = require('../../shared/permissions');
const authMiddleware = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');

const router = Router();

router.use(authMiddleware);

/**
 * GET /permissions
 * Returns the catalog of permission keys and groups. Useful for the admin role editor.
 */
router.get(
  '/',
  requirePermission('role:read'),
  catchAsync(async (_req, res) => {
    sendResponse(res, {
      message: 'Permission catalog',
      data: { permissions: PERMISSION_LIST, groups: PERMISSION_GROUPS },
    });
  })
);

module.exports = router;