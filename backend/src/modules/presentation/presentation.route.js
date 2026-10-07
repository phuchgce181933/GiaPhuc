'use strict';
const express = require('express');
const auth = require('../../middlewares/auth.middleware');
const { requirePermission } = require('../../middlewares/rbac.middleware');
const controller = require('./presentation.controller');
const { PERMISSIONS } = require('../../shared/permissions');
const router = express.Router();
router.get('/canva/callback', controller.callback);
router.use(auth);
router.get('/canva/connect', requirePermission(PERMISSIONS.PRESENTATION_CREATE), controller.connect);
router.get('/canva/status', requirePermission(PERMISSIONS.PRESENTATION_VIEW), controller.connectionStatus);
router.get('/', requirePermission(PERMISSIONS.PRESENTATION_VIEW), controller.list);
router.post('/', requirePermission(PERMISSIONS.PRESENTATION_CREATE), controller.create);
router.get('/:id', requirePermission(PERMISSIONS.PRESENTATION_VIEW), controller.detail);
router.patch('/:id', requirePermission(PERMISSIONS.PRESENTATION_UPDATE), controller.update);
router.post('/:id/canva', requirePermission(PERMISSIONS.PRESENTATION_CREATE), controller.createCanva);
router.post('/:id/export', requirePermission(PERMISSIONS.PRESENTATION_EXPORT), controller.exportFile);
router.delete('/:id', requirePermission(PERMISSIONS.PRESENTATION_DELETE), async (req, res, next) => {
  try {
    const { getPresentationModel } = require('./presentation.model');
    const model = await getPresentationModel();
    const result = await model.deleteOne({ _id: req.params.id, ownerId: req.user.id });
    if (!result.deletedCount) return res.status(404).json({ success: false, message: 'Không tìm thấy bài thuyết trình hoặc bạn không có quyền.' });
    res.json({ success: true, data: { deleted: true } });
  } catch (error) { next(error); }
});
module.exports = router;
