'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const env = require('./config/env');
const logger = require('./config/logger');
const { getDb } = require('./config/db');
const requestId = require('./middleware/requestId');
const notFound = require('./middleware/notFound');
const errorHandler = require('./middleware/errorHandler');
const ApiError = require('./utils/ApiError');
const apiRoutes = require('./routes');

const app = express();

// Initialize SQLite + run migrations + seed admin (synchronous via better-sqlite3).
try {
  getDb();
} catch (err) {
  logger.error('Failed to initialize database', { error: err.message });
  throw err;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestId);
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      // allow non-browser tools (no origin) and configured origins
      if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
      return cb(ApiError.forbidden(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const morganFormat = env.isDev ? 'dev' : 'combined';
app.use(
  morgan(morganFormat, {
    stream: logger.stream,
    skip: (req) =>
      // Avoid noisy access logs for token-bearing endpoints; controllers log a masked summary.
      req.method === 'POST' && /\/runs\/(prepare|start)/.test(req.originalUrl),
  })
);

// Root info
app.get('/', (_req, res) => {
  res.json({
    success: true,
    data: {
      name: 'perf-api',
      version: '0.1.0',
      docs: '/api/v1/health',
    },
  });
});

// API v1
app.use('/api/v1', apiRoutes);

// 404 + error handler
app.use(notFound);
app.use(errorHandler);

module.exports = app;
