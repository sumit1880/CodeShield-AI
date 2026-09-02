import { createApp } from './app';
import { env } from './config/env';
import { logger } from './utils/logger';

const app = createApp();

app.listen(env.port, () => {
  logger.info(`Agentic vulnerability detection backend listening on port ${env.port}`);
});
