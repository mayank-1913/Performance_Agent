'use strict';

const multer = require('multer');
const ApiError = require('../utils/ApiError');
const logger = require('../config/logger');
const env = require('../config/env');

function mapMulterError(err) {
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return ApiError.payloadTooLarge(`File too large. Max ${env.maxUploadSizeMb}MB allowed.`);
    case 'LIMIT_UNEXPECTED_FILE':
      return ApiError.badRequest(`Unexpected field "${err.field}".`);
    case 'LIMIT_FILE_COUNT':
      return ApiError.badRequest('Too many files uploaded.');
    default:
      return ApiError.badRequest(err.message || 'Upload error');
  }
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  let normalized = err;

  if (err instanceof multer.MulterError) {
    normalized = mapMulterError(err);
  } else if (!(err instanceof ApiError)) {
    normalized = new ApiError(err.statusCode || 500, err.message || 'Internal server error', {
      code: err.code || 'INTERNAL_ERROR',
      isOperational: false,
    });
  }

  const { statusCode, message, code, details, stack, isOperational } = normalized;

  const logPayload = {
    requestId: req.id,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code,
    details,
  };

  if (statusCode >= 500 || !isOperational) {
    logger.error(`${message}`, { ...logPayload, stack });
  } else {
    logger.warn(`${message}`, logPayload);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: req.id,
      ...(env.isDev && stack ? { stack } : {}),
    },
  });
}

module.exports = errorHandler;
