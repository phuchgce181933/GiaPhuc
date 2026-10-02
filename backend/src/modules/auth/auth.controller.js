'use strict';

const catchAsync = require('../../shared/catchAsync');
const sendResponse = require('../../shared/sendResponse');
const authService = require('./auth.service');

const login = catchAsync(async (req, res) => {
  const result = await authService.login(req.body);
  sendResponse(res, { message: 'Logged in', data: result });
});

const refresh = catchAsync(async (req, res) => {
  const tokens = await authService.refresh(req.body.refreshToken);
  sendResponse(res, { message: 'Token refreshed', data: tokens });
});

const changePassword = catchAsync(async (req, res) => {
  const result = await authService.changePassword(
    req.user.id,
    req.body.currentPassword,
    req.body.newPassword
  );
  sendResponse(res, { message: 'Password changed', data: result });
});

module.exports = { login, refresh, changePassword };