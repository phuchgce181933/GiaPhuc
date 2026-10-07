'use strict';
const express = require('express');
const authenticate = require('../../middlewares/auth.middleware');
const timetableAccess = require('../../middlewares/timetable-rbac.middleware');
const { handle } = require('./timetable.controller');
const ApiError = require('../../shared/ApiError');

const router = express.Router();
router.use(authenticate, timetableAccess);
router.use((req, res, next) => {
  handle(req, res, next).catch((error) => next(new ApiError(503, 'Không thể đọc database thời khóa biểu. Vui lòng thử lại.', {
    code: 'TIMETABLE_UNAVAILABLE', cause: error,
  })));
});
module.exports = router;
