import { createApp } from './app';
import { env, validateStartupConfig } from './config/env';
import { logger } from './utils/logger';
import { SemgrepService } from './services/semgrep/semgrep.service';
import { getPrismaClient } from './config/prisma';

// Fails fast with a clear message if required configuration (an LLM
// provider, Google OAuth client ID) is missing, instead of accepting
// traffic and failing confusingly on the first request.
validateStartupConfig();

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(`Agentic vulnerability detection backend listening on port ${env.port}`);
});

let isShuttingDown = false;

async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Received termination signal, initiating graceful shutdown');

  // Stop accepting new connections
  server.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error during server close');
    }

    try {
      const prisma = getPrismaClient();
      await prisma.$disconnect();
      logger.info('Database disconnected cleanly');
    } catch (dbErr) {
      logger.error({ err: dbErr }, 'Error disconnecting database');
    }

    logger.info('Graceful shutdown completed');
    process.exit(0);
  });

  // Force exit after 30s if in-flight requests don't finish
  const forceTimer = setTimeout(() => {
    logger.warn('Graceful shutdown timed out (30s), forcing process termination');
    process.exit(1);
  }, 30_000);

  forceTimer.unref();
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Non-blocking startup check: log whether Semgrep is actually reachable in
// this environment. The app must keep serving requests either way — this
// only affects whether scans get Semgrep evidence or fall back to LLM-only
// detection.
new SemgrepService()
  .checkAvailability()
  .then(({ available, version }) => {
    if (available) {
      logger.info({ version }, '[Startup] Semgrep is available');
    } else {
      logger.warn('[Startup] Semgrep is not available on PATH; continuing with LLM-only detection');
    }
  })
  .catch(() => {
    logger.warn('[Startup] Semgrep availability check failed; continuing with LLM-only detection');
  });

