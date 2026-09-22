'use strict';

const { Router } = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const ctrl = require('./runs.controller');

const router = Router();

router.get('/', asyncHandler(ctrl.list));
router.post('/prepare', asyncHandler(ctrl.prepare));
router.post('/', asyncHandler(ctrl.start));

router.get('/:runId', asyncHandler(ctrl.get));
router.get('/:runId/logs', asyncHandler(ctrl.logs));
router.get('/:runId/stream', ctrl.stream); // SSE: do not wrap in asyncHandler
router.post('/:runId/stop', asyncHandler(ctrl.stop));

// Phase 4 reporting endpoints
router.get('/:runId/summary', asyncHandler(ctrl.summary));
router.get('/:runId/metrics', asyncHandler(ctrl.metrics));
router.get('/:runId/report', ctrl.report); // streams HTML; do not JSON-wrap

module.exports = router;
