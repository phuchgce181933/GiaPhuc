'use strict';

const express = require('express');
const validate = require('../../middlewares/validate.middleware');
const authMiddleware = require('../../middlewares/auth.middleware');
const ctrl = require('./auth.controller');
const { loginSchema, refreshSchema, changePasswordSchema } = require('./auth.validation');

const router = express.Router();

router.post('/login', validate(loginSchema), ctrl.login);
router.post('/refresh', validate(refreshSchema), ctrl.refresh);
router.post('/change-password', authMiddleware, validate(changePasswordSchema), ctrl.changePassword);

module.exports = router;