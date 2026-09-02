import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { buildContainer, Container } from './config/container';
import { healthRouter } from './routes/health.route';
import { buildAnalyzeRouter } from './routes/analyze.route';
import { errorHandler, notFoundHandler } from './middleware/error-handler';

export function createApp(container: Container = buildContainer()): Express {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(express.json({ limit: '10mb' }));
  app.use(pinoHttp({ logger, autoLogging: env.nodeEnv !== 'test' }));

  app.use('/', healthRouter);
  app.use('/api', buildAnalyzeRouter(container));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
