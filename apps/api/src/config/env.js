'use strict';

const path = require('path');
const dotenv = require('dotenv');

// Load .env from the api app root (one level up from src/config)
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toList = (value) => {
  const list = (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
};

const env = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: toInt(process.env.PORT, 4000),
  logLevel: process.env.LOG_LEVEL || 'info',
  corsOrigins: toList(process.env.CORS_ORIGINS) || ['http://localhost:5173'],
  uploadDir: process.env.UPLOAD_DIR || './storage/uploads',
  maxUploadSizeMb: toInt(process.env.MAX_UPLOAD_SIZE_MB, 10),
  k6Bin: process.env.K6_BIN || 'k6',
  maxRunTimeMs: toInt(process.env.MAX_RUN_TIME_MS, 30 * 60 * 1000),

  // Phase 7: persistence + auth
  dbPath: process.env.DB_PATH || null, // defaults to storage/database.sqlite
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY_DO_NOT_USE_IN_PROD',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin',
  authDisabled: process.env.AUTH_DISABLED === '1',
};

env.isDev = env.nodeEnv === 'development';
env.isProd = env.nodeEnv === 'production';

/**
 * Phase 8 hardening: refuse to boot in production when the JWT secret is
 * any known development / template value or too short to be safe. Also
 * refuses when the admin password is left at the shipped default. Dev
 * and test boots are unaffected — this only fires when NODE_ENV=production.
 */
const KNOWN_UNSAFE_JWT_SECRETS = new Set([
  'CHANGE_ME_DEV_ONLY_DO_NOT_USE_IN_PROD',
  'CHANGE_ME_TO_A_LONG_RANDOM_STRING',
  'local-dev-secret-please-replace',
  'change-me',
  'changeme',
  'secret',
  'test-secret',
  'dev',
  'development',
  'password',
  '',
]);
const MIN_PROD_SECRET_LEN = 32;

if (env.isProd) {
  const s = String(env.jwtSecret || '');
  if (KNOWN_UNSAFE_JWT_SECRETS.has(s)) {
    throw new Error(
      '[env] JWT_SECRET is set to a known unsafe / template value in production. ' +
      'Set JWT_SECRET in .env to a random string at least ' + MIN_PROD_SECRET_LEN + ' characters long.'
    );
  }
  if (s.length < MIN_PROD_SECRET_LEN) {
    throw new Error(
      '[env] JWT_SECRET is too short for production (need >= ' + MIN_PROD_SECRET_LEN +
      ' characters, got ' + s.length + '). Rotate it before starting the API.'
    );
  }
  if (env.adminPassword === 'admin' || env.adminPassword === 'password' || !env.adminPassword) {
    throw new Error(
      '[env] ADMIN_PASSWORD is set to a known default in production. ' +
      'Set a strong ADMIN_PASSWORD in .env before starting the API.'
    );
  }
} else if (env.jwtSecret === 'CHANGE_ME_DEV_ONLY_DO_NOT_USE_IN_PROD') {
  // eslint-disable-next-line no-console
  console.warn('[env] JWT_SECRET is using its development default. Safe for dev; must be replaced before NODE_ENV=production.');
}

module.exports = env;
