'use strict';

const { Router } = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const ctrl = require('./scripts.controller');

const router = Router();

router.get('/', asyncHandler(ctrl.listScripts));
router.post('/generate', asyncHandler(ctrl.generate));
router.get('/:id', asyncHandler(ctrl.getScript));
router.get('/:id/download', asyncHandler(ctrl.downloadScript));

module.exports = router;
