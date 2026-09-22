'use strict';

const path = require('path');
const fs = require('fs');
const winston = require('winston');
const env = require('./env');

const logsDir = path.resolve(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const { combine, timestamp, errors, splat, printf, colorize, json } = winston.format;

const devFormat = printf(({ level, message, timestamp: ts, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${stack || message}${metaStr}`;
});

const logger = winston.createLogger({
  level: env.logLevel,
  format: combine(timestamp(), errors({ stack: true }), splat()),
  defaultMeta: { service: 'perf-api' },
  transports: [
    new winston.transports.Console({
      format: env.isDev
        ? combine(colorize(), timestamp({ format: 'HH:mm:ss' }), devFormat)
        : json(),
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: json(),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: json(),
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
