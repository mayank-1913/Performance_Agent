'use strict';

const { Router } = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const ctrl = require('./auth.controller');
const { requireAuth, requireRole } = require('./auth.middleware');

const router = Router();

router.post('/login', asyncHandler(ctrl.login));
router.get('/me', requireAuth, asyncHandler(ctrl.me));

// Admin-only user management
router.get('/users', requireAuth, requireRole('admin'), asyncHandler(ctrl.listUsers));
router.post('/users', requireAuth, requireRole('admin'), asyncHandler(ctrl.createUser));
router.put('/users/:id', requireAuth, requireRole('admin'), asyncHandler(ctrl.updateUser));
router.delete('/users/:id', requireAuth, requireRole('admin'), asyncHandler(ctrl.deleteUser));

module.exports = router;
