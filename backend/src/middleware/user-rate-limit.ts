import { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { AuthenticatedRequest } from './google-auth.middleware';
import { ErrorCode } from '../utils/errors';

export interface UserRateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
}

/**
 * Builds a per-user rate limiter that enforces a quota keyed by req.user.id.
 * Falls back to req.ip if req.user is absent (e.g. if invoked outside auth).
 */
export function buildUserRateLimiter(options: UserRateLimiterOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? 24 * 60 * 60 * 1000; // 24 hours
  const max = options.maxRequests ?? env.dailyAnalysisLimit;

  return rateLimit({
    windowMs,
    limit: max,
    keyGenerator: (req) => {
      const authReq = req as AuthenticatedRequest;
      return authReq.user?.id || req.ip || 'anonymous';
    },
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: ErrorCode.RATE_LIMITED, message: 'Daily analysis quota exceeded' }
    }
  });
}
