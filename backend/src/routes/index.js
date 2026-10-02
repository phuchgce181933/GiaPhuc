'use strict';

const express = require('express');
const authRouter = require('../modules/auth/auth.route');
const userRouter = require('../modules/user/user.route');
const roleRouter = require('../modules/role/role.route');
const permissionRouter = require('../modules/permission/permission.route');

const router = express.Router();

router.get('/health', (_req, res) => {
  res.json({ success: true, message: 'OK', data: { status: 'healthy', timestamp: new Date().toISOString() } });
});

router.use('/auth', authRouter);
router.use('/users', userRouter);
router.use('/roles', roleRouter);
router.use('/permissions', permissionRouter);

module.exports = router;