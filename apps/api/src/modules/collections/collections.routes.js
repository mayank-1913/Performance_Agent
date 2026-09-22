'use strict';

const { Router } = require('express');
const { upload } = require('../../middleware/upload');
const asyncHandler = require('../../utils/asyncHandler');
const { requireRole } = require('../auth/auth.middleware');
const {
  uploadCollection,
  listCollections,
  getCollection,
  authCheck,
  getTree,
  deleteCollection,
} = require('./collections.controller');

const router = Router();

router.get('/', asyncHandler(listCollections));
router.get('/:id', asyncHandler(getCollection));
router.get('/:id/auth-check', asyncHandler(authCheck));
router.post('/:id/auth-check', asyncHandler(authCheck));
router.get('/:id/tree', asyncHandler(getTree));
router.post('/', upload.single('collection'), asyncHandler(uploadCollection));

// Admin-only destructive action
router.delete('/:id', requireRole('admin'), asyncHandler(deleteCollection));

module.exports = router;
