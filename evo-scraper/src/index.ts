// Entry point. Sobe Express + cron interno opcional.

import { config } from './config.js';
import { logger } from './lib/logger.js';
import { makeApp } from './server.js';
import { startCronIfEnabled } from './jobs.js';
import { closeBrowser } from './auth.js';

const app = makeApp();
const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'evo-scraper up');
});

startCronIfEnabled();

// Graceful shutdown — fecha browser e drena Express
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutdown signal received');
  server.close(() => logger.info('http server closed'));
  await closeBrowser();
  setTimeout(() => process.exit(0), 5000);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT',  () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaught exception');
});
