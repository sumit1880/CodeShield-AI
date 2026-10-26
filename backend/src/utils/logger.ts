import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: process.env.LOG_LEVEL || (env.nodeEnv === 'test' ? 'silent' : 'info'),
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'headers.authorization',
      'headers.cookie',
      'authorization',
      'cookie'
    ],
    censor: '[REDACTED]'
  }
});
