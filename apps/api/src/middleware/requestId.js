'use strict';

const { v4: uuidv4 } = require('uuid');

/**
 * Attach a unique request id for tracing. Honors incoming X-Request-Id if present.
 */
function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuidv4();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
