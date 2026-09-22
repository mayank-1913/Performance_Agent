'use strict';

const { Router } = require('express');
const { upload } = require('../../middleware/upload');
const asyncHandler = require('../../utils/asyncHandler');
const ctrl = require('./environments.controller');

const router = Router();

router.get('/', asyncHandler(ctrl.listEnvironments));
router.get('/:id', asyncHandler(ctrl.getEnvironment));
router.post('/', upload.single('environment'), asyncHandler(ctrl.uploadEnvironment));
router.delete('/:id', asyncHandler(ctrl.deleteEnvironment));

module.exports = router;
