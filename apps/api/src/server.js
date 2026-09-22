'use strict';

const env = require('./config/env');
const logger = require('./config/logger');
const app = require('./app');

const server = app.listen(env.port, () => {
  logger.info(`API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  server.close((err) => {
    if (err) {
      logger.error('Error during shutdown', { err: err.message });
      process.exit(1);
    }
    logger.info('Server closed.');
    process.exit(0);
  });

  // Force exit if not closed in 10s
  setTimeout(() => {
    logger.warn('Force exit after timeout.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { message: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason instanceof Error ? reason.message : String(reason) });
});
