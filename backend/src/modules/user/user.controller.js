'use strict';

const ApiError = require('../../shared/ApiError');
const userService = require('./user.service');
const catchAsync = require('../../shared/catchAsync');
const sendResponse = require('../../shared/sendResponse');
const { requirePermission } = require('../../middlewares/rbac.middleware');

const list = catchAsync(async (req, res) => {
  const result = await userService.listUsers(req.query);
  sendResponse(res, { message: 'Users fetched', data: result.items, meta: result });
});

const detail = catchAsync(async (req, res) => {
  const hasAny = req.user.role?.permissions?.includes('profile:read:any');
  const isSelf = String(req.params.id) === String(req.user.id);
  if (!hasAny && !isSelf) throw ApiError.forbidden('Cannot view this user');
  const user = await userService.getUserById(req.params.id);
  sendResponse(res, { message: 'User fetched', data: user });
});

const create = catchAsync(async (req, res) => {
  const user = await userService.createUser(req.body);
  sendResponse(res, { statusCode: 201, message: 'User created', data: user });
});

const update = catchAsync(async (req, res) => {
  const user = await userService.updateUser(req.params.id, req.body);
  sendResponse(res, { message: 'User updated', data: user });
});

const updateProfile = catchAsync(async (req, res) => {
  const user = await userService.updateOwnProfile(req.params.id, req.body);
  sendResponse(res, { message: 'Profile updated', data: user });
});

const changeRole = catchAsync(async (req, res) => {
  const user = await userService.changeRole(req.params.id, req.body.roleId, { actor: req.user });
  sendResponse(res, { message: 'Role changed', data: user });
});

const changeStatus = catchAsync(async (req, res) => {
  const user = await userService.changeStatus(req.params.id, req.body.status);
  sendResponse(res, { message: 'Status changed', data: user });
});

const remove = catchAsync(async (req, res) => {
  const result = await userService.deleteUser(req.params.id);
  sendResponse(res, { message: 'User deleted', data: result });
});

const me = catchAsync(async (req, res) => {
  const user = await userService.getUserById(req.user.id);
  sendResponse(res, { message: 'Current user', data: user });
});

module.exports = {
  list,
  detail,
  create,
  update,
  updateProfile,
  changeRole,
  changeStatus,
  remove,
  me,
  requirePermission,
};