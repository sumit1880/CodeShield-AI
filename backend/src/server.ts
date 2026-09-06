import { createApp } from './app';
import { env, validateStartupConfig } from './config/env';
import { logger } from './utils/logger';
import { SemgrepService } from './services/semgrep/semgrep.service';

// Fails fast with a clear message if required configuration (an LLM
// provider, Google OAuth client ID) is missing, instead of accepting
// traffic and failing confusingly on the first request.
validateStartupConfig();

const app = createApp();

app.listen(env.port, () => {
  logger.info(`Agentic vulnerability detection backend listening on port ${env.port}`);
});

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
