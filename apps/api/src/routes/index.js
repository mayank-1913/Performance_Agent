'use strict';

const { Router } = require('express');
const healthRoutes = require('../modules/health/health.routes');
const authRoutes = require('../modules/auth/auth.routes');
const collectionsRoutes = require('../modules/collections/collections.routes');
const environmentsRoutes = require('../modules/environments/environments.routes');
const scriptsRoutes = require('../modules/scripts/scripts.routes');
const runsRoutes = require('../modules/runs/runs.routes');
const reportsRoutes = require('../modules/reports/reports.routes');
const { requireAuth } = require('../modules/auth/auth.middleware');

const router = Router();

// Public
router.use('/health', healthRoutes);
router.use('/auth', authRoutes);

// Protected
router.use('/collections', requireAuth, collectionsRoutes);
router.use('/environments', requireAuth, environmentsRoutes);
router.use('/scripts', requireAuth, scriptsRoutes);
router.use('/runs', requireAuth, runsRoutes);
router.use('/reports', requireAuth, reportsRoutes);

module.exports = router;
