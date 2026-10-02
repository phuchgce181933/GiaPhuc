'use strict';

const express = require('express');
const catchAsync = require('../../shared/catchAsync');
const sendResponse = require('../../shared/sendResponse');
const roleService = require('./role.service');
const validate = require('../../middlewares/validate.middleware');
const authMiddleware = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const {
  createRoleSchema,
  updateRoleSchema,
  idParamSchema,
} = require('./role.validation');

const router = express.Router();

const list = catchAsync(async (req, res) => {
  const { q, page, limit } = req.query;
  const result = await roleService.listRoles({ search: q, page, limit });
  sendResponse(res, { message: 'Roles fetched', data: result.items, meta: result });
});
const detail = catchAsync(async (req, res) => {
  const role = await roleService.getRoleById(req.params.id);
  sendResponse(res, { message: 'Role fetched', data: role });
});
const create = catchAsync(async (req, res) => {
  const role = await roleService.createRole(req.body);
  sendResponse(res, { statusCode: 201, message: 'Role created', data: role });
});
const update = catchAsync(async (req, res) => {
  const role = await roleService.updateRole(req.params.id, req.body);
  sendResponse(res, { message: 'Role updated', data: role });
});
const remove = catchAsync(async (req, res) => {
  await roleService.deleteRole(req.params.id);
  sendResponse(res, { message: 'Role deleted', data: { id: req.params.id } });
});

router.use(authMiddleware);

router.get('/', requirePermission('role:read'), list);
router.get('/:id', requirePermission('role:read'), validate(idParamSchema, 'params'), detail);
router.post(
  '/',
  requirePermission('role:manage'),
  validate(createRoleSchema),
  create
);
router.patch(
  '/:id',
  requirePermission('role:manage'),
  validate(idParamSchema, 'params'),
  validate(updateRoleSchema),
  update
);
router.delete(
  '/:id',
  requirePermission('role:manage'),
  validate(idParamSchema, 'params'),
  remove
);

module.exports = router;