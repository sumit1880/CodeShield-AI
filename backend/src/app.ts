import express, { Express, RequestHandler } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { buildContainer, Container } from './config/container';
import { healthRouter } from './routes/health.route';
import { buildAnalyzeRouter, AnalyzeRouterOptions } from './routes/analyze.route';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { requestId } from './middleware/request-id';
import { ErrorCode } from './utils/errors';

export interface CreateAppOptions extends AnalyzeRouterOptions {
  /** Caps requests per window on /api/*. Defaults to a real in-memory rate limiter. */
  rateLimiter?: RequestHandler;
}

export function createApp(container: Container = buildContainer(), options: CreateAppOptions = {}): Express {
  const app = express();

  // `trust proxy` so rate limiting and logging see the real client IP when
  // deployed behind a platform load balancer/reverse proxy (Render, etc.)
  // instead of the proxy's own address.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin }));
  app.use(requestId);
  // Body size is capped well above the analyzer's own MAX_CODE_CHARACTERS
  // check but far below anything that could meaningfully exhaust memory;
  // the ZIP upload path is bounded separately by multer + safeExtract.
  app.use(express.json({ limit: '2mb' }));
  app.use(pinoHttp({ logger, autoLogging: env.nodeEnv !== 'test' }));

  const rateLimiter =
    options.rateLimiter ??
    rateLimit({
      windowMs: env.rateLimit.windowMs,
      limit: env.rateLimit.maxRequests,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: { code: ErrorCode.RATE_LIMITED, message: 'Too many requests, please try again later' }
      }
    });

  app.use('/', healthRouter);
  app.use(
    '/api',
    rateLimiter,
    buildAnalyzeRouter(container, {
      authMiddleware: options.authMiddleware,
      userRateLimiter: options.userRateLimiter,
      concurrencyLimiter: options.concurrencyLimiter
    })
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
