import pino from 'pino';
import { env } from '../config/env';

export const logger = pino({
  level: process.env.LOG_LEVEL || (env.nodeEnv === 'test' ? 'silent' : 'info')
});
