'use strict';

const os = require('os');
const env = require('../../config/env');

const startedAt = Date.now();

function getHealth(_req, res) {
  res.json({
    success: true,
    data: {
      status: 'ok',
      service: 'perf-api',
      version: process.env.npm_package_version || '0.1.0',
      env: env.nodeEnv,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      node: process.version,
      hostname: os.hostname(),
      memory: process.memoryUsage(),
    },
  });
}

module.exports = { getHealth };
