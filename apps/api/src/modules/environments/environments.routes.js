'use strict';

const { Router } = require('express');
const { upload } = require('../../middleware/upload');
const asyncHandler = require('../../utils/asyncHandler');
const { requireRole } = require('../auth/auth.middleware');
const ctrl = require('./environments.controller');

const router = Router();

router.get('/', asyncHandler(ctrl.listEnvironments));
router.get('/:id', asyncHandler(ctrl.getEnvironment));
router.post('/', upload.single('environment'), asyncHandler(ctrl.uploadEnvironment));
// Admin-only destructive action
router.delete('/:id', requireRole('admin'), asyncHandler(ctrl.deleteEnvironment));

module.exports = router;
