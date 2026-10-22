import { NextFunction, Request, RequestHandler, Response } from 'express';
import { OAuth2Client, TokenPayload } from 'google-auth-library';
import { env } from '../config/env';
import { ApiError, ErrorCode } from '../utils/errors';
import { logger } from '../utils/logger';

export interface AuthenticatedRequest extends Request {
  /** Set once the Google ID token has been verified. Never contains the raw token. */
  user?: { id: string; email?: string };
}

export type VerifyIdToken = (idToken: string) => Promise<TokenPayload | undefined>;

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

/**
 * Builds Google-Sign-In-only auth middleware: the client authenticates with
 * Google, sends the resulting ID token as `Authorization: Bearer <token>`,
 * and this middleware verifies it directly against Google (signature,
 * expiry, issuer, and audience/client-id) via google-auth-library. No local
 * password/session system is introduced.
 *
 * `verify` is injectable purely for tests, so they never make a real call
 * to Google.
 */
export function buildGoogleAuthMiddleware(verify?: VerifyIdToken): RequestHandler {
  const client = new OAuth2Client();

  const defaultVerify: VerifyIdToken = async (idToken) => {
    const audience = env.google.clientIds.length > 0 ? env.google.clientIds : undefined;
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload();
  };

  const verifyIdToken = verify ?? defaultVerify;

  return async function googleAuth(req: AuthenticatedRequest, _res: Response, next: NextFunction) {
    const token = extractBearerToken(req);
    if (!token) {
      return next(
        new ApiError(ErrorCode.UNAUTHORIZED, 'Missing Google ID token (expected "Authorization: Bearer <token>")')
      );
    }

    try {
      const payload = await verifyIdToken(token);
      if (!payload || !payload.sub) {
        return next(new ApiError(ErrorCode.UNAUTHORIZED, 'Invalid Google ID token'));
      }
      // An address Google hasn't verified shouldn't count as an identity
      if (payload.email && payload.email_verified === false) {
        return next(new ApiError(ErrorCode.UNAUTHORIZED, 'Google account email is not verified'));
      }
      req.user = { id: payload.sub, email: payload.email };
      next();
    } catch (err) {
      logger.warn({ err: (err as Error).message }, '[Auth] Google ID token verification failed');
      // Never surface the underlying verification error message to the
      // client (it can leak library/version details); log it separately if
      // needed at a lower level. Never log the token itself.
      next(new ApiError(ErrorCode.UNAUTHORIZED, 'Invalid or expired Google ID token'));
    }
  };
}

/** Default, production middleware instance (verifies against real Google endpoints). */
export const googleAuth = buildGoogleAuthMiddleware();
