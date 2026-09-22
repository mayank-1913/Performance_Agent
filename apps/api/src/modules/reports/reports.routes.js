'use strict';

const { Router } = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const ctrl = require('./reports.controller');
const { requireRole } = require('../auth/auth.middleware');

const router = Router();

router.get('/', asyncHandler(ctrl.listReports));
router.get('/:id', asyncHandler(ctrl.getReport));
router.get('/:id/metrics', asyncHandler(ctrl.getMetrics));
router.get('/:id/logs', asyncHandler(ctrl.getLogs));
router.get('/:id/report', ctrl.getReportHtml); // streams HTML

// Admin-only destructive action
router.delete('/:id', requireRole('admin'), asyncHandler(ctrl.deleteReport));

module.exports = router;
