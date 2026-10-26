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
import { buildAnalysesRouter } from './routes/analyses.route';
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

  app.use(
    helmet({
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
    })
  );

  const configuredOrigins = (env.corsOrigin || '')
    .split(',')
    .map((o) => o.trim().replace(/\/$/, ''))
    .filter(Boolean);

  const defaultOrigins: string[] = []; // No wildcard when credentials are required
  const allowedOrigins = Array.from(new Set([...defaultOrigins, ...configuredOrigins]));

  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server, curl, mobile apps, or local same-origin without Origin header
        if (!origin) return callback(null, true);

        const normalized = origin.replace(/\/$/, '');
        if (
          allowedOrigins.includes('*') ||
          allowedOrigins.includes(normalized) ||
          /^https:\/\/.*\.vercel\.app$/.test(normalized)
        ) {
          return callback(null, true);
        }

        logger.warn({ origin }, '[CORS] Origin rejected');
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
    })
  );
  app.use(requestId);
  // Body size is capped well above the analyzer's own MAX_CODE_CHARACTERS
  // check but far below anything that could meaningfully exhaust memory;
  // the ZIP upload path is bounded separately by multer + safeExtract.
  app.use(express.json({ limit: '2mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: env.nodeEnv !== 'test',
      serializers: {
        req: (req: any) => {
          const raw = req.raw || req;
          const headers = { ...(raw.headers || {}) };
          if (headers.authorization) headers.authorization = '[REDACTED]';
          if (headers.cookie) headers.cookie = '[REDACTED]';
          if (headers['x-api-key']) headers['x-api-key'] = '[REDACTED]';
          return {
            id: req.id,
            method: req.method,
            url: req.url,
            query: req.query,
            params: req.params,
            headers,
            remoteAddress: raw.socket?.remoteAddress,
            remotePort: raw.socket?.remotePort
          };
        },
        res: (res: any) => {
          const raw = res.raw || res;
          const headers = { ...(raw.getHeaders ? raw.getHeaders() : raw.headers || {}) };
          if (headers['set-cookie']) headers['set-cookie'] = '[REDACTED]';
          return {
            statusCode: res.statusCode,
            headers
          };
        }
      },
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
          'headers.authorization',
          'headers.cookie'
        ],
        censor: '[REDACTED]'
      }
    })
  );

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
  app.use('/api/analyses', rateLimiter, buildAnalysesRouter(container, { authMiddleware: options.authMiddleware }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
