'use strict';

class ApiError extends Error {
  constructor(statusCode, message, { code = 'API_ERROR', details = undefined, isOperational = true } = {}) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, this.constructor);
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, { code: 'BAD_REQUEST', details });
  }

  static unauthorized(message = 'Unauthorized') {
    return new ApiError(401, message, { code: 'UNAUTHORIZED' });
  }

  static forbidden(message = 'Forbidden') {
    return new ApiError(403, message, { code: 'FORBIDDEN' });
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message, { code: 'NOT_FOUND' });
  }

  static payloadTooLarge(message = 'Payload too large') {
    return new ApiError(413, message, { code: 'PAYLOAD_TOO_LARGE' });
  }

  static unsupportedMediaType(message = 'Unsupported media type') {
    return new ApiError(415, message, { code: 'UNSUPPORTED_MEDIA_TYPE' });
  }

  static internal(message = 'Internal server error') {
    return new ApiError(500, message, { code: 'INTERNAL_ERROR', isOperational: false });
  }
}

module.exports = ApiError;
