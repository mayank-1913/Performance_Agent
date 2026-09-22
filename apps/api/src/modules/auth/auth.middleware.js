'use strict';

const jwt = require('jsonwebtoken');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');

/**
 * Extracts a token from `Authorization: Bearer <token>` first, then
 * `?token=...` for SSE/EventSource and report HTML downloads (which can't
 * send custom headers from a browser <a href> or `new EventSource(url)`).
 */
function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization || '';
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  if (typeof req.query?.token === 'string' && req.query.token.length > 0) {
    return req.query.token;
  }
  return null;
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn }
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, env.jwtSecret);
  } catch {
    return null;
  }
}

/**
 * Express middleware that requires a valid JWT. Attaches `req.user`.
 * If `AUTH_DISABLED=1`, accepts everything as a synthetic admin user.
 */
function requireAuth(req, _res, next) {
  if (env.authDisabled) {
    req.user = { id: '_disabled_', username: 'auth-disabled', role: 'admin' };
    return next();
  }
  const token = extractToken(req);
  if (!token) return next(ApiError.unauthorized('Missing or invalid token'));
  const payload = verifyToken(token);
  if (!payload) return next(ApiError.unauthorized('Token invalid or expired'));
  req.user = { id: payload.sub, username: payload.username, role: payload.role };
  next();
}

function requireRole(role) {
  return function (req, _res, next) {
    if (!req.user) return next(ApiError.unauthorized('Auth required'));
    if (req.user.role !== role && req.user.role !== 'admin') {
      return next(ApiError.forbidden(`Requires role: ${role}`));
    }
    next();
  };
}

module.exports = { requireAuth, requireRole, signToken, verifyToken, extractToken };
